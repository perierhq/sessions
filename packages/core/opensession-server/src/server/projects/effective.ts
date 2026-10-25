// What each role of a project actually gets: its model and where its runs
// happen. Sandbox precedence is a per-session choice, then the project,
// then the global default; the personal default is gone. Automations keep
// running where they ran before projects had settings (D3 as built): on
// this machine, or in the disposable sandbox when the automation's own
// sandbox setting asks for it; neither the project's nor the global
// sandbox moves them. Reviews run on this machine (D4). Incident agents use the project's
// sandbox, else This machine (container) when Ready, else the experimental
// host path, else they can't start. Support runs where incident agents
// run, except the host path: it reads untrusted mail, so it never runs
// unsandboxed on this machine and can't start instead.
import {
  defaultProjectDocument,
  type EffectiveSandbox,
  type ProjectRole,
  type ProjectSettingsDocument,
  type RunPlace,
} from "../../shared/project-settings";
import { automationModel } from "../automations";
import {
  hostAgentUserProblem,
  incidentHostAgentsEnabled,
  podmanReadyForIncident,
} from "../incidents/response/host-agents";
import { resolveRoleModels } from "../incidents/response/models";
import type { SandboxProviderId } from "../sandbox/provider";
import {
  resolveRequestedSandbox,
  sandboxAutomationAvailability,
  sandboxConfig,
} from "../sandbox/config";
import {
  globalRoleDefault,
  globalSandboxDefault,
  globalWebsites,
} from "./global-defaults";
import { getProjectDocument } from "./store";

export const THIS_MACHINE = "This machine";
export const NO_SANDBOX_REASON =
  "Agents can't start: this project has no sandbox";
const PODMAN_FOR_AUTOMATIONS =
  "This machine (container) runs sessions and incident agents only; automations and their runs need Daytona";

export type SessionKind =
  | "interactive"
  | "incident"
  | "automation"
  | "descendant";

export interface EffectiveDeps {
  global: () => string;
  automationCapable: (provider: string) => boolean;
  podmanReady: (project: string, model: string) => boolean;
  hostEnabled: () => boolean;
  hostProblem: () => Promise<string | null>;
  requested: typeof resolveRequestedSandbox;
  /** The project's automations (not reviews or incident response). */
  automations: (project: string) => Promise<Array<{ sandbox?: boolean }>>;
  /** The provider of the disposable automation sandbox. */
  automationProvider: () => string;
}

const REVIEW_EVENT_KEY = "github:pull_request";

async function projectAutomations(
  project: string,
): Promise<Array<{ sandbox?: boolean }>> {
  const { listAutomations } = await import("../automations");
  return (await listAutomations()).filter(
    (a) =>
      a.repo === project &&
      a.eventKey !== REVIEW_EVENT_KEY &&
      !a.incidentResponse,
  );
}

let depsOverride: Partial<EffectiveDeps> | undefined;

/** Replace the live inputs (undefined restores them). */
export function __setEffectiveDepsForTest(deps?: Partial<EffectiveDeps>): void {
  depsOverride = deps;
}

function deps(): EffectiveDeps {
  return {
    global: depsOverride?.global ?? globalSandboxDefault,
    automationCapable:
      depsOverride?.automationCapable ??
      ((provider) =>
        provider === sandboxAutomationAvailability().provider &&
        sandboxAutomationAvailability().available),
    podmanReady: depsOverride?.podmanReady ?? podmanReadyForIncident,
    hostEnabled: depsOverride?.hostEnabled ?? incidentHostAgentsEnabled,
    hostProblem: depsOverride?.hostProblem ?? (() => hostAgentUserProblem()),
    requested: depsOverride?.requested ?? resolveRequestedSandbox,
    automations: depsOverride?.automations ?? projectAutomations,
    automationProvider:
      depsOverride?.automationProvider ??
      (() => sandboxAutomationAvailability().provider),
  };
}

/** How a run place reads: a provider's name, or this machine. */
export function sandboxLabel(provider: string | null): string {
  switch (provider) {
    case null:
    case "local":
      return THIS_MACHINE;
    case "podman":
      return "This machine · container";
    case "daytona": {
      const target = sandboxConfig().daytona?.target;
      return target ? `Daytona ${target}` : "Daytona";
    }
    case "box":
      return "Boat";
    case "tart":
      return "Mac VM";
    case "usecomputer":
      return "use.computer";
    default:
      return provider;
  }
}

/** The project's own choice as a provider (`null` = this machine), or
 *  undefined when it follows the global default. */
function projectChoice(
  doc: ProjectSettingsDocument,
): string | null | undefined {
  if (doc.sandbox === "default") return undefined;
  return doc.sandbox === "local" ? null : doc.sandbox;
}

function globalChoice(d: EffectiveDeps): string | null {
  const g = d.global();
  return g === "none" ? null : g;
}

