// Per-project incident settings: the incident policy, agent models,
// production Runners, typed actions and recent releases, read and written
// as a projection of the project settings document (projects/store.ts).
// Every export keeps its name and shape for the coordinator, policy,
// actions and routes; the legacy `incident-projects` namespace is read only
// by projects/legacy.ts.
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
  type RedactedProjectSettings,
} from "../../../shared/incident-response";
import type {
  ProjectSettingsDocument,
  ProjectSettingsPatch,
} from "../../../shared/project-settings";
import { legacyProjectDocuments } from "../../projects/legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
  listProjectDocuments,
  onProjectDocumentChange,
  patchProjectDocumentAsServer,
  peekProjectDocument,
  projectExists,
  STALE_REVISION_ERROR,
  updateProjectDocument,
} from "../../projects/store";
import { isRecord } from "../../projects/validate";
import { incidentAudit } from "../audit-sink";

export { ACTION_PLACEHOLDERS, ACTION_TEMPLATES };
export {
  loosenedFields,
  productionRunnerProblem,
  runnerPlatformProblem,
  settingsInvariantProblem,
  validateAction,
} from "../../projects/validate";

const MAX_RELEASES = 20;

export interface ProjectSettingsContext {
  projectExists(id: string): boolean;
  runnerProblem(runnerId: string, project: string): string | null;
  modelProblem(id: string): string | null;
}

/** Replace parts of the validation context (undefined restores production).
 *  The project settings document validates every write. */
export function __setProjectSettingsContextForTest(
  ctx: Partial<ProjectSettingsContext> | undefined,
): void {
  __setProjectStoreContextForTest(ctx);
}

/** Whether `project` is a registered project (the test context may say
 *  otherwise). */
