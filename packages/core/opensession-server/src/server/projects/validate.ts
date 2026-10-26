// Validation shared by the project settings document (projects/store.ts) and
// the incident settings adapter (incidents/response/project-settings.ts):
// typed production actions, the night rule, the incident policy fields, the
// production Runners, the rules over a whole record and which changes loosen
// the incident policy. Pure apart from the Runner lookups.
import {
  ACTION_KINDS,
  ACTION_PLACEHOLDERS,
  AUTONOMY_LEVELS,
  NEVER_WITHOUT_YOU,
  type ActionCost,
  type ActionKind,
  type ActionScope,
  type IncidentAction,
  type IncidentProjectSettings,
  type NeverWithoutYou,
  type NightRule,
} from "../../shared/incident-response";
import type {
  ProjectIncidentPolicy,
  ProjectSettingsDocument,
} from "../../shared/project-settings";
import { sameModel } from "../incidents/response/models";
import {
  INCIDENT_SERVICE_USER,
  type Runner,
  getRunner,
  runnerAllowed,
} from "../runners";

export const MAX_RUNNERS = 10;
export const MAX_ACTIONS = 20;
const MAX_SCOPE_GLOBS = 50;

/** Why a paired Runner cannot be bound for incidents at all. */
export function runnerPlatformProblem(runner: Runner): string | null {
  return runner.platform === "win32"
    ? `Runner ${runner.name} runs Windows; incident checks and actions need macOS or Linux`
    : null;
}

/** Whether a paired Runner may run this project's checks and actions: it
 *  must be reserved for incidents (`bindProductionRunner`) and allow this
 *  project. Online state is reported elsewhere. */
export function productionRunnerProblem(
  runnerId: string,
  project: string,
): string | null {
  const runner = getRunner(runnerId);
  if (!runner) return `Runner ${runnerId} is not paired`;
  const platform = runnerPlatformProblem(runner);
  if (platform) return platform;
  if (!runner.incidentReserved)
    return `Runner ${runner.name} is not reserved for incidents. Bind it to ${project} first`;
  // Maintenance is a state, not policy: the run itself reports it.
  if (
    !runnerAllowed(
      { ...runner, maintenance: false },
      {
        user: INCIDENT_SERVICE_USER,
        repo: project,
        permission: "commands",
        incidentService: true,
      },
    )
  )
    return `Runner ${runner.name} does not allow commands for ${project}`;
  return null;
}

// ── Validation ──────────────────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type Result<T> = T | { error: string };
export function failed<T>(r: Result<T>): r is { error: string } {
  return typeof r === "object" && r !== null && "error" in r;
}

export function integerIn(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

export function numberIn(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function validateNight(value: unknown): Result<NightRule> {
  if (!isRecord(value))
    return {
      error: "Night rule (night) needs a start, an end and a time zone",
    };
  const { start, end, timeZone } = value;
  if (
    typeof start !== "string" ||
    !HH_MM.test(start) ||
    typeof end !== "string" ||
    !HH_MM.test(end)
  )
    return {
      error: "Night rule (night) times must be HH:MM from 00:00 to 23:59",
    };
  if (start === end)
    return {
      error: "Night rule (night) must start and end at different times",
    };
  if (typeof timeZone !== "string" || !timeZone || !validTimeZone(timeZone))
    return { error: "Night rule (night) needs a valid time zone" };
  return { start, end, timeZone };
}

function balanced(glob: string): boolean {
  let square = 0;
  let curly = 0;
  for (const ch of glob) {
    if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
    if (square < 0 || curly < 0) return false;
  }
  return square === 0 && curly === 0;
}

function validateGlobs(value: unknown, field: string): Result<string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SCOPE_GLOBS)
    return {
      error: `Action scope (scope.${field}) must be a list of at most ${MAX_SCOPE_GLOBS} globs`,
    };
  for (const glob of value)
    if (
      typeof glob !== "string" ||
      glob.length < 1 ||
      glob.length > 200 ||
      glob.includes("\u0000") ||
      !balanced(glob)
    )
      return {
        error: `Action scope (scope.${field}) has an invalid glob ${JSON.stringify(glob)}`,
      };
  return [...value];
}

function validateScope(value: unknown): Result<ActionScope> {
  if (value === undefined)
    return { services: [], paths: [], migrationPaths: [] };
  if (!isRecord(value))
    return { error: "Action scope (scope) must be an object" };
  const services = validateGlobs(value.services, "services");
  if (failed(services)) return services;
  const paths = validateGlobs(value.paths, "paths");
  if (failed(paths)) return paths;
  const migrationPaths = validateGlobs(value.migrationPaths, "migrationPaths");
  if (failed(migrationPaths)) return migrationPaths;
  return { services, paths, migrationPaths };
}

