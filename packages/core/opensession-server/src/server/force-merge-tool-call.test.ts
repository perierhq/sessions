import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ForceMergeDeps } from "./force-merge";
import type { GithubCredential } from "./github-auth";
import {
  assessPrMergeReadiness,
  type PrReadinessSource,
} from "./pr-merge-readiness";
import { __setIdentitiesForTest } from "./shared/user-mappings";

function source(number: number): PrReadinessSource {
  return {
    repoId: "app",
    ghRepo: "acme/app",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    author: "ada",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: `b-${number}`,
    headRefOid: String(number).padStart(40, "a"),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    checks: [],
    latestReviews: [],
    reviewRequests: [],
    rules: { requiredChecks: [], requiredApprovals: 0, strictUpToDate: false },
  };
}

const github: ForceMergeDeps = {
  audit: () => {},
  github: {
    verdict: async (t) => assessPrMergeReadiness(source(t.number)),
    mergeMethods: async () => ["squash"],
    head: async (t) => ({
      sha: String(t.number).padStart(40, "a"),
      open: true,
    }),
    merge: async () => ({ ok: true }),
    comment: async () => {},
  },
};

const sessions: Record<string, { supervisor?: boolean }> = {
  "plain-session": {},
  "supervisor-session": { supervisor: true },
};

const realCache = await import("./session-cache");
mock.module("./session-cache", () => ({
  ...realCache,
  findSession: (id: string) => sessions[id],
}));
const realWebAuth = await import("./web-auth");
mock.module("./web-auth", () => ({
  ...realWebAuth,
  webAuthRequired: () => true,
}));
const realRepos = await import("./session-repos");
mock.module("./session-repos", () => ({
  ...realRepos,
  resolvePrReadinessTarget: async (
    _sessionId: string,
    input: { number?: number },
  ) => ({ repoId: "app", ghRepo: "acme/app", number: input.number ?? 1 }),
}));
const realForceMerge = await import("./force-merge");
// Captured first: mock.module rebinds the live namespace's exports too.
const realRequest = realForceMerge.requestForceMerge;
const realOpen = realForceMerge.openForceMerge;
mock.module("./force-merge", () => ({
  ...realForceMerge,
  requestForceMerge: (
    sessionId: string,
    input: Parameters<typeof realRequest>[1],
    signal?: AbortSignal,
  ) => realRequest(sessionId, input, signal, github),
  openForceMerge: (
    sessionId: string,
    input: Parameters<typeof realOpen>[1],
    signal?: AbortSignal,
  ) => realOpen(sessionId, input, signal, github),
}));

const { forceMergeToolCall } = await import("./force-merge-session");
const { confirmForceMerge, pendingForceMerge } = await import("./force-merge");
const { __setMergeQueueDepsForTest } = await import("./supervisor-merge-queue");

const restoreIdentities = __setIdentitiesForTest([
  { name: "Ada", email: "ada@example.test", github: "ada" },
]);
__setMergeQueueDepsForTest({
  tell: async () => {},
  save: async () => {},
  postItem: async () => {},
});
afterAll(() => {
  restoreIdentities();
  __setMergeQueueDepsForTest();
});

const credential: GithubCredential = {
  kind: "user",
  principal: "user:ada",
  env: {},
};

describe("forceMergeToolCall", () => {
  test("outside the supervisor it waits for the answer and returns the outcome", async () => {
    let settled = false;
    const call = forceMergeToolCall("plain-session", "Ada", {
      number: 4,
      reason: "Checks are flaky.",
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    for (let i = 0; i < 20 && !pendingForceMerge("plain-session"); i++)
      await new Promise((r) => setTimeout(r, 0));
    const open = pendingForceMerge("plain-session");
    expect(open?.request.number).toBe(4);
    // The card is up and the call is still waiting on the owner.
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    await confirmForceMerge(
      "plain-session",
      open!.request.id,
      "ada",
      credential,
    );
    const outcome = await call;
    expect(typeof outcome).toBe("object");
    if (typeof outcome === "string") throw new Error(outcome);
    expect(outcome.request.number).toBe(4);
    expect(outcome.result.status).toBe("merged");
  });

  test("in the supervisor it returns as soon as the card is up", async () => {
    const answer = await forceMergeToolCall("supervisor-session", "Ada", {
      number: 5,
      reason: "The owner asked to merge it.",
    });
    expect(answer).toBe(
      "Card raised for acme/app#5; you'll hear when it's merged.",
    );
    expect(pendingForceMerge("supervisor-session")?.request.number).toBe(5);
  });
});
