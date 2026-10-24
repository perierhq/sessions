/** Workspace and project defaults for new interactive sandbox sessions. The
 *  personal default is gone: a session's own choice beats the project's,
 *  which beats the workspace's (projects/effective.ts). */

import type { SandboxProviderId } from "./provider";
import {
  RUNNABLE_SANDBOX_PROVIDERS,
  type RunnableSandboxProviderId,
  sandboxConfig,
  sandboxProviderCertified,
  sandboxProviderConfigured,
  setRepoPortalSandbox,
  setWorkspaceSandboxDefault,
} from "./config";
import {
  getSandboxConnection,
  isWorkspaceSandboxProvider,
  sandboxConnectionReady,
} from "./connections";

export type WorkspaceSandboxDefault = RunnableSandboxProviderId | "none";

export interface SandboxDefaultsStatus {
  workspace: WorkspaceSandboxDefault;
  /** What a new session starts in, for `repo` when one was named. */
  effective: WorkspaceSandboxDefault;
  /** Per-repo overrides (the project settings' sandbox); a repo absent here
   *  follows the workspace default. */
  repos: Record<string, WorkspaceSandboxDefault>;
  /** Repos whose Portals run in a Sandbox of their own for sessions on this
   * machine (repo id → provider); a repo absent here runs them beside the
   * session. */
  portals: Record<string, RunnableSandboxProviderId>;
}

function runnable(value: unknown): value is RunnableSandboxProviderId {
  return (
    typeof value === "string" &&
    (RUNNABLE_SANDBOX_PROVIDERS as readonly string[]).includes(value)
  );
}

export function workspaceSandboxDefault(): WorkspaceSandboxDefault {
  const value = sandboxConfig().sessionDefault;
  return runnable(value) ? value : "none";
}

/** The project documents' own sandbox choices, as workspace-style values. */
async function projectSandboxDefaults(): Promise<
  Record<string, WorkspaceSandboxDefault>
> {
  const { listProjectDocuments } = await import("../projects/store");
  const out: Record<string, WorkspaceSandboxDefault> = {};
  for (const doc of await listProjectDocuments()) {
    if (doc.sandbox === "local") out[doc.project] = "none";
    else if (runnable(doc.sandbox)) out[doc.project] = doc.sandbox;
  }
  return out;
}

/** A project's own sandbox choice, or null when it follows the default. */
async function projectSandboxDefault(
  repoId: string | undefined,
): Promise<WorkspaceSandboxDefault | null> {
  if (!repoId) return null;
  const { getProjectDocument } = await import("../projects/store");
  const doc = await getProjectDocument(repoId);
  if (doc.sandbox === "local") return "none";
  return runnable(doc.sandbox) ? doc.sandbox : null;
}

export function repoPortalSandboxes(): Record<
  string,
  RunnableSandboxProviderId
> {
  const out: Record<string, RunnableSandboxProviderId> = {};
  for (const [repoId, override] of Object.entries(
    sandboxConfig().perRepo || {},
  )) {
    if (override.portalSandbox) out[repoId] = override.portalSandbox;
  }
  return out;
}

export async function sandboxDefaultsStatus(
  repoId?: string,
): Promise<SandboxDefaultsStatus> {
  const workspace = workspaceSandboxDefault();
  const [repos, project] = await Promise.all([
    projectSandboxDefaults(),
    projectSandboxDefault(repoId),
  ]);
  return {
    workspace,
    effective: effectiveSandboxDefault(workspace, project),
    repos,
    portals: repoPortalSandboxes(),
  };
}

/** Precedence: the project's own default, then the workspace's. Only a
 *  per-session choice beats it. */
export function effectiveSandboxDefault(
  workspace: WorkspaceSandboxDefault,
  project?: WorkspaceSandboxDefault | null,
): WorkspaceSandboxDefault {
  return project ?? workspace;
}

function assertAvailable(
  value: string,
): asserts value is RunnableSandboxProviderId {
  if (!runnable(value)) throw new Error(`Unknown sandbox provider "${value}"`);
  if (
    isWorkspaceSandboxProvider(value) &&
    getSandboxConnection(value) &&
    !sandboxConnectionReady(value)
  ) {
    throw new Error(`Sandbox provider "${value}" is not currently available`);
  }
  if (!sandboxProviderCertified(value) || !sandboxProviderConfigured(value)) {
    throw new Error(`Sandbox provider "${value}" is not currently available`);
  }
}

export async function saveWorkspaceSandboxDefault(
  value: string,
): Promise<SandboxDefaultsStatus> {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "none") assertAvailable(normalized);
  setWorkspaceSandboxDefault(normalized);
  return sandboxDefaultsStatus();
}

/** Writes the project settings' sandbox ("workspace" follows the default,
 *  "none" is this machine) as `actor`; changing it needs a verified person. */
export async function saveRepoSandboxDefault(
  repoId: string,
  value: string,
  actor: { name: string; verified: boolean; login?: string },
): Promise<SandboxDefaultsStatus> {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "workspace" && normalized !== "none")
    assertAvailable(normalized);
  const sandbox =
    normalized === "workspace"
      ? "default"
      : normalized === "none"
        ? "local"
        : normalized;
  const { getProjectDocument, updateProjectDocument } =
    await import("../projects/store");
  const { revision } = await getProjectDocument(repoId);
  const out = await updateProjectDocument(
    repoId,
    { expectedRevision: revision, sandbox },
    actor,
  );
  if ("error" in out) throw new Error(out.error);
  return sandboxDefaultsStatus(repoId);
}

/** `none` runs the repo's Portals beside the session again. */
export async function saveRepoPortalSandbox(
  repoId: string,
  value: string,
): Promise<SandboxDefaultsStatus> {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "none") assertAvailable(normalized);
  setRepoPortalSandbox(repoId, normalized);
  return sandboxDefaultsStatus(repoId);
}

/** Apply defaults only when a caller omitted `sandbox`. false/""/"local"
 * remain explicit Host choices, preserving per-session overrides. The
 * person who asked no longer matters: the personal default is gone. */
export async function resolveInteractiveSandbox(
  requested: boolean | string | undefined | null,
  _user: string | undefined | null,
  repoId?: string,
  model?: string | null,
): Promise<
  | { ok: true; provider: SandboxProviderId | null }
  | { ok: false; error: string }
> {
  const { resolveSessionSandbox } = await import("../projects/effective");
  return resolveSessionSandbox(requested, repoId, model, "interactive");
}
