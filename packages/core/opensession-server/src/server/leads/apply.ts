// `lead_apply`: run the steps of a recorded proposal (the lead act stage,
// approvals.ts) when the project's lead rules or the owner's approval allow
// it, each through an existing mechanism. The lead passes only the
// proposal's id; the steps are the ones the server recorded and the owner
// saw. Checks run every time, in this order:
//
//   1. the lead is off or the kill switch is on: refused
//   2. the category is only the owner's (pinned or set so): refused, and
//      anything still standing for the proposal is voided
//   3. the watch stage: refused
//   4. the rules say act: at the act stage the proposal runs without an
//      approval; at coordinate only workers and pull requests would, and
//      those steps are not available yet
//   5. otherwise an approval of exactly this proposal: ready (or waiting
//      with its condition met now), not expired, and only at the act stage
//      (APPROVED_RUNS_ONLY_AT_ACT)
//
// A condition is re-checked now, whoever allowed the run: unknown or not
// met refuses, and a waiting approval keeps waiting. Steps of a kind this
// file can't run are refused before anything is claimed. The settings and
// the record are read again and checks 1 to 5 re-run right before one
// compare-and-set claims the record (claimApply, or claimAlone for a run by
// the rules), so a change made while the condition was checked refuses.
// The steps run in order: the settings are read again before each one and
// a run they no longer allow stops; each step's intent is audited before it
// runs, a step already done counts as done, and the first failure stops the
// run (failed, or partial after a step that ran). Nothing re-runs.
//
// The lead and the inbox get fixed copy only. Raw error text from GitHub,
// the signal store or a condition check is logged on the server and
// audited as a digest.
//
// A merge goes through mergePinnedPr as the GitHub App, pinned to the
// approved head, so branch protection applies; a signal change through
// updateSignal, written only while the stored fields equal the proposal's
// `before`. No step uses the owner's token. The owner hears the outcome in
// their supervisor inbox, in fixed copy. Nothing runs at import.
import { randomUUIDv7 } from "bun";
import type { PrSnapshot } from "../../shared/incident-response";
import type { Signal, SignalRule } from "../../shared/incidents";
import {
  COORDINATE_CATEGORIES,
  LEAD_CATEGORY_LABELS,
  type LeadDecision,
  leadDecision,
} from "../../shared/project-lead";
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import { digest } from "../audit";
import type {
  PinnedMergeComment,
  PinnedMergeResult,
} from "../incidents/response/merge";
import type { SignalWriter } from "../incidents/signal-store";
import type { MergeMethod } from "../pr-contract";
import type { postSupervisorItem } from "../supervisor-inbox";
import {
  type ClaimError,
  type LeadApproval,
  type LeadRecord,
  type LeadStep,
  type LeadStepKind,
  type SignalPatchAfter,
  type SignalPatchBefore,
  claimAlone,
  claimApply,
  getRecord,
  transition,
  voidFor,
} from "./approvals";
import {
  type ConditionResult,
  type LeadCondition,
  checkCondition,
  describeCondition,
} from "./conditions";
import { leadSources } from "./overview";
import {
  leadAudit,
  leadOwner,
  leadReportRefusal,
  leadSource,
  proposalTitle,
  stepCopy,
} from "./report";

/**
 * Whether a run the owner approved waits for the act stage. The owner has
 * not confirmed the looser reading (an approved asks-first action may also
 * run at coordinate), so approved runs happen only at act. Set this to
 * false to let them run at coordinate too; watch always refuses.
 */
export const APPROVED_RUNS_ONLY_AT_ACT = true;

/** The step kinds this file runs. */
export const RUNNABLE_STEPS: readonly LeadStepKind[] = [
  "merge-pr",
  "signal-patch",
];

/** What the rules let run without the owner at the coordinate stage. */
const COORDINATE_STEPS: readonly LeadStepKind[] = [
  "spawn-worker",
  "autofix-pr",
];

export const APPLY_OPTIONS = ["Propose again", "Drop it"] as const;

export const FORCE_MERGE_LINE =
  "Sessions never bypasses branch protection. To merge it anyway, ask Blob to force merge.";

// ── Dependencies ────────────────────────────────────────────────────────────

