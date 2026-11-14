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
//      approval; at coordinate only a fix or CI repair
//      (COORDINATE_CATEGORIES) whose steps all ask the autofix agent
//      (COORDINATE_STEPS)
//   5. otherwise an approval of exactly this proposal: ready (or waiting
//      with its condition met now), not expired, at the coordinate or act
//      stage (APPROVED_RUNS_ONLY_AT_ACT is off)
//
// A condition is re-checked now, whoever allowed the run: unknown or not
// met refuses, and a waiting approval keeps waiting. The settings and
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
// Each step kind goes through the mechanism that already does the job:
//
//   - merge-pr: mergePinnedPr as the GitHub App, pinned to the approved
//     head, so branch protection applies
//   - autofix-pr: fireAutoFix, called directly since the webhook ignores
//     labels the App applies; only while the PR is open, from this
//     repository and still at the approved head; the loop commits as the
//     App's fallback identity, never a person's
//   - spawn-worker: refused, not available yet. spawn_task's path would
//     start a fully trusted session for the owner (interactive trust,
//     their user, AWS credentials, interactive-only MCP servers). The
//     restricted path the incident fix loop uses (an automation descendant
//     policy under an automation's coordinator session, in a sandbox or an
//     isolated Runner) has no lead automation to hang off yet, so the step
//     fails closed until it does
//   - signal-patch: updateSignal, written only while the stored fields
//     equal the proposal's `before`
//   - support-send: sendDraft. An approved run sends for the approver,
//     marked approved through the lead (logged "Approved by X, sent by
//     Blob" and kept out of the "sent unchanged" counts); a run by the
//     rules sends as Sessions, so the inbox's decideReply rules and
//     autonomy decide as for any automatic send (a draft on a veto window
//     rarely gets that far, as designed). A draft's text never changes
//     under its id (a new text is a new draft), so a different live draft
//     means it changed since the proposal; its target must still be the
//     one pinned at proposal time, and a person who stopped the draft or
//     acted on the conversation after the approval wins.
//
//   - blob-comment, blob-label, close-issue, close-pr: Blob's own GitHub
//     account through github-blob.ts and every guard it holds (Blob's
//     repositories, the text guards, the label allowlist, the write
//     limits). As a recorded step it may also post on a public repository
//     listed in publicRepos, when the lead's owner may post there
//     (blobSupervisorPoster). close-pr runs only while the pull request is
//     still at the head the owner saw, read again right before closing;
//     close-issue only while the issue is as it was when proposed (its
//     updated_at and state, pinned by the server). A close posts its
//     fixed note (blobCloseNote) with the approved reason line in the same
//     step, after those checks. While Blob has no token stored, a step a
//     person approved posts through the GitHub App instead (github-blob.ts
//     `app` mode, the same guards; any repository of this project, public
//     ones too, since the approval is the gate), and a run by the rules is
//     refused
//   - approve-run: approves a waiting workflow run of an outside
//     contributor's pull request as the GitHub App (its own actions:write
//     mint), only while the pull request is open, still at the approved
//     head, and the run is a pull_request run for that head in this
//     repository. This runs the contributor's code in CI, so its category
//     asks first, and can't be set to alone. A repository with a workflow
//     on workflow_run or pull_request_target (read from its default branch
//     right before approving) refuses: those run with the repository's
//     secrets after the contributor's run, so the owner approves on GitHub
//
// No step uses the owner's token. The owner hears the outcome in their
// supervisor inbox, in fixed copy. Nothing runs at import.
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
import type {
  SupportActor,
  SupportConversation,
  SupportDraft,
} from "../../shared/support";
import type { PrRef } from "../../agents/github/review";
import { digest } from "../audit";
import type {
  PinnedMergeComment,
  PinnedMergeResult,
} from "../incidents/response/merge";
import type { SignalWriter } from "../incidents/signal-store";
import type { MergeMethod } from "../pr-contract";
import { PROJECT_LEAD_ACTOR } from "../session-actors";
import type {
  closeSupervisorItems,
  postSupervisorItem,
} from "../supervisor-inbox";
import { RULES } from "../support/policy";
import type { sendDraft } from "../support/reply";
import type {
  BlobPoster,
  blobClose,
  blobComment,
  blobLabel,
} from "../github-blob";
import {
  type ClaimError,
  type LeadApproval,
  type LeadRecord,
  type LeadStep,
  type LeadStepKind,
  type SignalPatchAfter,
  type SignalPatchBefore,
  type SupportSendPin,
  LEAD_RULES_APPROVER,
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
 * Whether a run the owner approved waits for the act stage. Owner decision
 * (2026-11-11): his approval is the gate, so an approved asks-first action
 * also runs at coordinate. Set this to true to hold approved runs until
 * act; watch always refuses.
 */
export const APPROVED_RUNS_ONLY_AT_ACT: boolean = false;

/** The answer a proposal's card closes with when the lead settled it
 *  under its own rules, without the owner's answer. */
export const DONE_BY_LEAD_ANSWER = "Done by the lead under its rules";

/** The `dedupeKey` of the Applied or Couldn't apply item a run posts. */
export function applyItemKey(project: string, proposalId: string): string {
  return `${leadSource(project)}:apply:${proposalId}`;
}

/** The inbox items of proposals the lead ran under its own rules that
 *  have settled: their cards are done. An applied one always is; a failed
 *  or partial one only once `failureTold` confirms its Couldn't apply item
 *  is in the inbox, so the owner never loses the card without being told. */
export function doneByRulesItemIds(
  records: readonly LeadRecord[],
  failureTold: (proposalId: string) => boolean,
): Set<string> {
  return new Set(
    records
      .filter(
        (r) =>
          (r.approval?.approvedBy === LEAD_RULES_APPROVER &&
            r.approval.state === "applied") ||
          (failedByRules(r) && failureTold(r.proposal.id)),
      )
      .map((r) => r.proposal.itemId),
  );
}

/** A run the lead started under its own rules that failed or ran part way. */
export function failedByRules(record: LeadRecord): boolean {
  return (
    record.approval?.approvedBy === LEAD_RULES_APPROVER &&
    (record.approval.state === "failed" || record.approval.state === "partial")
  );
}

/** What the rules let run without the owner at the coordinate stage. */
export const COORDINATE_STEPS: readonly LeadStepKind[] = ["autofix-pr"];

/** Why a spawn-worker step never runs (see the header). */
export const WORKER_UNAVAILABLE = "Starting a worker is not available yet";

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

/** A pull request as the autofix loop needs it. */
export interface AutofixPr {
  state: "OPEN" | "MERGED" | "CLOSED";
  title: string;
  headRef: string;
  headSha: string;
  /** The head branch lives in another repository (a fork). */
  fork: boolean;
}

/** A workflow run as an approve-run step checks it. */
export interface ApplyRun {
  /** `owner/name` the run belongs to. */
  repo: string;
  headSha: string;
  /** GitHub's status: `action_required` while it waits for approval. */
  status: string;
  /** What started the run: an outside contributor's is `pull_request`. */
  event: string;
}

/** Why an approve-run step refuses a repository with a workflow that runs
 *  with secrets after a contributor's run. */
export const SECRET_WORKFLOWS_REFUSAL =
  "This repo has workflows that run with secrets after a contributor's run; approve it on GitHub yourself";

/** Triggers that run a workflow from the default branch, with the
 *  repository's secrets, after or around a contributor's pull request. */
const SECRET_TRIGGERS = /\b(?:workflow_run|pull_request_target)\b/;

/** Whether a workflow file names a trigger that runs with secrets after a
 *  contributor's run. Any mention counts, comments too: it fails closed. */
export function workflowRunsWithSecrets(text: string): boolean {
  return SECRET_TRIGGERS.test(text);
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
  /** Throws when GitHub can't be read. */
  readAutofixPr(ghRepo: string, number: number): Promise<AutofixPr>;
  /** fireAutoFix as the App, not awaited: "running" when an autofix loop
   *  or another code action already runs on the PR. */
  startAutofix(ref: PrRef): Promise<"started" | "running">;
  getConversation(id: string): Promise<SupportConversation | null>;
  sendDraft: typeof sendDraft;
  /** Who Blob posts for: `privateOnly` unless the owner may post on
   *  listed public repositories (blobSupervisorPoster). */
  blobPoster(owner: string): Promise<Pick<BlobPoster, "privateOnly">>;
  blobComment: typeof blobComment;
  blobLabel: typeof blobLabel;
  blobClose: typeof blobClose;
  /** Throws when GitHub can't be read. */
  readRun(ghRepo: string, runId: number): Promise<ApplyRun>;
  /** The text of each workflow file on the default branch; [] without
   *  any. Throws when GitHub can't be read. */
  readWorkflows(ghRepo: string): Promise<string[]>;
  /** POST .../actions/runs/{id}/approve as the App. */
  approveRun(
    ghRepo: string,
    runId: number,
  ): Promise<{ ok: boolean; status: number; error?: string }>;
  postSupervisorItem: typeof postSupervisorItem;
  closeSupervisorItems: typeof closeSupervisorItems;
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
  async readAutofixPr(ghRepo, number) {
    const { githubRequest } = await import("../../agents/github/github-rest");
    const r = await githubRequest<Record<string, any>>(
      "GET",
      `/repos/${ghRepo}/pulls/${number}`,
    );
    if (!r.ok || !r.data) throw new Error(r.error || `HTTP ${r.status}`);
    const p = r.data;
    const headRepo = String(p.head?.repo?.full_name || "").toLowerCase();
    return {
      state: p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED",
      title: typeof p.title === "string" ? p.title : `PR #${number}`,
      headRef: String(p.head?.ref || ""),
      headSha: String(p.head?.sha || ""),
      // A deleted head repository reads as null: outside too.
      fork: headRepo !== ghRepo.toLowerCase(),
    };
  },
  async startAutofix(ref) {
    const { isLockHeld, readPrState } =
      await import("../../agents/github/state");
    if (
      isLockHeld("code", ref.number, ref.ghRepo) ||
      readPrState(ref.number, ref.ghRepo)?.autoFix?.active
    )
      return "running";
    const { fireAutoFix } = await import("../../agents/github/webhook");
    // A requester off the roster: the loop commits as the fallback
    // identity and never inherits an earlier run's person.
    void fireAutoFix(ref, PROJECT_LEAD_ACTOR);
    return "started";
  },
  getConversation: async (id) =>
    (await import("../support/store")).getConversation(id),
  sendDraft: async (...args) =>
    (await import("../support/reply")).sendDraft(...args),
  async blobPoster(owner) {
    const { blobSupervisorPoster } = await import("../github-blob");
    const { privateOnly } = await blobSupervisorPoster(owner);
    return privateOnly ? { privateOnly } : {};
  },
  blobComment: async (...args) =>
    (await import("../github-blob")).blobComment(...args),
  blobLabel: async (...args) =>
    (await import("../github-blob")).blobLabel(...args),
  blobClose: async (...args) =>
    (await import("../github-blob")).blobClose(...args),
  async readRun(ghRepo, runId) {
    const { githubRequest } = await import("../../agents/github/github-rest");
    const r = await githubRequest<Record<string, any>>(
      "GET",
      `/repos/${ghRepo}/actions/runs/${runId}`,
      undefined,
      { mint: "read" },
    );
    if (!r.ok || !r.data) throw new Error(r.error || `HTTP ${r.status}`);
    return {
      repo: String(r.data.repository?.full_name || ""),
      headSha: String(r.data.head_sha || ""),
      status: String(r.data.status || ""),
      event: String(r.data.event || ""),
    };
  },
  async readWorkflows(ghRepo) {
    const { githubRequest } = await import("../../agents/github/github-rest");
    const dir = await githubRequest<unknown>(
      "GET",
      `/repos/${ghRepo}/contents/.github/workflows`,
      undefined,
      { mint: "read" },
    );
    if (dir.status === 404) return [];
    if (!dir.ok || !Array.isArray(dir.data))
      throw new Error(dir.error || `HTTP ${dir.status}`);
    const texts: string[] = [];
    for (const entry of dir.data as Array<Record<string, unknown>>) {
      const path = entry?.path;
      if (entry?.type !== "file" || typeof path !== "string") continue;
      if (!/\.ya?ml$/i.test(path)) continue;
      const file = await githubRequest<Record<string, unknown>>(
        "GET",
        `/repos/${ghRepo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
        undefined,
        { mint: "read" },
      );
      const content = file.data?.content;
      if (!file.ok || typeof content !== "string")
        throw new Error(file.error || `HTTP ${file.status}`);
      texts.push(Buffer.from(content, "base64").toString("utf8"));
    }
    return texts;
  },
  async approveRun(ghRepo, runId) {
    const { githubRequest } = await import("../../agents/github/github-rest");
    const r = await githubRequest(
      "POST",
      `/repos/${ghRepo}/actions/runs/${runId}/approve`,
      undefined,
      { mint: "actions" },
    );
    return {
      ok: r.ok,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
    };
  },
  postSupervisorItem: async (...args) =>
    (await import("../supervisor-inbox")).postSupervisorItem(...args),
  closeSupervisorItems: async (...args) =>
    (await import("../supervisor-inbox")).closeSupervisorItems(...args),
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

type GateProposal = Pick<LeadRecord["proposal"], "category" | "steps">;

/** Whether the rules may run `proposal` without the owner at the
 *  coordinate stage: a coordinate category, and every step asks the
 *  autofix agent. */
export function coordinateAlone(proposal: GateProposal): boolean {
  return (
    (COORDINATE_CATEGORIES as readonly string[]).includes(proposal.category) &&
    proposal.steps.every((s) => COORDINATE_STEPS.includes(s.kind))
  );
}

/** Whether the rules may run `proposal` without the owner at `stage`. */
function aloneAt(
  stage: ProjectSettingsDocument["lead"]["stage"],
  proposal: GateProposal,
): boolean {
  return (
    stage === "act" || (stage === "coordinate" && coordinateAlone(proposal))
  );
}

/**
 * Whether the settings as they are now still allow a claimed run in `mode`
 * to go on: checks 1 to 4 again, and the stage and level the mode needs.
 * The record is applying by then, so only the settings are checked.
 * Returns the reason it stops (fixed copy), or null.
 */
export function runStillAllowed(
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  proposal: GateProposal,
  mode: ApplyMode,
): string | null {
  const checked = settingsCheck(doc, proposal.category);
  if (!checked.ok) return checked.reason;
  const stage = doc.lead.stage;
  if (
    mode === "alone" &&
    (checked.decision.effective !== "act" || !aloneAt(stage, proposal))
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
  // Fails closed before anything is claimed (see the header).
  if (proposal.steps.some((s) => s.kind === "spawn-worker"))
    return refuse(`${WORKER_UNAVAILABLE}. ${NOTHING_RAN}`);
  // leadDecision acts at coordinate only for COORDINATE_CATEGORIES; a
  // merge or another step there still needs the owner.
  if (decision.effective === "act" && !approval && aloneAt(stage, proposal))
    return { ok: true, mode: "alone", decision };
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
  | "autofix-started"
  | "autofix-running"
  | "sent"
  | "already-sent"
  | "posted"
  | "already-closed"
  | "approved"
  | "already-approved"
  | "not-open"
  | "fork"
  | "refused"
  | "merged-elsewhere"
  | "head-moved"
  | "blocked"
  | "changed"
  | "missing"
  | "error";

type StepOutcome =
  | {
      ok: true;
      result: StepResult;
      already: boolean;
      sha?: string;
    }
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
  proposalId: string;
  /** The project's settings when the run started its step. */
  doc: Pick<ProjectSettingsDocument, "lead">;
  d: LeadApplyDeps;
  approval: LeadApproval;
  /** When the lead proposed the run: a person acting on a support
   *  conversation after this wins, approved or not. */
  proposedAt: number;
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
  const foreign = projectRepo(step, ctx);
  if (foreign) return foreign;
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

function projectRepo(
  step: { ghRepo: string },
  ctx: RunContext,
): StepOutcome | null {
  const repos = ctx.d.projectGhRepos(ctx.project);
  return repos.some((r) => r.toLowerCase() === step.ghRepo.toLowerCase())
    ? null
    : {
        ok: false,
        result: "error",
        reason: `${step.ghRepo} is no longer this project's repository`,
      };
}

async function autofixStep(
  step: Extract<LeadStep, { kind: "autofix-pr" }>,
  ctx: RunContext,
): Promise<StepOutcome> {
  const name = prName(step);
  const foreign = projectRepo(step, ctx);
  if (foreign) return foreign;
  let pr: AutofixPr;
  try {
    pr = await ctx.d.readAutofixPr(step.ghRepo, step.number);
  } catch (error) {
    return {
      ok: false,
      result: "error",
      reason: `Couldn't read ${name} from GitHub`,
      detail: errorText(error),
    };
  }
  if (pr.state !== "OPEN")
    return {
      ok: false,
      result: "not-open",
      reason: `${name} is ${pr.state === "MERGED" ? "merged" : "closed"}`,
    };
  if (pr.fork || !pr.headRef)
    return {
      ok: false,
      result: "fork",
      reason: `${name} comes from another repository, so the autofix agent doesn't work on it`,
    };
  if (pr.headSha !== step.headSha)
    return {
      ok: false,
      result: "head-moved",
      reason: `${name} has new commits since ${short(step.headSha)} was proposed`,
    };
  const started = await ctx.d.startAutofix({
    number: step.number,
    headRef: pr.headRef,
    headSha: pr.headSha,
    title: pr.title,
    ghRepo: step.ghRepo,
  });
  return started === "running"
    ? { ok: true, result: "autofix-running", already: true }
    : { ok: true, result: "autofix-started", already: false };
}

function workerStep(): StepOutcome {
  return { ok: false, result: "refused", reason: WORKER_UNAVAILABLE };
}

/** Who sends a support reply: the approver, marked approved through the
 *  lead, or Sessions under the inbox's rules for a run by the lead's
 *  rules. */
export function supportSender(approval: LeadApproval): SupportActor {
  return approval.rule || !approval.login
    ? { kind: "sessions" }
    : {
        kind: "person",
        name: approval.approvedBy,
        login: approval.login,
        approvedVia: "lead",
      };
}

/** Whether the draft still goes where it went when it was proposed. */
export function samePin(
  draft: Pick<SupportDraft, "to" | "answersMessageId">,
  pin: SupportSendPin,
): boolean {
  const to = draft.to ?? [];
  return (
    draft.answersMessageId === pin.answersMessageId &&
    to.length === pin.to.length &&
    to.every(
      (a, i) =>
        a.address.toLowerCase() === pin.to[i]!.address.toLowerCase() &&
        (a.name ?? null) === (pin.to[i]!.name ?? null),
    )
  );
}

/** Whether a person stopped the draft, or acted on the conversation after
 *  the lead proposed the run: they win over the lead. */
export function personStepped(
  c: Pick<SupportConversation, "draft" | "events">,
  since: number,
): boolean {
  const d = c.draft;
  if (d?.rule === RULES.personStopped || d?.decidedBy?.kind === "person")
    return true;
  return c.events.some(
    (e) => e.actor.kind === "person" && Date.parse(e.at) >= since,
  );
}

const ALREADY_SENT = "This reply was already sent";

async function supportStep(
  step: Extract<LeadStep, { kind: "support-send" }>,
  ctx: RunContext,
): Promise<StepOutcome> {
  const name = `the reply in support conversation ${step.conversationId}`;
  const c = await ctx.d.getConversation(step.conversationId);
  if (!c || c.project !== ctx.project)
    return {
      ok: false,
      result: "missing",
      reason: `Support conversation ${step.conversationId} is no longer one of this project's`,
    };
  if (c.messages.some((m) => m.draftId === step.draftId))
    return { ok: true, result: "already-sent", already: true };
  const draft = c.draft;
  if (draft?.id !== step.draftId)
    return {
      ok: false,
      result: "changed",
      reason: `The draft of ${name} changed since this was proposed`,
    };
  // Recorded by the server when the lead proposed it; one recorded
  // before pinning never sends.
  if (!step.pin || !samePin(draft, step.pin))
    return {
      ok: false,
      result: "changed",
      reason: `The recipient of ${name} changed since this was proposed`,
    };
  if (personStepped(c, ctx.proposedAt))
    return {
      ok: false,
      result: "refused",
      reason: `A person stopped or answered ${name} after this was proposed`,
    };
  const sent = await ctx.d.sendDraft(
    step.conversationId,
    step.draftId,
    supportSender(ctx.approval),
  );
  if (sent.ok) return { ok: true, result: "sent", already: false };
  if (sent.error === ALREADY_SENT)
    return { ok: true, result: "already-sent", already: true };
  return {
    ok: false,
    result: "refused",
    reason: `Support didn't send ${name}`,
    detail: sent.error,
  };
}

/** Who Blob posts for in a recorded step: the lead's owner, on this
 *  project's repositories, public ones too where the owner may post. */
async function stepPoster(ctx: RunContext): Promise<BlobPoster | null> {
  const owner = leadOwner(ctx.doc);
  if (!owner) return null;
  return {
    owner,
    ...(await ctx.d.blobPoster(owner)),
    lead: {
      project: ctx.project,
      repos: [...ctx.d.projectGhRepos(ctx.project)],
      recordedStep: true,
      ...(ctx.approval.login ? { approvedBy: ctx.approval.login } : {}),
    },
  };
}

type BlobStep = Extract<
  LeadStep,
  { kind: "blob-comment" | "blob-label" | "close-issue" | "close-pr" }
>;

const BLOB_DOING: Record<BlobStep["kind"], string> = {
  "blob-comment": "comment on",
  "blob-label": "label",
  "close-issue": "close",
  "close-pr": "close",
};

async function blobStep(step: BlobStep, ctx: RunContext): Promise<StepOutcome> {
  const foreign = projectRepo(step, ctx);
  if (foreign) return foreign;
  const name = `#${step.number} in ${step.ghRepo}`;
  if (step.kind === "close-pr") {
    let pr: AutofixPr;
    try {
      pr = await ctx.d.readAutofixPr(step.ghRepo, step.number);
    } catch (error) {
      return {
        ok: false,
        result: "error",
        reason: `Couldn't read PR ${name} from GitHub`,
        detail: errorText(error),
      };
    }
    if (pr.state === "CLOSED")
      return { ok: true, result: "already-closed", already: true };
    if (pr.state === "MERGED")
      return { ok: false, result: "not-open", reason: `PR ${name} is merged` };
    if (pr.headSha !== step.headSha)
      return {
        ok: false,
        result: "head-moved",
        reason: `PR ${name} has new commits since ${short(step.headSha)} was proposed`,
      };
  }
  // Recorded by the server when the lead proposed it; one recorded
  // before pinning never closes.
  if (step.kind === "close-issue" && !step.pin)
    return {
      ok: false,
      result: "changed",
      reason: `Issue ${name} wasn't pinned when this was proposed, so Blob didn't close it`,
    };
  const poster = await stepPoster(ctx);
  if (!poster)
    return {
      ok: false,
      result: "refused",
      reason: "Nobody to post for: the lead has no owner",
    };
  const result =
    step.kind === "blob-comment"
      ? await ctx.d.blobComment(poster, {
          repo: step.ghRepo,
          number: step.number,
          body: step.body,
        })
      : step.kind === "blob-label"
        ? await ctx.d.blobLabel(poster, {
            repo: step.ghRepo,
            number: step.number,
            add: step.add,
            remove: step.remove,
          })
        : await ctx.d.blobClose(poster, {
            repo: step.ghRepo,
            number: step.number,
            pullRequest: step.kind === "close-pr",
            note: step.note,
            ...(step.kind === "close-issue"
              ? { reason: step.reason, expect: { issue: step.pin! } }
              : { expect: { headSha: step.headSha } }),
          });
  if (result.ok) return { ok: true, result: "posted", already: false };
  // github-blob.ts answers in its own fixed copy, never GitHub's text.
  return {
    ok: false,
    result: "refused",
    reason: `Blob couldn't ${BLOB_DOING[step.kind]} ${name}: ${result.message.replace(/\.$/, "")}`,
  };
}

async function approveRunStep(
  step: Extract<LeadStep, { kind: "approve-run" }>,
  ctx: RunContext,
): Promise<StepOutcome> {
  const foreign = projectRepo(step, ctx);
  if (foreign) return foreign;
  const name = prName(step);
  const run = `workflow run ${step.runId}`;
  let pr: AutofixPr;
  let found: ApplyRun;
  try {
    pr = await ctx.d.readAutofixPr(step.ghRepo, step.number);
    found = await ctx.d.readRun(step.ghRepo, step.runId);
  } catch (error) {
    return {
      ok: false,
      result: "error",
      reason: `Couldn't read ${name} or its ${run} from GitHub`,
      detail: errorText(error),
    };
  }
  if (pr.state !== "OPEN")
    return {
      ok: false,
      result: "not-open",
      reason: `${name} is ${pr.state === "MERGED" ? "merged" : "closed"}`,
    };
  if (pr.headSha !== step.headSha)
    return {
      ok: false,
      result: "head-moved",
      reason: `${name} has new commits since ${short(step.headSha)} was approved`,
    };
  if (
    found.repo.toLowerCase() !== step.ghRepo.toLowerCase() ||
    found.headSha !== step.headSha
  )
    return {
      ok: false,
      result: "changed",
      reason: `The ${run} is not for ${name} at ${short(step.headSha)}`,
    };
  // Only a pull_request run runs the contributor's code without secrets.
  if (found.event !== "pull_request")
    return {
      ok: false,
      result: "refused",
      reason: `The ${run} was not started by a pull request, so Blob doesn't approve it`,
    };
  if (found.status !== "action_required")
    return { ok: true, result: "already-approved", already: true };
  let workflows: string[];
  try {
    workflows = await ctx.d.readWorkflows(step.ghRepo);
  } catch (error) {
    return {
      ok: false,
      result: "error",
      reason: `Couldn't read the workflows of ${step.ghRepo} from GitHub`,
      detail: errorText(error),
    };
  }
  if (workflows.some(workflowRunsWithSecrets))
    return { ok: false, result: "refused", reason: SECRET_WORKFLOWS_REFUSAL };
  const approved = await ctx.d.approveRun(step.ghRepo, step.runId);
  if (approved.ok) return { ok: true, result: "approved", already: false };
  return {
    ok: false,
    result: approved.status === 403 ? "refused" : "error",
    reason:
      approved.status === 403
        ? `The GitHub App may not approve the ${run}: it needs the Actions write permission on ${step.ghRepo}`
        : `GitHub refused to approve the ${run}`,
    ...(approved.error ? { detail: approved.error } : {}),
  };
}

function runStep(step: LeadStep, ctx: RunContext): Promise<StepOutcome> {
  switch (step.kind) {
    case "merge-pr":
      return mergeStep(step, ctx);
    case "signal-patch":
      return patchStep(step, ctx);
    case "autofix-pr":
      return autofixStep(step, ctx);
    case "spawn-worker":
      return Promise.resolve(workerStep());
    case "support-send":
      return supportStep(step, ctx);
    case "blob-comment":
    case "blob-label":
    case "close-issue":
    case "close-pr":
      return blobStep(step, ctx);
    case "approve-run":
      return approveRunStep(step, ctx);
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
    case "blob-comment":
      return {
        ghRepo: step.ghRepo,
        number: step.number,
        bodyDigest: digest(step.body),
      };
    case "blob-label":
      return {
        ghRepo: step.ghRepo,
        number: step.number,
        add: step.add,
        remove: step.remove,
      };
    case "close-issue":
      return {
        ghRepo: step.ghRepo,
        number: step.number,
        reason: step.reason,
        noteDigest: digest(step.note),
        ...(step.pin ? { updatedAt: step.pin.updatedAt } : {}),
      };
    case "close-pr":
      return {
        ghRepo: step.ghRepo,
        number: step.number,
        headSha: step.headSha,
        noteDigest: digest(step.note),
      };
    case "approve-run":
      return {
        ghRepo: step.ghRepo,
        number: step.number,
        runId: step.runId,
        headSha: step.headSha,
      };
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
    dedupeKey: applyItemKey(project, item.proposalId),
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
        // A run that failed can't wait for the brief.
        urgency: "now",
      })
    : await d.postSupervisorItem({
        ...base,
        kind: "fyi",
        title: `Applied: ${item.title}`,
        body: item.lines,
      });
  return posted.item.id;
}

/** The proposal's own card leaves the owner's inbox once the lead settled
 *  it under its rules: the Applied or Couldn't apply item says how it went.
 *  A failed run's card stays until its Couldn't apply item is posted. A
 *  failure is logged; the next wake check retries (leads/goal.ts). */
async function closeProposalCard(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead">,
  d: LeadApplyDeps,
  itemId: string,
): Promise<void> {
  const owner = leadOwner(doc);
  if (!owner) return;
  const source = leadSource(project);
  try {
    await d.closeSupervisorItems(
      owner,
      (item) => item.source === source && item.id === itemId,
      { state: "answered", answer: DONE_BY_LEAD_ANSWER },
    );
  } catch (error) {
    logRaw(project, itemId, "closing the proposal's card", errorText(error));
  }
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
  const ctx: RunContext = {
    project,
    proposalId,
    doc,
    d,
    approval,
    proposedAt: proposal.createdAt,
    names: {},
  };
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
        ctx.doc = doc;
        stop = runStillAllowed(doc, proposal, mode);
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
  // A failed run's card stays open until the owner was told it failed.
  if (approval.approvedBy === LEAD_RULES_APPROVER && (!failure || itemId))
    await closeProposalCard(project, doc, d, proposal.itemId);
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
