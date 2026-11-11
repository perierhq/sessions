// lead_apply: the order of its checks, conditions re-checked at apply time,
// the claim under concurrent calls, each merge outcome, the signal change's
// before check, the autofix, worker and support-reply steps, the
// coordinate stage's limits, partial runs that never re-run, and the
// identities used. Approvals run on the in-memory kernel; GitHub, signals,
// workers, support and the inbox are fakes, and merges go through the real
// mergePinnedPr.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PrSnapshot } from "../../shared/incident-response";
import type { Signal } from "../../shared/incidents";
import type { LeadCategory } from "../../shared/project-lead";
import type { SupportConversation } from "../../shared/support";
import { RULES } from "../support/policy";
import type { PrRef } from "../../agents/github/review";
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
  type AutofixPr,
  FORCE_MERGE_LINE,
  type LeadApplyDeps,
  COORDINATE_STEPS,
  WORKER_UNAVAILABLE,
  __setLeadApplyDepsForTest,
  applyGate,
  leadApply,
  personStepped,
  samePin,
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
let autofixPrs: Map<string, AutofixPr>;
let autofixStarts: PrRef[] = [];
let autofixRunning = false;
let conversations: Map<string, SupportConversation>;
let sends: unknown[][] = [];
let sendResult:
  | { ok: true }
  | { ok: false; status: 404 | 409 | 502; error: string } = { ok: true };

const CONV = "sc_0001";
const DRAFT = "sd_0001";
const TO = [{ name: "Customer", address: "customer@example.test" }];
const ANSWERS = "m-in-1@example.test";

function conversation(
  over: Partial<SupportConversation> = {},
): SupportConversation {
  return {
    id: CONV,
    project: "acme",
    messages: [],
    events: [],
    draft: {
      id: DRAFT,
      text: "Thanks, it's fixed.",
      state: "veto",
      rule: "Sends when the veto window ends",
      decidedBy: null,
      to: TO,
      answersMessageId: ANSWERS,
    },
    ...over,
  } as never;
}

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
  autofixPrs = new Map([
    [
      "acme/web#12",
      {
        state: "OPEN",
        title: "Fix search",
        headRef: "fix-search",
        headSha: SHA,
        fork: false,
      },
    ],
  ]);
  autofixStarts = [];
  autofixRunning = false;
  conversations = new Map([[CONV, conversation()]]);
  sends = [];
  sendResult = { ok: true };
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
    readAutofixPr: async (ghRepo, number) => {
      const found = autofixPrs.get(`${ghRepo}#${number}`);
      if (!found) throw new Error("not found");
      return { ...found };
    },
    startAutofix: async (ref) => {
      if (autofixRunning) return "running";
      autofixStarts.push(ref);
      return "started";
    },
    getConversation: async (id) =>
      structuredClone(conversations.get(id) ?? null),
    sendDraft: (async (...args: unknown[]) => {
      sends.push(args);
      return sendResult;
    }) as never,
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

const autofixStep = (over: Record<string, unknown> = {}) => ({
  kind: "autofix-pr",
  ghRepo: "acme/web",
  number: 12,
  headSha: SHA,
  ...over,
});