/** A pull request as the merge needs it, with its title for the commit. */
export interface ApplyPr {
  pr: PrSnapshot;
  title: string;
}

export interface MergeInput {
  pr: PrSnapshot;
  headSha: string;
  title: string;
  method?: MergeMethod;
  comment?: PinnedMergeComment;
}

export interface LeadApplyDeps {
  now(): number;
  newClaimId(): string;
  projectDocument(project: string): Promise<ProjectSettingsDocument>;
  projectLabel(project: string): string;
  /** The project's GitHub repositories, `owner/name`. */
  projectGhRepos(project: string): readonly string[];
  checkCondition(condition: LeadCondition): Promise<ConditionResult>;
  /** Throws when GitHub can't be read. */
  readPr(ghRepo: string, number: number): Promise<ApplyPr>;
  /** mergePinnedPr with the GitHub App's identity. */
  mergePr(input: MergeInput): Promise<PinnedMergeResult>;
  getSignal(id: string): Promise<Signal | null>;
  updateSignal(
    id: string,
    input: Record<string, unknown>,
    by: string,
    writer: SignalWriter,
  ): Promise<Signal | { error: string } | null>;
  postSupervisorItem: typeof postSupervisorItem;
}

// The project's settings, label and repositories come from the overview's
// sources; the rest is imported on first use: it pulls in the GitHub
// client, the incident stores and the catalog client.
const liveDeps: LeadApplyDeps = {
  now: () => Date.now(),
  newClaimId: () => `la-${randomUUIDv7()}`,
  projectDocument: (project) => leadSources().projectDocument(project),
  projectLabel: (project) => leadSources().projectLabel(project),
  projectGhRepos: (project) => leadSources().projectGhRepos(project),
  checkCondition: (condition) => checkCondition(condition),
  async readPr(ghRepo, number) {
    const { defaultMergeGithub, snapshotFromVerdict } =
      await import("../incidents/response/merge");
    const github = defaultMergeGithub();
    // repoId only labels the verdict; the read itself goes by ghRepo.
    const verdict = await github.verdict({ repoId: ghRepo, ghRepo, number });
    const mergeCommitSha =
      verdict.state === "MERGED"
        ? await github.mergeCommit(ghRepo, number).catch(() => undefined)
        : undefined;
    return {
      pr: snapshotFromVerdict(verdict, {
        files: null,
        now: Date.now(),
        ...(mergeCommitSha ? { mergeCommitSha } : {}),
      }),
      title: verdict.pr.title,
    };
  },
  async mergePr(input) {
    const { defaultMergeGithub, mergePinnedPr } =
      await import("../incidents/response/merge");
    return mergePinnedPr(input, defaultMergeGithub());
  },
  getSignal: async (id) =>
    (await import("../incidents/signal-store")).getSignal(id),
  updateSignal: async (...args) =>
    (await import("../incidents/signal-store")).updateSignal(...args),
  postSupervisorItem: async (...args) =>
    (await import("../supervisor-inbox")).postSupervisorItem(...args),
};

let override: Partial<LeadApplyDeps> | undefined;

/** Replace the live sources (undefined restores them). */
export function __setLeadApplyDepsForTest(
  deps: Partial<LeadApplyDeps> | undefined,
): void {
  override = deps;
}

function deps(): LeadApplyDeps {
  return { ...liveDeps, ...override };
}

// ── The checks ──────────────────────────────────────────────────────────────

export type ApplyMode = "alone" | "approved";

export type ApplyGate =
  | { ok: true; mode: ApplyMode; decision: LeadDecision }
  | {
      ok: false;
      reason: string;
      /** Void what still stands for the proposal: the owner keeps the
       *  category now. */
      void?: boolean;
    };

const NOTHING_RAN = "Nothing ran.";

function lower(category: LeadRecord["proposal"]["category"]): string {
  return LEAD_CATEGORY_LABELS[category].toLowerCase();
}

type SettingsCheck =
  | { ok: true; decision: LeadDecision }
  | { ok: false; reason: string; void?: boolean };

/** Checks 1 to 3 of the header: the lead, the kill switch, only-you and
 *  the watch stage. Reasons are fixed copy without the closing sentence. */
