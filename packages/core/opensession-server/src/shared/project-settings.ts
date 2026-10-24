// Wire types for per-project settings, shared by the server and the
// frontend: the stored project document, the patch the project page sends,
// and the views the server computes for it (effective sandbox and models,
// the role-by-capability access table, the readiness checklist) and for the
// global Defaults page. Types, constant lists and small pure helpers only.

import type {
  AccessMode,
  AccessProfileFields,
  CredentialGrantMode,
  EgressRoute,
  IncidentAgentRole,
} from "./incident-access";
import {
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  type AutonomyLevel,
  type IncidentAction,
  type IncidentBudget,
  type IncidentRelease,
  type NeverWithoutYou,
  type NightRule,
} from "./incident-response";

// ── Roles ────────────────────────────────────────────────────────────────

/** Every role, in the order the nav, models, sandbox and table use. */
export const PROJECT_ROLES = [
  "you",
  "automations",
  "investigator",
  "verifier",
  "reviews",
] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The roles that run without a person at the keyboard. */
export const UNATTENDED_ROLES = [
  "automations",
  "investigator",
  "verifier",
  "reviews",
] as const;
export type UnattendedRole = (typeof UNATTENDED_ROLES)[number];

/** The incident agents: the only roles with keychain and host enforcement. */
export type IncidentRole = IncidentAgentRole;

export const ROLE_LABELS: Record<ProjectRole, string> = {
  you: "You",
  automations: "Automations",
  investigator: "Investigator",
  verifier: "Verifier",
  reviews: "Reviews",
};

export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  you: "New sessions. You can still switch in the composer",
  automations: "Scheduled and triggered runs",
  investigator: "Incidents: finds the cause and drafts the fix",
  verifier: "Incidents: proves the fix on a different provider",
  reviews: "Pull request reviews and fixes",
};

/** The collective label when Investigator and Verifier share one value. */
export const INCIDENT_AGENTS_LABEL = "Incident agents";

export function isProjectRole(v: unknown): v is ProjectRole {
  return (
    typeof v === "string" && (PROJECT_ROLES as readonly string[]).includes(v)
  );
}

export function isUnattendedRole(v: unknown): v is UnattendedRole {
  return (
    typeof v === "string" && (UNATTENDED_ROLES as readonly string[]).includes(v)
  );
}

// ── The stored document ──────────────────────────────────────────────────

/** `"default"` uses the global default, `"local"` is this machine without a
 *  sandbox, anything else is a sandbox provider id (`"podman"` is this
 *  machine in a container). */
export type SandboxChoice = "default" | "local" | (string & {});
/** `"default"` uses the global default, `"same"` opens previews beside the
 *  session, anything else is a sandbox provider id. */
export type PreviewsChoice = "default" | "same" | (string & {});

export interface ProjectIncidentPolicy {
  agentsPaused: boolean;
  autonomy: AutonomyLevel;
  vetoMs: number;
  watchMs: number;
  maxRounds: number;
  night?: NightRule;
  neverWithoutYou: NeverWithoutYou[];
  budget: IncidentBudget;
}

export interface ProjectProduction {
  runners: string[];
  actions: IncidentAction[];
  releases: IncidentRelease[];
}

export interface ProjectCredentialRow {
  credential: string;
  roles: Partial<Record<IncidentRole, CredentialGrantMode>>;
  grantedBy: string;
  grantedByLogin?: string;
  grantedAt: string;
}

export interface ProjectHostRow {
  runner: string;
  ssh?: string;
  access: "read-only";
  roles: IncidentRole[];
}

export interface ProjectSignalException {
  signalId: string;
  role: IncidentRole;
  fields: Omit<AccessProfileFields, "model" | "runners">;
  updatedBy: string;
  updatedAt: string;
}

/** Web search for the roles listed; never the verifier. */
export type WebSearchRole = Exclude<UnattendedRole, "verifier">;

export interface ProjectAccess {
  modes: Record<UnattendedRole, AccessMode>;
  connections: Array<{ server: string; roles: UnattendedRole[] }>;
  credentials: ProjectCredentialRow[];
  hosts: ProjectHostRow[];
  websites: Array<{ host: string; roles: UnattendedRole[] }>;
  webSearch: WebSearchRole[];
  /** How each incident agent reaches the web; null means no egress. */
  routes: Record<IncidentRole, EgressRoute | null>;
  deniedTools: Record<IncidentRole, string[]>;
  signalExceptions: ProjectSignalException[];
}

