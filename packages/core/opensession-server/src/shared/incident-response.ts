// Wire types for the incident response loop (agents, proof, policy,
// actions), shared by the server and the frontend. Types, constant lists
// and small pure helpers only.

import type { HttpSource, ObservationResult } from "./incidents";

export const AUTONOMY_LEVELS = [
  "watch",
  "propose",
  "deploy-after-veto",
  "deploy-right-away",
] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const NEVER_WITHOUT_YOU = [
  "costs-money",
  "needs-secret",
  "migration",
  "outside-scope",
  "not-reversible",
] as const;
export type NeverWithoutYou = (typeof NEVER_WITHOUT_YOU)[number];
export const DEFAULT_NEVER_WITHOUT_YOU: NeverWithoutYou[] = [
  "costs-money",
  "needs-secret",
  "migration",
  "outside-scope",
];

export const ACTION_KINDS = [
  "rollback",
  "deploy",
  "pause",
  "run-once",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Globs; empty `paths` means anywhere. */
export interface ActionScope {
  services: string[];
  paths: string[];
  migrationPaths: string[];
}

export type ActionCost = { kind: "none" } | { kind: "amount"; usd: number };

export interface IncidentAction {
  id: string;
  kind: ActionKind;
  label: string;
  runner: string;
  command: string;
  cwd?: string;
  timeoutMs: number;
  reversible: boolean;
  cost: ActionCost;
  needsSecret: boolean;
  scope: ActionScope;
}

/** A daily window, `HH:MM` in `timeZone`. */
export interface NightRule {
  start: string;
  end: string;
  timeZone: string;
}

export interface IncidentBudget {
  perIncidentUsd: number;
  perMonthUsd: number;
}

export interface IncidentRelease {
  at: string;
  source: "action" | "hook";
  ref?: string;
  actionRunId?: string;
  note?: string;
  /** Recorded by a rollback action: it undid a release, so it is never
   *  rolled back first, nor what a rollback goes back past. */
  rollback?: true;
}

export interface IncidentProjectSettings {
  project: string;
  agentsPaused: boolean;
  autonomy: AutonomyLevel;
  vetoMs: number;
  watchMs: number;
  maxRounds: number;
  night?: NightRule;
  neverWithoutYou: NeverWithoutYou[];
  budget: IncidentBudget;
  agents: { investigatorModel?: string; verifierModel?: string };
  productionRunners: string[];
  actions: IncidentAction[];
  automationId?: string;
  releaseHookSecret?: string;
  releases: IncidentRelease[];
  updatedAt?: string;
  updatedBy?: string;
}

export type RedactedProjectSettings = Omit<
  IncidentProjectSettings,
  "releaseHookSecret"
> & {
  releaseHookPath?: string;
};

export const DEFAULT_AUTONOMY: AutonomyLevel = "deploy-after-veto";
export const DEFAULT_VETO_MS = 600_000;
export const DEFAULT_WATCH_MS = 600_000;
export const DEFAULT_MAX_ROUNDS = 2;
export const DEFAULT_BUDGET: IncidentBudget = {
  perIncidentUsd: 20,
  perMonthUsd: 200,
};

export const ACTION_PLACEHOLDERS = [
  "ref",
  "previousRef",
  "incident",
  "project",
] as const;
export type ActionPlaceholder = (typeof ACTION_PLACEHOLDERS)[number];

export type ActionTemplateName = "docker-compose" | "systemd" | "script";

/**
 * Suggested commands for common setups. The settings UI copies one into an
 * action; nothing runs a template unedited.
 */
export const ACTION_TEMPLATES: Record<
  ActionTemplateName,
  Partial<Record<ActionKind, Pick<IncidentAction, "command" | "reversible">>>
> = {
  "docker-compose": {
    deploy: {
      command: "IMAGE_TAG={{ref}} docker compose up -d",
      reversible: true,
    },
    rollback: {
      command: "IMAGE_TAG={{previousRef}} docker compose up -d",
      reversible: true,
    },
    pause: { command: "docker compose stop worker", reversible: true },
    "run-once": { command: "docker compose run --rm job", reversible: false },
  },
  systemd: {
    deploy: {
      command:
        "git fetch origin && git checkout {{ref}} && sudo systemctl restart app",
      reversible: true,
    },
    rollback: {
      command: "git checkout {{previousRef}} && sudo systemctl restart app",
      reversible: true,
    },
    pause: { command: "sudo systemctl stop worker", reversible: true },
    "run-once": {
      command: "sudo systemctl start job.service",
      reversible: false,
    },
  },
  script: {
    deploy: { command: "./deploy.sh {{ref}}", reversible: true },
    rollback: { command: "./rollback.sh {{previousRef}}", reversible: true },
    pause: { command: "./pause.sh", reversible: true },
    "run-once": { command: "./run-once.sh", reversible: false },
  },
};

/** The same union as plan 3's `IncidentAgentRole`. */
export type AgentRole = "investigator" | "verifier";
export type Independence = "other-provider" | "same-provider" | "same-model";

export type EvidenceCost = "free" | "cheap" | "expensive";
export interface EvidenceRow {
  step: string;
  cost: EvidenceCost;
  result: "ruled-out" | "confirmed" | "inconclusive";
  evidence: string;
  source?: string;
}
export interface Claim {
  text: string;
  source?: string;
}
export interface ReadFirst {
  path: string;
  found: boolean;
}

export type CandidateCheck =
  | { kind: "request"; source: HttpSource }
  | { kind: "after-deploy"; reason: string };

/**
 * Action ids in run order. `pr: true` means merge the investigator's PR,
 * then run the project's `deploy` action, then `actions`.
 */
export interface CandidatePlan {
  pr: boolean;
  actions: string[];
}

export interface InvestigatorReport {
  role: "investigator";
  summary: string;
  cause: string;
  readFirst: ReadFirst[];
  attempts: EvidenceRow[];
  candidate: CandidatePlan | null;
  noCandidateReason?: string;
  check: CandidateCheck;
  claims: Claim[];
  notePath: string;
  runbookPaths: string[];
}

export type ClaimStatus = "verified" | "refuted" | "unverifiable";
export interface ClaimCheck {
  text: string;
  status: ClaimStatus;
  evidence: string;
  source?: string;
}
export interface VerifierReport {
  role: "verifier";
  verdict: "certain" | "not-certain";
  reasons: string[];
  claims: ClaimCheck[];
  proofAccepted: boolean;
}

export type AgentWorkspace =
  | { kind: "sandbox"; provider: string }
  | { kind: "host"; user: string };

export function describeWorkspace(w: AgentWorkspace): string {
  return w.kind === "sandbox"
    ? `Runs in the ${w.provider} sandbox`
    : "Runs on this server, not in a sandbox";
}

export type CancelReason =
  | "paused"
  | "provider"
  | "budget"
  | "timeout"
  | "stopped"
  | "closed";

/**
 * One run per agent session. A send-back reuses the investigator's run and
 * moves its `round` forward; a new session is a new `attempt`.
 * `accessSummary` and `accessRevision` are plan 3's `AgentAccess.summary`
 * and `revision` at spawn.
 */
export interface AgentRun {
  role: AgentRole;
  round: number;
  attempt: number;
  sessionId: string;
  model: string;
  provider: string;
  independence?: Independence;
  workspace: AgentWorkspace;
  accessSummary: string;
  accessRevision: string;
  status: "running" | "waiting" | "done" | "error" | "cancelled";
  startedAt: string;
  turnSentAt: string;
  endedAt?: string;
  costUsd: number;
  tokens: number;
  prUrl?: string;
  error?: string;
  cancelledFor?: CancelReason;
  report?: InvestigatorReport | VerifierReport;
  reportError?: string;
  reminded: boolean;
}

export interface ProofSample {
  at: string;
  result: ObservationResult;
  detail: string;
}

export interface ProofResult {
  round: number;
  at: string;
  runner?: string;
  baseline: { samples: ProofSample[]; verdict: "fails" | "passes" | "unclear" };
  candidate: {
    kind: "request" | "after-deploy";
    samples: ProofSample[];
    verdict: "passes" | "fails" | "unclear" | "after-deploy";
    refused?: string;
  };
}

export interface Verdict {
  round: number;
  at: string;
  verdict: "certain" | "not-certain";
  reasons: string[];
  verifiedSha?: string;
}

export type PolicyDecision =
  | { kind: "act"; after: "veto" | "now"; vetoMs: number; rule: string }
  | { kind: "ask"; reason: string; rule: string }
  | { kind: "watch"; rule: string };

export interface PrSnapshot {
  ghRepo: string;
  number: number;
  url: string;
  headSha: string;
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: string;
  requiredApprovals: number;
  strictUpToDate: boolean;
  failingChecks: string[];
  pendingChecks: string[];
  missingRequired: string[];
  mergeCommitSha?: string;
  /** Paths changed; a rename lists its old and its new path. */
  files: string[] | null;
  /** The base branch's rules could not be read, so required checks and
   *  reviews are unknown and Sessions does not merge. */
  rulesUnreadable?: true;
  fetchedAt: string;
}

export interface CandidateState {
  round: number;
  plan: CandidatePlan;
  check: CandidateCheck;
  claims: Claim[];
  notePath: string;
  runbookPaths: string[];
  prUrl?: string;
  pr?: PrSnapshot;
  rollbackFirst?: boolean;
}

export interface MergeRecord {
  ghRepo: string;
  number: number;
  sha: string;
  status: "merged" | "refused";
  mergedSha?: string;
  method?: string;
  at: string;
  detail?: string;
}

export interface ActionRun {
  id: string;
  round: number;
  actionId: string;
  kind: ActionKind;
  label: string;
  runner: string;
  /** `interrupted`: Sessions restarted mid-run. `unknown`: a Runner
   *  problem, so it may or may not have run. Neither is ever run again
   *  without a person. */
  status: "running" | "ok" | "failed" | "interrupted" | "unknown";
  purpose: "plan" | "auto-rollback" | "rollback-first" | "owner-rollback";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  detail: string;
  ref?: string;
  secretTouched: boolean;
}

export interface DeadlineWindow {
  startedAt: string;
  deadline: string;
}

export const NEEDS_YOU_KINDS = [
  "policy",
  "protection",
  "stopped",
  "budget",
  "rounds",
  "agent-error",
  "no-report",
  "no-candidate",
  "question",
  "proof-stopped",
  "merge",
  "action-failed",
  "interrupted",
  "no-action",
  "setup",
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** Where a person fixes a setup problem: the settings section to open. */
export type SetupFix = "sandboxes" | "providers";

export const OWNER_DECISIONS = [
  "stop",
  "deploy-now",
  "approve",
  "send-back",
  "retry",
  "resolve",
  "close",
  "roll-back",
] as const;
export type OwnerDecision = (typeof OWNER_DECISIONS)[number];

/**
 * `options` on `watching` and `done` is `["roll-back"]` when a manual
 * rollback is available, else `[]`.
 */
export type NextAction =
  | { kind: "working"; detail: string }
  | { kind: "veto"; deadline: string; rule: string }
  | {
      kind: "needs-you";
      reason: string;
      needsYou: NeedsYouKind;
      rule?: string;
      /** A setup problem: where it is fixed. */
      fix?: SetupFix;
      options: OwnerDecision[];
    }
  | { kind: "watching"; deadline: string; options: OwnerDecision[] }
  | { kind: "info"; detail: string; rule?: string }
  | { kind: "done"; detail: string; options: OwnerDecision[] };

/** `month` is the UTC calendar month, `YYYY-MM`. */
export interface ProjectSpend {
  month: string;
  monthUsd: number;
  perMonthUsd: number;
}

export type LedgerKind =
  | "agent-started"
  | "agent-finished"
  | "agent-message"
  | "proof"
  | "verdict"
  | "policy"
  | "veto"
  | "merge"
  | "action"
  | "decision"
  | "budget"
  | "release";

export interface LedgerEntry {
  id: string;
  at: string;
  actor: "sessions" | "investigator" | "verifier" | "owner";
  kind: LedgerKind;
  detail: string;
  by?: string;
  sessionId?: string;
  runner?: string;
  secretTouched?: boolean;
  costUsd?: number;
}

export const RESPONSE_PHASES = [
  "idle",
  "investigating",
  "proving",
  "verifying",
  "deciding",
  "veto",
  "merging",
  "deploying",
  "watching",
  "rolling-back",
  "documenting",
  "needs-you",
  "paused",
  "watch-only",
  "done",
] as const;
export type ResponsePhase = (typeof RESPONSE_PHASES)[number];

export type SendBackReason =
  | { kind: "not-certain"; reasons: string[] }
  | { kind: "owner"; by: string; note: string }
  | { kind: "rolled-back"; detail: string }
  | { kind: "reopened"; detail: string }
  | { kind: "check-failed"; detail: string };

export interface IncidentResponse {
  phase: ResponsePhase;
  round: number;
  maxRounds: number;
  coordinatorSessionId?: string;
  automationId?: string;
  agents: AgentRun[];
  candidate?: CandidateState;
  proof?: ProofResult;
  verdict?: Verdict;
  decision?: PolicyDecision;
  veto?: DeadlineWindow;
  merge?: MergeRecord;
  actionRuns: ActionRun[];
  watch?: DeadlineWindow;
  mergingSince?: string;
  documentingSince?: string;
  costUsd: number;
  ownerTouched: boolean;
  ownerRollback?: { by: string; at: string };
  sendBack?: SendBackReason;
  retryRequested?: boolean;
  /** Rollback-first only: the investigator that studies the release in
   *  parallel is best effort. Set when it could not start (`unavailable`:
   *  no model, workspace or session; `refused`: the budget or the access
   *  gate); the rollback goes on without it. */
  parallelInvestigator?: "unavailable" | "refused";
  /** Rollback-first only: the access gate refused the parallel
   *  investigator for a passing reason (not the budget). The rollback goes
   *  on, and the investigator is tried again from this time. */
  parallelInvestigatorRetryAt?: string;
  pausedFrom?: ResponsePhase;
  needsYou?: {
    kind: NeedsYouKind;
    reason: string;
    since: string;
    resumePhase: ResponsePhase;
    /** A setup problem: false while starting the agents again would fail
     *  the same way, so Try again is not offered. Absent means it may. */
    retryable?: boolean;
    /** A setup problem: where it is fixed. */
    fix?: SetupFix;
  };
  note?: { prUrl?: string; pr?: PrSnapshot; merged: boolean; detail?: string };
  next: NextAction;
  ledger: LedgerEntry[];
  droppedLedger: number;
  startedAt: string;
  updatedAt: string;
}

/** A veto countdown as `m:ss`, seconds rounded up, never negative. */
export function formatVetoRemaining(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function describeIndependence(i: Independence): string {
  switch (i) {
    case "other-provider":
      return "Verifier · different provider";
    case "same-provider":
      return "Verifier · same provider, different model";
    case "same-model":
      return "Verifier · same model";
  }
}