function validateCost(value: unknown): Result<ActionCost> {
  if (value === undefined) return { kind: "none" };
  if (isRecord(value) && value.kind === "none") return { kind: "none" };
  if (
    isRecord(value) &&
    value.kind === "amount" &&
    numberIn(value.usd, Number.MIN_VALUE, 100_000)
  )
    return { kind: "amount", usd: value.usd };
  return {
    error:
      "Action cost (cost) must be none or an amount over $0 and up to $100000",
  };
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PLACEHOLDER_AT = /\{\{[^{}]*\}\}/y;

/** Whether a `{{name}}` sits inside single or double quotes. Sessions quotes
 *  every value itself, so a quoted placeholder would change its meaning. */
function placeholderInQuotes(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      PLACEHOLDER_AT.lastIndex = i;
      if (PLACEHOLDER_AT.test(command)) return true;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return false;
}

export function validateAction(
  value: unknown,
  productionRunners: string[],
): Result<IncidentAction> {
  if (!isRecord(value)) return { error: "Each action must be an object" };
  const {
    id,
    kind,
    label,
    runner,
    command,
    cwd,
    timeoutMs,
    reversible,
    needsSecret,
  } = value;
  if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id))
    return {
      error:
        "Action id (id) must be 1 to 40 lower-case letters, digits or dashes",
    };
  if (
    typeof kind !== "string" ||
    !(ACTION_KINDS as readonly string[]).includes(kind)
  )
    return {
      error: `Action kind (kind) must be one of ${ACTION_KINDS.join(", ")}`,
    };
  const trimmedLabel = typeof label === "string" ? label.trim() : "";
  if (trimmedLabel.length < 1 || trimmedLabel.length > 60)
    return { error: "Action label (label) must be 1 to 60 characters" };
  if (typeof runner !== "string" || !productionRunners.includes(runner))
    return { error: "Pick one of the project's production Runners" };
  if (
    typeof command !== "string" ||
    command.trim().length < 1 ||
    command.length > 4000
  )
    return { error: "Action command (command) must be 1 to 4000 characters" };
  if (command.includes("\u0000"))
    return { error: "Action command (command) cannot contain a NUL character" };
  for (const match of command.matchAll(PLACEHOLDER))
    if (!(ACTION_PLACEHOLDERS as readonly string[]).includes(match[1]))
      return { error: `Unknown placeholder {{${match[1]}}}` };
  if (placeholderInQuotes(command))
    return {
      error:
        "Placeholders cannot be inside quotes: Sessions quotes their values",
    };
  if (
    cwd !== undefined &&
    (typeof cwd !== "string" ||
      !cwd.startsWith("/") ||
      cwd.length > 512 ||
      cwd.includes("\u0000"))
  )
    return {
      error:
        "Action directory (cwd) must be an absolute path of at most 512 characters",
    };
  if (timeoutMs !== undefined && !integerIn(timeoutMs, 10_000, 3_600_000))
    return {
      error: "Action timeout (timeoutMs) must be from 10 seconds to 1 hour",
    };
  if (reversible !== undefined && typeof reversible !== "boolean")
    return { error: "Action reversible (reversible) must be true or false" };
  if (needsSecret !== undefined && typeof needsSecret !== "boolean")
    return {
      error: "Action needs a secret (needsSecret) must be true or false",
    };
  const cost = validateCost(value.cost);
  if (failed(cost)) return cost;
  const scope = validateScope(value.scope);
  if (failed(scope)) return scope;
  return {
    id,
    kind: kind as ActionKind,
    label: trimmedLabel,
    runner,
    command,
    ...(cwd !== undefined ? { cwd: cwd as string } : {}),
    timeoutMs: (timeoutMs as number | undefined) ?? 600_000,
    reversible: (reversible as boolean | undefined) ?? kind !== "run-once",
    cost,
    needsSecret: (needsSecret as boolean | undefined) ?? false,
    scope,
  };
}

/** Rules over the whole record, checked on the record a write commits to. */
export function settingsInvariantProblem(
  s: IncidentProjectSettings,
): string | null {
  for (const action of s.actions)
    if (!s.productionRunners.includes(action.runner))
      return `Action ${action.id} runs on ${action.runner}, which is not one of the project's production Runners`;
  if (!(s.budget.perMonthUsd >= s.budget.perIncidentUsd))
    return "Budget per month (perMonthUsd) must be from the per-incident budget to $100000";
  const { investigatorModel, verifierModel } = s.agents;
  if (
    investigatorModel &&
    verifierModel &&
    sameModel(investigatorModel, verifierModel)
  )
    return "Pick a different model for the verifier";
  return null;
}

