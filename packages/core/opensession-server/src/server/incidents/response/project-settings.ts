// Per-project incident settings on the `incident-projects` application
// catalog namespace: autonomy, veto and watch windows, the night rule,
// never-without-you, budgets, agent models, production Runners, typed
// actions and recent releases. Configuration lives here only; nothing reads
// it from a repository.
import { randomBytes } from "node:crypto";
import {
  ACTION_KINDS,
  ACTION_PLACEHOLDERS,
  ACTION_TEMPLATES,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  NEVER_WITHOUT_YOU,
  type ActionCost,
  type ActionKind,
  type ActionScope,
  type IncidentAction,
  type IncidentProjectSettings,
  type IncidentRelease,
  type NeverWithoutYou,
  type NightRule,
  type RedactedProjectSettings,
} from "../../../shared/incident-response";
import { catalogDocuments } from "../../catalog-documents";
import { configuredRepos } from "../../config";
import { resolveModel } from "../../models";
import { getRunner, runnerAllowed } from "../../runners";
import { incidentAudit } from "../audit-sink";
import { canonicalModelId, sameModel } from "./models";

export { ACTION_PLACEHOLDERS, ACTION_TEMPLATES };

const NAMESPACE = "incident-projects";
const MAX_RELEASES = 20;
const MAX_RUNNERS = 10;
const MAX_ACTIONS = 20;
const MAX_SCOPE_GLOBS = 50;

export interface ProjectSettingsContext {
  projectExists(id: string): boolean;
  runnerProblem(runnerId: string, project: string): string | null;
  modelProblem(id: string): string | null;
}

// Bound on first use, never at import: the catalog client is a live effect.
let documents: ReturnType<typeof catalogDocuments> | undefined;
function settingsDocuments(): ReturnType<typeof catalogDocuments> {
  return (documents ??= catalogDocuments(NAMESPACE));
}

let contextOverride: Partial<ProjectSettingsContext> | undefined;

/** Replace parts of the validation context (undefined restores production). */
export function __setProjectSettingsContextForTest(
  ctx: Partial<ProjectSettingsContext> | undefined,
): void {
  contextOverride = ctx;
}

function context(): ProjectSettingsContext {
  return {
    projectExists:
      contextOverride?.projectExists ??
      ((id) => Object.hasOwn(configuredRepos(), id)),
    runnerProblem: contextOverride?.runnerProblem ?? productionRunnerProblem,
    modelProblem:
      contextOverride?.modelProblem ??
      ((id) => (resolveModel(id) ? null : `Unknown model ${id}`)),
  };
}

/** Whether `project` is a registered project (the test context may say
 *  otherwise). */
export function incidentProjectExists(project: string): boolean {
  return context().projectExists(project);
}

/** Whether a paired Runner may run this project's actions. Platform and
 *  online state are reported elsewhere. */
export function productionRunnerProblem(
  runnerId: string,
  project: string,
): string | null {
  const runner = getRunner(runnerId);
  if (!runner) return `Runner ${runnerId} is not paired`;
  if (!runnerAllowed(runner, { repo: project, permission: "commands" }))
    return `Runner ${runner.name} does not allow commands for ${project}`;
  return null;
}

