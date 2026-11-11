// lead_apply: the order of its checks, conditions re-checked at apply time,
// the claim under concurrent calls, each merge outcome, the signal change's
// before check, partial runs that never re-run, and the identities used.
// Approvals run on the in-memory kernel; GitHub, signals and the inbox are
// fakes, and merges go through the real mergePinnedPr.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PrSnapshot } from "../../shared/incident-response";
import type { Signal } from "../../shared/incidents";
import type { LeadCategory } from "../../shared/project-lead";
import {
  defaultProjectDocument,
  type ProjectSettingsDocument,
} from "../../shared/project-settings";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { type MergeGithub, mergePinnedPr } from "../incidents/response/merge";
import type { SignalWriter } from "../incidents/signal-store";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import {
  type LeadRecord,
  __setLeadApprovalsDepsForTest,
  approve,
  getRecord,
  recordProposal,
} from "./approvals";
import {
  APPROVED_RUNS_ONLY_AT_ACT,
  FORCE_MERGE_LINE,
  type LeadApplyDeps,
  __setLeadApplyDepsForTest,
  applyGate,
  leadApply,
  signalHolds,
} from "./apply";
import type { ConditionResult } from "./conditions";
import { __setLeadAuditForTest } from "./report";

useIncidentTestKernel();

const SHA = "a".repeat(40);
const MOVED = "c".repeat(40);
const NOW = Date.parse("2026-11-10T12:00:00.000Z");

let clock = NOW;
let doc: ProjectSettingsDocument;
let audits: Array<Record<string, unknown>> = [];
let posts: Array<Record<string, unknown>> = [];
let prs: Map<string, PrSnapshot>;
let merges: unknown[][] = [];
let comments: unknown[][] = [];
let mergeResponse:
  | { ok: true; sha: string }
  | { ok: false; status: number; message: string };
let signals: Map<string, Signal>;
let writes: Array<{
  id: string;
  input: Record<string, unknown>;
  by: string;
  writer: SignalWriter;
}> = [];
let condition: ConditionResult = { status: "met" };
let conditionChecks = 0;
let claims = 0;
let restoreApprovals: () => void = () => {};
let fakes: Partial<LeadApplyDeps> = {};

const APP = { kind: "service", principal: "service", env: { GH_TOKEN: "app" } };

function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    ghRepo: "acme/web",
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    headSha: SHA,
    base: "main",
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    requiredApprovals: 0,
    strictUpToDate: false,
    failingChecks: [],
    pendingChecks: [],
    missingRequired: [],
    files: null,
    fetchedAt: "x",
    ...over,
  };
}

const github: Pick<
  MergeGithub,
  "mergeMethods" | "merge" | "appCredential" | "comment"
> = {
  mergeMethods: async () => ["squash", "merge"],
  appCredential: async () => APP as never,
  merge: async (...args) => {
    merges.push(args);
    return mergeResponse as never;
  },
  comment: async (...args) => {
    comments.push(args);
  },
};

const statusSignal: Signal = {
  id: "sig-status",
  name: "Status page",
  project: "acme",
  enabled: true,
  severity: "major",
  createdBy: "Ada",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "http", url: "https://status.acme.example.test/" },
  rule: { kind: "consecutive", failures: 3, recoveries: 2 },
} as Signal;

const RULE_BEFORE = { kind: "consecutive", failures: 3, recoveries: 2 };
const RULE_AFTER = { kind: "consecutive", failures: 5, recoveries: 2 };

function withLead(
  over: Partial<ProjectSettingsDocument["lead"]> = {},
  rules: Partial<Record<LeadCategory, string>> = {},
): void {
  doc = {
    ...doc,
    lead: {
      ...doc.lead,
      enabled: true,
      stage: "act",
      ...over,
      rules: { ...doc.lead.rules, ...rules } as never,
    },
  };
}