export function incidentProjectExists(project: string): boolean {
  return projectExists(project);
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

/** The incident settings a project document holds. */
export function settingsFromDocument(
  doc: ProjectSettingsDocument,
): IncidentProjectSettings {
  const agents: IncidentProjectSettings["agents"] = {};
  if (doc.models.investigator)
    agents.investigatorModel = doc.models.investigator;
  if (doc.models.verifier) agents.verifierModel = doc.models.verifier;
  const { night, ...policy } = doc.incidents;
  return {
    project: doc.project,
    ...policy,
    ...(night ? { night } : {}),
    neverWithoutYou: [...doc.incidents.neverWithoutYou],
    budget: { ...doc.incidents.budget },
    agents,
    productionRunners: [...doc.production.runners],
    actions: [...doc.production.actions],
    releases: [...doc.production.releases],
    ...(doc.automationId ? { automationId: doc.automationId } : {}),
    ...(doc.releaseHookSecret
      ? { releaseHookSecret: doc.releaseHookSecret }
      : {}),
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
}

/** `doc` holding what `s` says, for a server-side write. */
function documentWithSettings(
  doc: ProjectSettingsDocument,
  s: IncidentProjectSettings,
): ProjectSettingsDocument {
  const models = { ...doc.models };
  if (s.agents.investigatorModel)
    models.investigator = s.agents.investigatorModel;
  else delete models.investigator;
  if (s.agents.verifierModel) models.verifier = s.agents.verifierModel;
  else delete models.verifier;
  const next: ProjectSettingsDocument = {
    ...doc,
    models,
    incidents: {
      agentsPaused: s.agentsPaused,
      autonomy: s.autonomy,
      vetoMs: s.vetoMs,
      watchMs: s.watchMs,
      maxRounds: s.maxRounds,
      ...(s.night ? { night: s.night } : {}),
      neverWithoutYou: [...s.neverWithoutYou],
      budget: { ...s.budget },
    },
    production: {
      runners: [...s.productionRunners],
      actions: [...s.actions],
      releases: [...s.releases],
    },
  };
  if (s.automationId) next.automationId = s.automationId;
  else delete next.automationId;
  if (s.releaseHookSecret) next.releaseHookSecret = s.releaseHookSecret;
  return next;
}

/** Subscribe to committed settings writes, the caller's and the server's
 *  own (releases, pairing); returns the unsubscribe function. */
export function onProjectSettingsChange(
  listener: (project: string) => void,
): () => void {
  return onProjectDocumentChange(listener);
}

/** The last settings this process read or wrote for the project. */
export function peekProjectSettings(
  project: string,
): IncidentProjectSettings | undefined {
  const doc = peekProjectDocument(project);
  return doc && settingsFromDocument(doc);
}

export async function getProjectSettings(
  project: string,
): Promise<IncidentProjectSettings> {
  return settingsFromDocument(await getProjectDocument(project));
}

/** Projects with settings of their own: a stored document, or legacy
 *  incident settings not yet migrated. */
export async function listProjectSettings(): Promise<
  IncidentProjectSettings[]
> {
  const [docs, legacy] = await Promise.all([
    listProjectDocuments(),
    legacyProjectDocuments().list(),
  ]);
  const out = docs.map(settingsFromDocument);
  for (const row of legacy)
    if (!docs.some((d) => d.project === row.key))
      out.push(await getProjectSettings(row.key));
  return out;
}

/** Fields only a signed-in person may change: never an agent, an
 *  automation or a claimed name. */
export interface SettingsWriter {
  /** A verified sign-in that is not an automation (the route's
   *  `verifiedPerson(ctx)`). Without it actions and production Runners
   *  cannot change, and the policy cannot be loosened. */
  signedInPerson?: boolean;
}

/** A refused write. `forbidden`: only a signed-in person may make it. */
export type SettingsRefusal = { error: string; forbidden?: true };

const POLICY_KEYS = [
  "agentsPaused",
  "autonomy",
  "vetoMs",
  "watchMs",
  "maxRounds",
  "night",
  "neverWithoutYou",
  "budget",
] as const;

/** The legacy settings body as a document patch (without its revision). */
function patchFromInput(
  input: Record<string, unknown>,
): Omit<ProjectSettingsPatch, "expectedRevision"> | SettingsRefusal {
  const patch: Omit<ProjectSettingsPatch, "expectedRevision"> = {};
  const incidents: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) if (key in input) incidents[key] = input[key];
  if (Object.keys(incidents).length)
    patch.incidents = incidents as ProjectSettingsPatch["incidents"];
  if ("agents" in input) {
    if (!isRecord(input.agents))
      return { error: "Agent models (agents) must be an object" };
    const models: Record<string, string | null> = {};
    for (const [key, role] of [
      ["investigatorModel", "investigator"],
      ["verifierModel", "verifier"],
    ] as const) {
      if (!(key in input.agents)) continue;
      const v = input.agents[key];
      if (v === undefined || v === null || v === "") models[role] = null;
      else if (typeof v !== "string")
        return { error: `Agent model (${key}) must be a model id` };
      else models[role] = v;
    }
    patch.models = models;
  }
  if ("productionRunners" in input || "actions" in input) {
    patch.production = {};
    if ("productionRunners" in input)
      patch.production.runners = input.productionRunners as string[];
    if ("actions" in input)
      patch.production.actions = input.actions as IncidentAction[];
  }
  return patch;
}

export async function updateProjectSettings(
  project: string,
  input: Record<string, unknown>,
  by: string,
  writer: SettingsWriter = {},
): Promise<IncidentProjectSettings | SettingsRefusal> {
  if (!projectExists(project)) return { error: `Unknown project ${project}` };
  if (!isRecord(input)) return { error: "Settings must be an object" };
  const patch = patchFromInput(input);
  if ("error" in patch) return patch;
  // The legacy API carries no revision: write against the current one, and
  // try again when a concurrent write moved it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { revision } = await getProjectDocument(project);
    const out = await updateProjectDocument(
      project,
      { expectedRevision: revision, ...patch },
      { name: by, verified: writer.signedInPerson === true },
    );
    if (!("error" in out)) return settingsFromDocument(out);
    if (out.status === 409 && out.error === STALE_REVISION_ERROR) continue;
    return out.status === 403
      ? { error: out.error, forbidden: true }
      : { error: out.error };
  }
  return { error: STALE_REVISION_ERROR };
}

/** Server-side writes (`automationId`, pairing, releases): no caller
 *  validation and no field audit, but only for a registered project and
 *  only when the whole record still keeps its rules. Throws otherwise and
 *  writes nothing. */
export async function patchProjectSettings(
  project: string,
  mutate: (s: IncidentProjectSettings) => IncidentProjectSettings,
): Promise<IncidentProjectSettings> {
  const doc = await patchProjectDocumentAsServer(project, (d) =>
    documentWithSettings(d, mutate(settingsFromDocument(d))),
  );
  return settingsFromDocument(doc);
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
  if (!projectExists(project)) return { error: `Unknown project ${project}` };
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