/**
 * The fields whose change gives agents more room: a higher autonomy, a
 * never-without-you entry removed, a shorter veto, a higher budget, more
 * rounds, the kill switch or the new-incident pause off, or the night rule
 * off or changed. Tightening any of them is open to every writer.
 */
export function loosenedFields(
  before: PolicyFields,
  after: PolicyFields,
): PolicyField[] {
  const fields: PolicyField[] = [];
  if (before.agentsPaused && !after.agentsPaused) fields.push("agentsPaused");
  if (before.incidentsPaused && !after.incidentsPaused)
    fields.push("incidentsPaused");
  if (
    AUTONOMY_LEVELS.indexOf(after.autonomy) >
    AUTONOMY_LEVELS.indexOf(before.autonomy)
  )
    fields.push("autonomy");
  if (
    after.budget.perIncidentUsd > before.budget.perIncidentUsd ||
    after.budget.perMonthUsd > before.budget.perMonthUsd
  )
    fields.push("budget");
  if (
    before.night &&
    JSON.stringify(before.night) !== JSON.stringify(after.night)
  )
    fields.push("night");
  if (before.neverWithoutYou.some((v) => !after.neverWithoutYou.includes(v)))
    fields.push("neverWithoutYou");
  if (after.vetoMs < before.vetoMs) fields.push("vetoMs");
  if (after.maxRounds > before.maxRounds) fields.push("maxRounds");
  return fields.sort();
}

// ── The incident policy and production, field by field ─────────────────────

/** The incident policy fields a caller may change. */
export const POLICY_FIELDS = [
  "agentsPaused",
  "incidentsPaused",
  "autonomy",
  "vetoMs",
  "watchMs",
  "maxRounds",
  "night",
  "neverWithoutYou",
  "budget",
] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];
export type PolicyFields = Pick<ProjectIncidentPolicy, PolicyField>;

/** A validated policy change; `night: null` clears the night rule. */
export type PolicyPatch = Partial<Omit<ProjectIncidentPolicy, "night">> & {
  night?: NightRule | null;
};

/** The policy fields present in `input`, each checked; the budget merges
 *  over `current` so one half of it may change alone. */
export function validatePolicyFields(
  input: Record<string, unknown>,
  current: Pick<ProjectIncidentPolicy, "budget">,
): Result<PolicyPatch> {
  const patch: PolicyPatch = {};
  if ("agentsPaused" in input) {
    if (typeof input.agentsPaused !== "boolean")
      return { error: "Kill switch (agentsPaused) must be true or false" };
    patch.agentsPaused = input.agentsPaused;
  }
  if ("incidentsPaused" in input) {
    if (typeof input.incidentsPaused !== "boolean")
      return {
        error: "Pause new incidents (incidentsPaused) must be true or false",
      };
    patch.incidentsPaused = input.incidentsPaused;
  }
  if ("autonomy" in input) {
    if (
      typeof input.autonomy !== "string" ||
      !(AUTONOMY_LEVELS as readonly string[]).includes(input.autonomy)
    )
      return {
        error: `Autonomy (autonomy) must be one of ${AUTONOMY_LEVELS.join(", ")}`,
      };
    patch.autonomy = input.autonomy as ProjectIncidentPolicy["autonomy"];
  }
  if ("vetoMs" in input) {
    if (!integerIn(input.vetoMs, 60_000, 3_600_000))
      return { error: "Veto window (vetoMs) must be from 1 minute to 1 hour" };
    patch.vetoMs = input.vetoMs;
  }
  if ("watchMs" in input) {
    if (!integerIn(input.watchMs, 60_000, 3_600_000))
      return {
        error: "Watch window (watchMs) must be from 1 minute to 1 hour",
      };
    patch.watchMs = input.watchMs;
  }
  if ("maxRounds" in input) {
    if (!integerIn(input.maxRounds, 1, 5))
      return { error: "Max rounds (maxRounds) must be from 1 to 5" };
    patch.maxRounds = input.maxRounds;
  }
  if ("night" in input) {
    if (input.night === null) patch.night = null;
    else {
      const night = validateNight(input.night);
      if (failed(night)) return night;
      patch.night = night;
    }
  }
  if ("neverWithoutYou" in input) {
    const list = input.neverWithoutYou;
    if (
      !Array.isArray(list) ||
      new Set(list).size !== list.length ||
      list.some(
        (v) =>
          typeof v !== "string" ||
          !(NEVER_WITHOUT_YOU as readonly string[]).includes(v),
      )
    )
      return {
        error: `Never without you (neverWithoutYou) must list each of ${NEVER_WITHOUT_YOU.join(", ")} at most once`,
      };
    patch.neverWithoutYou = NEVER_WITHOUT_YOU.filter((v) =>
      list.includes(v),
    ) as NeverWithoutYou[];
  }
  if ("budget" in input) {
    if (!isRecord(input.budget))
      return { error: "Budget (budget) must be an object" };
    const budget = { ...current.budget, ...input.budget };
    if (!numberIn(budget.perIncidentUsd, 0.5, 1000))
      return {
        error:
          "Budget per incident (perIncidentUsd) must be from $0.50 to $1000",
      };
    if (!numberIn(budget.perMonthUsd, budget.perIncidentUsd, 100_000))
      return {
        error:
          "Budget per month (perMonthUsd) must be from the per-incident budget to $100000",
      };
    patch.budget = {
      perIncidentUsd: budget.perIncidentUsd,
      perMonthUsd: budget.perMonthUsd,
    };
  }
  return patch;
}

