import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelForceMerge,
  confirmForceMerge,
  openForceMerge,
  pendingForceMerge,
  type ForceMergeDeps,
  type GithubMergeResponse,
} from "./force-merge";
import type { GithubCredential } from "./github-auth";
import {
  assessPrMergeReadiness,
  type PrReadinessSource,
} from "./pr-merge-readiness";
import {
  __setMergeQueueDepsForTest,
  MAX_PAT_ROUNDS,
  MERGE_CARD_DELIVERY_PREFIX,
  mergeQueue,
  raiseMergeCard,
} from "./supervisor-merge-queue";
import { backgroundDeliveryKind } from "./supervisor-watch";

const credential: GithubCredential = {
  kind: "user",
  principal: "user:ada",
  env: {},
};
const driver = { name: "Ada", login: "ada" };

function source(number: number, conflicting: boolean): PrReadinessSource {
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
    mergeable: conflicting ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    checks: [],
    latestReviews: [],
    reviewRequests: [],
    rules: { requiredChecks: [], requiredApprovals: 0, strictUpToDate: false },
  };
}

/** A repository where merging one PR can leave others conflicting. */
function setup(opts: { merge?: GithubMergeResponse } = {}) {
  const conflicting = new Set<number>();
  /** PRs that conflict once the given PR merges. */
  const conflictsAfter = new Map<number, number[]>();
  const told: string[] = [];
  const pat: Array<{ pr: number; finish: () => void }> = [];
  const github: ForceMergeDeps = {
    audit: () => {},
    github: {
      verdict: async (t) =>
        assessPrMergeReadiness(source(t.number, conflicting.has(t.number))),
      mergeMethods: async () => ["squash"],
      head: async (t) => ({
        sha: String(t.number).padStart(40, "a"),
        open: true,
      }),
      merge: async (_repo, number) => {
        const response = opts.merge ?? { ok: true };
        if (response.ok)
          for (const n of conflictsAfter.get(number) ?? []) conflicting.add(n);
        return response;
      },
      comment: async () => {},
    },
  };
  __setMergeQueueDepsForTest({
    open: (sessionId, input) =>
      openForceMerge(
        sessionId,
        {
          target: input.target,
          reason: input.reason,
          driver: input.driver,
          requestedBy: "Blob",
        },
        undefined,
        github,
      ),
    askPat: async ({ pr, action }) => {
      expect(action).toBe("auto_fix");
      let finish = () => {};
      const done = new Promise<void>((resolve) => (finish = resolve));
      pat.push({ pr, finish });
      return { ok: true, message: "Started", done };
    },
    tell: async (_sessionId, text) => {
      told.push(text);
    },
    persona: () => "Pat",
  });
  return { conflicting, conflictsAfter, told, pat };
}

const raise = (sessionId: string, number: number) =>
  raiseMergeCard(sessionId, {
    target: { repoId: "app", ghRepo: "acme/app", number },
    reason: "The owner asked to merge it.",
    driver,
    owner: "ada",
  });

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The owner taps Confirm on the session's open card. */
async function tap(sessionId: string) {
  const open = pendingForceMerge(sessionId)!;
  await confirmForceMerge(sessionId, open.request.id, "ada", credential);
  await flush();
}

afterEach(() => __setMergeQueueDepsForTest());