export interface ProjectSettingsDocument {
  schema: 1;
  project: string;
  revision: number;
  sandbox: SandboxChoice;
  models: Partial<Record<ProjectRole, string>>;
  incidents: ProjectIncidentPolicy;
  production: ProjectProduction;
  access: ProjectAccess;
  automationId?: string;
  releaseHookSecret?: string;
  migratedAt?: string;
  updatedAt: string;
  updatedBy: string;
}

// ── The patch the project page sends ─────────────────────────────────────

export type AccessRowKey =
  | { kind: "mode" }
  | { kind: "connection"; server: string }
  | { kind: "credential"; credential: string }
  | { kind: "host"; runner: string; ssh?: string }
  | { kind: "website"; host: string }
  | { kind: "webSearch" };

/** The host of the "Any website" row in the access table: You may open
 *  any website; unattended runs need a list, so their cells are locked. */
export const ANY_WEBSITE_HOST = "*";

/** Why "Changes code" can't be set for Automations or Reviews: nothing
 *  reads it at run time. Each automation carries its own mode, and the
 *  GitHub flow picks one per kind of run. */
export const MODE_NOT_SET_HERE: Partial<Record<UnattendedRole, string>> = {
  automations: "Each automation sets its own mode",
  reviews:
    "Set per run: reviews only read; fixes and replies to mentions push to the pull request's branch",
};

/** `null` clears the cell (a credential not lent to that role). */
export type AccessCellChange = {
  row: AccessRowKey;
  role: UnattendedRole;
  value: boolean | AccessMode | CredentialGrantMode | null;
};

export interface ProjectSettingsPatch {
  /** The revision the page loaded; a stale one answers 409. */
  expectedRevision: number;
  sandbox?: SandboxChoice;
  previews?: PreviewsChoice;
  /** `null` clears the role back to the global default. */
  models?: Partial<Record<ProjectRole, string | null>>;
  incidents?: Partial<Omit<ProjectIncidentPolicy, "night">> & {
    night?: NightRule | null;
  };
  production?: { runners?: string[]; actions?: IncidentAction[] };
  access?: {
    cells?: AccessCellChange[];
    addRows?: AccessRowKey[];
    removeRows?: AccessRowKey[];
    removeSignalExceptions?: Array<{ signalId: string; role: IncidentRole }>;
  };
}

// ── Views the server computes ────────────────────────────────────────────

export type RunPlace =
  | {
      state: "ok";
      /** Sandbox provider id; `null` is this machine without a sandbox. */
      provider: string | null;
      label: string;
      source: "project" | "default" | "fallback";
    }
  | { state: "cant-start"; reason: string };

export interface EffectiveSandbox {
  you: RunPlace;
  reviews: RunPlace;
  automations: RunPlace;
  incidentAgents: RunPlace;
  note: string | null;
}

export type AccessCellValue =
  | "yes"
  | "no"
  | "branch"
  | "read"
  | "ask-once"
  | "ask-each"
  | "standing"
  | "locked"
  | "blocked";

export interface AccessCellView {
  value: AccessCellValue;
  editable: boolean;
  /** Why the cell can't be edited, or why it is blocked. */
  reason?: string;
}

export interface AccessRowView {
  key: AccessRowKey;
  title: string;
  detail?: string;
  warning?: { text: string; fix?: { kind: "allow-agents"; server: string } };
  cells: Record<ProjectRole, AccessCellView>;
}

export type AccessGroupId =
  | "code"
  | "connectors"
  | "keychain"
  | "production"
  | "websites"
  | "search";

export interface AccessTableView {
  groups: Array<{
    id: AccessGroupId;
    label: string | null;
    rows: AccessRowView[];
  }>;
  signalExceptions: ProjectAccess["signalExceptions"];
}

/** The checklist's steps, in their fixed order. */
export const READINESS_STEP_IDS = [
  "models",
  "where",
  "production",
  "signals",
  "deploy",
  "access",
] as const;
export type ReadinessStepId = (typeof READINESS_STEP_IDS)[number];
export const READINESS_TOTAL = 6;

export type ReadinessFix =
  | { kind: "providers" }
  | { kind: "connect-sandbox" }
  | { kind: "pair-runner" }
  | { kind: "add-signal" }
  | { kind: "add-action"; action: "deploy" | "rollback" }
  | { kind: "allow-agents"; server: string }
  | { kind: "unpause" };

export interface ReadinessStep {
  /** `"paused"` is a blocking problem, never one of the six steps. */
  id: ReadinessStepId | "paused";
  state: "ready" | "todo" | "blocked";
  title: string;
  detail: string;
  fix?: ReadinessFix;
}

export type ProjectStatus =
  | { kind: "off"; label: "Incidents off" }
  | { kind: "partial"; label: string }
  | { kind: "ready"; label: "Ready" }
  | { kind: "blocked"; label: "Can't start" };

