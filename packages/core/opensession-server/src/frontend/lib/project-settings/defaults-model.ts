// Copy and small rules for the global Defaults page (Settings → Projects →
// Defaults). Pure: the page and the settings nav read the same phrases
// from here, so a project never carries two different statuses.

import { parseAutomationEgressDomain } from "../../../server/sandbox/automation-egress";
import type {
  ProjectDefaultsView,
  ProjectListItem,
  ProjectRole,
} from "../../../shared/project-settings";

/** The one status phrase for a project: the nav, the Projects card and the
 *  phone list all show this and nothing else. */
export function projectStatusPhrase(item: ProjectListItem): string {
  return item.status.label;
}

/** Who uses the default sandbox. The server builds the sentence; a count is
 *  the fallback when it sent none. */
export function sandboxUsedByCopy(view: ProjectDefaultsView): string {
  if (view.sandboxUsedBy) return view.sandboxUsedBy;
  const n = view.projects.length;
  return `Used by ${n} ${n === 1 ? "project" : "projects"}`;
}

/** "a", "a and b", "a, b, and c". */
function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** Which projects a role's default model reaches: "All 3 projects", or the
 *  ones that use it and the ones that set their own. */
export function roleScopeCopy(
  role: ProjectRole,
  projects: ProjectListItem[],
  overrides: Record<string, ProjectRole[]>,
): string {
  if (projects.length === 0) return "No projects yet";
  const own = projects.filter((p) => overrides[p.id]?.includes(role));
  const using = projects.filter((p) => !own.includes(p));
  if (own.length === 0) {
    return projects.length === 1
      ? projects[0]!.label
      : `All ${projects.length} projects`;
  }
  const users = using.length
    ? joinNames(using.map((p) => p.label))
    : "No project";
  const setters = joinNames(own.map((p) => p.label));
  return `${users}. ${setters} ${own.length === 1 ? "sets its own" : "set their own"}`;
}

/** The roles each project has set its own model for, as far as the list
 *  says: today only the model for You travels with a project. */
export function modelOverrides(
  view: ProjectDefaultsView,
): Record<string, ProjectRole[]> {
  const out: Record<string, ProjectRole[]> = {};
  for (const project of view.projects) {
    if (project.modelForYou && project.modelForYou !== view.models.you) {
      out[project.id] = ["you"];
    }
  }
  return out;
}

/** A website for the unattended allowlist, checked on the client by the
 *  server's own rules for instant feedback. The server stays the
 *  authority. */
export function parseWebsite(
  value: string,
): { host: string } | { error: string } {
  if (!value.trim())
    return { error: "Enter a website, like status.example.test" };
  try {
    const host = parseAutomationEgressDomain(value);
    return { host };
  } catch {
    return {
      error:
        "Enter a website name, like status.example.test, with no path or port",
    };
  }
}