describe("supervisor merge cards", () => {
  test("raising a card returns at once; the merge arrives as a notice", async () => {
    const { told } = setup();
    const answer = await raise("q-fast", 12);
    expect(answer).toBe(
      "Card raised for acme/app#12; you'll hear when it's merged.",
    );
    // The card waits for the owner; the tool call did not.
    expect(pendingForceMerge("q-fast")?.request.number).toBe(12);
    expect(told).toEqual([]);

    await tap("q-fast");
    expect(told).toHaveLength(1);
    expect(told[0]).toStartWith("Merge card: acme/app#12 was merged");
    expect(mergeQueue("q-fast")).toEqual([]);
  });

  test("a cancel or a refusal arrives as a notice too", async () => {
    const { told } = setup({
      merge: { ok: false, status: 403, message: "Resource not accessible" },
    });
    await raise("q-fail", 7);
    await tap("q-fail");
    expect(told[0]).toStartWith("Merge card: acme/app#7 was not merged.");

    await raise("q-fail", 8);
    cancelForceMerge("q-fail", pendingForceMerge("q-fail")!.request.id, "Ada");
    await flush();
    expect(told[1]).toBe(
      "Merge card: Ada cancelled the force merge of acme/app#8. Nothing was merged; do not ask again unless they say so.",
    );
  });

  test("several PRs queue and merge in order, one card at a time", async () => {
    const { told } = setup();
    await raise("q-order", 12);
    expect(await raise("q-order", 10)).toStartWith(
      "Queued acme/app#10 behind acme/app#12.",
    );
    expect(await raise("q-order", 11)).toStartWith(
      "Queued acme/app#11 behind acme/app#12, acme/app#10.",
    );
    expect(await raise("q-order", 11)).toStartWith(
      "acme/app#11 is already in the merge queue",
    );
    expect(pendingForceMerge("q-order")?.request.number).toBe(12);

    await tap("q-order");
    expect(pendingForceMerge("q-order")?.request.number).toBe(10);
    await tap("q-order");
    expect(pendingForceMerge("q-order")?.request.number).toBe(11);
    await tap("q-order");
    expect(pendingForceMerge("q-order")).toBeNull();
    expect(told.map((t) => t.match(/acme\/app#\d+ was merged/)?.[0])).toEqual([
      "acme/app#12 was merged",
      "acme/app#10 was merged",
      "acme/app#11 was merged",
    ]);
  });

  test("a PR that conflicts after another merges goes to Pat, then its card comes back", async () => {
    const { conflicting, conflictsAfter, told, pat } = setup();
    conflictsAfter.set(12, [10]);
    await raise("q-pat", 12);
    await raise("q-pat", 10);

    await tap("q-pat");
    // #10 now conflicts: Pat updates it, no card yet, the owner hears once.
    expect(pat.map((p) => p.pr)).toEqual([10]);
    expect(pendingForceMerge("q-pat")).toBeNull();
    expect(told).toHaveLength(2);
    expect(told[1]).toBe(
      "Merge card: acme/app#10 conflicts with its base now that acme/app#12 merged. I asked Pat to update the branch; its card comes back when Pat is done, and you'll hear how it ends.",
    );
    // A PR raised meanwhile waits its turn behind #10.
    expect(await raise("q-pat", 11)).toStartWith(
      "Queued acme/app#11 behind acme/app#10.",
    );

    conflicting.delete(10);
    pat[0]!.finish();
    await flush();
    expect(pendingForceMerge("q-pat")?.request.number).toBe(10);
    await tap("q-pat");
    expect(told[2]).toStartWith("Merge card: acme/app#10 was merged");
    expect(pendingForceMerge("q-pat")?.request.number).toBe(11);
  });

  test("a PR still conflicting after Pat's rounds leaves the queue, told once more", async () => {
    const { conflicting, told, pat } = setup();
    conflicting.add(10);
    expect(await raise("q-stuck", 10)).toBe(
      "acme/app#10 conflicts with its base. I asked Pat to update the branch; its card comes back when Pat is done, and you'll hear how it ends.",
    );
    for (let round = 0; round < MAX_PAT_ROUNDS; round++) {
      pat[round]!.finish();
      await flush();
    }
    expect(pat).toHaveLength(MAX_PAT_ROUNDS);
    // The conflict was told once (the tool's answer); then the drop.
    expect(told).toEqual([
      `Merge card: acme/app#10 still conflicts with its base after Pat updated it ${MAX_PAT_ROUNDS} times, so it left the merge queue. Nothing was merged.`,
    ]);
    expect(mergeQueue("q-stuck")).toEqual([]);
  });

  test("GitHub refusing a confirmed merge as not mergeable goes to Pat", async () => {
    const { told, pat } = setup({
      merge: {
        ok: false,
        status: 405,
        message: "Pull Request is not mergeable",
      },
    });
    await raise("q-405", 9);
    await tap("q-405");
    expect(pat.map((p) => p.pr)).toEqual([9]);
    expect(told).toEqual([
      "Merge card: acme/app#9 conflicts with its base. I asked Pat to update the branch; its card comes back when Pat is done, and you'll hear how it ends.",
    ]);
    expect(mergeQueue("q-405")).toEqual(["acme/app#9"]);
  });

  test("the outcome notice stays in the conversation, not the watch", () => {
    const notice = "<!--os:session-notice-->\nMerge card: merged";
    expect(
      backgroundDeliveryKind(
        notice,
        undefined,
        `${MERGE_CARD_DELIVERY_PREFIX}1`,
      ),
    ).toBeNull();
    expect(backgroundDeliveryKind(notice, undefined, "other")).toBe(
      "session-notice",
    );
  });
});
