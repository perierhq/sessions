// SWR hooks for per-project settings and the global defaults. Reads
// revalidate on focus and reconnect; a write's response is the new view,
// so callers pass it to `mutate` instead of refetching.
import useSWR, {
  type Arguments,
  mutate as revalidateApiResources,
  type SWRResponse,
} from "swr";
import {
  fetchProjectDefaults,
  fetchProjects,
  fetchProjectSettings,
} from "../lib/api/projects";
import { apiResourceSWRConfig } from "../lib/api-swr";
import type {
  ProjectDefaultsView,
  ProjectListItem,
  ProjectSettingsView,
} from "../../shared/project-settings";

/** Resource keys for the project settings hooks; every one starts with
 *  `["api", "project…"]` so `isProjectKey` can revalidate them together. */
export const projectSWRKey = {
  projects: () => ["api", "projects"] as const,
  projectSettings: (project: string) =>
    ["api", "project-settings", project] as const,
  projectDefaults: () => ["api", "project-defaults"] as const,
};

/** A project settings resource key. */
export function isProjectKey(key: Arguments): boolean {
  return (
    Array.isArray(key) &&
    key[0] === "api" &&
    String(key[1] ?? "").startsWith("project")
  );
}

/**
 * Revalidate every project resource after a write: the project list (the
 * nav and Defaults status phrases), open project pages (effective sandbox
 * and model labels, readiness) and the defaults. `except` is the key the
 * write's own response was just cached under.
 */
export function revalidateProjects(except?: readonly unknown[]): void {
  void revalidateApiResources(
    (key: Arguments) =>
      isProjectKey(key) &&
      !(
        except &&
        Array.isArray(key) &&
        key.length === except.length &&
        key.every((part, i) => part === except[i])
      ),
  );
}

export function useProjects(): SWRResponse<ProjectListItem[]> {
  return useSWR<ProjectListItem[]>(
    projectSWRKey.projects(),
    fetchProjects,
    apiResourceSWRConfig<ProjectListItem[]>(0),
  );
}

export function useProjectSettings(
  project: string | null,
): SWRResponse<ProjectSettingsView> {
  return useSWR<ProjectSettingsView>(
    project ? projectSWRKey.projectSettings(project) : null,
    () => fetchProjectSettings(project!),
    apiResourceSWRConfig<ProjectSettingsView>(0),
  );
}

export function useProjectDefaults(): SWRResponse<ProjectDefaultsView> {
  return useSWR<ProjectDefaultsView>(
    projectSWRKey.projectDefaults(),
    fetchProjectDefaults,
    apiResourceSWRConfig<ProjectDefaultsView>(0),
  );
}
