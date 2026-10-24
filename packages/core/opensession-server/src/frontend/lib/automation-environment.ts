// Where an automation runs, as its form and detail say it: the project's
// sandbox for automations (Settings → Projects → the project → Where agents
// run), a per-automation disposable sandbox kept from before projects had
// their own, or the global default. The server decides; this is the copy.

import type { RunPlace } from "../../shared/project-settings";

/** The fields of an automation these rules read. */
export interface AutomationPlaceInput {
  sandbox?: boolean;
  repo?: string;
  incidentResponse?: { project: string };
}

/** The automations the list shows. The built-in incident automation is
 *  reached from its incident and its project page, never from here. */
export function visibleAutomations<T extends AutomationPlaceInput>(
  automations: readonly T[],
): T[] {
  return automations.filter((a) => !a.incidentResponse);
}

export const LEGACY_SANDBOX_COPY =
  "Disposable sandbox (set before projects had their own)";

/**
 * The project whose place an automation runs in: its own repo, else the
 * instance default repo (the server's `getRepo(undefined)`: the repo marked
 * default, else the first). `null` for a kept disposable sandbox, or while
 * the repos load.
 */
export function automationProject(
  automation: AutomationPlaceInput,
  repos: ReadonlyArray<{ id: string; default?: boolean }> | undefined,
): string | null {
  if (automation.sandbox) return null;
  if (automation.repo) return automation.repo;
  return (repos?.find((r) => r.default) ?? repos?.[0])?.id ?? null;
}

/**
 * One line on where an automation runs. `project` is `automationProject`;
 * `place` is that project's automations cell once it has loaded.
 */
export function automationPlaceCopy(
  automation: AutomationPlaceInput,
  place: RunPlace | undefined,
  project: string | null = automation.repo ?? null,
): string {
  if (automation.sandbox) return LEGACY_SANDBOX_COPY;
  if (!project) return "Runs where the default project says";
  const where = `Set in ${project} → Where agents run`;
  if (!place) return `Runs where ${project} says. ${where}`;
  if (place.state === "cant-start")
    return `Can't start: ${place.reason}. ${where}`;
  return `Runs on ${place.label}. ${where}`;
}

/** The empty choice in the model field: the model a run gets without one. */
export function automationDefaultModelLabel(
  projectModel: string | undefined,
  globalModel: string,
): string {
  if (projectModel) return `Project default · ${projectModel}`;
  return globalModel ? `Default · ${globalModel}` : "Default";
}