export interface ProjectReadiness {
  /** To-dos first, then the ready steps. */
  steps: ReadinessStep[];
  readyCount: number;
  total: 6;
  blocking: ReadinessStep | null;
  status: ProjectStatus;
}

export interface ProjectRunnerView {
  id: string;
  name: string;
  online: boolean;
  platform: string;
  reserved: boolean;
}

export interface EffectiveRoleModel {
  model: string;
  label: string;
  source: "project" | "default";
}

export interface ProjectSettingsView {
  document: Omit<ProjectSettingsDocument, "releaseHookSecret"> & {
    releaseHookPath?: string;
  };
  previews: PreviewsChoice;
  effective: {
    sandbox: EffectiveSandbox;
    models: Record<ProjectRole, EffectiveRoleModel>;
  };
  access: AccessTableView;
  readiness: ProjectReadiness;
  runners: ProjectRunnerView[];
  monthSpendUsd: number;
  /** A legacy store changed after this project was migrated. */
  drift: boolean;
}

export interface ProjectListItem {
  id: string;
  label: string;
  status: ProjectStatus;
  sandboxForYou: string | null;
  modelForYou: string;
}

export interface ProjectDefaultsView {
  models: Record<ProjectRole, string>;
  /** Sandbox provider id, or `"none"`. */
  sandbox: string;
  /** Who uses the default sandbox, computed on the server. */
  sandboxUsedBy: string;
  previews: "same" | (string & {});
  websites: string[];
  projects: ProjectListItem[];
}

export type ProjectDefaultsPatch = {
  models?: Partial<Record<ProjectRole, string | null>>;
  sandbox?: string;
  previews?: "same" | (string & {});
  websites?: string[];
};

// ── Migration from the legacy stores ──────────────────────────────────────

export interface ProjectMigrationReport {
  project: string;
  /** What the new document can't hold, and why. */
  dropped: Array<{ field: string; item: string; why: string }>;
  access: "migrated" | "default" | "reset-unreadable";
}

export interface MigrationResult {
  /** `null` on a dry run. */
  backupPath: string | null;
  projects: ProjectMigrationReport[];
  personalDefaultsCleared: number;
  alreadyMigrated: string[];
}

/** One project composed from its legacy settings again (after drift). */
export interface ProjectRemigrateResult {
  project: string;
  report: ProjectMigrationReport;
  /** `null` until confirmed (`force`); the backup taken before writing. */
  backupPath: string | null;
  /** Whether the stored document was replaced. */
  overwritten: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** A project nobody has set anything for: every role on the global
 *  defaults, incident policy at today's defaults, no production, and the
 *  access today's defaults give (verifier read-only, no web search). */
export function defaultProjectDocument(
  project: string,
  now: string,
): ProjectSettingsDocument {
  return {
    schema: 1,
    project,
    revision: 0,
    sandbox: "default",
    models: {},
    incidents: {
      agentsPaused: false,
      autonomy: DEFAULT_AUTONOMY,
      vetoMs: DEFAULT_VETO_MS,
      watchMs: DEFAULT_WATCH_MS,
      maxRounds: DEFAULT_MAX_ROUNDS,
      neverWithoutYou: [...DEFAULT_NEVER_WITHOUT_YOU],
      budget: { ...DEFAULT_BUDGET },
    },
    production: { runners: [], actions: [], releases: [] },
    access: {
      modes: {
        automations: "code",
        investigator: "code",
        verifier: "ask",
        reviews: "code",
      },
      connections: [],
      credentials: [],
      hosts: [],
      websites: [],
      webSearch: ["automations", "investigator", "reviews"],
      routes: {
        investigator: { route: "server" },
        verifier: { route: "server" },
      },
      deniedTools: { investigator: [], verifier: [] },
      signalExceptions: [],
    },
    updatedAt: now,
    updatedBy: "sessions",
  };
}

/** The one status phrase for a project, used in the nav, the Defaults
 *  page and the phone list. Incidents off wins, then a blocking problem,
 *  then the count. */
export function projectStatusLabel(
  readiness: Pick<ProjectReadiness, "readyCount" | "blocking">,
  incidentsOn: boolean,
): ProjectStatus {
  if (!incidentsOn) return { kind: "off", label: "Incidents off" };
  if (readiness.blocking) return { kind: "blocked", label: "Can't start" };
  if (readiness.readyCount >= READINESS_TOTAL) {
    return { kind: "ready", label: "Ready" };
  }
  return {
    kind: "partial",
    label: `${readiness.readyCount} of ${READINESS_TOTAL} ready`,
  };
}