function settingsCheck(
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  category: LeadRecord["proposal"]["category"],
): SettingsCheck {
  const off = leadReportRefusal(doc);
  if (off) return { ok: false, reason: off };
  const decision = leadDecision(
    { ...doc.lead, agentsPaused: doc.incidents.agentsPaused },
    category,
  );
  if (decision.level === "only-you")
    return {
      ok: false,
      reason: `Only the owner decides ${lower(category)} (${decision.rule})`,
      void: true,
    };
  if (doc.lead.stage === "watch")
    return {
      ok: false,
      reason: "Watch stage: the lead proposes and nothing runs",
    };
  return { ok: true, decision };
}

/**
 * Whether the settings as they are now still allow a claimed run in `mode`
 * to go on: checks 1 to 4 again, and the stage and level the mode needs.
 * The record is applying by then, so only the settings are checked.
 * Returns the reason it stops (fixed copy), or null.
 */
export function runStillAllowed(
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  category: LeadRecord["proposal"]["category"],
  mode: ApplyMode,
): string | null {
  const checked = settingsCheck(doc, category);
  if (!checked.ok) return checked.reason;
  const stage = doc.lead.stage;
  if (
    mode === "alone" &&
    (checked.decision.effective !== "act" || stage !== "act")
  )
    return "The lead's rules no longer let this run without the owner";
  if (mode === "approved" && APPROVED_RUNS_ONLY_AT_ACT && stage !== "act")
    return "Approved actions run at the act stage";
  return null;
}

/**
 * Checks 1 to 5 of the header, on the project settings and the record as
 * they are now. Pure; the condition and the step kinds are checked after.
 */
export function applyGate(
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  record: LeadRecord,
  now: number,
): ApplyGate {
  const refuse = (reason: string, extra: { void?: boolean } = {}) => ({
    ok: false as const,
    reason,
    ...extra,
  });
  const { proposal } = record;
  const checked = settingsCheck(doc, proposal.category);
  if (!checked.ok)
    return refuse(
      `${checked.reason}. ${NOTHING_RAN}`,
      checked.void ? { void: true } : {},
    );
  const { decision } = checked;
  const stage = doc.lead.stage;
  const approval = record.approval;
  if (proposal.voidedAt !== undefined || approval?.state === "void")
    return refuse(
      `This proposal was voided (${approval?.reason ?? proposal.voidReason ?? "voided"}). ${NOTHING_RAN} Propose it again.`,
    );
  if (decision.effective === "act") {
    if (stage === "coordinate") {
      // leadDecision acts at coordinate only for COORDINATE_CATEGORIES.
      if (
        (COORDINATE_CATEGORIES as readonly string[]).includes(
          proposal.category,
        ) &&
        proposal.steps.every((s) => COORDINATE_STEPS.includes(s.kind))
      )
        return refuse(
          `Starting workers and asking the autofix agent from a proposal are not available yet. ${NOTHING_RAN}`,
        );
    } else if (!approval) return { ok: true, mode: "alone", decision };
  }
  if (APPROVED_RUNS_ONLY_AT_ACT && stage !== "act")
    return refuse(`Approved actions run at the act stage. ${NOTHING_RAN}`);
  if (!approval)
    return refuse(
      `The owner hasn't approved this proposal. ${NOTHING_RAN} Wait for their answer.`,
    );
  if (approval.state === "applying")
    return refuse(`It is being applied already. ${NOTHING_RAN}`);
  if (approval.state !== "waiting" && approval.state !== "ready")
    return refuse(
      `It already ran (${approval.state}) and never runs again. ${NOTHING_RAN} Propose it again for a new run.`,
    );
  if (now >= approval.expiresAt)
    return refuse(
      `The approval expired. ${NOTHING_RAN} Propose it again for a new run.`,
    );
  return { ok: true, mode: "approved", decision };
}

function claimRefusal(error: ClaimError): string {
  switch (error) {
    case "busy":
      return "It is being applied already";
    case "settled":
      return "It already ran and never runs again";
    case "voided":
      return "This proposal was voided";
    case "expired":
      return "It expired";
    case "not-ready":
      return "The approval is still waiting for its condition";
    case "no-approval":
      return "The owner hasn't approved this proposal";
    case "not-found":
      return "The proposal was not found";
  }
}

