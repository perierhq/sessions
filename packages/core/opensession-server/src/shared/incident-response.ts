// Wire types for the incident response loop (agents, proof, policy,
// actions), shared by the server and the frontend. Types, constant lists
// and small pure helpers only.

import type { FindingsSet, OwnerOption, OwnerOptionAction } from "./findings";
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
  /** What one post-release check may spend: it only checks, so less than
   *  an investigator or a verifier. Absent: DEFAULT_CHECK_BUDGET_USD, at
   *  most the per-incident budget. */
  perCheckUsd?: number;
}

/** A post-release check's budget when the project sets none. */
export const DEFAULT_CHECK_BUDGET_USD = 2;

/** What one post-release check may spend under `budget`. */
export function checkBudgetUsd(budget: IncidentBudget): number {
  return Math.min(
    budget.perCheckUsd ?? DEFAULT_CHECK_BUDGET_USD,
    budget.perIncidentUsd,
  );
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
  /** Signals keep checking but open and reopen no incident. */
  incidentsPaused: boolean;
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

/**
 * "2 of 2", or past the limit (a person sent the work back once the rounds
 * were used up) "3, an extra round past the limit of 2": never "3 of 2".
 */
export function roundOfMax(round: number, maxRounds: number): string {
  return round <= maxRounds
    ? `${round} of ${maxRounds}`
    : `${round}, an extra round past the limit of ${maxRounds}`;
}
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

/** What was wrong with a refused report, so the owner reads plain words
 *  instead of the parser's detail. */
export type ReportProblem =
  | "missing"
  | "unreadable"
  | "conclusion"
  | "evidence"
  | "decision"
  | "action"
  | "check"
  | "claims"
  | "note"
  | "pr";
/** One thing wrong with a refused report: what the owner is told about it
 *  and the parser's detail, which goes back to the agent. */
export interface ReportIssue {
  problem: ReportProblem;
  error: string;
  /** The rule it broke, as the server's report rules name it. */
  rule?: string;
}
export type Independence = "other-provider" | "same-provider" | "same-model";

export type EvidenceCost = "free" | "cheap" | "expensive";
/** What one step of the investigation showed. `informative` is a step that
 *  gathered context without confirming or ruling anything out. */
export type EvidenceResult =
  | "ruled-out"
  | "confirmed"
  | "inconclusive"
  | "informative";
export const EVIDENCE_RESULTS: readonly EvidenceResult[] = [
  "ruled-out",
  "confirmed",
  "inconclusive",
  "informative",
];
export interface EvidenceRow {
  step: string;
  cost: EvidenceCost;
  result: EvidenceResult;
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

/**
 * What an investigator may suggest the owner do next, each one mapped onto
 * something the incident card can already do. `send-back` is Send it back
 * with a prefilled note, `open-settings` only opens a project settings
 * section, `close-provider` is Close without action (a signal that fails
 * again opens or reopens an incident). None of them is a new server action.
 */
export const NEXT_STEP_KINDS = [
  "send-back",
  "open-settings",
  "close-provider",
] as const;
export type NextStepKind = (typeof NEXT_STEP_KINDS)[number];

/** The project settings an `open-settings` step may open. */
export const NEXT_STEP_TARGETS = [
  "access",
  "production",
  "signals",
  "models",
  "sandbox",
] as const;
export type NextStepTarget = (typeof NEXT_STEP_TARGETS)[number];

/** The most next steps a report keeps, and their longest title and why. */
export const NEXT_STEPS_MAX = 3;
export const NEXT_STEP_TITLE_MAX = 60;
export const NEXT_STEP_WHY_MAX = 200;

/** `why` is empty when the investigator gave none. */
export type NextStep =
  | { kind: "send-back"; title: string; why: string; payload: string }
  | {
      kind: "open-settings";
      title: string;
      why: string;
      payload: NextStepTarget;
    }
  | { kind: "close-provider"; title: string; why: string };

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
  /** Suggested next steps for the owner, at most NEXT_STEPS_MAX. */
  nextSteps?: NextStep[];
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

/** What the post-release check found in production once the fix was out:
 *  `confirmed` (it behaves as designed), `not-confirmed` (it couldn't
 *  show that, or the fix isn't live), `regressed` (worse, or broken in a
 *  new way). */
export type PostReleaseVerdict = "confirmed" | "not-confirmed" | "regressed";
export const POST_RELEASE_VERDICTS: readonly PostReleaseVerdict[] = [
  "confirmed",
  "not-confirmed",
  "regressed",
];
export interface PostReleaseReport {
  role: "post-release";
  verdict: PostReleaseVerdict;
  reasons: string[];
  checks: ClaimCheck[];
}

/**
 * The read-only check Sessions runs in production once the fix is live:
 * started (`running`), its verdict, or `skipped` when it could not run or
 * finish (the budget, no model, an error); the watch alone decides then.
 */
/** The release a hand-released fix's watch starts from. */
export interface IncidentReleaseSeen {
  at: string;
  source: "hook" | "release-pr" | "merge";
  ref?: string;
}

/** Failures a watch keeps. */
export const WATCH_FAILURES_MAX = 20;

export interface PostReleaseCheck {
  round: number;
  status: "running" | "skipped" | PostReleaseVerdict;
  at: string;
  sessionId?: string;
  /** The release it checked: the deploy action's run, a release Sessions
   *  recorded, or the merge itself. */
  after: string;
  reasons?: string[];
  checks?: ClaimCheck[];
  /** Other parts than the one the incident opened on that failed after
   *  the release, newest failure of each: they don't count against the
   *  fix and go to an incident of their own. */
  otherParts?: Array<{ at: string; detail: string }>;
}

export type AgentWorkspace =
  | { kind: "sandbox"; provider: string }
  | { kind: "host"; user: string };

export function describeWorkspace(w: AgentWorkspace): string {
  if (w.kind === "host") return "Runs on this server, not in a sandbox";
  return w.provider === "podman"
    ? "Runs in a container on this server"
    : `Runs in the ${w.provider} sandbox`;
}

export type CancelReason =
  | "paused"
  | "provider"
  | "budget"
  | "timeout"
  | "stopped"
  | "closed"
  /** A post-release check at its own budget (IncidentBudget.perCheckUsd). */
  | "check-budget";

/**
 * One run per agent session. A send-back reuses the investigator's run and
 * moves its `round` forward; a new session is a new `attempt`. When the
 * role's access was widened since the run's session started, the send-back
 * starts a new session instead and the old run names it in `supersededBy`.
 * `accessSummary` and `accessRevision` are plan 3's `AgentAccess.summary`
 * and `revision` at spawn.
 */
/** A round a session already finished, kept when a send-back moves the same
 *  session on to the next round (the run's own report and times are then
 *  the new round's). */
export interface PastRound {
  round: number;
  startedAt: string;
  endedAt?: string;
  report?: InvestigatorReport | VerifierReport | PostReleaseReport;
}

export interface AgentRun {
  role: AgentRole;
  /** A post-release check: a verifier session started after the fix was
   *  live. Its report is on `IncidentResponse.postRelease`, not here. */
  check?: "post-release";
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
  report?: InvestigatorReport | VerifierReport | PostReleaseReport;
  /** The parser's detail on a refused report; for the agent and logs. */
  reportError?: string;
  /** What the owner is told about a refused report. */
  reportProblem?: ReportProblem;
  /** Everything wrong with a refused report, so one reminder asks for
   *  every fix; a missing pull request is one of them. */
  reportIssues?: ReportIssue[];
  /** Values Sessions repaired in an otherwise valid report. */
  reportWarnings?: string[];
  reminded: boolean;
  /** A post-release check stopped at its budget and asked once to report
   *  from what it has. */
  wrappedUp?: boolean;
  /** The session that took over the next round, when this one's access
   *  was widened after it started. */
  supersededBy?: string;
  /** When a send-back moved this session to its current round; `startedAt`
   *  stays the session's own start. */
  roundStartedAt?: string;
  /** The rounds this session finished before a send-back, oldest first. */
  pastRounds?: PastRound[];
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
  /** The baseline did not fail, and the proof went on to the verifier
   *  anyway: the investigator said the fix can only be shown after release
   *  (`after-release`), or the signal fails on and off (`intermittent`).
   *  The verifier then decides what it can prove (`proofAccepted`). */
  deferred?: ProofDeferral;
}

export type ProofDeferral = "after-release" | "intermittent";

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

/**
 * A pull request already merged that may be the incident's fix: one of its
 * own agents' (merged before the card went up), or one the latest round's
 * agents named (`named`), merged since the incident opened. `at` is when
 * GitHub last changed it, the merge for a merged pull request.
 */
export interface MergedFix {
  url: string;
  number: number;
  at: string;
  headSha?: string;
  named?: true;
}

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
  /** Every check failed because GitHub Actions did not run it (a billing
   *  or spending limit, say): why, as GitHub put it. */
  actionsBlocked?: string;
  /** With `actionsBlocked`: the workflow runs of those checks, which
   *  Sessions re-runs once GitHub Actions works again. */
  blockedRuns?: number[];
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
  "unproven",
  "merge",
  "action-failed",
  "interrupted",
  "no-action",
  "setup",
  "post-release",
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
  "close-prs",
  "keep-prs",
  "release-watch",
  "released-watch",
  "merge",
  "answer",
] as const;
export type OwnerDecision = (typeof OWNER_DECISIONS)[number];

/** The decision each agent option posts. */
export const OPTION_DECISION: Readonly<
  Record<OwnerOptionAction, OwnerDecision>
> = Object.freeze({
  merge: "merge",
  "release-watch": "release-watch",
  "send-back": "send-back",
  close: "close",
  "mark-fixed": "resolve",
  answer: "answer",
});

/** An agent's option as the card offers it: Sessions checked that it can
 *  do it now. `recommended` marks the agent's first option. */
export interface AgentOption extends OwnerOption {
  decision: OwnerDecision;
  role: AgentRole;
  recommended?: true;
}

/**
 * Send it back and Answer carry a note: what the investigator should do
 * differently in its next round, or the answer to an agent's question.
 * Every other decision is complete on its own. The longest note the server
 * keeps.
 */
export const SEND_BACK_NOTE_MAX = 2000;

/**
 * A note the owner added without a decision: what they know or did (a
 * release, an upstream outage). It changes nothing by itself; the agents'
 * next prompt carries it (`sentAt` once one did), and every brief of a
 * fresh session does. At most SEND_BACK_NOTE_MAX characters.
 */
export interface OwnerNote {
  at: string;
  by: string;
  text: string;
  sentAt?: string;
}

/** The most notes an incident keeps; the oldest go first. */
export const OWNER_NOTES_MAX = 20;

/**
 * `options` on `watching` and `done` is `["roll-back"]` when a manual
 * rollback is available, else `[]`. Closed without action with code-fix
 * pull requests still open (`openPrs`), `done` offers
 * `["close-prs", "keep-prs"]`.
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
      /** The agent's own options for this decision. When there are any,
       *  the card offers only these; `options` stay for its menu. */
      agentOptions?: AgentOption[];
      /** The agent's question the options answer. */
      agentQuestion?: string;
    }
  | { kind: "watching"; deadline: string; options: OwnerDecision[] }
  | { kind: "info"; detail: string; rule?: string }
  | { kind: "done"; detail: string; options: OwnerDecision[] };

