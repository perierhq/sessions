// Per-project incident settings on the `incident-projects` application
// catalog namespace: autonomy, veto and watch windows, the night rule,
// never-without-you, budgets, agent models, production Runners, typed
// actions and recent releases. Configuration lives here only; nothing reads
// it from a repository.
import { randomBytes } from "node:crypto";
import {
  ACTION_PLACEHOLDERS,
  ACTION_TEMPLATES,
  DEFAULT_AUTONOMY,
  DEFAULT_BUDGET,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_NEVER_WITHOUT_YOU,
  DEFAULT_VETO_MS,
  DEFAULT_WATCH_MS,
  type ActionKind,
  type IncidentAction,
  type IncidentProjectSettings,
  type IncidentRelease,
  type NightRule,
  type RedactedProjectSettings,
} from "../../../shared/incident-response";
import { catalogDocuments } from "../../catalog-documents";
import { configuredRepos } from "../../config";
import { resolveModel } from "../../models";
import {
  type Result,
  failed,
  isRecord,
  loosenedFields,
  productionRunnerProblem,
  settingsInvariantProblem,
  validateActionList,
  validatePolicyFields,
  validateProductionRunners,
} from "../../projects/validate";
import { incidentAudit } from "../audit-sink";
import { canonicalModelId, sameModel } from "./models";

export { ACTION_PLACEHOLDERS, ACTION_TEMPLATES };
export {
  loosenedFields,
  productionRunnerProblem,
  runnerPlatformProblem,
  settingsInvariantProblem,
  validateAction,
} from "../../projects/validate";

const NAMESPACE = "incident-projects";
const MAX_RELEASES = 20;

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

const listeners = new Set<(project: string) => void>();

/** Subscribe to committed settings writes, the caller's and the server's
 *  own (releases, pairing); returns the unsubscribe function. */
export function onProjectSettingsChange(
  listener: (project: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Each listener on its own microtask, so none can fail or hold the write. */
function notify(project: string): void {
  for (const listener of [...listeners])
    void Promise.resolve()
      .then(() => listener(project))
      .catch((error: unknown) => {
        console.warn(
          "[incident-settings] change listener failed:",
          error instanceof Error ? error.message : error,
        );
      });
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
  const policy = validatePolicyFields(input, current);
  if (failed(policy)) return policy;
  const patch: SettingsPatch = { ...policy };
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
    const runners = validateProductionRunners(
      input.productionRunners,
      project,
      ctx.runnerProblem,
    );
    if (failed(runners)) return runners;
    patch.productionRunners = runners;
  }
  if ("actions" in input) {
    const actions = validateActionList(
      input.actions,
      patch.productionRunners ?? current.productionRunners,
    );
    if (failed(actions)) return actions;
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

/** Fields only a signed-in person may change: never an agent, an
 *  automation or a claimed name. */
const PERSON_ONLY_FIELDS: readonly CallerField[] = [
  "actions",
  "productionRunners",
];

export interface SettingsWriter {
  /** A verified sign-in that is not an automation (the route's
   *  `verifiedPerson(ctx)`). Without it actions and production Runners
   *  cannot change, and the policy cannot be loosened. */
  signedInPerson?: boolean;
}

const PERSON_ONLY_ERROR =
  "Only a signed-in person can change actions or production Runners";
const LOOSEN_ERROR = "Only a signed-in person can loosen the incident policy";

class SettingsRefused extends Error {
  constructor(
    readonly reason: string,
    readonly forbidden = false,
  ) {
    super(reason);
  }
}

/** A refused write. `forbidden`: only a signed-in person may make it. */
export type SettingsRefusal = { error: string; forbidden?: true };

export async function updateProjectSettings(
  project: string,
  input: Record<string, unknown>,
  by: string,
  writer: SettingsWriter = {},
): Promise<IncidentProjectSettings | SettingsRefusal> {
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
  const loosened = (
    before: IncidentProjectSettings,
    after: IncidentProjectSettings,
  ) => (writer.signedInPerson ? [] : loosenedFields(before, after));
  const planned = changedFields(snapshot, applyPatch(snapshot, early));
  if (planned.length === 0) return snapshot;
  const refusedEarly = personOnly(planned);
  const looserEarly = loosened(snapshot, applyPatch(snapshot, early));
  if (refusedEarly.length || looserEarly.length) {
    incidentAudit({
      kind: "incident_settings_refused",
      project,
      by,
      fields: refusedEarly.length ? refusedEarly : looserEarly,
    });
    return {
      error: refusedEarly.length ? PERSON_ONLY_ERROR : LOOSEN_ERROR,
      forbidden: true,
    };
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
        throw new SettingsRefused(PERSON_ONLY_ERROR, true);
      if (loosened(current, next).length)
        throw new SettingsRefused(LOOSEN_ERROR, true);
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
    if (error instanceof SettingsRefused)
      return error.forbidden
        ? { error: error.reason, forbidden: true }
        : { error: error.reason };
    throw error;
  }
  const result = remember(withDefaults(project, committed));
  if (fields.length) {
    incidentAudit({ kind: "incident_settings_updated", project, by, fields });
    notify(project);
  }
  return result;
}

/** Server-side writes (`automationId`, pairing, releases): no caller
 *  validation and no field audit, but only for a registered project and
 *  only when the whole record still keeps its rules. Throws otherwise and
 *  writes nothing. */
export async function patchProjectSettings(
  project: string,
  mutate: (s: IncidentProjectSettings) => IncidentProjectSettings,
): Promise<IncidentProjectSettings> {
  if (!context().projectExists(project))
    throw new Error(`Unknown project ${project}`);
  const committed = await settingsDocuments().update(project, (stored) => {
    const current = withDefaults(project, stored);
    const next = mutate(current);
    const problem = settingsInvariantProblem(next);
    if (problem) throw new Error(problem);
    return {
      ...next,
      project,
      releaseHookSecret: next.releaseHookSecret ?? newHookSecret(),
    };
  });
  const result = remember(withDefaults(project, committed));
  notify(project);
  return result;
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
  if (!context().projectExists(project))
    return { error: `Unknown project ${project}` };
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

/** The newest release that was not a rollback, and its index. */
export function latestForwardRelease(
  s: IncidentProjectSettings,
): { release: IncidentRelease; index: number } | undefined {
  const index = s.releases.findIndex((r) => !r.rollback);
  return index < 0 ? undefined : { release: s.releases[index]!, index };
}

/** The release rollback-first would undo: the newest, unless it was itself
 *  a rollback (the release before it is already undone). */
export function releaseToRollBack(
  s: IncidentProjectSettings,
): IncidentRelease | undefined {
  const newest = s.releases[0];
  return newest && !newest.rollback ? newest : undefined;
}

/** The first action of that kind. */
export function projectAction(
  s: IncidentProjectSettings,
  kind: ActionKind,
): IncidentAction | undefined {
  return s.actions.find((a) => a.kind === kind);
}