function place(
  provider: string | null,
  source: "project" | "default" | "fallback",
): RunPlace {
  return { state: "ok", provider, label: sandboxLabel(provider), source };
}

export const AUTOMATIONS_AS_BEFORE = "This machine, as before";
export const AUTOMATIONS_DISPOSABLE = "Disposable sandbox";

/** Where the project's automations run (D3 as built): each where its own
 *  sandbox setting says, never moved by the project or global sandbox. */
async function automationPlace(
  project: string,
  d: EffectiveDeps,
): Promise<RunPlace> {
  let automations: Array<{ sandbox?: boolean }> = [];
  try {
    automations = await d.automations(project);
  } catch (error) {
    console.warn(
      "[project-settings] automations unreadable for the sandbox view:",
      error instanceof Error ? error.message : error,
    );
  }
  const boxed = automations.filter((a) => a.sandbox === true).length;
  if (boxed > 0 && boxed === automations.length)
    return {
      state: "ok",
      provider: d.automationProvider(),
      label: AUTOMATIONS_DISPOSABLE,
      source: "fallback",
    };
  return {
    state: "ok",
    provider: null,
    label: boxed
      ? `${AUTOMATIONS_AS_BEFORE} (${boxed} of ${automations.length} in a disposable sandbox)`
      : AUTOMATIONS_AS_BEFORE,
    source: "fallback",
  };
}

/** Where interactive sessions start when nobody chose. */
function youPlace(doc: ProjectSettingsDocument, d: EffectiveDeps): RunPlace {
  const own = projectChoice(doc);
  if (own !== undefined) return place(own, "project");
  return place(globalChoice(d), "default");
}

async function incidentPlace(
  doc: ProjectSettingsDocument,
  model: string,
  d: EffectiveDeps,
): Promise<RunPlace> {
  const own = projectChoice(doc);
  const chosen = own === undefined ? globalChoice(d) : own;
  if (chosen) return place(chosen, own === undefined ? "default" : "project");
  if (d.podmanReady(doc.project, model)) return place("podman", "fallback");
  if (d.hostEnabled() && (await d.hostProblem()) === null)
    return place(null, "fallback");
  return { state: "cant-start", reason: NO_SANDBOX_REASON };
}

/** Where Support runs: where incident agents run, but never unsandboxed
 *  on this machine. It reads untrusted mail, so the host path that
 *  incident agents may fall back to is a can't-start for Support. */
async function supportPlace(
  doc: ProjectSettingsDocument,
  model: string,
  d: EffectiveDeps,
): Promise<RunPlace> {
  const out = await incidentPlace(doc, model, d);
  if (out.state === "ok" && out.provider === null)
    return { state: "cant-start", reason: NO_SANDBOX_REASON };
  return out;
}

function sameProvider(a: RunPlace, b: RunPlace): boolean {
  return a.state === "ok" && b.state === "ok" && a.provider === b.provider;
}

function sandboxNote(s: Omit<EffectiveSandbox, "note">): string | null {
  if (s.incidentAgents.state === "cant-start")
    return "No sandbox provider is connected, so incident agents can't start. Connect one in the checklist above";
  if (s.support.state === "cant-start")
    return "Support reads customer mail, so it never runs on this machine without a sandbox and can't start. Connect a sandbox provider in the checklist above";
  if (s.you.state !== "ok" || s.you.provider === null) return null;
  if (!sameProvider(s.you, s.incidentAgents)) return null;
  return "Sessions and incident agents run here. Reviews run on this machine, and automations where they ran before";
}

/** Where each role of the project runs. */
export async function effectiveSandboxes(
  project: string,
  doc?: ProjectSettingsDocument,
): Promise<EffectiveSandbox> {
  const d = deps();
  const document = doc ?? (await getProjectDocument(project));
  const model = await effectiveRoleModel(project, "investigator", document);
  const you = youPlace(document, d);
  const incidentAgents = await incidentPlace(document, model, d);
  const supportModel = await effectiveRoleModel(project, "support", document);
  const support = await supportPlace(document, supportModel, d);
  // Reviews run on this machine in v1 (D4).
  const reviews = place(null, "fallback");
  const automations = await automationPlace(project, d);
  const base = { you, reviews, automations, incidentAgents, support };
  return { ...base, note: sandboxNote(base) };
}

/** The model a role runs on in this project: the project's, else the
 *  role's global default, else today's built-in choice. */
export async function effectiveRoleModel(
  project: string,
  role: ProjectRole,
  doc?: ProjectSettingsDocument,
): Promise<string> {
  const document = doc ?? (await getProjectDocument(project));
  const own = document.models[role];
  if (role === "investigator" || role === "verifier") {
    const agents: { investigatorModel?: string; verifierModel?: string } = {};
    if (document.models.investigator)
      agents.investigatorModel = document.models.investigator;
    if (document.models.verifier)
      agents.verifierModel = document.models.verifier;
    const models = resolveRoleModels(agents);
    if (!("error" in models)) return models[role].model;
    return own ?? globalRoleDefault(role) ?? automationModel()!;
  }
  if (own) return own;
  if (role === "you") return globalRoleDefault("you")!;
  return globalRoleDefault(role) ?? automationModel()!;
}

