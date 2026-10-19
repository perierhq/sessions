/**
 * The `pull_request` webhook drives the PR sessions' archive lifecycle: any
 * close (merged or not, whoever merged it) archives them, and a reopen or
 * push restores them. The lifecycle itself is covered in
 * pr-session-archive.test.ts; this pins the webhook wiring.
 */
import { beforeEach, expect, mock, test } from "bun:test";

const calls: Array<[string, number, string | undefined]> = [];

mock.module("./pr-session-archive", () => ({
  prSessionLifecycleAction: (action: string) =>
    action === "closed"
      ? "archive"
      : action === "reopened" || action === "synchronize"
        ? "unarchive"
        : null,
  archiveClosedPrSessions: async (prNumber: number, ghRepo?: string) => {
    calls.push(["archive", prNumber, ghRepo]);
    return { archived: [], skippedRunning: [] };
  },
  unarchiveReopenedPrSessions: async (prNumber: number, ghRepo?: string) => {
    calls.push(["unarchive", prNumber, ghRepo]);
    return [];
  },
}));

const { handleGithubPrEvent } = await import("./webhook");

function payload(action: string, pr: Record<string, unknown> = {}) {
  return {
    action,
    // Not a trusted login: lifecycle routing must not depend on the sender.
    sender: { login: "someone-else" },
    pull_request: {
      number: 41,
      title: "Example",
      head: { ref: "feature", sha: "abc1234" },
      ...pr,
    },
  };
}

beforeEach(() => {
  calls.length = 0;
});

test("a closed PR archives its sessions", async () => {
  await handleGithubPrEvent("pull_request", payload("closed"));
  expect(calls).toEqual([["archive", 41, undefined]]);
});

test("a merged PR archives its sessions even when the merger is untrusted", async () => {
  await handleGithubPrEvent(
    "pull_request",
    payload("closed", { merged: true, merged_by: { login: "someone-else" } }),
  );
  expect(calls).toEqual([["archive", 41, undefined]]);
});

test("a reopen or push restores them", async () => {
  await handleGithubPrEvent("pull_request", payload("reopened"));
  await handleGithubPrEvent("pull_request", payload("synchronize"));
  expect(calls).toEqual([
    ["unarchive", 41, undefined],
    ["unarchive", 41, undefined],
  ]);
});

test("other actions leave the sessions alone", async () => {
  await handleGithubPrEvent("pull_request", payload("edited"));
  await handleGithubPrEvent("pull_request", payload("opened"));
  expect(calls).toEqual([]);
});
