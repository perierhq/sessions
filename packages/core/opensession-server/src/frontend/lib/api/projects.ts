// Typed client for per-project settings and the global defaults
// (routes/projects.ts, routes/project-defaults.ts). The one place to follow
// a server rename. Writes throw `ApiError` with the HTTP status, so the page
// can tell a stale revision (409) from a missing permission (403).

import type {
  MigrationResult,
  ProjectDefaultsPatch,
  ProjectDefaultsView,
  ProjectListItem,
  ProjectSettingsPatch,
  ProjectSettingsView,
} from "../../../shared/project-settings";
import { request } from "./request";

export { ApiError } from "./request";

const seg = encodeURIComponent;

export async function fetchProjects(): Promise<ProjectListItem[]> {
  const list = await request<ProjectListItem[]>("/projects", {
    label: "Failed to load projects",
  });
  // A server whose /api/projects is the older feeds list answers an
  // object; treat it as a failed load rather than a list.
  if (!Array.isArray(list)) throw new Error("Failed to load projects");
  return list;
}

export function fetchProjectSettings(
  project: string,
): Promise<ProjectSettingsView> {
  return request<ProjectSettingsView>(`/projects/${seg(project)}/settings`, {
    label: "Failed to load project settings",
  });
}

/** 409 when `expectedRevision` is stale, 403 for a change that needs a
 *  signed-in person, 400 with the reason for an invalid value. */
export function patchProjectSettings(
  project: string,
  patch: ProjectSettingsPatch,
): Promise<ProjectSettingsView> {
  return request<ProjectSettingsView>(`/projects/${seg(project)}/settings`, {
    method: "PATCH",
    body: patch,
    label: "Failed to save settings",
  });
}

/** Reserve a paired Runner for the project's production. `shared` keeps
 *  what it already serves. */
export function bindProjectRunner(
  project: string,
  runnerId: string,
  opts: { shared?: boolean } = {},
): Promise<ProjectSettingsView> {
  return request<ProjectSettingsView>(
    `/projects/${seg(project)}/production/runners`,
    {
      method: "POST",
      body: { runnerId, shared: opts.shared === true },
      label: "Failed to add the Runner",
    },
  );
}

/** Let runs that carry no user open a connector limited to named people. */
export function allowAgentsOnConnector(
  server: string,
  on = true,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/connections/${seg(server)}/allow-unattended`, {
    method: "POST",
    body: { on },
    label: "Failed to allow agents",
  });
}

export function fetchProjectDefaults(): Promise<ProjectDefaultsView> {
  return request<ProjectDefaultsView>("/project-defaults", {
    label: "Failed to load defaults",
  });
}

export function patchProjectDefaults(
  patch: ProjectDefaultsPatch,
): Promise<ProjectDefaultsView> {
  return request<ProjectDefaultsView>("/project-defaults", {
    method: "PATCH",
    body: patch,
    label: "Failed to save defaults",
  });
}

/** Compose every project's document from the legacy stores. A dry run
 *  only reports. */
export function migrateProjects(opts: {
  dryRun: boolean;
}): Promise<MigrationResult> {
  return request<MigrationResult>("/projects/migrate", {
    method: "POST",
    body: { dryRun: opts.dryRun },
    label: "Failed to migrate project settings",
  });
}