/** A role's model in a project that sets none of its own. */
export function defaultRoleModel(role: ProjectRole): Promise<string> {
  return effectiveRoleModel("", role, defaultProjectDocument("", ""));
}

/**
 * Where a new session runs. A caller's explicit choice wins (This machine
 * (container) only for sessions and incident agents); otherwise the
 * project's sandbox, else the global default. Automations follow D3, and
 * their descendants need an unattended-capable sandbox or don't start.
 */
export async function resolveSessionSandbox(
  requested: boolean | string | undefined | null,
  project: string | undefined,
  model: string | null | undefined,
  kind: SessionKind,
): Promise<
  | { ok: true; provider: SandboxProviderId | null }
  | { ok: false; error: string }
> {
  const d = deps();
  const unattended = kind === "automation" || kind === "descendant";
  if (requested !== undefined && requested !== null) {
    if (unattended && typeof requested === "string") {
      if (requested.trim().toLowerCase() === "podman")
        return { ok: false, error: PODMAN_FOR_AUTOMATIONS };
    }
    return d.requested(requested, project, model);
  }
  if (!project) {
    const global = globalChoice(d);
    if (kind === "automation") return { ok: true, provider: null };
    if (kind === "descendant")
      return global && d.automationCapable(global)
        ? d.requested(global, project, model)
        : { ok: true, provider: null };
    return d.requested(global ?? "local", project, model);
  }
  // Automations run where they ran before (D3 as built): this machine
  // unless the automation itself asks for the disposable sandbox, which
  // the automation runner provisions.
  if (kind === "automation") return { ok: true, provider: null };
  let doc: ProjectSettingsDocument;
  try {
    doc = await getProjectDocument(project);
  } catch (error) {
    const why = error instanceof Error ? error.message : error;
    // An incident agent or an automation run may be pinned to a sandbox
    // the global default isn't: stop, so the incident shows a setup
    // problem, rather than run somewhere looser.
    if (kind !== "interactive") {
      console.warn(`[project-settings] ${project} settings unreadable:`, why);
      return {
        ok: false,
        error: `Can't start: the settings for ${project} could not be read`,
      };
    }
    // Starting a session must not depend on the project settings being
    // readable: use the global default, as a project that sets none does.
    console.warn(
      `[project-settings] ${project} settings unreadable, using the global sandbox:`,
      why,
    );
    doc = defaultProjectDocument(project, "");
  }
  if (kind === "descendant") {
    const own = projectChoice(doc);
    const chosen = own === undefined ? globalChoice(d) : own;
    if (chosen && d.automationCapable(chosen))
      return d.requested(chosen, project, model);
    return {
      ok: false,
      error:
        "Can't start: runs started by automations need a sandbox that runs unattended (Daytona)",
    };
  }
  const own = projectChoice(doc);
  const chosen = own === undefined ? globalChoice(d) : own;
  return d.requested(chosen ?? "local", project, model);
}

export const WEB_SEARCH_OFF =
  "Web search is off for this agent in the project's access settings.";

/**
 * What the access table lets Automations, Reviews or Support do on the web: a
 * `web_search` denial when the role's web search cell is off, and the
 * project's websites ticked for the role (callers add the global list).
 * Unreadable settings deny web search and add no websites.
 */
export async function roleWebAccess(
  project: string,
  role: "automations" | "reviews" | "support",
): Promise<{ deniedTools: Record<string, string>; websites: string[] }> {
  try {
    const doc = await getProjectDocument(project);
    return {
      deniedTools: (doc.access.webSearch as string[]).includes(role)
        ? {}
        : { web_search: WEB_SEARCH_OFF },
      websites: doc.access.websites
        .filter((row) => row.roles.includes(role))
        .map((row) => row.host),
    };
  } catch (error) {
    console.warn(
      `[project-settings] ${project} settings unreadable, ${role} get no web search:`,
      error instanceof Error ? error.message : error,
    );
    return { deniedTools: { web_search: WEB_SEARCH_OFF }, websites: [] };
  }
}

/** The websites an automation on `project` may reach: the global list and
 *  the project's websites ticked for Automations. */
export async function automationEgressHosts(
  project: string,
): Promise<string[]> {
  const out = globalWebsites();
  try {
    const doc = await getProjectDocument(project);
    for (const row of doc.access.websites)
      if (row.roles.includes("automations") && !out.includes(row.host))
        out.push(row.host);
  } catch (error) {
    console.warn(
      "[project-settings] websites unreadable, using the global list:",
      error instanceof Error ? error.message : error,
    );
  }
  return out;
}