beforeEach(() => {
  clock = NOW;
  audits = [];
  posts = [];
  merges = [];
  comments = [];
  writes = [];
  claims = 0;
  conditionChecks = 0;
  condition = { status: "met" };
  mergeResponse = { ok: true, sha: "f".repeat(40) };
  prs = new Map([["acme/web#12", pr()]]);
  signals = new Map([[statusSignal.id, structuredClone(statusSignal)]]);
  doc = defaultProjectDocument("acme", "");
  // Fixes and CI repair ask first here, so their merges need the owner.
  withLead({}, { "fix-verified": "asks-first", "ci-repair": "asks-first" });
  __setOwnerRosterForTest(
    [{ name: "Ada Lovelace", github: "ada-example" }] as never,
    "Ada",
  );
  __setLeadAuditForTest((event) => {
    audits.push(event);
  });
  let ids = 0;
  restoreApprovals = __setLeadApprovalsDepsForTest({
    now: () => clock,
    newId: () => `lp-${++ids}`,
  });
  fakes = {
    now: () => clock,
    newClaimId: () => `la-${++claims}`,
    projectDocument: async () => doc,
    projectLabel: () => "Acme",
    projectGhRepos: () => ["acme/web"],
    checkCondition: async () => {
      conditionChecks++;
      return condition;
    },
    readPr: async (ghRepo, number) => {
      const found = prs.get(`${ghRepo}#${number}`);
      if (!found) throw new Error("not found");
      return { pr: found, title: "Fix search" };
    },
    mergePr: (input) => mergePinnedPr(input, github),
    getSignal: async (id) => structuredClone(signals.get(id) ?? null),
    updateSignal: async (id, input, by, writer) => {
      writes.push({ id, input, by, writer });
      const stored = signals.get(id);
      if (!stored) return null;
      const refused = writer.precondition?.(stored);
      if (refused) return { error: refused };
      const next = { ...stored, ...input } as Signal;
      signals.set(id, next);
      return next;
    },
    postSupervisorItem: (async (input: Record<string, unknown>) => {
      posts.push(input);
      return {
        item: { id: `si-${posts.length}` },
        created: true,
        delivery: "none",
        revision: clock,
      };
    }) as never,
  };
  __setLeadApplyDepsForTest(fakes);
});

afterEach(() => {
  restoreApprovals();
  __setLeadApplyDepsForTest(undefined);
  __setLeadAuditForTest(undefined);
  __setOwnerRosterForTest(undefined);
});

const mergeStep = (over: Record<string, unknown> = {}) => ({
  kind: "merge-pr",
  ghRepo: "acme/web",
  number: 12,
  headSha: SHA,
  ...over,
});

const patchStep = (over: Record<string, unknown> = {}) => ({
  kind: "signal-patch",
  signalId: "sig-status",
  before: { rule: RULE_BEFORE },
  after: { rule: RULE_AFTER },
  ...over,
});