export function defaultProjectSettings(
  project: string,
): IncidentProjectSettings {
  return {
    project,
    agentsPaused: false,
    autonomy: DEFAULT_AUTONOMY,
    vetoMs: DEFAULT_VETO_MS,
    watchMs: DEFAULT_WATCH_MS,
    maxRounds: DEFAULT_MAX_ROUNDS,
    neverWithoutYou: [...DEFAULT_NEVER_WITHOUT_YOU],
    budget: { ...DEFAULT_BUDGET },
    agents: {},
    productionRunners: [],
    actions: [],
    releases: [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A stored record merged over the defaults. */
function withDefaults(
  project: string,
  stored: unknown,
): IncidentProjectSettings {
  const base = defaultProjectSettings(project);
  if (!isRecord(stored)) return base;
  const s = stored as Partial<IncidentProjectSettings>;
  return {
    ...base,
    ...s,
    project,
    budget: { ...base.budget, ...(isRecord(s.budget) ? s.budget : {}) },
    agents: { ...(isRecord(s.agents) ? s.agents : {}) },
    neverWithoutYou: Array.isArray(s.neverWithoutYou)
      ? s.neverWithoutYou
      : base.neverWithoutYou,
    productionRunners: Array.isArray(s.productionRunners)
      ? s.productionRunners
      : [],
    actions: Array.isArray(s.actions) ? s.actions : [],
    releases: Array.isArray(s.releases) ? s.releases : [],
  };
}

const cache = new Map<string, IncidentProjectSettings>();
function remember(s: IncidentProjectSettings): IncidentProjectSettings {
  cache.set(s.project, s);
  return s;
}

/** The last settings this process read or wrote for the project. */
export function peekProjectSettings(
  project: string,
): IncidentProjectSettings | undefined {
  return cache.get(project);
}

export async function getProjectSettings(
  project: string,
): Promise<IncidentProjectSettings> {
  return remember(
    withDefaults(project, await settingsDocuments().get(project)),
  );
}

export async function listProjectSettings(): Promise<
  IncidentProjectSettings[]
> {
  const rows = await settingsDocuments().list();
  return rows.map((row) => remember(withDefaults(row.key, row.value)));
}

function newHookSecret(): string {
  return randomBytes(24).toString("hex");
}

// ── Validation ──────────────────────────────────────────────────────────────

type Result<T> = T | { error: string };
function failed<T>(r: Result<T>): r is { error: string } {
  return typeof r === "object" && r !== null && "error" in r;
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function numberIn(value: unknown, min: number, max: number): value is number {
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

function validateNight(value: unknown): Result<NightRule> {
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

const CALLER_FIELDS = [
  "agentsPaused",
  "autonomy",
  "vetoMs",
  "watchMs",
  "maxRounds",
  "night",
  "neverWithoutYou",
  "budget",
  "agents",
  "productionRunners",
  "actions",
] as const;
type CallerField = (typeof CALLER_FIELDS)[number];
type SettingsPatch = Partial<
  Pick<IncidentProjectSettings, Exclude<CallerField, "night">>
> & {
  night?: NightRule | null;
};

function validatePatch(
  project: string,
  input: Record<string, unknown>,
  current: IncidentProjectSettings,
  ctx: ProjectSettingsContext,
): Result<SettingsPatch> {
  const patch: SettingsPatch = {};
  if ("agentsPaused" in input) {
    if (typeof input.agentsPaused !== "boolean")
      return { error: "Kill switch (agentsPaused) must be true or false" };
    patch.agentsPaused = input.agentsPaused;
  }
  if ("autonomy" in input) {
    if (
      typeof input.autonomy !== "string" ||
      !(AUTONOMY_LEVELS as readonly string[]).includes(input.autonomy)
    )
      return {
        error: `Autonomy (autonomy) must be one of ${AUTONOMY_LEVELS.join(", ")}`,
      };
    patch.autonomy = input.autonomy as IncidentProjectSettings["autonomy"];
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
  if ("agents" in input) {
    if (!isRecord(input.agents))
      return { error: "Agent models (agents) must be an object" };
    const agents: IncidentProjectSettings["agents"] = { ...current.agents };
    for (const key of ["investigatorModel", "verifierModel"] as const) {
      if (!(key in input.agents)) continue;
      const v = input.agents[key];
      if (v === undefined || v === null || v === "") {
        delete agents[key];
        continue;
      }
      if (typeof v !== "string")
        return { error: `Agent model (${key}) must be a model id` };
      const problem = ctx.modelProblem(v);
      if (problem) return { error: problem };
      agents[key] = canonicalModelId(v);
    }
    if (
      agents.investigatorModel &&
      agents.verifierModel &&
      sameModel(agents.investigatorModel, agents.verifierModel)
    )
      return { error: "Pick a different model for the verifier" };
    patch.agents = agents;
  }
  if ("productionRunners" in input) {
    const list = input.productionRunners;
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
      const problem = ctx.runnerProblem(id, project);
      if (problem) return { error: problem };
    }
    patch.productionRunners = [...(list as string[])];
  }
  if ("actions" in input) {
    const list = input.actions;
    if (!Array.isArray(list) || list.length > MAX_ACTIONS)
      return {
        error: `Actions (actions) must be a list of at most ${MAX_ACTIONS}`,
      };
    const runners = patch.productionRunners ?? current.productionRunners;
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
    patch.actions = actions;
  }
  return patch;
}

function applyPatch(
  current: IncidentProjectSettings,
  patch: SettingsPatch,
): IncidentProjectSettings {
  const { night, ...rest } = patch;
  const next: IncidentProjectSettings = { ...current, ...rest };
  if (night === null) delete next.night;
  else if (night) next.night = night;
  return next;
}

function changedFields(
  before: IncidentProjectSettings,
  after: IncidentProjectSettings,
): CallerField[] {
  return CALLER_FIELDS.filter(
    (f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]),
  ).sort();
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

/** Fields only a signed-in person may change: never an agent, an
 *  automation or a claimed name. */
const PERSON_ONLY_FIELDS: readonly CallerField[] = [
  "actions",
  "productionRunners",
];

export interface SettingsWriter {
  /** A verified sign-in that is not an automation (the route's
   *  `verifiedPerson(ctx)`). Without it actions and production Runners
   *  cannot change. */
  signedInPerson?: boolean;
}

const PERSON_ONLY_ERROR =
  "Only a signed-in person can change actions or production Runners";

class SettingsRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function updateProjectSettings(
  project: string,
  input: Record<string, unknown>,
  by: string,
  writer: SettingsWriter = {},
): Promise<IncidentProjectSettings | { error: string }> {
  const ctx = context();
  if (!ctx.projectExists(project))
    return { error: `Unknown project ${project}` };
  if (!isRecord(input)) return { error: "Settings must be an object" };
  const snapshot = await getProjectSettings(project);
  const early = validatePatch(project, input, snapshot, ctx);
  if (failed(early)) return early;
  const personOnly = (fields: CallerField[]) =>
    writer.signedInPerson
      ? []
      : fields.filter((f) => PERSON_ONLY_FIELDS.includes(f));
  const planned = changedFields(snapshot, applyPatch(snapshot, early));
  if (planned.length === 0) return snapshot;
  const refusedEarly = personOnly(planned);
  if (refusedEarly.length) {
    incidentAudit({
      kind: "incident_settings_refused",
      project,
      by,
      fields: refusedEarly,
    });
    return { error: PERSON_ONLY_ERROR };
  }
  let fields: CallerField[] = [];
  let committed: unknown;
  try {
    committed = await settingsDocuments().update(project, (stored) => {
      // Validate again against the record this write commits to: a
      // concurrent edit may have changed what the patch depends on.
      const current = withDefaults(project, stored);
      const patch = validatePatch(project, input, current, ctx);
      if (failed(patch)) throw new SettingsRefused(patch.error);
      const next = applyPatch(current, patch);
      fields = changedFields(current, next);
      if (fields.length === 0 && stored !== null)
        return stored as IncidentProjectSettings;
      if (personOnly(fields).length)
        throw new SettingsRefused(PERSON_ONLY_ERROR);
      const problem = settingsInvariantProblem(next);
      if (problem) throw new SettingsRefused(problem);
      return {
        ...next,
        releaseHookSecret: current.releaseHookSecret ?? newHookSecret(),
        updatedAt: new Date().toISOString(),
        updatedBy: by,
      };
    });
  } catch (error) {
    if (error instanceof SettingsRefused) return { error: error.reason };
    throw error;
  }
  const result = remember(withDefaults(project, committed));
  if (fields.length)
    incidentAudit({ kind: "incident_settings_updated", project, by, fields });
  return result;
}

/** Server-side writes (`automationId`, pairing, releases): no validation and
 *  no field audit. */
export async function patchProjectSettings(
  project: string,
  mutate: (s: IncidentProjectSettings) => IncidentProjectSettings,
): Promise<IncidentProjectSettings> {
  const committed = await settingsDocuments().update(project, (stored) => {
    const current = withDefaults(project, stored);
    const next = mutate(current);
    return {
      ...next,
      project,
      releaseHookSecret: next.releaseHookSecret ?? newHookSecret(),
    };
  });
  return remember(withDefaults(project, committed));
}

export function redactProjectSettings(
  s: IncidentProjectSettings,
): RedactedProjectSettings {
  const { releaseHookSecret, ...rest } = s;
  return {
    ...rest,
    ...(releaseHookSecret
      ? {
          releaseHookPath: `/incident-releases/${s.project}/${releaseHookSecret}`,
        }
      : {}),
  };
}

const RELEASE_REF = /^[0-9a-f]{7,40}$/;

/** Records a release, newest first. A `ref` must be a commit SHA. */
export async function recordRelease(
  project: string,
  release: IncidentRelease,
): Promise<{ error: string } | undefined> {
  if (release.ref !== undefined && !RELEASE_REF.test(release.ref))
    return { error: "Invalid ref" };
  await patchProjectSettings(project, (s) => ({
    ...s,
    releases: [release, ...s.releases]
      .map((r, i) => ({ r, i }))
      .sort((a, b) =>
        a.r.at === b.r.at ? a.i - b.i : a.r.at < b.r.at ? 1 : -1,
      )
      .map(({ r }) => r)
      .slice(0, MAX_RELEASES),
  }));
  incidentAudit({
    kind: "incident_release",
    project,
    source: release.source,
    ref: release.ref,
  });
  return undefined;
}

export function latestRelease(
  s: IncidentProjectSettings,
): IncidentRelease | undefined {
  return s.releases[0];
}

/** The first action of that kind. */
export function projectAction(
  s: IncidentProjectSettings,
  kind: ActionKind,
): IncidentAction | undefined {
  return s.actions.find((a) => a.kind === kind);
}