/** A policy with a validated change applied. */
export function applyPolicyPatch<T extends PolicyFields>(
  current: T,
  patch: PolicyPatch,
): T {
  const { night, ...rest } = patch;
  const next = { ...current, ...rest } as T;
  if (night === null) delete next.night;
  else if (night) next.night = night;
  return next;
}

/** A list of production Runner ids, each usable for `project`. */
export function validateProductionRunners(
  list: unknown,
  project: string,
  runnerProblem: (runnerId: string, project: string) => string | null,
): Result<string[]> {
  if (
    !Array.isArray(list) ||
    list.length > MAX_RUNNERS ||
    new Set(list).size !== list.length ||
    list.some((v) => typeof v !== "string" || !v)
  )
    return {
      error: `Production Runners (productionRunners) must be at most ${MAX_RUNNERS} different Runner ids`,
    };
  for (const id of list as string[]) {
    const problem = runnerProblem(id, project);
    if (problem) return { error: problem };
  }
  return [...(list as string[])];
}

/** A list of actions on `runners`, ids unique, at most one deploy and one
 *  rollback. */
export function validateActionList(
  list: unknown,
  runners: string[],
): Result<IncidentAction[]> {
  if (!Array.isArray(list) || list.length > MAX_ACTIONS)
    return {
      error: `Actions (actions) must be a list of at most ${MAX_ACTIONS}`,
    };
  const actions: IncidentAction[] = [];
  for (const item of list) {
    const action = validateAction(item, runners);
    if (failed(action)) {
      const id =
        isRecord(item) && typeof item.id === "string" ? item.id : undefined;
      return { error: id ? `${action.error} (action ${id})` : action.error };
    }
    if (actions.some((a) => a.id === action.id))
      return { error: `Action ids (actions) must be unique: ${action.id}` };
    if (action.kind === "deploy" && actions.some((a) => a.kind === "deploy"))
      return { error: "Only one deploy action per project" };
    if (
      action.kind === "rollback" &&
      actions.some((a) => a.kind === "rollback")
    )
      return { error: "Only one rollback action per project" };
    actions.push(action);
  }
  return actions;
}

/** Rules over the whole project document, checked on the document a write
 *  commits to. */
export function documentInvariantProblem(
  d: ProjectSettingsDocument,
): string | null {
  for (const action of d.production.actions)
    if (!d.production.runners.includes(action.runner))
      return `Action ${action.id} runs on ${action.runner}, which is not one of the project's production Runners`;
  const { budget } = d.incidents;
  if (!(budget.perMonthUsd >= budget.perIncidentUsd))
    return "Budget per month (perMonthUsd) must be from the per-incident budget to $100000";
  const { investigator, verifier } = d.models;
  if (investigator && verifier && sameModel(investigator, verifier))
    return "Pick a different model for the verifier";
  if ((d.access.webSearch as string[]).includes("verifier"))
    return "The verifier never searches the web";
  for (const role of ["investigator", "verifier"] as const) {
    const problem = egressRouteProblem(d.access.routes[role]);
    if (problem) return `Egress for the ${role}: ${problem}`;
  }
  return null;
}

/** Why a stored egress route is malformed: null (no egress) or one of
 *  server, a Runner by id, or a proxy URL. */
export function egressRouteProblem(route: unknown): string | null {
  if (route === null) return null;
  if (!isRecord(route)) return "must be a route or off (null)";
  switch (route.route) {
    case "server":
      return null;
    case "runner":
      return typeof route.runner === "string" && route.runner.trim()
        ? null
        : "a Runner route needs the Runner";
    case "proxy":
      return typeof route.url === "string" && route.url.trim()
        ? null
        : "a proxy route needs its URL";
    default:
      return `unknown route ${JSON.stringify(route.route)}`;
  }
}
