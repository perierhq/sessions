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
import type {
  SandboxProviderId,
  SandboxProviderUsability,
} from "../sandbox/provider";
import {
  isRunnableSandboxProvider,
  resolveRequestedSandbox,
  sandboxAutomationAvailability,
  parseSandboxChoice,
  sandboxConfig,
  sandboxProviderUsability,
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
  /** Whether a provider can take new runs now: the same authority session
   *  create checks (sandbox/config.ts sandboxProviderUsability). */
  providerUsability: (provider: string) => SandboxProviderUsability["state"];
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
    providerUsability:
      depsOverride?.providerUsability ??
      ((provider) =>
        isRunnableSandboxProvider(provider)
          ? sandboxProviderUsability(provider).state
          : "usable"),
  };
}

/** Each provider's usability read once per view, not once per role. */
function withUsabilityMemo(d: EffectiveDeps): EffectiveDeps {
  const seen = new Map<string, SandboxProviderUsability["state"]>();
  return {
    ...d,
    providerUsability: (provider) => {
      let state = seen.get(provider);
      if (!state) {
        state = d.providerUsability(provider);
        seen.set(provider, state);
      }
      return state;
    },
  };
}

/** How a run place reads: a provider's name, or this machine. */
export function sandboxLabel(provider: string | null): string {
  // Modal with a GPU (`modal:T4`) reads "Modal · T4 GPU".
  const gpuChoice = provider ? parseSandboxChoice(provider) : null;
  if (gpuChoice?.gpu)
    return `${sandboxLabel(gpuChoice.provider)} · ${gpuChoice.gpu} GPU`;
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
    case "modal":
      return "Modal";
    default:
      return provider;
  }
}

/** The project's own choice as a provider (`null` = this machine), or
 *  undefined when it follows the global default. A GPU on the choice
 *  (`modal:T4`) is left out: it rides along to new sessions only
 *  (sandbox/defaults.ts defaultSandboxGpu). */
function projectChoice(
  doc: ProjectSettingsDocument,
): string | null | undefined {
  if (doc.sandbox === "default") return undefined;
  if (doc.sandbox === "local") return null;
  return parseSandboxChoice(doc.sandbox)?.provider ?? doc.sandbox;
}

/** The GPU the project's own Modal choice carries, if any. */
function projectGpu(doc: ProjectSettingsDocument): string | undefined {
  return parseSandboxChoice(doc.sandbox)?.gpu;
}

function globalChoice(d: EffectiveDeps): string | null {
  const g = d.global();
  return g === "none" ? null : g;
}

/** A provider as a not-ready reason names it. */
function providerName(provider: string): string {
  return provider === "podman"
    ? "This machine (container)"
    : sandboxLabel(provider);
}

/** Why runs on `provider` can't start now, in the words Settings,
 *  Sandboxes uses for its state, or null when it can take them. */
function notReadyReason(provider: string, d: EffectiveDeps): string | null {
  const name = providerName(provider);
  switch (d.providerUsability(provider)) {
    case "usable":
      return null;
    case "not_configured":
      return `${name} isn't connected`;
    case "unqualified":
      return `${name} needs attention`;
    case "unavailable":
      return `${name} isn't available`;
  }
}

/** A role's place on `provider`, not ready when the provider can't take
 *  runs: session create would refuse it (resolveRequestedSandbox). */
function place(
  provider: string | null,
  source: "project" | "default" | "fallback",
  d: EffectiveDeps,
  label = sandboxLabel(provider),
): RunPlace {
  const reason = provider ? notReadyReason(provider, d) : null;
  if (provider && reason)
    return { state: "not-ready", provider, label, source, reason };
  return { state: "ok", provider, label, source };
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
  const label = boxed
    ? `${AUTOMATIONS_AS_BEFORE} (${boxed} of ${automations.length} in a disposable sandbox)`
    : AUTOMATIONS_AS_BEFORE;
  const all = boxed > 0 && boxed === automations.length;
  if (boxed > 0) {
    // The ones that ask for a disposable sandbox can't launch without it
    // (automations.ts validateSandboxAutomation).
    const provider = d.automationProvider();
    const reason = d.automationCapable(provider)
      ? null
      : (notReadyReason(provider, d) ??
        "Disposable sandboxes need a dial-back URL");
    if (reason)
      return {
        state: "not-ready",
        provider,
        label: all ? AUTOMATIONS_DISPOSABLE : label,
        source: "fallback",
        reason,
      };
  }
  if (all)
    return {
      state: "ok",
      provider: d.automationProvider(),
      label: AUTOMATIONS_DISPOSABLE,
      source: "fallback",
    };
  return { state: "ok", provider: null, label, source: "fallback" };
}

/** Where interactive sessions start when nobody chose. */
function youPlace(doc: ProjectSettingsDocument, d: EffectiveDeps): RunPlace {
  const own = projectChoice(doc);
  const gpu = projectGpu(doc);
  if (own && gpu)
    return place(own, "project", d, sandboxLabel(`${own}:${gpu}`));
  if (own !== undefined) return place(own, "project", d);
  return place(globalChoice(d), "default", d);
}

async function incidentPlace(
  doc: ProjectSettingsDocument,
  model: string,
  d: EffectiveDeps,
): Promise<RunPlace> {
  const own = projectChoice(doc);
  const chosen = own === undefined ? globalChoice(d) : own;
  if (chosen)
    return place(chosen, own === undefined ? "default" : "project", d);
  if (d.podmanReady(doc.project, model)) return place("podman", "fallback", d);
  if (d.hostEnabled() && (await d.hostProblem()) === null)
    return place(null, "fallback", d);
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

const NOT_READY_ROLES = [
  ["you", "sessions"],
  ["automations", "automations"],
  ["incidentAgents", "incident agents"],
  ["support", "Support"],
] as const;

/** "a", "a and b", "a, b and c". */
function listRoles(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What can't start on a provider that isn't ready: "Modal isn't
 *  connected, so sessions and incident agents can't start". */
function notReadyNote(s: Omit<EffectiveSandbox, "note">): string | null {
  const byReason = new Map<string, string[]>();
  for (const [key, role] of NOT_READY_ROLES) {
    const p = s[key];
    if (p.state !== "not-ready") continue;
    byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), role]);
  }
  if (!byReason.size) return null;
  return [...byReason]
    .map(([reason, roles]) => `${reason}, so ${listRoles(roles)} can't start`)
    .join(". ");
}

function sandboxNote(s: Omit<EffectiveSandbox, "note">): string | null {
  const notReady = notReadyNote(s);
  if (notReady) return notReady;
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
  const d = withUsabilityMemo(deps());
  const document = doc ?? (await getProjectDocument(project));
  const model = await effectiveRoleModel(project, "investigator", document);
  const you = youPlace(document, d);
  const incidentAgents = await incidentPlace(document, model, d);
  const supportModel = await effectiveRoleModel(project, "support", document);
  const support = await supportPlace(document, supportModel, d);
  // Reviews run on this machine in v1 (D4).
  const reviews = place(null, "fallback", d);
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

/**
 * The project's Support websites switched to "Use as knowledge": the hosts
 * the knowledge import crawls and whose pages may back replies. Other
 * Support websites stay links-only. Throws when the settings can't be
 * read: callers retire mirrors of hosts not listed, so never guess.
 */
export async function knowledgeWebsites(project: string): Promise<string[]> {
  const doc = await getProjectDocument(project);
  return doc.access.websites
    .filter((row) => row.roles.includes("support") && row.knowledge === true)
    .map((row) => row.host);
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
