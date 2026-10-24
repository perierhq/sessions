// What each role of a project actually gets: its model and where its runs
// happen. Sandbox precedence is a per-session choice, then the project,
// then the global default; the personal default is gone. Automations need a
// sandbox that can run unattended (Daytona today): the project's when it
// can, else the global default's, else this machine as before (D3).
// Reviews run on this machine (D4). Incident agents use the project's
// sandbox, else This machine (container) when Ready, else the experimental
// host path, else they can't start.
import {
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

/** Where automations run (D3). */
function automationPlace(
  doc: ProjectSettingsDocument,
  d: EffectiveDeps,
): RunPlace {
  const own = projectChoice(doc);
  if (own && d.automationCapable(own)) return place(own, "project");
  const global = globalChoice(d);
  if (global && d.automationCapable(global)) return place(global, "default");
  return place(null, "fallback");
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

function sameProvider(a: RunPlace, b: RunPlace): boolean {
  return a.state === "ok" && b.state === "ok" && a.provider === b.provider;
}

function sandboxNote(s: Omit<EffectiveSandbox, "note">): string | null {
  if (s.incidentAgents.state === "cant-start")
    return "No sandbox provider is connected, so incident agents can't start. Connect one in the checklist above";
  if (s.automations.state !== "ok" || s.automations.source === "project")
    return null;
  if (s.you.state !== "ok" || s.you.provider === null) return null;
  if (!sameProvider(s.you, s.incidentAgents)) return null;
  const who = "Sessions, reviews and incident agents run here";
  return s.automations.source === "default"
    ? `${who}. Automations use the global default`
    : `${who}. Automations run on this machine`;
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
  // Reviews run on this machine in v1 (D4).
  const reviews = place(null, "fallback");
  const automations = automationPlace(document, d);
  const base = { you, reviews, automations, incidentAgents };
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
    if (unattended)
      return global && d.automationCapable(global)
        ? d.requested(global, project, model)
        : { ok: true, provider: null };
    return d.requested(global ?? "local", project, model);
  }
  const doc = await getProjectDocument(project);
  if (unattended) {
    const at = automationPlace(doc, d);
    if (at.state === "ok" && at.provider)
      return d.requested(at.provider, project, model);
    if (kind === "descendant")
      return {
        ok: false,
        error:
          "Can't start: runs started by automations need a sandbox that runs unattended (Daytona)",
      };
    return { ok: true, provider: null };
  }
  const own = projectChoice(doc);
  const chosen = own === undefined ? globalChoice(d) : own;
  return d.requested(chosen ?? "local", project, model);
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
