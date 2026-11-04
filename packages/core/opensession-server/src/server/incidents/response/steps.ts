// The fix loop as data: what the coordinator knows when it decides
// (`ResponseView`) and the one step it applies next (`ResponseStep`).
// Types and constants only.
import type {
  ActionRun,
  AgentRole,
  CancelReason,
  IncidentProjectSettings,
  IncidentResponse,
  InvestigatorReport,
  LedgerKind,
  MergedFix,
  NeedsYouKind,
  PostReleaseReport,
  PolicyDecision,
  ReportIssue,
  ReportProblem,
  ResponsePhase,
  SetupFix,
  VerifierReport,
} from "../../../shared/incident-response";
import type {
  FixedBy,
  Incident,
  IncidentState,
  Observation,
  Signal,
  SignalEvaluation,
} from "../../../shared/incidents";
import type { AgentLive } from "./agents";
import type { RoleModels } from "./models";

/** An agent turn longer than this is cancelled and the owner asked. */
export const AGENT_MAX_MS = 7_200_000;
/** A PR snapshot older than this is fetched again before it is used. */
export const PR_REFRESH_MS = 30_000;
/** Checks still pending this long after merging began ask the owner. */
export const PR_CHECKS_WAIT_MS = 1_200_000;
/** How often a pull request the owner releases by hand is read from GitHub
 *  when the PR cache doesn't know it. */
export const HAND_RELEASE_REFRESH_MS = 600_000;
/** How often a pull request whose checks GitHub Actions did not run is
 *  read again while the owner fixes it. */
export const ACTIONS_RECHECK_MS = 600_000;
/** How often a card that holds Deploy the fix back for failing checks
 *  reads its pull request again. */
export const CHECKS_RECHECK_MS = 600_000;
/** A release this close before the incident opened is rolled back first. */
export const ROLLBACK_FIRST_WINDOW_MS = 1_800_000;
/** Rollback-first's parallel investigator, refused by the access gate for a
 *  passing reason, is tried again after this long. */
export const PARALLEL_INVESTIGATOR_RETRY_MS = 60_000;
/** A finished agent with no final message after this long has no report. */
export const FINAL_TEXT_GRACE_MS = 60_000;

export interface ResponseView {
  now: number;
  incident: Incident;
  settings: IncidentProjectSettings;
  /** The incident's signals that still exist. */
  signals: ReadonlyMap<string, Signal>;
  evaluations: ReadonlyMap<string, SignalEvaluation>;
  primaryRecent: Observation[];
  /** Only for an incident that closes once it recovers
   *  (`closesWhenRecovered`): each own signal's passing checks in a row at
   *  the end of its recent observations, as its rule counts them. */
  passes?: ReadonlyMap<string, number>;
  /** Only for a setup problem: whether the agents could start now, and if
   *  not, where that is fixed. */
  setup?: { ready: boolean; fix?: SetupFix };
  /** The project's agent cost spent this UTC month, this incident
   *  excluded. The guards add this incident's whole cost to it. */
  monthCostUsd: number;
  /** Live status by session id; `finalText` only for finished agents. */
  agents: ReadonlyMap<string, AgentLive & { finalText?: string }>;
  /** Action runs this process is executing right now. */
  liveActionRunIds: ReadonlySet<string>;
  models: RoleModels | { error: string };
  /** Only while the owner releases the fix by hand: its pull request's
   *  state as the PR cache has it, undefined when the cache doesn't know. */
  handReleasePr?: "OPEN" | "MERGED" | "CLOSED";
  /** Only while a hand-released fix waits for its release: the project's
   *  release pull requests the PR cache knows (release-please and the
   *  like), with the time each was last updated. */
  releasePrs?: ReleasePr[];
  /** Only then, with release pull requests merged since: the files the
   *  hand-released fix changed, to tell which release holds it. */
  fixFiles?: readonly string[];
  /** Only while the incident waits on its owner: its agents' pull
   *  requests (any round's) as the PR cache has them, the ones it doesn't
   *  know left out. */
  prs?: KnownPr[];
  /** Only while the incident waits on its owner: a fix already merged the
   *  owner may say they released (outside.ts `mergedFixFor`). */
  mergedFix?: MergedFix;
}

