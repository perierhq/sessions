// Typed client for per-project settings and the global defaults
// (routes/projects.ts, routes/project-defaults.ts). The one place to follow
// a server rename. Writes throw `ApiError` with the HTTP status, so the page
// can tell a stale revision (409) from a missing permission (403).

import type {
  MigrationResult,
  ProjectDefaultsPatch,
  ProjectDefaultsView,
  ProjectListItem,
  ProjectRemigrateResult,
  ProjectSettingsPatch,
  ProjectSettingsView,
} from "../../../shared/project-settings";
import { request } from "./request";

export { ApiError } from "./request";

const seg = encodeURIComponent;

export function fetchProjects(): Promise<ProjectListItem[]> {
  return request<ProjectListItem[]>("/project-settings", {
    label: "Failed to load projects",
  });
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

function remigrate(
  project: string,
  force: boolean,
): Promise<ProjectRemigrateResult> {
  return request<ProjectRemigrateResult>(`/projects/${seg(project)}/migrate`, {
    method: "POST",
    body: { force },
    label: "Failed to re-run the migration",
  });
}

/** What re-running one project's migration would do, nothing written:
 *  `widened` lists what it gives agents more of than they have now. */
export function previewRemigration(
  project: string,
): Promise<ProjectRemigrateResult> {
  return remigrate(project, false);
}

/** Compose one project from its legacy settings again, after they changed
 *  during an upgrade. Confirmed (`force`): the server backs up the current
 *  settings, then replaces them. */
export function remigrateProject(
  project: string,
): Promise<ProjectRemigrateResult> {
  return remigrate(project, true);
}
