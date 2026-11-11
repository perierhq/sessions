/**
 * Lead approvals: step and condition validation, every transition of the
 * state machine, the compare-and-set claim under concurrent attempts,
 * expiry, the per-project cap and voiding. Runs on the in-memory kernel
 * store with a fake clock; one test swaps in a catalog that forces
 * compare-and-set conflicts.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "../session-kernel";

const root = mkdtempSync(join(tmpdir(), "lead-approvals-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Approvals = typeof import("./approvals");
let A: Approvals;

beforeAll(async () => {
  A = await import("./approvals");
});

afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let clock = Date.parse("2026-07-01T12:00:00Z");
let ids = 0;
let restore: () => void = () => {};

beforeEach(() => {
  rmSync(join(root, ".opensession-lead-approvals"), {
    recursive: true,
    force: true,
  });
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  clock = Date.parse("2026-07-01T12:00:00Z");
  ids = 0;
  restore = A.__setLeadApprovalsDepsForTest({
    now: () => clock,
    newId: () => `lp-${++ids}`,
  });
});

afterEach(() => {
  restore();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

const merge = {
  kind: "merge-pr",
  ghRepo: "acme/api",
  number: 42,
  headSha: SHA,
  method: "squash",
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    project: "acme",
    category: "fix-verified",
    subject: "PR 42",
    itemId: "si-1",
    itemRevision: 1000,
    steps: [merge],
    ...overrides,
  } as import("./approvals").ActProposalInput;
}

async function propose(overrides: Record<string, unknown> = {}) {
  const result = await A.recordProposal(input(overrides));
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function approved(
  overrides: Record<string, unknown> = {},
  approval: Partial<import("./approvals").ApproveInput> = {},
) {
  const proposal = await propose(overrides);
  const result = await A.approve({
    project: proposal.project,
    proposalId: proposal.id,
    approvedBy: "Ada",
    login: "ada-example",
    itemRevision: proposal.itemRevision,
    ...approval,
  });
  if (!result.ok) throw new Error(result.error);
  return { proposal, approval: result.approval };
}

describe("validation", () => {
  test("accepts every step kind", () => {
    const steps = [
      merge,
      { kind: "autofix-pr", ghRepo: "acme/api", number: 7, headSha: SHA },
      { kind: "spawn-worker", prompt: "Fix the flaky test.\nThen open a PR." },
      {
        kind: "signal-patch",
        signalId: "sig-0001",
        before: { rule: { kind: "consecutive", failures: 2 }, dependsOn: null },
        after: {
          rule: { kind: "consecutive", failures: 4 },
          dependsOn: ["sig-0002"],
        },
      },
      { kind: "support-send", conversationId: "sc_0001", draftId: "d-1" },
    ];
    const result = A.validateLeadSteps(steps);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.map((s) => s.kind)).toEqual([
        "merge-pr",
        "autofix-pr",
        "spawn-worker",
        "signal-patch",
        "support-send",
      ]);
  });

  test.each([
    ["owner only", { ...merge, ghRepo: "acme" }],
    ["dot repo", { ...merge, ghRepo: "acme/.." }],
    ["three parts", { ...merge, ghRepo: "acme/api/x" }],
    ["leading hyphen", { ...merge, ghRepo: "-acme/api" }],
    ["zero", { ...merge, number: 0 }],
    ["negative", { ...merge, number: -3 }],
    ["fraction", { ...merge, number: 1.5 }],
    ["string number", { ...merge, number: "42" }],
    ["short sha", { ...merge, headSha: "abc123" }],
    ["upper sha", { ...merge, headSha: "A".repeat(40) }],
    ["bad method", { ...merge, method: "force" }],
    ["unknown field", { ...merge, token: "x" }],
    ["unknown kind", { kind: "delete-repo" }],
    ["empty prompt", { kind: "spawn-worker", prompt: "  " }],
    ["long prompt", { kind: "spawn-worker", prompt: "x".repeat(4001) }],
    ["control prompt", { kind: "spawn-worker", prompt: "hi\u0007" }],
    ["bidi prompt", { kind: "spawn-worker", prompt: "hi\u202e" }],
    ["line separator prompt", { kind: "spawn-worker", prompt: "a\u2028b" }],
    [
      "paragraph separator prompt",
      { kind: "spawn-worker", prompt: "a\u2029b" },
    ],
    ["zero-width prompt", { kind: "spawn-worker", prompt: "a\u200bb" }],
    ["word joiner prompt", { kind: "spawn-worker", prompt: "a\u2060b" }],
    ["byte order mark prompt", { kind: "spawn-worker", prompt: "a\ufeffb" }],
    [
      "bad signal id",
      {
        kind: "signal-patch",
        signalId: "../x",
        before: { provider: null },
        after: { provider: true },
      },
    ],
    [
      "empty after",
      { kind: "signal-patch", signalId: "sig-1", before: {}, after: {} },
    ],
    [
      "before misses a field",
      {
        kind: "signal-patch",
        signalId: "sig-1",
        before: {},
        after: { provider: true },
      },
    ],
    [
      "invalid rule",
      {
        kind: "signal-patch",
        signalId: "sig-1",
        before: { rule: { kind: "consecutive", failures: 2 } },
        after: { rule: { kind: "consecutive", failures: 0 } },
      },
    ],
    [
      "field outside the patch",
      {
        kind: "signal-patch",
        signalId: "sig-1",
        before: { name: "a" },
        after: { name: "b" },
      },
    ],
    [
      "bad conversation",
      { kind: "support-send", conversationId: "", draftId: "d-1" },
    ],
  ])("rejects a step: %s", (_name, step) => {
    expect(A.validateLeadStep(step).ok).toBe(false);
  });

  test("bounds the step list", () => {
    expect(A.validateLeadSteps([]).ok).toBe(false);
    expect(A.validateLeadSteps(Array(11).fill(merge)).ok).toBe(false);
    expect(A.validateLeadSteps(Array(10).fill(merge)).ok).toBe(true);
    const bad = A.validateLeadSteps([merge, { ...merge, number: 0 }]);
    expect(bad.ok ? "" : bad.error).toStartWith("step 2:");
  });

  test("validates conditions", () => {
    expect(
      A.validateLeadCondition({
        kind: "pr-merged",
        ghRepo: "acme/api",
        number: 1,
      }).ok,
    ).toBe(true);
    expect(
      A.validateLeadCondition({
        kind: "checks-green",
        ghRepo: "acme/api",
        number: 1,
        headSha: SHA,
      }).ok,
    ).toBe(true);
    expect(
      A.validateLeadCondition({ kind: "incident-resolved", id: "inc-1" }).ok,
    ).toBe(true);
    for (const bad of [
      { kind: "pr-merged", ghRepo: "acme", number: 1 },
      { kind: "checks-green", ghRepo: "acme/api", number: 1 },
      { kind: "incident-resolved", id: "" },
      { kind: "incident-resolved", id: "inc-1", extra: true },
      { kind: "eventually" },
      null,
    ])
      expect(A.validateLeadCondition(bad).ok).toBe(false);
  });

  test("validates the proposal fields", () => {
    expect(A.validateProposalInput(input()).ok).toBe(true);
    for (const bad of [
      input({ project: "" }),
      input({ project: "a/b" }),
      input({ category: "launch-rockets" }),
      input({ subject: "" }),
      input({ subject: "two\nlines" }),
      input({ itemId: "" }),
      input({ itemRevision: -1 }),
      input({ steps: [] }),
      input({ condition: { kind: "pr-merged", ghRepo: "acme" } }),
      input({ expiresAt: -1 }),
      { ...input(), extra: 1 },
    ])
      expect(A.validateProposalInput(bad).ok).toBe(false);
  });

  test("a step must fit the proposal's category", () => {
    expect(
      A.validateProposalInput(input({ category: "signal-rule-change" })),
    ).toEqual({
      ok: false,
      error: "step 1: merge-pr does not fit signal-rule-change",
    });
    for (const [kind, categories] of Object.entries(A.STEP_CATEGORIES))
      for (const category of categories)
        expect(
          A.stepFitsCategory(
            kind as import("./approvals").LeadStepKind,
            category,
          ),
        ).toBe(true);
    expect(A.stepFitsCategory("autofix-pr", "fix-verified")).toBe(false);
  });

  test("a proposal may carry the approval's condition and expiry", async () => {
    const condition = { kind: "pr-merged", ghRepo: "acme/api", number: 41 };
    const proposal = await propose({ condition, expiresAt: clock + DAY });
    expect(proposal).toMatchObject({ condition, expiresAt: clock + DAY });
    expect((await A.getRecord("acme", proposal.id))?.proposal).toEqual(
      proposal,
    );
    for (const expiresAt of [clock, clock + 30 * DAY + 1])
      expect((await A.recordProposal(input({ expiresAt }))).ok).toBe(false);
  });

  test("approval expiry: 7 days by default, at most 30", () => {
    const now = 1_000_000;
    expect(A.approvalExpiry(now)).toEqual({ ok: true, value: now + 7 * DAY });
    expect(A.approvalExpiry(now, now + 30 * DAY).ok).toBe(true);
    expect(A.approvalExpiry(now, now + 30 * DAY + 1).ok).toBe(false);
    expect(A.approvalExpiry(now, now).ok).toBe(false);
    expect(A.approvalExpiry(now, 1.5).ok).toBe(false);
  });
});

describe("transitions", () => {
  const base = {
    proposalId: "lp-1",
    approvedBy: "Ada",
    login: "ada-example",
    at: 0,
    expiresAt: 1000,
    updatedAt: 0,
  };

  for (const from of [
    "waiting",
    "ready",
    "applying",
    "applied",
    "failed",
    "partial",
    "void",
  ] as const)
    for (const to of [
      "waiting",
      "ready",
      "applying",
      "applied",
      "failed",
      "partial",
      "void",
    ] as const)
      test(`${from} -> ${to}`, () => {
        const approval = { ...base, state: from, claimId: "c-1" };
        const result = A.transitionApproval(approval, to, 10, {
          claimId: "c-1",
          reason: "because",
        });
        const legal = A.LEAD_APPROVAL_TRANSITIONS[from].includes(to);
        expect(A.canTransition(from, to)).toBe(legal);
        // applying is entered by a claim only.
        expect(result.ok).toBe(legal && to !== "applying");
        if (result.ok) {
          expect(result.approval.state).toBe(to);
          expect(result.approval.reason).toBe("because");
        } else expect(result.error).toBe("illegal");
      });

  test("the table", () => {
    expect(A.LEAD_APPROVAL_TRANSITIONS).toEqual({
      waiting: ["ready", "void"],
      ready: ["applying", "void"],
      applying: ["applied", "failed", "partial"],
      applied: [],
      failed: [],
      partial: [],
      void: [],
    });
  });

  test("leaving applying takes the claimant", () => {
    const approval = { ...base, state: "applying" as const, claimId: "c-1" };
    expect(A.transitionApproval(approval, "applied", 10)).toEqual({
      ok: false,
      error: "not-claimant",
    });
    expect(
      A.transitionApproval(approval, "applied", 10, { claimId: "c-2" }),
    ).toEqual({ ok: false, error: "not-claimant" });
  });

  test("an expired approval can only become void", () => {
    const approval = { ...base, state: "waiting" as const };
    expect(A.transitionApproval(approval, "ready", 1000)).toEqual({
      ok: false,
      error: "expired",
    });
    expect(A.transitionApproval(approval, "void", 1000).ok).toBe(true);
  });

  test("through the store: waiting -> ready -> applying -> applied", async () => {
    const { proposal } = await approved(
      {},
      { condition: { kind: "pr-merged", ghRepo: "acme/api", number: 41 } },
    );
    const ready = await A.transition("acme", proposal.id, "ready");
    expect(ready.ok && ready.approval.state).toBe("ready");
    const claim = await A.claimApply("acme", proposal.id, "run-1");
    expect(claim.ok && claim.approval.state).toBe("applying");
    expect(await A.transition("acme", proposal.id, "applied")).toEqual({
      ok: false,
      error: "not-claimant",
    });
    const done = await A.transition("acme", proposal.id, "applied", {
      claimId: "run-1",
    });
    expect(done.ok && done.approval.state).toBe("applied");
    const [record] = await A.listForProject("acme");
    expect(record?.approval?.state).toBe("applied");
    expect(A.isSettled(record!)).toBe(true);
  });

  test("through the store: illegal moves change nothing", async () => {
    const { proposal } = await approved();
    expect(await A.transition("acme", proposal.id, "waiting")).toEqual({
      ok: false,
      error: "illegal",
    });
    expect(await A.transition("acme", proposal.id, "applying")).toEqual({
      ok: false,
      error: "illegal",
    });
    expect(await A.transition("acme", proposal.id, "applied")).toEqual({
      ok: false,
      error: "illegal",
    });
    expect((await A.getRecord("acme", proposal.id))?.approval?.state).toBe(
      "ready",
    );
    expect(await A.transition("acme", "lp-missing", "void")).toEqual({
      ok: false,
      error: "not-found",
    });
    const bare = await propose({ itemId: "si-2" });
    expect(await A.transition("acme", bare.id, "ready")).toEqual({
      ok: false,
      error: "no-approval",
    });
  });

  test("through the store: void marks the proposal too", async () => {
    const { proposal } = await approved();
    const result = await A.transition("acme", proposal.id, "void", {
      reason: "head moved",
    });
    expect(result.ok).toBe(true);
    const record = await A.getRecord("acme", proposal.id);
    expect(record?.approval?.state).toBe("void");
    expect(record?.proposal.voidReason).toBe("head moved");
    expect(await A.transition("acme", proposal.id, "ready")).toEqual({
      ok: false,
      error: "illegal",
    });
  });

  test("failed and partial keep their reason", async () => {
    for (const [itemId, state] of [
      ["si-f", "failed"],
      ["si-p", "partial"],
    ] as const) {
      const { proposal } = await approved({ itemId });
      await A.claimApply("acme", proposal.id, "run-1");
      const result = await A.transition("acme", proposal.id, state, {
        claimId: "run-1",
        reason: "step 2 failed",
      });
      expect(result.ok && result.approval).toMatchObject({
        state,
        reason: "step 2 failed",
      });
    }
  });
});

describe("approve", () => {
  test("ready without a condition, waiting with one", async () => {
    expect((await approved()).approval).toMatchObject({
      state: "ready",
      approvedBy: "Ada",
      login: "ada-example",
      at: clock,
      expiresAt: clock + 7 * DAY,
    });
    const waiting = await approved(
      { itemId: "si-2" },
      {
        condition: {
          kind: "checks-green",
          ghRepo: "acme/api",
          number: 42,
          headSha: SHA,
        },
      },
    );
    expect(waiting.approval.state).toBe("waiting");
    expect(waiting.approval.condition?.kind).toBe("checks-green");
  });

  test("is idempotent while live, refuses stale, invalid and unknown", async () => {
    const { proposal, approval } = await approved();
    const again = await A.approve({
      project: "acme",
      proposalId: proposal.id,
      approvedBy: "Ada",
      login: "ada-example",
      itemRevision: proposal.itemRevision,
    });
    expect(again).toEqual({ ok: true, approval, created: false });

    const other = await propose({ itemId: "si-2", itemRevision: 5 });
    const base = {
      project: "acme",
      proposalId: other.id,
      approvedBy: "Ada",
      login: "ada-example",
      itemRevision: 5,
    };
    expect(await A.approve({ ...base, itemRevision: 4 })).toEqual({
      ok: false,
      error: "stale",
    });
    // No revision: the owner's answer can't be tied to what they saw.
    const { itemRevision: _, ...noRevision } = base;
    expect(
      await A.approve(noRevision as import("./approvals").ApproveInput),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(await A.getRecord("acme", other.id)).not.toHaveProperty("approval");
    expect((await A.approve({ ...base, login: "-bad" })).ok).toBe(false);
    expect((await A.approve({ ...base, expiresAt: clock + 31 * DAY })).ok).toBe(
      false,
    );
    expect(
      (await A.approve({ ...base, condition: { kind: "pr-merged" } })).ok,
    ).toBe(false);
    expect(await A.approve({ ...base, proposalId: "lp-missing" })).toEqual({
      ok: false,
      error: "not-found",
    });
    expect((await A.approve({ ...base, itemRevision: 5 })).ok).toBe(true);
  });

  test("a new proposal for the same item supersedes the old one", async () => {
    const first = await approved();
    const second = await propose({ itemRevision: 2000 });
    const old = await A.getRecord("acme", first.proposal.id);
    expect(old?.proposal.voidReason).toBe("superseded");
    expect(old?.approval?.state).toBe("void");
    expect(
      await A.approve({
        project: "acme",
        proposalId: first.proposal.id,
        approvedBy: "Ada",
        login: "ada-example",
        itemRevision: first.proposal.itemRevision,
      }),
    ).toEqual({ ok: false, error: "voided" });
    expect((await A.listForProject("acme"))[0]?.proposal.id).toBe(second.id);
  });
});

describe("proposalForItem", () => {
  test("the item's standing proposal, unapproved or live, never a voided one", async () => {
    expect(await A.proposalForItem("acme", "si-1")).toBeUndefined();
    const first = await propose();
    expect((await A.proposalForItem("acme", "si-1"))?.proposal.id).toBe(
      first.id,
    );
    const second = await propose({ itemRevision: 2000 });
    expect((await A.proposalForItem("acme", "si-1"))?.proposal.id).toBe(
      second.id,
    );
    await A.approve({
      project: "acme",
      proposalId: second.id,
      approvedBy: "Ada",
      login: "ada-example",
      itemRevision: second.itemRevision,
    });
    expect((await A.proposalForItem("acme", "si-1"))?.approval?.state).toBe(
      "ready",
    );
    await A.voidFor("acme", () => true, "test");
    expect(await A.proposalForItem("acme", "si-1")).toBeUndefined();
    expect(await A.proposalForItem("acme", "si-2")).toBeUndefined();
    expect(await A.proposalForItem("other", "si-1")).toBeUndefined();
  });
});

describe("claimApply", () => {
  test("idempotent for the claimant, refused for anyone else", async () => {
    const { proposal } = await approved();
    const first = await A.claimApply("acme", proposal.id, "run-1");
    expect(first.ok && first.already).toBe(false);
    const again = await A.claimApply("acme", proposal.id, "run-1");
    expect(again.ok && again.already).toBe(true);
    expect(await A.claimApply("acme", proposal.id, "run-2")).toEqual({
      ok: false,
      error: "busy",
    });
  });

  test("refuses a waiting approval until it is ready", async () => {
    const { proposal } = await approved(
      {},
      { condition: { kind: "incident-resolved", id: "inc-1" } },
    );
    expect(await A.claimApply("acme", proposal.id, "run-1")).toEqual({
      ok: false,
      error: "not-ready",
    });
    expect((await A.getRecord("acme", proposal.id))?.approval?.state).toBe(
      "waiting",
    );
    await A.transition("acme", proposal.id, "ready");
    const claim = await A.claimApply("acme", proposal.id, "run-1");
    expect(claim.ok && claim.approval.state).toBe("applying");
  });

  test("refuses missing, unapproved, void, expired and done", async () => {
    expect(await A.claimApply("acme", "lp-x", "run-1")).toEqual({
      ok: false,
      error: "not-found",
    });
    const bare = await propose({ itemId: "si-bare" });
    expect(await A.claimApply("acme", bare.id, "run-1")).toEqual({
      ok: false,
      error: "no-approval",
    });

    const voided = await approved({ itemId: "si-void" });
    await A.transition("acme", voided.proposal.id, "void");
    expect(await A.claimApply("acme", voided.proposal.id, "run-1")).toEqual({
      ok: false,
      error: "voided",
    });

    const expiring = await approved({ itemId: "si-exp" });
    clock += 7 * DAY;
    expect(await A.claimApply("acme", expiring.proposal.id, "run-1")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(
      (await A.getRecord("acme", expiring.proposal.id))?.proposal.voidReason,
    ).toBe("expired");
    clock -= 7 * DAY;

    const done = await approved({ itemId: "si-done" });
    await A.claimApply("acme", done.proposal.id, "run-1");
    await A.transition("acme", done.proposal.id, "applied", {
      claimId: "run-1",
    });
    expect(await A.claimApply("acme", done.proposal.id, "run-1")).toEqual({
      ok: false,
      error: "settled",
    });
  });

  test("an expired approval is voided by the claim", () => {
    const record = {
      proposal: {
        id: "lp-1",
        project: "acme",
        category: "fix-verified" as const,
        subject: "PR 42",
        itemId: "si-1",
        itemRevision: 1,
        steps: [],
        createdAt: 0,
      },
      approval: {
        proposalId: "lp-1",
        approvedBy: "Ada",
        login: "ada-example",
        at: 0,
        expiresAt: 100,
        state: "ready" as const,
        updatedAt: 0,
      },
    };
    expect(A.claimApproval(record, "run-1", 100)).toEqual({
      ok: false,
      error: "expired",
    });
  });

  test("one winner among concurrent claims on the catalog", async () => {
    const { proposal } = await approved();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        A.claimApply("acme", proposal.id, `run-${i}`),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "busy")).toHaveLength(7);
    const record = await A.getRecord("acme", proposal.id);
    expect(record?.approval?.claimId).toBe(
      winners[0]!.ok ? winners[0]!.approval.claimId : "",
    );
  });

  test("one winner when every claim reads the same revision", async () => {
    // A catalog with no per-key lock: every update reads, yields, then puts
    // with the revision it read, so concurrent claims conflict and rerun.
    const docs = new Map<string, { rev: number; value: string }>();
    let conflicts = 0;
    const racy = {
      async get(key: string) {
        const row = docs.get(key);
        return row ? JSON.parse(row.value) : null;
      },
      async update<T>(key: string, mutate: (value: unknown) => T | null) {
        let current = docs.get(key);
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (;;) {
          const next = mutate(current ? JSON.parse(current.value) : null);
          const encoded = JSON.stringify(next);
          const committed = docs.get(key);
          if ((committed?.rev ?? 0) !== (current?.rev ?? 0)) {
            conflicts++;
            current = committed;
            continue;
          }
          if (current?.value !== encoded)
            docs.set(key, { rev: (current?.rev ?? 0) + 1, value: encoded });
          return next;
        }
      },
      async list() {
        return [...docs].map(([key, row]) => ({
          key,
          value: JSON.parse(row.value),
        }));
      },
    };
    restore();
    restore = A.__setLeadApprovalsDepsForTest({
      now: () => clock,
      newId: () => `lp-${++ids}`,
      documents: () => racy,
    });
    const { proposal } = await approved();
    conflicts = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        A.claimApply("acme", proposal.id, `run-${i}`),
      ),
    );
    expect(conflicts).toBeGreaterThan(0);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "busy")).toHaveLength(4);
  });
});

describe("claimAlone", () => {
  test("an unapproved proposal is claimed once, by the rules, with no login", async () => {
    const proposal = await propose();
    const results = await Promise.all(
      ["la-1", "la-2", "la-3"].map((claimId) =>
        A.claimAlone("acme", proposal.id, claimId, "Alone: fixes"),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const record = await A.getRecord("acme", proposal.id);
    expect(record?.approval).toMatchObject({
      state: "applying",
      approvedBy: A.LEAD_RULES_APPROVER,
      rule: "Alone: fixes",
    });
    expect(record?.approval?.login).toBeUndefined();
    const claimId = record!.approval!.claimId!;
    expect(
      await A.transition("acme", proposal.id, "applied", { claimId }),
    ).toMatchObject({ ok: true });
    expect(
      await A.claimAlone("acme", proposal.id, "la-4", "Alone: fixes"),
    ).toEqual({ ok: false, error: "settled" });
  });

  test("refused once the owner approved, and for voided or expired proposals", async () => {
    const { proposal } = await approved({ itemId: "si-a" });
    expect(await A.claimAlone("acme", proposal.id, "la-1", "r")).toEqual({
      ok: false,
      error: "not-ready",
    });
    const old = await propose({ itemId: "si-b", expiresAt: clock + DAY });
    clock += DAY;
    expect(await A.claimAlone("acme", old.id, "la-2", "r")).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await A.claimAlone("acme", old.id, "la-3", "r")).toEqual({
      ok: false,
      error: "voided",
    });
    expect((await A.getRecord("acme", old.id))?.proposal.voidReason).toBe(
      "expired",
    );
  });

  test("an approval by the rules that names a login doesn't read back", async () => {
    await propose();
    const { catalogDocuments } = await import("../catalog-documents");
    const proposal = {
      id: "lp-rules",
      ...input({ itemId: "si-rules" }),
      createdAt: clock,
    };
    const approval = {
      proposalId: "lp-rules",
      approvedBy: A.LEAD_RULES_APPROVER,
      rule: "Alone: fixes",
      at: clock,
      expiresAt: clock + DAY,
      state: "applying",
      updatedAt: clock,
    };
    await catalogDocuments(A.LEAD_APPROVALS_NAMESPACE).update(
      "acme",
      (current) => {
        const doc = current as { records: unknown[] };
        return {
          ...doc,
          records: [
            { proposal, approval },
            {
              proposal: { ...proposal, id: "lp-both", itemId: "si-both" },
              approval: { ...approval, proposalId: "lp-both", login: "ada" },
            },
            ...doc.records,
          ],
        };
      },
    );
    const ids = (await A.listForProject("acme")).map((r) => r.proposal.id);
    expect(ids).toContain("lp-rules");
    expect(ids).not.toContain("lp-both");
  });
});

describe("expiry", () => {
  test("approvals after 7 days, unapproved proposals after 30", async () => {
    const ready = await approved({ itemId: "si-ready" });
    const applying = await approved({ itemId: "si-applying" });
    await A.claimApply("acme", applying.proposal.id, "run-1");
    const bare = await propose({ itemId: "si-bare" });
    await approved({ project: "acme-two", itemId: "si-two" });

    expect(await A.expire(clock + 7 * DAY - 1)).toBe(0);
    expect(await A.expire(clock + 7 * DAY)).toBe(2);
    const view = new Map(
      (await A.listForProject("acme")).map((r) => [r.proposal.id, r]),
    );
    expect(view.get(ready.proposal.id)?.approval?.state).toBe("void");
    expect(view.get(ready.proposal.id)?.proposal.voidReason).toBe("expired");
    expect(view.get(applying.proposal.id)?.approval?.state).toBe("applying");
    expect(view.get(bare.id)?.proposal.voidedAt).toBeUndefined();
    expect((await A.listForProject("acme-two"))[0]?.approval?.state).toBe(
      "void",
    );

    expect(await A.expire(clock + 30 * DAY)).toBe(1);
    expect((await A.getRecord("acme", bare.id))?.proposal.voidReason).toBe(
      "expired",
    );
    expect(
      (await A.getRecord("acme", applying.proposal.id))?.approval?.state,
    ).toBe("applying");
  });

  test("listing applies expiry to the view", async () => {
    const { proposal } = await approved();
    clock += 8 * DAY;
    expect((await A.getRecord("acme", proposal.id))?.approval?.state).toBe(
      "void",
    );
  });

  test("a custom expiry is honoured", async () => {
    const { proposal } = await approved({}, { expiresAt: clock + DAY });
    clock += DAY;
    expect(await A.transition("acme", proposal.id, "applied")).toEqual({
      ok: false,
      error: "illegal",
    });
    expect((await A.getRecord("acme", proposal.id))?.approval?.state).toBe(
      "void",
    );
  });
});

describe("proposal expiry", () => {
  test("an unapproved proposal is void once its expiry passes", async () => {
    const proposal = await propose({ expiresAt: clock + DAY });
    clock += DAY;
    const record = await A.getRecord("acme", proposal.id);
    expect(record?.proposal.voidReason).toBe("expired");
  });
});

describe("cap", () => {
  const record = (id: string, settled: boolean) => ({
    proposal: {
      id,
      project: "acme",
      category: "fix-verified" as const,
      subject: id,
      itemId: id,
      itemRevision: 1,
      steps: [],
      createdAt: 0,
      ...(settled ? { voidedAt: 1, voidReason: "x" } : {}),
    },
  });

  test("drops settled records oldest first, never live ones", () => {
    // Newest first: d is newest, a oldest.
    const records = [
      record("d", true),
      record("c", false),
      record("b", true),
      record("a", true),
    ];
    const pruned = A.pruneRecords(records, 3);
    expect(pruned.fits).toBe(true);
    expect(pruned.records.map((r) => r.proposal.id)).toEqual(["d", "c", "b"]);
    const all = A.pruneRecords(records, 1);
    expect(all.records.map((r) => r.proposal.id)).toEqual(["c"]);
    const live = A.pruneRecords([record("b", false), record("a", false)], 1);
    expect(live.fits).toBe(false);
    expect(live.records).toHaveLength(2);
  });

  test("drops by bytes too", () => {
    const records = [record("b", true), record("a", true)];
    const one = Buffer.byteLength(JSON.stringify(records[0])) + 1;
    const pruned = A.pruneRecords(records, 10, 1024 + one + 10);
    expect(pruned.records.map((r) => r.proposal.id)).toEqual(["b"]);
  });

  test("the store keeps at most MAX_RECORDS", async () => {
    for (let i = 0; i < A.MAX_RECORDS + 5; i++)
      await propose({ itemRevision: i });
    const records = await A.listForProject("acme");
    expect(records).toHaveLength(A.MAX_RECORDS);
    expect(records[0]?.proposal.itemRevision).toBe(A.MAX_RECORDS + 4);
    expect(records.filter((r) => !A.isSettled(r))).toHaveLength(1);
  });

  test("refuses a proposal when every record is still to run", async () => {
    for (let i = 0; i < A.MAX_RECORDS; i++)
      await propose({ itemId: `si-${i}` });
    const refused = await A.recordProposal(input({ itemId: "si-new" }));
    expect(refused.ok).toBe(false);
    expect(await A.listForProject("acme")).toHaveLength(A.MAX_RECORDS);
  });
});

describe("voidFor", () => {
  test("voids what the predicate picks and has not started", async () => {
    const ready = await approved({ itemId: "si-1" });
    const waiting = await approved(
      { itemId: "si-2" },
      { condition: { kind: "pr-merged", ghRepo: "acme/api", number: 1 } },
    );
    const bare = await propose({ itemId: "si-3" });
    const applying = await approved({ itemId: "si-4" });
    await A.claimApply("acme", applying.proposal.id, "run-1");
    const other = await propose({
      itemId: "si-5",
      steps: [{ ...merge, headSha: OTHER_SHA }],
    });

    const headMoved = (r: import("./approvals").LeadRecord) =>
      r.proposal.steps.some((s) => s.kind === "merge-pr" && s.headSha === SHA);
    const voided = await A.voidFor("acme", headMoved, "PR head moved");
    expect(voided.sort()).toEqual(
      [ready.proposal.id, waiting.proposal.id, bare.id].sort(),
    );
    const view = new Map(
      (await A.listForProject("acme")).map((r) => [r.proposal.id, r]),
    );
    expect(view.get(ready.proposal.id)?.approval).toMatchObject({
      state: "void",
      reason: "PR head moved",
    });
    expect(view.get(waiting.proposal.id)?.approval?.state).toBe("void");
    expect(view.get(bare.id)?.proposal.voidReason).toBe("PR head moved");
    expect(view.get(applying.proposal.id)?.approval?.state).toBe("applying");
    expect(view.get(other.id)?.proposal.voidedAt).toBeUndefined();

    expect(await A.voidFor("acme", headMoved, "again")).toEqual([]);
    expect(await A.claimApply("acme", ready.proposal.id, "run-2")).toEqual({
      ok: false,
      error: "voided",
    });
  });

  test("ignores an invalid project", async () => {
    expect(await A.voidFor("", () => true, "x")).toEqual([]);
    expect(await A.listForProject("a/b")).toEqual([]);
  });
});

describe("settleInterrupted", () => {
  test("an apply older than the bound becomes partial, never re-runs", async () => {
    const { proposal } = await approved();
    await A.claimApply("acme", proposal.id, "run-1");
    const claimedAt = clock;
    expect(
      await A.settleInterrupted("acme", claimedAt + A.STALE_APPLY_MS - 1),
    ).toEqual([]);
    expect((await A.getRecord("acme", proposal.id))?.approval?.state).toBe(
      "applying",
    );
    expect(
      await A.settleInterrupted(" acme ", claimedAt + A.STALE_APPLY_MS),
    ).toEqual([proposal.id]);
    const record = await A.getRecord("acme", proposal.id);
    expect(record?.approval?.state).toBe("partial");
    expect(record?.approval?.reason).toBe("interrupted");
    expect(await A.claimApply("acme", proposal.id, "run-1")).toEqual({
      ok: false,
      error: "settled",
    });
    expect(await A.claimApply("acme", proposal.id, "run-2")).toEqual({
      ok: false,
      error: "settled",
    });
    // The late claimant cannot finish it either.
    expect(
      await A.transition("acme", proposal.id, "applied", { claimId: "run-1" }),
    ).toEqual({ ok: false, error: "illegal" });
  });

  test("leaves ready, waiting and settled records alone", async () => {
    const ready = await approved({ itemId: "si-ready" });
    const waiting = await approved(
      { itemId: "si-wait" },
      { condition: { kind: "incident-resolved", id: "inc-1" } },
    );
    expect(await A.settleInterrupted("acme", clock + 6 * DAY)).toEqual([]);
    expect(
      (await A.getRecord("acme", ready.proposal.id))?.approval?.state,
    ).toBe("ready");
    expect(
      (await A.getRecord("acme", waiting.proposal.id))?.approval?.state,
    ).toBe("waiting");
    expect(await A.settleInterrupted("a/b")).toEqual([]);
  });
});

describe("writes", () => {
  test("nothing is written for a missing project or a refused change", async () => {
    const { catalogDocuments, catalogNamespaceWriteCount } =
      await import("../catalog-documents");
    const writes = () => catalogNamespaceWriteCount(A.LEAD_APPROVALS_NAMESPACE);
    const before = writes();
    expect(await A.transition("ghost", "lp-x", "ready")).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(await A.claimApply("ghost", "lp-x", "run-1")).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(await A.voidFor("ghost", () => true, "x")).toEqual([]);
    expect(await A.settleInterrupted("ghost")).toEqual([]);
    expect(
      await A.approve({
        project: "ghost",
        proposalId: "lp-x",
        approvedBy: "Ada",
        login: "ada-example",
        itemRevision: 1,
      }),
    ).toEqual({ ok: false, error: "not-found" });
    expect(await A.expire()).toBe(0);
    expect(writes()).toBe(before);
    expect(
      await catalogDocuments(A.LEAD_APPROVALS_NAMESPACE).get("ghost"),
    ).toBeNull();

    const { proposal } = await approved();
    const after = writes();
    expect(await A.transition("acme", proposal.id, "applied")).toEqual({
      ok: false,
      error: "illegal",
    });
    expect(await A.claimApply("acme", "lp-x", "run-1")).toEqual({
      ok: false,
      error: "not-found",
    });
    await A.claimApply("acme", proposal.id, "run-1");
    const claimed = writes();
    expect(claimed).toBe(after + 1);
    await A.claimApply("acme", proposal.id, "run-1");
    expect(writes()).toBe(claimed);
  });

  test("a padded project name writes to the trimmed key", async () => {
    const { proposal } = await approved();
    const claim = await A.claimApply("  acme ", proposal.id, "run-1");
    expect(claim.ok && claim.approval.state).toBe("applying");
    expect((await A.getRecord("acme", proposal.id))?.approval?.state).toBe(
      "applying",
    );
    const { catalogDocuments } = await import("../catalog-documents");
    const keys = (
      await catalogDocuments(A.LEAD_APPROVALS_NAMESPACE).list()
    ).map((row) => row.key);
    expect(keys).toEqual(["acme"]);
  });
});

describe("storage", () => {
  async function addStored(record: unknown) {
    const { catalogDocuments } = await import("../catalog-documents");
    await catalogDocuments(A.LEAD_APPROVALS_NAMESPACE).update(
      "acme",
      (current) => {
        const doc = current as { records: unknown[] };
        return { ...doc, records: [...doc.records, record] };
      },
    );
  }

  async function storedIds() {
    const { catalogDocuments } = await import("../catalog-documents");
    const doc = (await catalogDocuments(A.LEAD_APPROVALS_NAMESPACE).get(
      "acme",
    )) as { records: Array<{ proposal: { id: string } }> };
    return doc.records.map((record) => record.proposal.id);
  }

  test("keeps a stored record that does not validate, but never lists it", async () => {
    const { proposal } = await approved();
    await addStored({ proposal: { id: "lp-bad", project: "acme" } });
    const records = await A.listForProject("acme");
    expect(records.map((r) => r.proposal.id)).toEqual([proposal.id]);
    await propose({ itemId: "si-2" });
    expect(await storedIds()).toContain("lp-bad");
  });

  test("a stricter validator doesn't drop a ready record, nor run it", async () => {
    await approved();
    // Stored before prompts refused line separators: ready, now invalid.
    await addStored({
      proposal: {
        id: "lp-old",
        project: "acme",
        category: "fix-verified",
        subject: "Old",
        itemId: "si-old",
        itemRevision: 1,
        steps: [{ kind: "spawn-worker", prompt: "a\u2028b" }],
        createdAt: clock,
      },
      approval: {
        proposalId: "lp-old",
        approvedBy: "Ada",
        login: "ada-example",
        at: clock,
        expiresAt: clock + DAY,
        state: "ready",
        updatedAt: clock,
      },
    });
    expect(await A.claimApply("acme", "lp-old", "run-1")).toEqual({
      ok: false,
      error: "not-found",
    });
    await propose({ itemId: "si-2" });
    clock += 2 * DAY;
    await A.expire();
    expect(await storedIds()).toContain("lp-old");
    expect(
      (await A.listForProject("acme")).some((r) => r.proposal.id === "lp-old"),
    ).toBe(false);
  });
});