/** One of the incident's pull requests as the PR cache has it. */
export interface KnownPr {
  url: string;
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** When GitHub last changed it (a comment or a label moves it too). */
  updatedAt: string;
  /** When it merged; absent unless merged, or when the PR cache's row
   *  predates the field (then Sessions doesn't act on the merge). */
  mergedAt?: string;
  headSha?: string;
  /** The round whose agent opened it. */
  round: number;
}

/** A release pull request of the project, as the PR cache has it. */
export interface ReleasePr {
  url: string;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  updatedAt: string;
  /** The files it changed, once Sessions read them (merged ones after
   *  the fix only); null when they couldn't be read. */
  files?: readonly string[] | null;
}

/** How long a merged fix waits for its release before asking the owner. */
export const RELEASE_WAIT_MS = 24 * 3_600_000;
/** How long the post-release check may run before Sessions stops it and
 *  the watch decides alone. */
export const CHECK_MAX_MS = 1_800_000;

export type ResponseStep =
  | { step: "none" }
  | { step: "init"; rollbackFirst: boolean }
  | {
      step: "start-agent";
      role: AgentRole;
      round: number;
      attempt: number;
      /** A post-release check (a verifier session), and what went out. */
      check?: "post-release";
      after?: string;
    }
  | {
      step: "skip-parallel-investigator";
      outcome: "unavailable" | "refused";
      reason: string;
    }
  | {
      step: "message-agent";
      sessionId: string;
      /** `answer`: the owner's answer to the agent's question, as its
       *  next prompt in the same round. */
      message: "send-back" | "reminder" | "answer";
    }
  | {
      step: "record-report";
      sessionId: string;
      report?: InvestigatorReport | VerifierReport | PostReleaseReport;
      error?: string;
      problem?: ReportProblem;
      /** Every problem with a refused report, for one reminder. */
      issues?: ReportIssue[];
      /** Values Sessions repaired in the report instead of refusing it. */
      warnings?: string[];
      /** The pull request the agent opened from its session branch. */
      prUrl?: string;
      /** A report refused for want of a pull request, read again on a
       *  Retry now that its pull request is found. */
      reread?: boolean;
      /** The accepted report's raw `findings` value, for `applyFindings`;
       *  absent when the report has no such key. */
      findings?: unknown;
    }
  | { step: "cancel-agents"; reason: string; for: CancelReason }
  | { step: "run-proof" }
  | {
      step: "fetch-pr";
      /** `recheck`: a waiting card's pull request read again; an error
       *  leaves the card as it is. */
      purpose: "verify" | "merge" | "note" | "recheck";
    }
  | {
      step: "transition";
      to: IncidentState | null;
      phase: ResponsePhase;
      detail: string;
      patch?: Partial<IncidentResponse>;
      fixedBy?: FixedBy;
      /** Also a ledger line of this kind, with `detail`. */
      log?: LedgerKind;
    }
  | {
      step: "needs-you";
      kind: NeedsYouKind;
      reason: string;
      rule?: string;
      /** A setup problem that a retry cannot get past yet, and where it is
       *  fixed. */
      retryable?: boolean;
      fix?: SetupFix;
      /** The card is brought up to date because the signal failed again. */
      failedAgainAt?: string;
      patch?: Partial<IncidentResponse>;
      /** A state the incident passes through first, so a person picks the
       *  work up from there. */
      via?: IncidentState;
    }
  | {
      step: "open-veto";
      decision: Extract<PolicyDecision, { kind: "act" }>;
    }
  | { step: "merge" }
  | { step: "run-action"; actionId: string; purpose: ActionRun["purpose"] }
  | {
      step: "start-watch";
      /** How long it lasts; the project's watch window when absent. */
      ms?: number;
    }
  | {
      step: "resolve";
      fixedBy: FixedBy;
      detail: string;
      /** The signal still fails on another part than the one the incident
       *  opened on: its newest such failure, for an incident of its own. */
      split?: { at: string; detail: string };
    }
  | { step: "merge-note" }
  /** A card whose pull request's checks GitHub Actions never ran: look
   *  whether Actions works again, and if so re-run them and verify the fix
   *  again (no new investigator round). */
  | { step: "actions-recheck" };