async function propose(
  category: LeadCategory,
  steps: unknown[],
  extra: Record<string, unknown> = {},
) {
  const result = await recordProposal({
    project: "acme",
    category,
    subject: `subject ${Math.random()}`,
    itemId: `si-p${Math.random().toString(36).slice(2, 8)}`,
    itemRevision: 1,
    steps,
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function approved(
  category: LeadCategory,
  steps: unknown[],
  approval: Record<string, unknown> = {},
) {
  const proposal = await propose(category, steps);
  const result = await approve({
    project: "acme",
    proposalId: proposal.id,
    approvedBy: "Ada",
    login: "ada-example",
    ...approval,
  });
  if (!result.ok) throw new Error(result.error);
  return proposal;
}

async function state(id: string) {
  return (await getRecord("acme", id))?.approval?.state;
}

// ── The order of the checks ─────────────────────────────────────────────────

function fakeRecord(
  category: LeadCategory,
  approval?: Partial<NonNullable<LeadRecord["approval"]>>,
  steps: LeadRecord["proposal"]["steps"] = [
    { kind: "merge-pr", ghRepo: "acme/web", number: 12, headSha: SHA },
  ],
): LeadRecord {
  return {
    proposal: {
      id: "lp-x",
      project: "acme",
      category,
      subject: "x",
      itemId: "si-x",
      itemRevision: 1,
      steps,
      createdAt: NOW,
    },
    ...(approval
      ? {
          approval: {
            proposalId: "lp-x",
            approvedBy: "Ada",
            login: "ada-example",
            at: NOW,
            expiresAt: NOW + 86_400_000,
            state: "ready",
            updatedAt: NOW,
            ...approval,
          },
        }
      : {}),
  };
}

describe("applyGate", () => {
  test("a lead that is off refuses before anything else", () => {
    withLead({ enabled: false, stage: "watch" });
    doc = { ...doc, incidents: { ...doc.incidents, agentsPaused: true } };
    const gate = applyGate(doc, fakeRecord("refund", {}), NOW);
    expect(gate).toMatchObject({ ok: false });
    expect(!gate.ok && gate.reason).toStartWith("The lead is off");
  });

  test("the kill switch comes next", () => {
    doc = { ...doc, incidents: { ...doc.incidents, agentsPaused: true } };
    const gate = applyGate(doc, fakeRecord("refund", {}), NOW);
    expect(!gate.ok && gate.reason).toStartWith("Agents are paused");
  });

  test("a pinned category is refused always, approval or not", () => {
    for (const stage of ["watch", "coordinate", "act"] as const) {
      withLead({ stage });
      const gate = applyGate(doc, fakeRecord("refund", {}), NOW);
      expect(gate).toMatchObject({ ok: false, void: true });
      expect(!gate.ok && gate.reason).toContain(
        "Only the owner decides refunds",
      );
    }
  });

  test("a category the owner keeps is refused before the stage", () => {
    withLead({ stage: "watch" }, { "public-release": "only-you" });
    const gate = applyGate(doc, fakeRecord("public-release", {}), NOW);
    expect(gate).toMatchObject({ ok: false, void: true });
  });

  test("watch refuses even a ready approval and an alone category", () => {
    withLead({ stage: "watch" }, { "fix-verified": "alone" });
    for (const record of [
      fakeRecord("public-release", {}),
      fakeRecord("fix-verified"),
    ]) {
      const gate = applyGate(doc, record, NOW);
      expect(!gate.ok && gate.reason).toStartWith("Watch stage");
    }
  });

  test("alone at act runs without an approval", () => {
    withLead({}, { "fix-verified": "alone" });
    expect(applyGate(doc, fakeRecord("fix-verified"), NOW)).toMatchObject({
      ok: true,
      mode: "alone",
    });
  });

  test("coordinate: workers and autofix alone are not available yet", () => {
    withLead({ stage: "coordinate" }, { "ci-repair": "alone" });
    const gate = applyGate(
      doc,
      fakeRecord("ci-repair", undefined, [
        { kind: "autofix-pr", ghRepo: "acme/web", number: 12, headSha: SHA },
      ]),
      NOW,
    );
    expect(!gate.ok && gate.reason).toContain("not available yet");
  });

  test("coordinate: an alone merge still needs an approval, and approved runs wait for act", () => {
    expect(APPROVED_RUNS_ONLY_AT_ACT).toBe(true);
    withLead({ stage: "coordinate" }, { "fix-verified": "alone" });
    for (const record of [
      fakeRecord("fix-verified"),
      fakeRecord("public-release", {}),
    ]) {
      const gate = applyGate(doc, record, NOW);
      expect(!gate.ok && gate.reason).toStartWith(
        "Approved actions run at the act stage",
      );
    }
  });

  test("asks first at act needs a live, unexpired approval", () => {
    const none = applyGate(doc, fakeRecord("public-release"), NOW);
    expect(!none.ok && none.reason).toStartWith("The owner hasn't approved");
    const expired = applyGate(
      doc,
      fakeRecord("public-release", { expiresAt: NOW }),
      NOW,
    );
    expect(!expired.ok && expired.reason).toStartWith("The approval expired");
    const done = applyGate(
      doc,
      fakeRecord("public-release", { state: "partial" }),
      NOW,
    );
    expect(!done.ok && done.reason).toContain("never runs again");
    expect(applyGate(doc, fakeRecord("public-release", {}), NOW)).toMatchObject(
      { ok: true, mode: "approved" },
    );
  });
});

// ── lead_apply ──────────────────────────────────────────────────────────────

describe("leadApply", () => {
  test("merges as the App, pinned, and names the approver and SHA", async () => {
    const p = await approved("fix-verified", [mergeStep({ method: "merge" })]);
    const result = await leadApply("acme", p.id);
    expect(result).toMatchObject({ ok: true, state: "applied" });
    expect(merges).toHaveLength(1);
    expect(merges[0]!.slice(0, 4)).toEqual([
      "acme/web",
      12,
      { sha: SHA, method: "merge", title: "Fix search (#12)" },
      APP,
    ]);
    expect(comments[0]![2]).toBe(
      `Merged by Sessions. @ada-example approved ${SHA}; merge commit ${"f".repeat(40)}.`,
    );
    expect(await state(p.id)).toBe("applied");
    expect(posts).toEqual([
      expect.objectContaining({
        kind: "fyi",
        user: "Ada",
        title: "Applied: Acme: Fixes verified by a second agent",
        body: expect.stringContaining("(done)"),
      }),
    ]);
    // The intent is recorded before the step, its result after.
    const steps = audits.filter((a) => a.step === 1);
    expect(steps.map((a) => a.phase)).toEqual(["intent", "result"]);
    expect(steps[1]).toMatchObject({
      kind: "lead_apply",
      result: "merged",
      sha: "f".repeat(40),
      headSha: SHA,
      login: "ada-example",
    });
  });

  test("an already merged PR counts as done", async () => {
    prs.set(
      "acme/web#12",
      pr({ state: "MERGED", mergeCommitSha: "d".repeat(40) }),
    );
    const p = await approved("fix-verified", [mergeStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(merges).toHaveLength(0);
    expect(posts[0]!.body).toContain("(already done)");
  });

  test("merged at another head, or a moved head, fails and never merges", async () => {
    prs.set("acme/web#12", pr({ state: "MERGED", headSha: MOVED }));
    const elsewhere = await approved("fix-verified", [mergeStep()]);
    const a = await leadApply("acme", elsewhere.id);
    expect(a).toMatchObject({ ok: false, state: "failed" });
    expect(a.text).toContain(`was merged at ${MOVED.slice(0, 7)}`);

    prs.set("acme/web#12", pr({ headSha: MOVED }));
    const moved = await approved("ci-repair", [mergeStep()]);
    const b = await leadApply("acme", moved.id);
    expect(b).toMatchObject({ ok: false, state: "failed" });
    expect(b.text).toContain("has new commits since");
    expect(merges).toHaveLength(0);
    expect(await state(moved.id)).toBe("failed");
    expect(posts.at(-1)).toMatchObject({
      kind: "needs-you",
      title: expect.stringMatching(/^Couldn.t apply: PR #12 in acme\/web/),
      options: ["Propose again", "Drop it"],
    });
  });

  test("a blocked merge asks the owner and suggests a force merge", async () => {
    prs.set("acme/web#12", pr({ requiredApprovals: 1 }));
    const p = await approved("fix-verified", [mergeStep()]);
    const result = await leadApply("acme", p.id);
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(merges).toHaveLength(0);
    expect(posts[0]).toMatchObject({
      kind: "needs-you",
      title: "Couldn't apply: Branch protection requires a review on PR #12",
      options: ["Propose again", "Drop it"],
    });
    expect(posts[0]!.body).toContain(FORCE_MERGE_LINE);
    // GitHub's own refusal is the same.
    prs.set("acme/web#12", pr());
    mergeResponse = {
      ok: false,
      status: 405,
      message: "Required status check",
    };
    const refused = await approved("fix-verified", [mergeStep()]);
    await leadApply("acme", refused.id);
    expect(posts.at(-1)!.body).toContain(FORCE_MERGE_LINE);
  });

  test("two calls at once: one claims, the other is refused", async () => {
    const p = await approved("fix-verified", [mergeStep()]);
    const [a, b] = await Promise.all([
      leadApply("acme", p.id),
      leadApply("acme", p.id),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(merges).toHaveLength(1);
    const again = await leadApply("acme", p.id);
    expect(again.ok).toBe(false);
    expect(merges).toHaveLength(1);
  });

  test("stops at the first failure: partial, and never re-runs", async () => {
    prs.set(
      "acme/web#13",
      pr({
        number: 13,
        url: "https://github.com/acme/web/pull/13",
        requiredApprovals: 1,
      }),
    );
    const p = await approved("fix-verified", [
      mergeStep(),
      mergeStep({ number: 13 }),
      mergeStep({ number: 14 }),
    ]);
    const result = await leadApply("acme", p.id);
    expect(result).toMatchObject({ ok: false, state: "partial" });
    expect(merges).toHaveLength(1);
    expect(await state(p.id)).toBe("partial");
    const body = String(posts[0]!.body);
    expect(body).toContain("1. Merge PR #12 in acme/web at aaaaaaa (done)");
    expect(body).toContain("2. Merge PR #13 in acme/web at aaaaaaa (failed)");
    expect(body).toContain("3. Merge PR #14 in acme/web at aaaaaaa (not run)");
    const again = await leadApply("acme", p.id);
    expect(again.text).toContain("never runs again");
    expect(merges).toHaveLength(1);
  });

  test("changes a signal as the lead, only while it holds the before values", async () => {
    const p = await approved("signal-rule-change", [patchStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      id: "sig-status",
      input: { rule: RULE_AFTER },
      by: "Blob (lead), approved by ada-example",
    });
    // No person's identity: the write is the lead's, guarded by `before`.
    expect(Object.keys(writes[0]!.writer)).toEqual(["precondition"]);
    expect(signals.get("sig-status")!.rule).toEqual(RULE_AFTER as never);

    // Already at `after`: done without a write.
    const again = await approved("signal-rule-change", [patchStep()]);
    expect(await leadApply("acme", again.id)).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
  });

  test("a signal that changed since the proposal is left alone", async () => {
    signals.set("sig-status", {
      ...statusSignal,
      rule: { kind: "consecutive", failures: 4, recoveries: 2 },
    });
    const p = await approved("signal-rule-change", [patchStep()]);
    const result = await leadApply("acme", p.id);
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.text).toContain("The Status page check changed");
    expect(writes).toHaveLength(0);
    // A change between the read and the write is caught inside it.
    signals.set("sig-status", structuredClone(statusSignal));
    const raced = await approved("signal-rule-change", [patchStep()]);
    __setLeadApplyDepsForTest({
      ...fakes,
      getSignal: async () => structuredClone(statusSignal),
    });
    signals.set("sig-status", {
      ...statusSignal,
      rule: { kind: "consecutive", failures: 4, recoveries: 2 },
    });
    expect(await leadApply("acme", raced.id)).toMatchObject({
      ok: false,
      state: "failed",
    });
    expect(signals.get("sig-status")!.rule).toMatchObject({ failures: 4 });
  });

  test("a condition is re-checked now: unknown and not met keep it waiting", async () => {
    const p = await approved("fix-verified", [mergeStep()], {
      condition: { kind: "incident-resolved", id: "inc-1" },
    });
    expect(await state(p.id)).toBe("waiting");
    condition = { status: "unknown", reason: "store down" };
    const unknown = await leadApply("acme", p.id);
    expect(unknown.text).toContain(
      "Couldn't check whether Incident inc-1 is resolved: store down",
    );
    expect(await state(p.id)).toBe("waiting");
    condition = { status: "not-met", reason: "Incident inc-1 is still open" };
    const notMet = await leadApply("acme", p.id);
    expect(notMet.text).toContain("Not yet: Incident inc-1 is still open");
    expect(notMet.text).toContain("The approval keeps waiting");
    expect(await state(p.id)).toBe("waiting");
    expect(merges).toHaveLength(0);
    condition = { status: "met" };
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(conditionChecks).toBe(3);
    expect(await state(p.id)).toBe("applied");
  });

  test("a category the owner now keeps voids the approval", async () => {
    const p = await approved("signal-rule-change", [patchStep()]);
    withLead({}, { "signal-rule-change": "only-you" });
    const result = await leadApply("acme", p.id);
    expect(result.text).toContain("Only the owner decides signal rule changes");
    expect(await state(p.id)).toBe("void");
    withLead({}, { "signal-rule-change": "asks-first" });
    expect((await leadApply("acme", p.id)).text).toContain("was voided");
    expect(writes).toHaveLength(0);
  });

  test("steps this PR can't run are refused before the claim", async () => {
    const p = await approved("fix-verified", [
      mergeStep(),
      { kind: "spawn-worker", prompt: "Fix the flaky test." },
    ]);
    const result = await leadApply("acme", p.id);
    expect(result.text).toStartWith("spawn-worker steps are not available yet");
    expect(await state(p.id)).toBe("ready");
    expect(merges).toHaveLength(0);
  });

  test("approved runs wait for the act stage", async () => {
    const p = await approved("fix-verified", [mergeStep()]);
    withLead({ stage: "coordinate" });
    expect((await leadApply("acme", p.id)).text).toStartWith(
      "Approved actions run at the act stage",
    );
    expect(await state(p.id)).toBe("ready");
  });

  test("alone at act runs by the rules, with no approver to name", async () => {
    withLead({}, { "fix-verified": "alone" });
    const p = await propose("fix-verified", [mergeStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(merges).toHaveLength(1);
    expect(comments).toHaveLength(0);
    const record = await getRecord("acme", p.id);
    expect(record?.approval).toMatchObject({
      state: "applied",
      approvedBy: "Blob (lead)",
      rule: expect.stringMatching(/^Alone: Fixes verified/),
    });
    expect(record?.approval?.login).toBeUndefined();
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: false });
    expect(merges).toHaveLength(1);
  });

  test("an unknown proposal is refused and audited", async () => {
    const result = await leadApply("acme", "lp-nope");
    expect(result.text).toStartWith("No proposal lp-nope");
    expect(audits.at(-1)).toMatchObject({
      kind: "lead_apply",
      phase: "refused",
      reasonDigest: expect.any(String),
    });
  });
});

test("signalHolds reads unset fields as false, empty and null", () => {
  const stored = { rule: statusSignal.rule };
  expect(signalHolds(stored, { provider: null, dependsOn: null })).toBe(true);
  expect(signalHolds(stored, { provider: false, dependsOn: [] })).toBe(true);
  expect(signalHolds(stored, { provider: true })).toBe(false);
  expect(
    signalHolds(
      { ...stored, dependsOn: ["b", "a"] },
      { dependsOn: ["a", "b"] },
    ),
  ).toBe(true);
  expect(signalHolds(stored, { rule: RULE_BEFORE as never })).toBe(true);
  expect(signalHolds(stored, { rule: RULE_AFTER as never })).toBe(false);
});