// ── Steps ───────────────────────────────────────────────────────────────────

type StepResult =
  | "merged"
  | "already-merged"
  | "patched"
  | "already-patched"
  | "merged-elsewhere"
  | "head-moved"
  | "blocked"
  | "changed"
  | "missing"
  | "error";

type StepOutcome =
  | { ok: true; result: StepResult; already: boolean; sha?: string }
  | {
      ok: false;
      result: StepResult;
      /** Fixed copy for the lead and the owner. */
      reason: string;
      /** Raw text from GitHub or a store: logged and audited as a digest,
       *  never shown. */
      detail?: string;
      sha?: string;
      forceMerge?: boolean;
    };

interface RunContext {
  project: string;
  d: LeadApplyDeps;
  approval: LeadApproval;
  /** Signal names by id, for the owner's copy. */
  names: Record<string, string>;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "failed";
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function prName(step: { ghRepo: string; number: number }): string {
  return `PR #${step.number} in ${step.ghRepo}`;
}

async function mergeStep(
  step: Extract<LeadStep, { kind: "merge-pr" }>,
  ctx: RunContext,
): Promise<StepOutcome> {
  const name = prName(step);
  const repos = ctx.d.projectGhRepos(ctx.project);
  if (!repos.some((r) => r.toLowerCase() === step.ghRepo.toLowerCase()))
    return {
      ok: false,
      result: "error",
      reason: `${step.ghRepo} is no longer this project's repository`,
    };
  let read: ApplyPr;
  try {
    read = await ctx.d.readPr(step.ghRepo, step.number);
  } catch (error) {
    return {
      ok: false,
      result: "error",
      reason: `Couldn't read ${name} from GitHub`,
      detail: errorText(error),
    };
  }
  const { pr, title } = read;
  const login = ctx.approval.login;
  const result = await ctx.d.mergePr({
    pr,
    headSha: step.headSha,
    title,
    ...(step.method ? { method: step.method } : {}),
    ...(login ? { comment: { approvedBy: login } } : {}),
  });
  switch (result.kind) {
    case "merged":
      return {
        ok: true,
        result: "merged",
        already: false,
        ...(result.mergedSha ? { sha: result.mergedSha } : {}),
      };
    case "already-merged":
      return {
        ok: true,
        result: "already-merged",
        already: true,
        ...(pr.mergeCommitSha ? { sha: pr.mergeCommitSha } : {}),
      };
    case "merged-elsewhere":
      return {
        ok: false,
        result: "merged-elsewhere",
        sha: result.mergedSha,
        reason: `${name} was merged at ${short(result.mergedSha)}, not at the approved ${short(step.headSha)}`,
      };
    case "head-moved":
      return {
        ok: false,
        result: "head-moved",
        reason: `${name} has new commits since ${short(step.headSha)} was approved`,
        detail: result.reason,
      };
    case "blocked":
      return {
        ok: false,
        result: "blocked",
        reason: `Branch protection blocks the merge of ${name}`,
        detail: result.reason,
        forceMerge: true,
      };
    case "error":
      return {
        ok: false,
        result: "error",
        reason: `GitHub refused the merge of ${name}`,
        detail: result.message,
      };
  }
}

function sameIds(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

function sameRule(a: SignalRule, b: SignalRule): boolean {
  return Bun.deepEquals(a, b);
}

/** Whether the stored signal holds `fields` (a patch's before or after).
 *  An unset provider reads as false and null; an unset dependsOn as empty
 *  and null. */
export function signalHolds(
  stored: Pick<Signal, "rule" | "provider" | "dependsOn">,
  fields: SignalPatchBefore | SignalPatchAfter,
): boolean {
  if (fields.rule !== undefined && !sameRule(stored.rule, fields.rule))
    return false;
  if (
    fields.provider !== undefined &&
    (stored.provider === true) !== (fields.provider === true)
  )
    return false;
  if (
    fields.dependsOn !== undefined &&
    !sameIds(stored.dependsOn, fields.dependsOn)
  )
    return false;
  return true;
}

/** Who a signal change names as its writer. */
export function patchWriter(approval: LeadApproval): string {
  return approval.login
    ? `Blob (lead), approved by ${approval.login}`
    : "Blob (lead), by the project's lead rules";
}

async function patchStep(
  step: Extract<LeadStep, { kind: "signal-patch" }>,
  ctx: RunContext,
): Promise<StepOutcome> {
  const stored = await ctx.d.getSignal(step.signalId);
  if (!stored || stored.project !== ctx.project)
    return {
      ok: false,
      result: "missing",
      reason: `Signal ${step.signalId} is no longer one of this project's`,
    };
  ctx.names[stored.id] = stored.name;
  if (signalHolds(stored, step.after))
    return { ok: true, result: "already-patched", already: true };
  const changed = `The ${stored.name} check changed since this was proposed`;
  if (!signalHolds(stored, step.before))
    return { ok: false, result: "changed", reason: changed };
  const input: Record<string, unknown> = {};
  if (step.after.rule !== undefined) input.rule = step.after.rule;
  if (step.after.provider !== undefined) input.provider = step.after.provider;
  if (step.after.dependsOn !== undefined)
    input.dependsOn = step.after.dependsOn;
  const updated = await ctx.d.updateSignal(
    step.signalId,
    input,
    patchWriter(ctx.approval),
    {
      precondition: (current) =>
        current.project === ctx.project && signalHolds(current, step.before)
          ? null
          : changed,
    },
  );
  if (updated === null)
    return {
      ok: false,
      result: "missing",
      reason: `Signal ${step.signalId} is gone`,
    };
  if ("error" in updated)
    return updated.error === changed
      ? { ok: false, result: "changed", reason: changed }
      : {
          ok: false,
          result: "error",
          reason: `The ${stored.name} check could not be changed`,
          detail: updated.error,
        };
  return { ok: true, result: "patched", already: false };
}

function runStep(step: LeadStep, ctx: RunContext): Promise<StepOutcome> {
  switch (step.kind) {
    case "merge-pr":
      return mergeStep(step, ctx);
    case "signal-patch":
      return patchStep(step, ctx);
    default:
      // Refused before the claim (RUNNABLE_STEPS).
      return Promise.resolve({
        ok: false,
        result: "error",
        reason: `${step.kind} steps are not available yet`,
      });
  }
}

function stepRef(step: LeadStep): Record<string, unknown> {
  switch (step.kind) {
    case "merge-pr":
    case "autofix-pr":
      return {
        ghRepo: step.ghRepo,
        number: step.number,
        headSha: step.headSha,
      };
    case "signal-patch":
      return { signalId: step.signalId, afterDigest: digest(step.after) };
    case "support-send":
      return { conversationId: step.conversationId, draftId: step.draftId };
    case "spawn-worker":
      return { promptDigest: digest(step.prompt) };
  }
}

// ── The owner's copy ────────────────────────────────────────────────────────

type StepMark = "done" | "already done" | "failed" | "not run";

function stepLines(
  steps: readonly LeadStep[],
  marks: readonly StepMark[],
  names: Record<string, string>,
): string {
  return [
    "Steps:",
    ...steps.map(
      (step, i) =>
        `${i + 1}. ${stepCopy(step, names)} (${marks[i] ?? "not run"})`,
    ),
  ].join("\n");
}

async function tellOwner(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead">,
  d: LeadApplyDeps,
  item: {
    proposalId: string;
    title: string;
    failure?: { reason: string; forceMerge: boolean };
    lines: string;
  },
): Promise<string | undefined> {
  const owner = leadOwner(doc);
  if (!owner) return undefined;
  const base = {
    user: owner,
    source: leadSource(project),
    project,
    dedupeKey: `${leadSource(project)}:apply:${item.proposalId}`,
  };
  const posted = item.failure
    ? await d.postSupervisorItem({
        ...base,
        kind: "needs-you",
        title: `Couldn't apply: ${item.failure.reason}`,
        body: [
          `Couldn't apply: ${item.failure.reason}`,
          item.title,
          item.lines,
          item.failure.forceMerge ? FORCE_MERGE_LINE : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        options: [...APPLY_OPTIONS],
      })
    : await d.postSupervisorItem({
        ...base,
        kind: "fyi",
        title: `Applied: ${item.title}`,
        body: item.lines,
      });
  return posted.item.id;
}

// ── lead_apply ──────────────────────────────────────────────────────────────

export type LeadApplyResult =
  | {
      ok: true;
      state: "applied";
      text: string;
    }
  | {
      ok: false;
      /** Set once the run was claimed: how it ended. */
      state?: "failed" | "partial";
      text: string;
    };

/** Log raw text from GitHub, a store or a check on the server only. */
function logRaw(
  project: string,
  proposalId: string,
  what: string,
  raw: string,
): void {
  console.warn(`[leads] ${project} ${proposalId}: ${what}: ${raw}`);
}

/** Run proposal `proposalId` of `project`, when the checks allow it. Never
 *  re-runs a proposal that was claimed before. */
export async function leadApply(
  project: string,
  proposalId: string,
): Promise<LeadApplyResult> {
  const d = deps();
  let doc = await d.projectDocument(project);
  let record = await getRecord(project, proposalId);
  const audit = {
    kind: "lead_apply",
    project,
    proposalId,
    category: record?.proposal.category ?? null,
  };
  const refuse = async (text: string): Promise<LeadApplyResult> => {
    await leadAudit({ ...audit, phase: "refused", reasonDigest: digest(text) });
    return { ok: false, text };
  };
  const gated = async (
    gate: Extract<ApplyGate, { ok: false }>,
  ): Promise<LeadApplyResult> => {
    if (gate.void) {
      const voided = await voidFor(
        project,
        (r) => r.proposal.id === proposalId,
        "the owner keeps this category",
      );
      if (voided.length) await leadAudit({ ...audit, phase: "voided", voided });
    }
    return refuse(gate.reason);
  };
  if (!record) {
    const off = leadReportRefusal(doc);
    return refuse(
      off
        ? `${off}. ${NOTHING_RAN}`
        : `No proposal ${proposalId} in this project. ${NOTHING_RAN}`,
    );
  }
  const { proposal } = record;
  const gate = applyGate(doc, record, d.now());
  if (!gate.ok) return gated(gate);
  const mode = gate.mode;
  const later = proposal.steps.find((s) => !RUNNABLE_STEPS.includes(s.kind));
  if (later)
    return refuse(`${later.kind} steps are not available yet. ${NOTHING_RAN}`);
  const condition =
    mode === "approved" ? record.approval?.condition : proposal.condition;
  if (condition) {
    const checked = await d.checkCondition(condition);
    if (checked.status !== "met")
      logRaw(
        project,
        proposalId,
        `condition ${checked.status}`,
        checked.reason,
      );
    if (checked.status === "unknown")
      return refuse(
        `Couldn't check whether ${describeCondition(condition)}. ${NOTHING_RAN} Try again later.`,
      );
    if (checked.status === "not-met")
      return refuse(
        `Not yet: waiting until ${describeCondition(condition)}. ${NOTHING_RAN} ${mode === "approved" ? "The approval keeps waiting." : ""}`.trim(),
      );
    if (record.approval?.state === "waiting") {
      const ready = await transition(project, proposalId, "ready");
      if (!ready.ok)
        return refuse(
          `The approval could not become ready (${ready.error}). ${NOTHING_RAN}`,
        );
      await leadAudit({ ...audit, phase: "ready" });
    }
  }

  // The owner may have changed the settings or the record while the
  // condition was checked: read both again and re-run checks 1 to 5.
  doc = await d.projectDocument(project);
  record = await getRecord(project, proposalId);
  if (!record) return refuse(`The proposal was not found. ${NOTHING_RAN}`);
  const regate = applyGate(doc, record, d.now());
  if (!regate.ok) return gated(regate);
  if (regate.mode !== mode)
    return refuse(
      `The lead's rules changed while this was checked. ${NOTHING_RAN} Try again.`,
    );

  // 6: claim, then run each step once, in order.
  const claimId = d.newClaimId();
  const claim =
    mode === "approved"
      ? await claimApply(project, proposalId, claimId)
      : await claimAlone(project, proposalId, claimId, regate.decision.rule);
  if (!claim.ok) return refuse(`${claimRefusal(claim.error)}. ${NOTHING_RAN}`);
  const approval = claim.approval;
  const who = {
    ...audit,
    mode,
    ...(approval.login ? { login: approval.login } : {}),
    ...(approval.rule ? { rule: approval.rule } : {}),
  };
  const ctx: RunContext = { project, d, approval, names: {} };
  const marks: StepMark[] = [];
  let failure: { reason: string; forceMerge?: boolean } | undefined;
  // Whatever happens below, the claim is settled after.
  try {
    for (const [index, step] of proposal.steps.entries()) {
      const at = {
        ...who,
        step: index + 1,
        stepKind: step.kind,
        ...stepRef(step),
      };
      let stop: string | null;
      try {
        doc = await d.projectDocument(project);
        stop = runStillAllowed(doc, proposal.category, mode);
      } catch (error) {
        logRaw(project, proposalId, "reading the settings", errorText(error));
        stop = "The project's settings could not be read";
      }
      if (stop) {
        failure = { reason: stop };
        await leadAudit({
          ...at,
          phase: "stopped",
          reasonDigest: digest(stop),
        });
        break;
      }
      await leadAudit({ ...at, phase: "intent" });
      let outcome: StepOutcome;
      try {
        outcome = await runStep(step, ctx);
      } catch (error) {
        outcome = {
          ok: false,
          result: "error",
          reason: `Step ${index + 1} stopped with an unexpected error`,
          detail: errorText(error),
        };
      }
      if (outcome.ok) marks.push(outcome.already ? "already done" : "done");
      else {
        marks.push("failed");
        failure = {
          reason: outcome.reason,
          ...(outcome.forceMerge ? { forceMerge: true } : {}),
        };
        if (outcome.detail)
          logRaw(project, proposalId, `step ${index + 1}`, outcome.detail);
      }
      await leadAudit({
        ...at,
        phase: "result",
        result: outcome.result,
        ...(outcome.sha ? { sha: outcome.sha } : {}),
        ...(outcome.ok
          ? {}
          : {
              reasonDigest: digest(outcome.reason),
              ...(outcome.detail
                ? { detailDigest: digest(outcome.detail) }
                : {}),
            }),
      });
      if (!outcome.ok) break;
    }
  } catch (error) {
    // An audit write failed: stop rather than run a step unrecorded.
    logRaw(project, proposalId, "the run stopped", errorText(error));
    failure ??= { reason: "The run stopped unexpectedly" };
  }
  // Only steps this run did count as ran; already done ones did nothing.
  const ran = marks.filter((m) => m === "done").length;
  const state = !failure ? "applied" : ran ? "partial" : "failed";
  const settled = await transition(project, proposalId, state, {
    claimId,
    ...(failure ? { reason: failure.reason } : {}),
  });
  try {
    await leadAudit({
      ...who,
      phase: "done",
      state,
      recorded: settled.ok,
      ...(failure ? { reasonDigest: digest(failure.reason) } : {}),
    });
  } catch (error) {
    logRaw(project, proposalId, "auditing the outcome", errorText(error));
  }
  const title = proposalTitle(d.projectLabel(project), proposal.category);
  const lines = stepLines(proposal.steps, marks, ctx.names);
  let itemId: string | undefined;
  try {
    itemId = await tellOwner(project, doc, d, {
      proposalId,
      title,
      lines,
      ...(failure
        ? {
            failure: {
              reason: failure.reason,
              forceMerge: failure.forceMerge === true,
            },
          }
        : {}),
    });
  } catch (error) {
    logRaw(project, proposalId, "telling the owner", errorText(error));
  }
  const told = itemId ? ` The owner was told (${itemId}).` : "";
  if (!failure)
    return {
      ok: true,
      state: "applied",
      text: `Applied ${proposalId}: ${marks.length} of ${proposal.steps.length} steps done.${told}`,
    };
  return {
    ok: false,
    state: ran ? "partial" : "failed",
    text: `Couldn't apply ${proposalId}: ${failure.reason}. ${ran ? `${ran} of ${proposal.steps.length} steps ran first; ` : ""}it never runs again.${told}`,
  };
}
