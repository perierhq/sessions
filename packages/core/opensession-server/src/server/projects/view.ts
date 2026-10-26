// What the project page and the Defaults page show: the stored document
// (release hook secret replaced by its path, for a signed-in person only),
// previews, the effective sandbox and models per role, the access table,
// the readiness checklist, production Runners, month spend and legacy
// drift. Every live input comes through `ProjectViewDeps`, read
// asynchronously on demand; tests replace them.

import type { CredentialInfo } from "../../shared/incident-access";
import {
  PROJECT_ROLES,
  type EffectiveRoleModel,
  type EffectiveSandbox,
  type PreviewsChoice,
  type ProjectListItem,
  type ProjectRole,
  type ProjectRunnerView,
  type ProjectSettingsDocument,
  type ProjectSettingsView,
} from "../../shared/project-settings";
import type { GitAccessIssue } from "../git-access-health";
import type { RoleModels } from "../incidents/response/models";
import { buildAccessTable } from "./access-table";
import { computeReadiness, type ConnectorState } from "./readiness";

export interface ProjectRunnerInfo extends ProjectRunnerView {
  /** Bound to this project. */
  bound: boolean;
  /** Why the Runner can't serve the project now, `null` when it can. */
  problem: string | null;
}

export interface ProjectViewDeps {
  /** Configured repos, in sidebar order. */
  projectIds(): string[];
  projectExists(project: string): boolean;
  getDocument(project: string): Promise<ProjectSettingsDocument>;
  previews(project: string): PreviewsChoice;
  effectiveSandboxes(
    project: string,
    doc: ProjectSettingsDocument,
  ): Promise<EffectiveSandbox>;
  effectiveModels(
    project: string,
    doc: ProjectSettingsDocument,
  ): Promise<Record<ProjectRole, EffectiveRoleModel>>;
  /** The investigator and verifier models, or why there are none. */
  roleModels(
    project: string,
    doc: ProjectSettingsDocument,
  ): Promise<RoleModels | { error: string }>;
  runners(project: string, bound: string[]): Promise<ProjectRunnerInfo[]>;
  /** Signals per project. */
  signalCounts(): Promise<Record<string, number>>;
  connectors(): Promise<ConnectorState[]>;
  credentials(): Promise<Record<string, CredentialInfo & { label?: string }>>;
  monthSpendUsd(project: string): Promise<number>;
  /** Projects whose legacy settings changed after their migration. */
  drift(): Promise<string[]>;
  /** How a sandbox provider id reads ("Daytona eu"). */
  sandboxLabel(provider: string): string;
  /** The project's open git sign-in issue, if any. */
  gitAccess?(project: string): GitAccessIssue | null;
}

let liveDeps: (() => ProjectViewDeps) | undefined;
let override: Partial<ProjectViewDeps> | undefined;

/** Install the live inputs; the routes do this on first use. */
export function setProjectViewDeps(factory: () => ProjectViewDeps): void {
  liveDeps = factory;
}

/** Replace some inputs (undefined restores them). */
export function __setProjectViewDepsForTest(
  over: Partial<ProjectViewDeps> | undefined,
): void {
  override = over;
}

export function projectViewDeps(): ProjectViewDeps {
  if (!liveDeps && !override)
    throw new Error("project view inputs are not installed");
  const base = liveDeps?.() ?? ({} as ProjectViewDeps);
  return override ? { ...base, ...override } : base;
}

function publicDocument(
  doc: ProjectSettingsDocument,
  person: boolean,
): ProjectSettingsView["document"] {
  const { releaseHookSecret, ...rest } = doc;
  return releaseHookSecret && person
    ? {
        ...rest,
        releaseHookPath: `/incident-releases/${doc.project}/${releaseHookSecret}`,
      }
    : rest;
}