/**
 * The decisions a needs-you card offers. With the agent's own options, the
 * card offers those, Send it back when its options have it (the card's
 * typed note), Close when they have it (the card's menu) and I released
 * it, watch when they have it (no agent knows the fix merged meanwhile;
 * after the agent's options). Otherwise it
 * offers its options. The web card shows these (frontend
 * lib/incidents/next-action.ts), and the server accepts no other decision
 * while the card is up (coordinator.ts decisionAllowed).
 */
export function needsYouCardDecisions(
  next: Extract<NextAction, { kind: "needs-you" }>,
): OwnerDecision[] {
  if (!next.agentOptions?.length) return next.options;
  const offered = new Set(next.agentOptions.map((o) => o.decision));
  for (const d of ["send-back", "close", "released-watch"] as const)
    if (next.options.includes(d)) offered.add(d);
  return [...offered];
}

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
  | "release"
  | "note";

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

/** What a round's verifier found, carried into a send-back so the next
 *  round weighs it: the verdict's reasons, its claim checks and its
 *  findings' questions and hypotheses. */
export interface VerifierFindings {
  round: number;
  reasons: string[];
  claims: ClaimCheck[];
  questions: Array<{ text: string; wouldAnswer: string }>;
  hypotheses: string[];
}

/** What earlier rounds' verifiers found that no later verifier said again
 *  or settled, oldest first (`earlierVerifierFindings`). */
