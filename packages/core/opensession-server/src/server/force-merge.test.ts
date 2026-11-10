import { describe, expect, test } from "bun:test";
import {
  cancelForceMerge,
  confirmForceMerge,
  explainMergeRefusal,
  forceMergeBypasses,
  formatForceMergeOutcome,
  parseGhApiError,
  pendingForceMerge,
  pickMergeMethod,
  requestForceMerge,
  type ForceMergeDeps,
  type GithubMergeResponse,
} from "./force-merge";
import type { GithubCredential } from "./github-auth";
import {
  assessPrMergeReadiness,
  type PrReadinessSource,
} from "./pr-merge-readiness";

const HEAD = "a".repeat(40);
const target = { repoId: "app", ghRepo: "tellahq/app", number: 42 };
const credential: GithubCredential = {
  kind: "user",
  principal: "user:ada",
  env: {},
};
const driver = { name: "Ada", login: "ada" };

function source(over: Partial<PrReadinessSource> = {}): PrReadinessSource {
  return {
    repoId: "app",
    ghRepo: "tellahq/app",
    number: 42,
    title: "Fix the thing",
    url: "https://github.com/tellahq/app/pull/42",
    author: "ada",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "fix-thing",
    headRefOid: HEAD,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checks: [
      { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
      {
        name: "e2e",
        workflowName: "ci",
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
    ],
    latestReviews: [],
    reviewRequests: [],
    rules: {
      requiredChecks: ["ci / e2e"],
      requiredApprovals: 1,
      strictUpToDate: false,
    },
    ...over,
  };
}

function fake(
  over: {
    src?: Partial<PrReadinessSource>;
    head?: string;
    merge?: GithubMergeResponse;
    methods?: Array<"squash" | "merge" | "rebase">;
  } = {},
) {
  const calls = {
    merge: [] as Array<{ sha: string; method: string }>,
    comment: [] as string[],
    audit: [] as Array<Record<string, unknown>>,
  };
  const deps: ForceMergeDeps = {
    audit: (event) => calls.audit.push(event),
    github: {
      verdict: async () => assessPrMergeReadiness(source(over.src)),
      mergeMethods: async () => over.methods ?? ["squash"],
      head: async () => ({ sha: over.head ?? HEAD, open: true }),
      merge: async (_repo, _n, opts) => {
        calls.merge.push({ sha: opts.sha, method: opts.method });
        return over.merge ?? { ok: true, sha: "b".repeat(40) };
      },
      comment: async (_repo, _n, body) => {
        calls.comment.push(body);
      },
    },
  };
  return { deps, calls };
}

async function open(sessionId: string, deps: ForceMergeDeps, ttl?: number) {
  const outcome = requestForceMerge(
    sessionId,
    { target, reason: "e2e is down for everyone", driver },
    undefined,
    deps,
    ttl,
  );
  // The card appears once the PR has been read.
  for (let i = 0; i < 20 && !pendingForceMerge(sessionId); i++)
    await Promise.resolve();
  return { outcome, open: pendingForceMerge(sessionId) };
}

describe("force merge", () => {
  test("the card names the PR, pinned head and every bypass", async () => {
    const { deps, calls } = fake();
    const { outcome, open: card } = await open("s-card", deps);
    expect(card).not.toBeNull();
    const r = card!.request;
    expect(r).toMatchObject({
      ghRepo: "tellahq/app",
      number: 42,
      title: "Fix the thing",
      headSha: HEAD,
      method: "squash",
      reason: "e2e is down for everyone",
      driver: "Ada",
    });
    expect(r.bypass).toEqual([
      { kind: "check", name: "ci / e2e", state: "failing", required: true },
      { kind: "review", detail: "Approving review required" },
    ]);
    // Nothing reached GitHub while the card waits.
    expect(calls.merge).toEqual([]);
    cancelForceMerge("s-card", r.id, "Ada");
    await outcome;
  });

  test("merges only after the driver confirms, pinned to the card's SHA", async () => {
    const { deps, calls } = fake();
    const { outcome, open: card } = await open("s-merge", deps);
    const id = card!.request.id;
    expect(calls.merge).toEqual([]);

    // Not the driver: refused, card stays open, nothing merged.
    await expect(
      confirmForceMerge("s-merge", id, "mallory", credential),
    ).rejects.toThrow("Only Ada can answer");
    // No login at all (machine auth, no-auth picker): refused.
    await expect(
      confirmForceMerge("s-merge", id, "", credential),
    ).rejects.toThrow("Only Ada can answer");
    // The driver without a GitHub credential: refused, card stays open.
    await expect(confirmForceMerge("s-merge", id, "ada", null)).rejects.toThrow(
      "Connect your GitHub account",
    );
    expect(calls.merge).toEqual([]);
    expect(pendingForceMerge("s-merge")).not.toBeNull();

    const result = await confirmForceMerge("s-merge", id, "Ada", credential);
    expect(result).toMatchObject({ status: "merged", confirmedBy: "Ada" });
    expect(calls.merge).toEqual([{ sha: HEAD, method: "squash" }]);
    expect((await outcome).result.status).toBe("merged");
    expect(pendingForceMerge("s-merge")).toBeNull();

    // The PR comment says who, why, and what was bypassed.
    expect(calls.comment).toHaveLength(1);
    expect(calls.comment[0]).toContain("@Ada");
    expect(calls.comment[0]).toContain("e2e is down for everyone");
    expect(calls.comment[0]).toContain("Check ci / e2e failing (required)");
    expect(calls.comment[0]).toContain("Approving review required");

    // The audit record carries the confirmer, the bypasses and the reason.
    const merged = calls.audit.find((e) => e.event === "merged")!;
    expect(merged).toMatchObject({
      kind: "pr_force_merge",
      repo: "tellahq/app",
      number: 42,
      head_sha: HEAD,
      confirmed_by: "Ada",
      reason: "e2e is down for everyone",
      bypassed: [
        "Check ci / e2e failing (required)",
        "Approving review required",
      ],
    });
    expect(calls.audit.map((e) => e.event)).toEqual([
      "requested",
      "confirmed",
      "merged",
    ]);
  });

  test("a merge Blob asked for records that Blob asked and the driver approved", async () => {
    const { deps, calls } = fake();
    const outcome = requestForceMerge(
      "s-blob",
      {
        target,
        reason: "e2e is down for everyone",
        driver,
        requestedBy: "Blob",
      },
      undefined,
      deps,
    );
    for (let i = 0; i < 20 && !pendingForceMerge("s-blob"); i++)
      await Promise.resolve();
    const card = pendingForceMerge("s-blob");
    // The driver's own confirmation and token, as for any merge.
    await confirmForceMerge("s-blob", card!.request.id, "Ada", credential);
    await outcome;
    expect(calls.audit[0]).toMatchObject({ event: "requested", actor: "Blob" });
    expect(calls.audit.find((e) => e.event === "merged")).toMatchObject({
      actor: "Blob",
      confirmed_by: "Ada",
      attribution: "Blob asked, Ada approved",
    });
    expect(calls.comment[0]).not.toContain("Blob");
  });

  test("a push after the card was shown aborts the merge", async () => {
    const { deps, calls } = fake({ head: "c".repeat(40) });
    const { outcome, open: card } = await open("s-moved", deps);
    const result = await confirmForceMerge(
      "s-moved",
      card!.request.id,
      "ada",
      credential,
    );
    expect(result).toEqual({
      status: "head_changed",
      expected: HEAD,
      actual: "c".repeat(40),
    });
    expect(calls.merge).toEqual([]);
    expect(calls.comment).toEqual([]);
    expect(formatForceMergeOutcome(await outcome)).toContain(
      "nothing was merged",
    );
    expect(calls.audit.at(-1)).toMatchObject({ event: "head_changed" });
  });

  test("GitHub refusing the pinned SHA (409) also counts as a moved head", async () => {
    const { deps, calls } = fake({
      merge: { ok: false, status: 409, message: "Head branch was modified" },
    });
    const { open: card } = await open("s-409", deps);
    const result = await confirmForceMerge(
      "s-409",
      card!.request.id,
      "ada",
      credential,
    );
    expect(result.status).toBe("head_changed");
    expect(calls.comment).toEqual([]);
  });

  test("cancel does nothing on GitHub", async () => {
    const { deps, calls } = fake();
    const { outcome, open: card } = await open("s-cancel", deps);
    cancelForceMerge("s-cancel", card!.request.id, "Ada");
    expect((await outcome).result).toEqual({ status: "cancelled", by: "Ada" });
    expect(calls.merge).toEqual([]);
    expect(calls.comment).toEqual([]);
    // A late confirm finds no card.
    await expect(
      confirmForceMerge("s-cancel", card!.request.id, "ada", credential),
    ).rejects.toThrow("no longer open");
    expect(calls.merge).toEqual([]);
  });

  test("an unanswered card expires and does nothing", async () => {
    const { deps, calls } = fake();
    const { outcome, open: card } = await open("s-expire", deps, 20);
    expect((await outcome).result).toEqual({ status: "expired" });
    expect(calls.merge).toEqual([]);
    await expect(
      confirmForceMerge("s-expire", card!.request.id, "ada", credential),
    ).rejects.toThrow("no longer open");
    expect(calls.audit.at(-1)).toMatchObject({
      event: "expired",
      bypassed: [
        "Check ci / e2e failing (required)",
        "Approving review required",
      ],
    });
  });

  test("a cancelled tool call closes the card without merging", async () => {
    const { deps, calls } = fake();
    const controller = new AbortController();
    const outcome = requestForceMerge(
      "s-abort",
      { target, reason: "flaky", driver },
      controller.signal,
      deps,
    );
    for (let i = 0; i < 20 && !pendingForceMerge("s-abort"); i++)
      await Promise.resolve();
    controller.abort();
    expect((await outcome).result).toEqual({
      status: "cancelled",
      by: "agent",
    });
    expect(pendingForceMerge("s-abort")).toBeNull();
    expect(calls.merge).toEqual([]);
  });

  test("GitHub refusing the bypass names what is missing", async () => {
    const { deps, calls } = fake({
      merge: {
        ok: false,
        status: 405,
        message: 'Required status check "ci / e2e" is expected.',
      },
    });
    const { outcome, open: card } = await open("s-405", deps);
    const result = await confirmForceMerge(
      "s-405",
      card!.request.id,
      "ada",
      credential,
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.error).toContain(
      "@ada is not allowed to bypass the required status checks on main",
    );
    expect(calls.comment).toEqual([]);
    expect((await outcome).result.status).toBe("refused");
    expect(calls.audit.at(-1)).toMatchObject({ event: "refused" });
  });

  test("refuses what a force merge cannot skip, before any card", async () => {
    for (const [src, msg] of [
      [{ isDraft: true }, "is a draft"],
      [{ mergeable: "CONFLICTING" as const }, "merge conflicts"],
      [{ state: "MERGED" as const }, "already merged"],
      [{ state: "CLOSED" as const }, "is closed"],
    ] as const) {
      const { deps } = fake({ src });
      await expect(
        requestForceMerge(
          "s-refuse",
          { target, reason: "why", driver },
          undefined,
          deps,
        ),
      ).rejects.toThrow(msg);
      expect(pendingForceMerge("s-refuse")).toBeNull();
    }
  });

  test("needs a reason, a driver, and one card at a time", async () => {
    const { deps } = fake();
    await expect(
      requestForceMerge(
        "s-x",
        { target, reason: "  ", driver },
        undefined,
        deps,
      ),
    ).rejects.toThrow("Give a reason");
    await expect(
      requestForceMerge(
        "s-x",
        { target, reason: "r", driver: { name: "", login: "" } },
        undefined,
        deps,
      ),
    ).rejects.toThrow("signed-in teammate");
    const { outcome, open: card } = await open("s-one", deps);
    await expect(
      requestForceMerge(
        "s-one",
        { target, reason: "r", driver },
        undefined,
        deps,
      ),
    ).rejects.toThrow("already has a force merge");
    cancelForceMerge("s-one", card!.request.id, "Ada");
    await outcome;
  });
});

describe("force merge helpers", () => {
  test("lists pending, missing and behind as bypasses", () => {
    const v = assessPrMergeReadiness(
      source({
        reviewDecision: "CHANGES_REQUESTED",
        latestReviews: [{ login: "bob", state: "CHANGES_REQUESTED" }],
        mergeStateStatus: "BEHIND",
        checks: [{ name: "lint", status: "IN_PROGRESS", conclusion: "" }],
        rules: {
          requiredChecks: ["deploy-preview"],
          requiredApprovals: 0,
          strictUpToDate: true,
        },
      }),
    );
    expect(forceMergeBypasses(v)).toEqual([
      { kind: "check", name: "lint", state: "pending", required: false },
      {
        kind: "check",
        name: "deploy-preview",
        state: "missing",
        required: true,
      },
      { kind: "review", detail: "Changes requested by bob" },
      { kind: "branch", detail: "Branch is behind main" },
    ]);
  });

  test("uses the repository's allowed merge method", () => {
    expect(pickMergeMethod(["merge", "squash"])).toBe("squash");
    expect(pickMergeMethod(["rebase"])).toBe("rebase");
    expect(pickMergeMethod([])).toBe("squash");
    expect(() => pickMergeMethod(["squash"], "merge")).toThrow(
      "does not allow merge merges",
    );
  });

  test("parses gh api errors and explains permission refusals", () => {
    expect(
      parseGhApiError(
        "gh: At least 1 approving review is required by reviewers with write access. (HTTP 405)\n",
      ),
    ).toEqual({
      status: 405,
      message:
        "At least 1 approving review is required by reviewers with write access.",
    });
    const req = {
      ghRepo: "tellahq/app",
      base: "main",
      method: "squash" as const,
    };
    expect(
      explainMergeRefusal(
        { status: 405, message: "At least 1 approving review is required" },
        req,
        "ada",
      ),
    ).toContain("not allowed to bypass the required reviews on main");
    expect(
      explainMergeRefusal(
        { status: 403, message: "Resource not accessible by integration" },
        req,
        "ada",
      ),
    ).toContain("@ada cannot merge in tellahq/app");
  });
});