const supportStep = () => ({
  kind: "support-send",
  conversationId: CONV,
  draftId: DRAFT,
  pin: { to: TO, answersMessageId: ANSWERS },
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
    itemRevision: proposal.itemRevision,
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

  test("coordinate: the rules run autofix alone, nothing else", () => {
    expect(COORDINATE_STEPS).toEqual(["autofix-pr"]);
    withLead({ stage: "coordinate" }, { "ci-repair": "alone" });
    const autofix = {
      kind: "autofix-pr" as const,
      ghRepo: "acme/web",
      number: 12,
      headSha: SHA,
    };
    expect(
      applyGate(doc, fakeRecord("ci-repair", undefined, [autofix]), NOW),
    ).toMatchObject({ ok: true, mode: "alone" });
    // A merge among them still needs the owner, and approved runs wait.
    const merge = applyGate(
      doc,
      fakeRecord("ci-repair", undefined, [
        autofix,
        { kind: "merge-pr", ghRepo: "acme/web", number: 12, headSha: SHA },
      ]),
      NOW,
    );
    expect(!merge.ok && merge.reason).toStartWith(
      "Approved actions run at the act stage",
    );
    // A category outside COORDINATE_CATEGORIES never runs alone there.
    withLead({ stage: "coordinate" }, { "support-routine-reply": "alone" });
    const support = applyGate(
      doc,
      fakeRecord("support-routine-reply", undefined, [
        { kind: "support-send", conversationId: CONV, draftId: DRAFT },
      ]),
      NOW,
    );
    expect(support.ok).toBe(false);
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
      title:
        "Couldn't apply: Branch protection blocks the merge of PR #12 in acme/web",
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
      "Couldn't check whether Incident inc-1 is resolved.",
    );
    expect(unknown.text).not.toContain("store down");
    expect(await state(p.id)).toBe("waiting");
    condition = { status: "not-met", reason: "Incident inc-1 is still open" };
    const notMet = await leadApply("acme", p.id);
    expect(notMet.text).toContain(
      "Not yet: waiting until Incident inc-1 is resolved",
    );
    expect(notMet.text).not.toContain("still open");
    expect(notMet.text).toContain("The approval keeps waiting");
    expect(await state(p.id)).toBe("waiting");
    expect(merges).toHaveLength(0);
    condition = { status: "met" };
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(conditionChecks).toBe(3);
    expect(await state(p.id)).toBe("applied");
    expect(audits.filter((a) => a.phase === "ready")).toHaveLength(1);
  });

  test("a category the owner now keeps voids the approval", async () => {
    const p = await approved("signal-rule-change", [patchStep()]);
    withLead({}, { "signal-rule-change": "only-you" });
    const result = await leadApply("acme", p.id);
    expect(result.text).toContain("Only the owner decides signal rule changes");
    expect(await state(p.id)).toBe("void");
    expect(audits).toContainEqual(
      expect.objectContaining({ phase: "voided", voided: [p.id] }),
    );
    withLead({}, { "signal-rule-change": "asks-first" });
    expect((await leadApply("acme", p.id)).text).toContain("was voided");
    expect(writes).toHaveLength(0);
  });

  test("asks the autofix agent as the App, at the proposed head", async () => {
    const p = await approved("ci-repair", [autofixStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({
      ok: true,
      state: "applied",
    });
    expect(autofixStarts).toEqual([
      {
        number: 12,
        headRef: "fix-search",
        headSha: SHA,
        title: "Fix search",
        ghRepo: "acme/web",
      },
    ]);
    expect(audits).toContainEqual(
      expect.objectContaining({
        step: 1,
        phase: "result",
        result: "autofix-started",
        headSha: SHA,
      }),
    );
    expect(String(posts[0]!.body)).toContain(
      "1. Ask the autofix agent to fix PR #12 in acme/web at aaaaaaa (done)",
    );
  });

  test("an autofix loop already running counts as done", async () => {
    autofixRunning = true;
    const p = await approved("ci-repair", [autofixStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(String(posts[0]!.body)).toContain("(already done)");
    expect(audits).toContainEqual(
      expect.objectContaining({ result: "autofix-running" }),
    );
  });

  test("a moved head, a closed PR or a fork never starts autofix", async () => {
    const base = autofixPrs.get("acme/web#12")!;
    const cases: Array<[Partial<AutofixPr>, string, string]> = [
      [{ headSha: MOVED }, "head-moved", "has new commits since aaaaaaa"],
      [{ state: "CLOSED" }, "not-open", "PR #12 in acme/web is closed"],
      [{ fork: true }, "fork", "comes from another repository"],
    ];
    for (const [over, result, copy] of cases) {
      autofixPrs.set("acme/web#12", { ...base, ...over });
      const p = await approved("ci-repair", [autofixStep()]);
      const applied = await leadApply("acme", p.id);
      expect(applied).toMatchObject({ ok: false, state: "failed" });
      expect(applied.text).toContain(copy);
      expect(audits).toContainEqual(expect.objectContaining({ result }));
    }
    expect(autofixStarts).toHaveLength(0);
  });

  test("a worker step never runs: not available yet, alone or approved", async () => {
    const worker = { kind: "spawn-worker", prompt: "Fix it." };
    const p = await approved("fix-verified", [worker]);
    const result = await leadApply("acme", p.id);
    expect(result.ok).toBe(false);
    expect(result.text).toStartWith(WORKER_UNAVAILABLE);
    // Refused before the claim: nothing ran and the approval still stands.
    expect(await state(p.id)).toBe("ready");

    withLead({ stage: "coordinate" }, { "ci-repair": "alone" });
    const alone = await propose("ci-repair", [autofixStep(), worker]);
    expect((await leadApply("acme", alone.id)).text).toStartWith(
      WORKER_UNAVAILABLE,
    );
    expect(autofixStarts).toHaveLength(0);
    expect((await getRecord("acme", alone.id))?.approval).toBeUndefined();
  });

  test("sends an approved support reply as the approver", async () => {
    const p = await approved("support-routine-reply", [supportStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({ ok: true });
    expect(sends).toEqual([
      [
        CONV,
        DRAFT,
        {
          kind: "person",
          name: "Ada",
          login: "ada-example",
          approvedVia: "lead",
        },
      ],
    ]);
    expect(audits).toContainEqual(
      expect.objectContaining({
        result: "sent",
        conversationId: CONV,
        draftId: DRAFT,
      }),
    );
  });

  test("a support reply by the rules goes as Sessions, under the inbox's rules", async () => {
    withLead({}, { "support-routine-reply": "alone" });
    const p = await propose("support-routine-reply", [supportStep()]);
    sendResult = {
      ok: false,
      status: 409,
      error: "The veto window is still open",
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await leadApply("acme", p.id);
      expect(result).toMatchObject({ ok: false, state: "failed" });
      expect(result.text).toContain(
        `Support didn't send the reply in support conversation ${CONV}`,
      );
    } finally {
      console.warn = warn;
    }
    expect(sends).toEqual([[CONV, DRAFT, { kind: "sessions" }]]);
  });

  test("a reply already sent counts as done; a changed draft or another project's conversation is left alone", async () => {
    conversations.set(
      CONV,
      conversation({
        draft: null,
        messages: [{ id: "m1", draftId: DRAFT }] as never,
      }),
    );
    const sent = await approved("support-routine-reply", [supportStep()]);
    expect(await leadApply("acme", sent.id)).toMatchObject({ ok: true });
    expect(String(posts.at(-1)!.body)).toContain("(already done)");

    sendResult = {
      ok: false,
      status: 409,
      error: "This reply was already sent",
    };
    conversations.set(CONV, conversation());
    const raced = await approved("support-routine-reply", [supportStep()]);
    expect(await leadApply("acme", raced.id)).toMatchObject({ ok: true });
    expect(sends).toHaveLength(1);

    conversations.set(
      CONV,
      conversation({
        draft: { id: "sd_0002", text: "New text", state: "veto" } as never,
      }),
    );
    const changed = await approved("support-routine-reply", [supportStep()]);
    const result = await leadApply("acme", changed.id);
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.text).toContain("changed since this was proposed");

    conversations.set(CONV, conversation({ project: "other" }));
    const foreign = await approved("support-routine-reply", [supportStep()]);
    expect((await leadApply("acme", foreign.id)).text).toContain(
      "is no longer one of this project's",
    );
    expect(sends).toHaveLength(1);
  });

  test("a support reply goes only to the target pinned at proposal time", async () => {
    const moved = [
      {
        ...conversation().draft,
        to: [{ name: null, address: "x@example.test" }],
      },
      { ...conversation().draft, answersMessageId: "m-in-2@example.test" },
    ];
    for (const draft of moved) {
      conversations.set(CONV, conversation({ draft } as never));
      const p = await approved("support-routine-reply", [supportStep()]);
      const result = await leadApply("acme", p.id);
      expect(result).toMatchObject({ ok: false, state: "failed" });
      expect(result.text).toContain(
        `The recipient of the reply in support conversation ${CONV} changed since this was proposed`,
      );
    }
    // A step recorded without a pin never sends.
    conversations.set(CONV, conversation());
    const { pin: _, ...unpinned } = supportStep();
    const old = await approved("support-routine-reply", [unpinned]);
    expect((await leadApply("acme", old.id)).text).toContain(
      "changed since this was proposed",
    );
    expect(sends).toHaveLength(0);
  });

  test("a person who stopped the draft or acted after the proposal wins", async () => {
    const base = conversation().draft!;
    const cases: Array<Partial<SupportConversation>> = [
      { draft: { ...base, state: "needs-person", rule: RULES.personStopped } },
      {
        draft: {
          ...base,
          state: "needs-person",
          decidedBy: { kind: "person", name: "Grace" },
        },
      },
      {
        events: [
          {
            at: new Date(NOW + 1000).toISOString(),
            kind: "note",
            actor: { kind: "person", name: "Grace" },
            detail: "Took it over",
          },
        ],
      },
    ];
    for (const over of cases) {
      conversations.set(CONV, conversation(over));
      const p = await approved("support-routine-reply", [supportStep()]);
      clock = NOW + 2000;
      const result = await leadApply("acme", p.id);
      clock = NOW;
      expect(result).toMatchObject({ ok: false, state: "failed" });
      expect(result.text).toContain(
        "A person stopped or answered the reply in support conversation",
      );
    }
    expect(sends).toHaveLength(0);
    // A person's action before the proposal doesn't stop it.
    expect(
      personStepped(
        conversation({
          events: [
            {
              at: new Date(NOW - 1000).toISOString(),
              kind: "note",
              actor: { kind: "person", name: "Grace" },
              detail: "Read it",
            },
          ],
        }),
        NOW,
      ),
    ).toBe(false);
  });

  test("a teammate acting after the proposal stops a rules run claimed later", async () => {
    withLead({}, { "support-routine-reply": "alone" });
    conversations.set(CONV, conversation());
    const p = await propose("support-routine-reply", [supportStep()]);
    conversations.set(
      CONV,
      conversation({
        events: [
          {
            at: new Date(NOW + 1000).toISOString(),
            kind: "note",
            actor: { kind: "person", name: "Grace" },
            detail: "Took it over",
          },
        ],
      }),
    );
    clock = NOW + 2000;
    const result = await leadApply("acme", p.id);
    clock = NOW;
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.text).toContain(
      "A person stopped or answered the reply in support conversation",
    );
    expect(sends).toHaveLength(0);
  });

  test("samePin compares addresses case-insensitively and in order", () => {
    const pin = { to: TO, answersMessageId: ANSWERS };
    expect(samePin({ to: TO, answersMessageId: ANSWERS }, pin)).toBe(true);
    expect(
      samePin(
        {
          to: [{ name: "Customer", address: "CUSTOMER@example.test" }],
          answersMessageId: ANSWERS,
        },
        pin,
      ),
    ).toBe(true);
    expect(samePin({ to: TO, answersMessageId: null }, pin)).toBe(false);
    expect(samePin({ answersMessageId: ANSWERS }, pin)).toBe(false);
  });

  test("coordinate: the rules ask the autofix agent without an approval", async () => {
    withLead({ stage: "coordinate" }, { "ci-repair": "alone" });
    const p = await propose("ci-repair", [autofixStep()]);
    expect(await leadApply("acme", p.id)).toMatchObject({
      ok: true,
      state: "applied",
    });
    expect(autofixStarts).toHaveLength(1);
    expect((await getRecord("acme", p.id))?.approval).toMatchObject({
      state: "applied",
      approvedBy: "Blob (lead)",
    });
  });

  test("coordinate: the rules tightened before a step stop the run: partial", async () => {
    withLead({ stage: "coordinate" }, { "ci-repair": "alone" });
    autofixPrs.set("acme/web#13", { ...autofixPrs.get("acme/web#12")! });
    const p = await propose("ci-repair", [
      autofixStep(),
      autofixStep({ number: 13 }),
    ]);
    const start = fakes.startAutofix!;
    fakes.startAutofix = async (ref) => {
      withLead({ stage: "coordinate" }, { "ci-repair": "asks-first" });
      return start(ref);
    };
    const result = await leadApply("acme", p.id);
    expect(result).toMatchObject({ ok: false, state: "partial" });
    expect(result.text).toContain(
      "The lead's rules no longer let this run without the owner",
    );
    expect(autofixStarts).toHaveLength(1);
    expect(audits).toContainEqual(
      expect.objectContaining({ step: 2, phase: "stopped" }),
    );
  });

  test("coordinate: a support reply by the rules waits for the act stage", async () => {
    withLead({ stage: "coordinate" }, { "support-routine-reply": "alone" });
    const p = await propose("support-routine-reply", [supportStep()]);
    expect((await leadApply("acme", p.id)).ok).toBe(false);
    expect(sends).toHaveLength(0);
    expect((await getRecord("acme", p.id))?.approval).toBeUndefined();
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

  test("the owner tightening alone to asks first during the condition check claims nothing", async () => {
    withLead({}, { "fix-verified": "alone" });
    const p = await propose("fix-verified", [mergeStep()], {
      condition: { kind: "incident-resolved", id: "inc-1" },
    });
    __setLeadApplyDepsForTest({
      ...fakes,
      checkCondition: async () => {
        withLead({}, { "fix-verified": "asks-first" });
        return { status: "met" };
      },
    });
    const result = await leadApply("acme", p.id);
    expect(result.text).toStartWith("The owner hasn't approved");
    expect((await getRecord("acme", p.id))?.approval).toBeUndefined();
    expect(merges).toHaveLength(0);
  });

  test("the kill switch flipped between steps stops the run: partial", async () => {
    prs.set("acme/web#13", pr({ number: 13 }));
    const p = await approved("fix-verified", [
      mergeStep(),
      mergeStep({ number: 13 }),
    ]);
    __setLeadApplyDepsForTest({
      ...fakes,
      mergePr: async (input) => {
        const merged = await mergePinnedPr(input, github);
        doc = { ...doc, incidents: { ...doc.incidents, agentsPaused: true } };
        return merged;
      },
    });
    const result = await leadApply("acme", p.id);
    expect(result).toMatchObject({ ok: false, state: "partial" });
    expect(result.text).toContain("Agents are paused");
    expect(merges).toHaveLength(1);
    expect(await state(p.id)).toBe("partial");
    const body = String(posts[0]!.body);
    expect(body).toContain("1. Merge PR #12 in acme/web at aaaaaaa (done)");
    expect(body).toContain("2. Merge PR #13 in acme/web at aaaaaaa (not run)");
    expect(audits).toContainEqual(
      expect.objectContaining({ step: 2, phase: "stopped" }),
    );
  });

  test("a step already done does not count as ran", async () => {
    prs.set(
      "acme/web#12",
      pr({ state: "MERGED", mergeCommitSha: "d".repeat(40) }),
    );
    prs.set("acme/web#13", pr({ number: 13, requiredApprovals: 1 }));
    const p = await approved("fix-verified", [
      mergeStep(),
      mergeStep({ number: 13 }),
    ]);
    expect(await leadApply("acme", p.id)).toMatchObject({
      ok: false,
      state: "failed",
    });
    expect(await state(p.id)).toBe("failed");
  });

  test("raw error text never reaches the lead or the inbox", async () => {
    const RAW = "secret-internal-detail";
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const texts: string[] = [];
      mergeResponse = { ok: false, status: 500, message: RAW };
      const refused = await approved("fix-verified", [mergeStep()]);
      texts.push((await leadApply("acme", refused.id)).text);

      mergeResponse = { ok: true, sha: "f".repeat(40) };
      __setLeadApplyDepsForTest({
        ...fakes,
        readPr: async () => {
          throw new Error(RAW);
        },
      });
      const unread = await approved("fix-verified", [mergeStep()]);
      texts.push((await leadApply("acme", unread.id)).text);

      __setLeadApplyDepsForTest({
        ...fakes,
        mergePr: async () => ({ kind: "error", message: RAW }),
      });
      const errored = await approved("fix-verified", [mergeStep()]);
      texts.push((await leadApply("acme", errored.id)).text);

      __setLeadApplyDepsForTest({
        ...fakes,
        updateSignal: async () => ({ error: RAW }),
      });
      const patch = await approved("signal-rule-change", [patchStep()]);
      texts.push((await leadApply("acme", patch.id)).text);

      __setLeadApplyDepsForTest(fakes);
      condition = { status: "unknown", reason: RAW };
      const waiting = await approved("fix-verified", [mergeStep()], {
        condition: { kind: "incident-resolved", id: "inc-1" },
      });
      texts.push((await leadApply("acme", waiting.id)).text);
      condition = { status: "not-met", reason: RAW };
      texts.push((await leadApply("acme", waiting.id)).text);

      expect(texts).toHaveLength(6);
      for (const text of texts) expect(text).not.toContain(RAW);
      expect(posts).toHaveLength(4);
      for (const post of posts) expect(JSON.stringify(post)).not.toContain(RAW);
      expect(texts[2]).toContain("GitHub refused the merge of PR #12");
      expect(texts[1]).toContain(
        "Couldn't read PR #12 in acme/web from GitHub",
      );
      expect(texts[3]).toContain("The Status page check could not be changed");
      for (const record of await Promise.all(
        [refused, unread, errored, patch].map((p) => getRecord("acme", p.id)),
      ))
        expect(JSON.stringify(record)).not.toContain(RAW);
      // The raw text is logged on the server with the proposal, and
      // audited as a digest only.
      expect(logged.filter((l) => l.includes(RAW))).toHaveLength(6);
      expect(logged.some((l) => l.includes(`acme ${errored.id}`))).toBe(true);
      expect(JSON.stringify(audits)).not.toContain(RAW);
      expect(audits).toContainEqual(
        expect.objectContaining({ detailDigest: expect.any(String) }),
      );
    } finally {
      console.warn = warn;
    }
  });

  test("an audit failure after the claim still settles the record", async () => {
    const p = await approved("fix-verified", [mergeStep()]);
    __setLeadAuditForTest((event) => {
      if (event.phase === "intent") throw new Error("audit down");
      audits.push(event);
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await leadApply("acme", p.id);
      expect(result).toMatchObject({ ok: false, state: "failed" });
    } finally {
      console.warn = warn;
    }
    expect(merges).toHaveLength(0);
    expect(await state(p.id)).toBe("failed");
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
