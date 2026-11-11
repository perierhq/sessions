/**
 * A merged pull request wakes the lead of the repository's project when one
 * of its approvals waits on it (leads/goal.ts wakeLeadFor, covered in
 * goal.test.ts). This pins the webhook wiring: the project is the
 * repository's id, and whoever merged it, the lead checks again itself.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "../../server/config";

const root = fs.mkdtempSync(join(tmpdir(), "github-lead-wake-webhook-"));
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

const wakes: unknown[][] = [];

const realArchive = await import("./pr-session-archive");
mock.module("./pr-session-archive", () => ({
  ...realArchive,
  archiveClosedPrSessions: async () => ({ archived: [], skippedRunning: [] }),
  unarchiveReopenedPrSessions: async () => [],
}));
mock.module("./approval-gate", () => ({
  refreshApprovalGate: () => Promise.resolve(),
  loadApprovalGateConfig: async () => null,
}));
const realGoal = await import("../../server/leads/goal");
mock.module("../../server/leads/goal", () => ({
  ...realGoal,
  wakeLeadFor: async (...args: unknown[]) => {
    wakes.push(args);
    return true;
  },
}));

const { handleGithubPrEvent } = await import("./webhook");

function payload(action: string, pr: Record<string, unknown> = {}) {
  return {
    action,
    repository: { full_name: "acme/docs" },
    sender: { login: "someone-else" },
    pull_request: {
      number: 41,
      title: "Example",
      head: { ref: "feature", sha: "abc1234" },
      ...pr,
    },
  };
}

/** The wake is fire and forget: wait for it to land. */
async function settled() {
  for (let i = 0; i < 50 && !wakes.length; i++) await Bun.sleep(2);
}

beforeEach(() => {
  wakes.length = 0;
});

afterAll(async () => {
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = priorConfig;
  await getConfigAsync();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a merged PR wakes the lead of its repository's project", async () => {
  await handleGithubPrEvent(
    "pull_request",
    payload("closed", { merged: true, merged_by: { login: "someone-else" } }),
  );
  await settled();
  expect(wakes).toEqual([
    ["docs", { kind: "pr-merged", ghRepo: "acme/docs", number: 41 }],
  ]);
});

test("a PR closed without merging wakes nothing", async () => {
  await handleGithubPrEvent("pull_request", payload("closed"));
  await settled();
  expect(wakes).toEqual([]);
});
