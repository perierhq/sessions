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
 * One line on where an automation runs. `place` is the project's
 * automations cell once it has loaded; `undefined` while it loads or when
 * the automation has no project.
 */
export function automationPlaceCopy(
  automation: AutomationPlaceInput,
  place: RunPlace | undefined,
): string {
  if (automation.sandbox) return LEGACY_SANDBOX_COPY;
  const repo = automation.repo;
  if (!repo) {
    return "Runs on the default sandbox when it can run unattended, else on this machine · set in Projects → Defaults";
  }
  const where = `set by ${repo} → Where agents run`;
  if (!place) return `Runs where ${repo} says · ${where}`;
  if (place.state === "cant-start")
    return `Can't start: ${place.reason} · ${where}`;
  return `Runs on ${place.label} · ${where}`;
}

/** The empty choice in the model field: the model a run gets without one. */
export function automationDefaultModelLabel(
  projectModel: string | undefined,
  globalModel: string,
): string {
  if (projectModel) return `Project default · ${projectModel}`;
  return globalModel ? `Default · ${globalModel}` : "Default";
}
