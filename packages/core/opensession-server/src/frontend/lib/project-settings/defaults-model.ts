// Copy and small rules for the global Defaults page (Settings → Projects →
// Defaults). Pure: the page and the settings nav read the same phrases
// from here, so a project never carries two different statuses.

import { parseAutomationEgressDomain } from "../../../server/sandbox/automation-egress";
import {
  readySandboxProviders,
  type SandboxAvailability,
} from "../ready-sandbox-providers";
import {
  PROJECT_ROLES,
  type ProjectDefaultsView,
  type ProjectListItem,
  type ProjectRole,
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

/**
 * A line cut around the hyphenated project names in it, so each can be set
 * unbreakable: a browser wraps at a hyphen, which splits "perier-site".
 * Longest names first, and only whole names.
 */
export function splitNames(
  text: string,
  names: readonly string[],
): Array<{ text: string; name: boolean }> {
  const hyphenated = [...new Set(names.filter((n) => n.includes("-")))].sort(
    (a, b) => b.length - a.length,
  );
  if (!hyphenated.length) return [{ text, name: false }];
  const escaped = hyphenated.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![\\w-])(?:${escaped.join("|")})(?![\\w-])`, "g");
  const out: Array<{ text: string; name: boolean }> = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at)
      out.push({ text: text.slice(at, match.index), name: false });
    out.push({ text: match[0], name: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), name: false });
  return out;
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
  overrides: ModelOverrides,
): string {
  if (projects.length === 0) return "No projects yet";
  const own = projects.filter((p) => overrides[p.id]?.includes(role));
  const using = projects.filter((p) => !own.includes(p));
  if (own.length === 0) {
    return projects.length === 1
      ? projects[0]!.label
      : `All ${projects.length} projects`;
  }
  if (using.length === 0)
    return projects.length === 1
      ? `${projects[0]!.label} sets its own`
      : "Every project sets its own";
  const users = joinNames(using.map((p) => p.label));
  const setters = joinNames(own.map((p) => p.label));
  return `${users}. ${setters} ${own.length === 1 ? "sets its own" : "set their own"}`;
}

/** The copy while the page doesn't yet know which projects set their own
 *  model for a role. */
export const UNKNOWN_SCOPE_COPY =
  "Used by every project that doesn't set its own";

/** `roleScopeCopy`, or the neutral line when `overrides` is unknown. */
export function roleScopeCopyFor(
  role: ProjectRole,
  projects: ProjectListItem[],
  overrides: ModelOverrides | null,
): string {
  return overrides
    ? roleScopeCopy(role, projects, overrides)
    : UNKNOWN_SCOPE_COPY;
}

/** Every role each project's own document sets a model for. */
export function modelOverridesFromDocuments(
  documents: Array<{
    project: string;
    models: Partial<Record<ProjectRole, string>>;
  }>,
): ModelOverrides {
  const out: ModelOverrides = {};
  for (const doc of documents) {
    const roles = PROJECT_ROLES.filter((role) => !!doc.models[role]);
    if (roles.length) out[doc.project] = roles;
  }
  return out;
}

/** Project id → the roles that project sets its own model for. */
export interface ModelOverrides {
  [project: string]: ProjectRole[];
}

/** The roles each project has set its own model for, as far as the list
 *  says: only the model for You travels with a project, so the page
 *  reads the project documents for the other roles. */
export function modelOverrides(view: ProjectDefaultsView): ModelOverrides {
  const out: ModelOverrides = {};
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

/** The slice of `/api/sandbox/status` that says where a project's new
 *  sessions start. */
export interface SandboxDefaultsSlice {
  defaults?: {
    workspace: string;
    repos?: Record<string, string>;
  };
}

/**
 * Where a new session in `repo` starts unless the person picks: the
 * project's sandbox, else the global default. `""` is this machine. A
 * personal default no longer exists, so a stored one is ignored.
 */
export function newSessionSandboxDefault(
  status: SandboxDefaultsSlice | null | undefined,
  repo: string,
): string {
  const defaults = status?.defaults;
  if (!defaults) return "";
  const own = defaults.repos?.[repo];
  const value =
    own && own !== "workspace" && own !== "default" ? own : defaults.workspace;
  return !value || value === "none" ? "" : value;
}

/**
 * What New Session starts with before the person picks: the default above
 * when it can run now, else this machine. The picker marks the same value
 * "Default", so what it shows and what it sends agree.
 */
export function newSessionSandboxPreselect(
  status: (SandboxDefaultsSlice & SandboxAvailability) | null | undefined,
  repo: string,
): string {
  const value = newSessionSandboxDefault(status, repo);
  return value && readySandboxProviders(status).includes(value) ? value : "";
}
