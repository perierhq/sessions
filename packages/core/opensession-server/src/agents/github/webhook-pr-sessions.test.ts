/**
 * The `pull_request` webhook drives the PR sessions' archive lifecycle: any
 * close (merged or not, whoever merged it) archives them, and a reopen or
 * push restores them. The lifecycle itself is covered in
 * pr-session-archive.test.ts; this pins the webhook wiring. Only the two
 * session-touching calls are replaced: the action mapping is the real one,
 * and the payload names a repository so its owner/name reaches the archive.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "../../server/config";

const root = fs.mkdtempSync(join(tmpdir(), "github-pr-sessions-webhook-"));
const priorConfig = process.env.OPENSESSION_CONFIG;
const config = join(root, "config.json");
fs.writeFileSync(
  config,
  JSON.stringify({
    repos: {
      app: { repo: join(root, "app"), ghRepo: "acme/app", default: true },
      docs: { repo: join(root, "docs"), ghRepo: "acme/docs" },
    },
  }),
);
process.env.OPENSESSION_CONFIG = config;
await getConfigAsync();

const calls: Array<[string, number, string | undefined]> = [];
const admitted: Array<{ number: number; headSha: string }> = [];

const realArchive = await import("./pr-session-archive");
mock.module("./pr-session-archive", () => ({
  ...realArchive,
  archiveClosedPrSessions: async (prNumber: number, ghRepo?: string) => {
    calls.push(["archive", prNumber, ghRepo]);
    return { archived: [], skippedRunning: [] };
  },
  unarchiveReopenedPrSessions: async (prNumber: number, ghRepo?: string) => {
    calls.push(["unarchive", prNumber, ghRepo]);
    return [];
  },
}));

// A push debounces into the desired-review scheduler; record what it admits
// instead of arming its timers.
const realDesired = await import("./desired-review");
mock.module("./desired-review", () => ({
  ...realDesired,
  DesiredReviewScheduler: class {
    admit(ref: { number: number; headSha: string }) {
      admitted.push({ number: ref.number, headSha: ref.headSha });
    }
    cancel() {}
    restore() {}
  },
}));
mock.module("./approval-gate", () => ({
  refreshApprovalGate: () => Promise.resolve(),
  loadApprovalGateConfig: async () => null,
}));
const realMappings = await import("../../server/shared/user-mappings");
mock.module("../../server/shared/user-mappings", () => ({
  ...realMappings,
  isTrustedGithubLogin: (login?: string | null) => login === "maintainer",
}));

const { handleGithubPrEvent } = await import("./webhook");

function payload(
  action: string,
  pr: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    repository: { full_name: "acme/docs" },
    // Not a trusted login: lifecycle routing must not depend on the sender.
    sender: { login: "someone-else" },
    pull_request: {
      number: 41,
      title: "Example",
      head: { ref: "feature", sha: "abc1234" },
      ...pr,
    },
    ...extra,
  };
}

beforeEach(() => {
  calls.length = 0;
  admitted.length = 0;
});

afterAll(async () => {
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  await getConfigAsync();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a closed PR archives its sessions in the PR's own repository", async () => {
  await handleGithubPrEvent("pull_request", payload("closed"));
  expect(calls).toEqual([["archive", 41, "acme/docs"]]);
});

test("a merged PR archives its sessions even when the merger is untrusted", async () => {
  await handleGithubPrEvent(
    "pull_request",
    payload("closed", { merged: true, merged_by: { login: "someone-else" } }),
  );
  expect(calls).toEqual([["archive", 41, "acme/docs"]]);
});

test("a reopen or push restores them", async () => {
  await handleGithubPrEvent("pull_request", payload("reopened"));
  await handleGithubPrEvent("pull_request", payload("synchronize"));
  expect(calls).toEqual([
    ["unarchive", 41, "acme/docs"],
    ["unarchive", 41, "acme/docs"],
  ]);
});

test("a push still admits a review after restoring the sessions", async () => {
  await handleGithubPrEvent(
    "pull_request",
    payload(
      "synchronize",
      {
        labels: [{ name: "os-review" }],
        head: { ref: "feature", sha: "def5678" },
      },
      { sender: { login: "maintainer" } },
    ),
  );
  expect(calls).toEqual([["unarchive", 41, "acme/docs"]]);
  expect(admitted).toEqual([{ number: 41, headSha: "def5678" }]);
});

test("other actions leave the sessions alone", async () => {
  await handleGithubPrEvent("pull_request", payload("edited"));
  await handleGithubPrEvent("pull_request", payload("opened"));
  expect(calls).toEqual([]);
});