export type EarlierVerifierFindings = VerifierFindings[];

export type SendBackReason =
  | {
      kind: "not-certain";
      reasons: string[];
      verifier?: VerifierFindings;
      earlier?: EarlierVerifierFindings;
    }
  | {
      kind: "owner";
      by: string;
      note: string;
      /** The needs-you reason the owner answered by sending it back. */
      answering?: string;
      /** The verifier's findings, when the round sent back had one. */
      verifier?: VerifierFindings;
      earlier?: EarlierVerifierFindings;
    }
  | { kind: "rolled-back"; detail: string }
  | { kind: "reopened"; detail: string }
  | { kind: "check-failed"; detail: string };

/** A pull request one of the incident's agents opened. */
export interface AgentPullRequest {
  url: string;
  number: number;
  sessionId: string;
}

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
  /** The owner releases the candidate's pull request by hand: Sessions
   *  merges and deploys nothing, waits for the merge, then watches. With
   *  `merger: "sessions"` (the owner chose an agent's Merge option on a
   *  project with no deploy action) Sessions merges it through the merge
   *  gate and then waits for the release the same way. */
  handRelease?: {
    by: string;
    at: string;
    prUrl: string;
    number: number;
    merger?: "sessions";
  };
  /** The owner's notes without a decision, oldest first, at most
   *  OWNER_NOTES_MAX. */
  ownerNotes?: OwnerNote[];
  /** Pull requests of this incident (their URLs) that were merged or
   *  closed outside Sessions and that it already acted on, so a later card
   *  doesn't act on them again. */
  settledPrs?: string[];
  /** The owner's answer to an agent's question, on its way to that
   *  agent's session as its next prompt (no new round). */
  answer?: {
    by: string;
    at: string;
    note: string;
    sessionId: string;
    role: AgentRole;
  };
  /** A waiting card whose pull request's checks GitHub Actions never ran:
   *  when Sessions last looked whether Actions works for the repository
   *  again. */
  actionsCheckedAt?: string;
  /** The round's fix is verified again (a new verifier attempt, no new
   *  investigator round): GitHub Actions came back and its checks ran. */
  reverify?: { at: string; reason: string };
  /** The read-only check of production after the fix went out. */
  postRelease?: PostReleaseCheck;
  /** A fix released by hand: the release the watch started from, once
   *  Sessions saw one after the merge (the release hook, a merged release
   *  pull request), or the merge itself when no release can be seen. */
  release?: IncidentReleaseSeen;
  /** Failed checks of the incident's signal during the watch, with what
   *  each said; `samePart` when it is the part the incident opened on.
   *  Newest last, at most WATCH_FAILURES_MAX. */
  watchFailures?: Array<{ at: string; detail: string; samePart: boolean }>;
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
    /** The incident's agents' pull requests still open when the card
     *  appeared, named on the card. */
    prs?: AgentPullRequest[];
    /** The card was brought up to date because the signal failed again
     *  (its `lastProblemAt` then). Such a card alerts at most once a day. */
    failedAgainAt?: string;
    /** A fix already merged that the owner may say they released, for
     *  Sessions to watch after (I released it, watch). */
    mergedFix?: MergedFix;
  };
  /** The failed check the incident opened on (its detail names a status
   *  page's failing parts), for telling a different part's failure apart. */
  openedOn?: { at: string; detail: string };
  /** Failures of other parts than the one the incident opened on, while it
   *  waited on its owner: newest last, at most OTHER_FAILURES_MAX. */
  otherFailures?: Array<{ at: string; detail: string }>;
  note?: { prUrl?: string; pr?: PrSnapshot; merged: boolean; detail?: string };
  /** Closed without action: pull requests the incident's agents opened that
   *  change code, left open for the owner to close or keep. Their note-only
   *  pull requests are closed without asking. */
  openPrs?: AgentPullRequest[];
  next: NextAction;
  ledger: LedgerEntry[];
  droppedLedger: number;
  /** Agent-composed findings, one set per (role, round); see shared/findings.ts. */
  findingSets?: FindingsSet[];
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
