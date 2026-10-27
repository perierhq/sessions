// What a support session runs with, from the project's Support role: its
// model, the connectors ticked for Support (never one restricted to named
// people: the run carries no user), its mode, and where it runs (the
// incident agents' rule, effectiveSandboxes(...).support). The Reviews role
// is the precedent (githubFlowMcpServers, reviewsModel in
// agents/github/run.ts). Unreadable settings give the least: read-only, no
// connectors, and no place to run. Nothing runs at import.

import type { ProjectSettingsDocument } from "../../shared/project-settings";
import type { SandboxRequest } from "../session-control";
import { withoutPeopleRestricted } from "../connections";
import {
  defaultRoleModel,
  effectiveRoleModel,
  effectiveSandboxes,
} from "../projects/effective";
import { getProjectDocument } from "../projects/store";

export interface SupportRunSpec {
  model: string;
  /** Connectors ticked for Support, never people-restricted ones. */
  mcpServers: string[];
  /** From access.modes.support. The support session itself always runs in
   *  ask mode; this is what a fix session may use (C5). */
  mode: "ask" | "code";
  sandbox:
    | { ok: true; request: SandboxRequest }
    | { ok: false; reason: string };
}

const SANDBOX_REQUESTS = new Set<string>([
  "daytona",
  "box",
  "tart",
  "usecomputer",
  "podman",
  "modal",
]);

/** A run place's provider as a create request, or null when Support can't
 *  run there. Never this machine (`null` or "local"): support reads
 *  untrusted mail, so it runs only in a sandbox, whatever the run place
 *  says (effective.ts supportPlace already refuses the host). */
export function supportSandboxRequest(
  provider: string | null,
): SandboxRequest | null {
  if (provider === null || provider === "local") return null;
  // SAFETY: SANDBOX_REQUESTS lists only SandboxRequest provider names.
  return SANDBOX_REQUESTS.has(provider) ? (provider as SandboxRequest) : null;
}

function supportConnectors(doc: ProjectSettingsDocument): string[] {
  return withoutPeopleRestricted(
    doc.access.connections
      .filter((c) => c.roles.includes("support"))
      .map((c) => c.server),
  );
}

/** The connectors a project ticks for Support, minus people-restricted
 *  ones, read fresh for every turn. Throws when the settings can't be
 *  read. */
export async function supportMcpServers(project: string): Promise<string[]> {
  return supportConnectors(await getProjectDocument(project));
}

export async function supportRunSpec(project: string): Promise<SupportRunSpec> {
  let doc: ProjectSettingsDocument;
  try {
    doc = await getProjectDocument(project);
  } catch (error) {
    console.warn(
      `[support] ${project} settings unreadable, the support agent can't start:`,
      error instanceof Error ? error.message : error,
    );
    let model = "";
    try {
      model = await defaultRoleModel("support");
    } catch {
      // No model either; the sandbox below already stops the start.
    }
    return {
      model,
      mcpServers: [],
      mode: "ask",
      sandbox: {
        ok: false,
        reason: `the settings for ${project} could not be read`,
      },
    };
  }
  const model = await effectiveRoleModel(project, "support", doc);
  const mcpServers = supportConnectors(doc);
  const mode = doc.access.modes.support === "code" ? "code" : "ask";
  const place = (await effectiveSandboxes(project, doc)).support;
  if (place.state !== "ok")
    return {
      model,
      mcpServers,
      mode,
      sandbox: { ok: false, reason: place.reason },
    };
  const request = supportSandboxRequest(place.provider);
  return {
    model,
    mcpServers,
    mode,
    sandbox: request
      ? { ok: true, request }
      : { ok: false, reason: `${place.label} can't run support agents` },
  };
}