/** The project page, or `null` for an unknown project. */
export async function buildProjectSettingsView(
  project: string,
  opts: { person: boolean },
  deps: ProjectViewDeps = projectViewDeps(),
): Promise<ProjectSettingsView | null> {
  if (!deps.projectExists(project)) return null;
  const doc = await deps.getDocument(project);
  const [
    sandbox,
    models,
    roleModels,
    runners,
    signals,
    connectors,
    credentials,
    spend,
    drift,
  ] = await Promise.all([
    deps.effectiveSandboxes(project, doc),
    deps.effectiveModels(project, doc),
    deps.roleModels(project, doc),
    deps.runners(project, doc.production.runners),
    deps.signalCounts(),
    deps.connectors(),
    deps.credentials(),
    deps.monthSpendUsd(project),
    deps.drift(),
  ]);
  const runnerNames = Object.fromEntries(
    runners.map((r) => [r.id, { name: r.name }] as const),
  );
  const runnerProblems = Object.fromEntries(
    doc.production.runners.map((id) => {
      const runner = runners.find((r) => r.id === id);
      return [id, runner ? runner.problem : `Runner ${id} is not paired`];
    }),
  );
  const isProviderChoice = !["default", "local", "podman"].includes(
    doc.sandbox,
  );
  const readiness = computeReadiness({
    doc,
    models: roleModels,
    incidentWorkspace: sandbox.incidentAgents,
    runnerProblems,
    runners: runnerNames,
    signalCount: signals[project] ?? 0,
    connectors,
    ...(isProviderChoice
      ? { sandboxLabel: deps.sandboxLabel(doc.sandbox) }
      : {}),
  });
  return {
    document: publicDocument(doc, opts.person),
    previews: deps.previews(project),
    effective: { sandbox, models },
    access: buildAccessTable(doc, {
      connectors,
      credentials,
      runners: runnerNames,
    }),
    readiness,
    runners: runners.map(({ bound: _b, problem: _p, ...r }) => r),
    monthSpendUsd: spend,
    drift: drift.includes(project),
    ...gitAccessView(deps.gitAccess?.(project) ?? null),
  };
}

function gitAccessView(
  issue: GitAccessIssue | null,
): Pick<ProjectSettingsView, "gitAccess"> {
  if (!issue) return {};
  const { kind, ghRepo, since, lastError, failures, nextAttemptAt } = issue;
  return {
    gitAccess: {
      kind,
      ...(ghRepo ? { ghRepo } : {}),
      since,
      lastError,
      failures,
      nextAttemptAt,
    },
  };
}

/** One row per configured project, in sidebar order, with its status. */
export async function buildProjectList(
  deps: ProjectViewDeps = projectViewDeps(),
): Promise<ProjectListItem[]> {
  const ids = deps.projectIds();
  const views = await Promise.all(
    ids.map((id) => buildProjectSettingsView(id, { person: false }, deps)),
  );
  return views.flatMap((view, i) => {
    if (!view) return [];
    const you = view.effective.sandbox.you;
    return [
      {
        id: ids[i]!,
        label: ids[i]!,
        status: view.readiness.status,
        sandboxForYou: you.state === "ok" ? you.provider : null,
        modelForYou: view.effective.models.you.model,
      },
    ];
  });
}

/** "a", "a and b", "a, b, and c". */
export function joinWithAnd(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** Who runs on the global default sandbox: whole projects that follow it,
 *  and the automations of projects whose own sandbox can't run them. */
export async function defaultSandboxUsedBy(
  deps: ProjectViewDeps = projectViewDeps(),
): Promise<string> {
  const ids = deps.projectIds().filter((id) => deps.projectExists(id));
  const docs = await Promise.all(ids.map((id) => deps.getDocument(id)));
  const whole: string[] = [];
  const automations: string[] = [];
  await Promise.all(
    docs.map(async (doc) => {
      if (doc.sandbox === "default") return;
      const effective = await deps.effectiveSandboxes(doc.project, doc);
      const place = effective.automations;
      if (place.state === "ok" && place.source === "default")
        automations.push(doc.project);
    }),
  );
  for (const doc of docs)
    if (doc.sandbox === "default") whole.push(doc.project);
  const order = (list: string[]) => ids.filter((id) => list.includes(id));
  const parts = [
    ...order(whole),
    ...order(automations).map((id) => `${id}'s automations`),
  ];
  return parts.length ? `Used by ${joinWithAnd(parts)}` : "No project uses it";
}

/** Every role's effective model from a project's own choices and the
 *  global defaults. */
export function effectiveModelsFrom(
  doc: Pick<ProjectSettingsDocument, "models">,
  globalDefault: (role: ProjectRole) => string,
  label: (model: string) => string,
): Record<ProjectRole, EffectiveRoleModel> {
  const out = {} as Record<ProjectRole, EffectiveRoleModel>;
  for (const role of PROJECT_ROLES) {
    const own = doc.models[role];
    const model = own ?? globalDefault(role);
    out[role] = {
      model,
      label: label(model),
      source: own ? "project" : "default",
    };
  }
  return out;
}
