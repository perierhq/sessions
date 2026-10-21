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
  NeedsYouKind,
  PolicyDecision,
  ResponsePhase,
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
  /** The project's agent cost spent this UTC month, this incident
   *  excluded. The guards add this incident's whole cost to it. */
  monthCostUsd: number;
  /** Live status by session id; `finalText` only for finished agents. */
  agents: ReadonlyMap<string, AgentLive & { finalText?: string }>;
  /** Action runs this process is executing right now. */
  liveActionRunIds: ReadonlySet<string>;
  models: RoleModels | { error: string };
}

export type ResponseStep =
  | { step: "none" }
  | { step: "init"; rollbackFirst: boolean }
  | { step: "start-agent"; role: AgentRole; round: number; attempt: number }
  | {
      step: "skip-parallel-investigator";
      outcome: "unavailable" | "refused";
      reason: string;
    }
  | {
      step: "message-agent";
      sessionId: string;
      message: "send-back" | "reminder";
    }
  | {
      step: "record-report";
      sessionId: string;
      report?: InvestigatorReport | VerifierReport;
      error?: string;
    }
  | { step: "cancel-agents"; reason: string; for: CancelReason }
  | { step: "run-proof" }
  | { step: "fetch-pr"; purpose: "verify" | "merge" | "note" }
  | {
      step: "transition";
      to: IncidentState | null;
      phase: ResponsePhase;
      detail: string;
      patch?: Partial<IncidentResponse>;
      fixedBy?: FixedBy;
    }
  | {
      step: "needs-you";
      kind: NeedsYouKind;
      reason: string;
      rule?: string;
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
  | { step: "start-watch" }
  | { step: "resolve"; fixedBy: FixedBy; detail: string }
  | { step: "merge-note" };
