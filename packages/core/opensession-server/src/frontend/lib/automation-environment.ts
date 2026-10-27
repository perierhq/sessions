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
 * The project an automation's form starts on. Editing: the automation's own
 * project (its repo, else the instance default), kept disposable sandbox or
 * not, since the project still sets its model. Creating: the draft's project,
 * else the one the person is in (the sidebar's project filter, which a new
 * session starts from too), else the default. Names that aren't registered
 * are skipped. `null` while the repos load.
 */
export function automationStartProject(
  source: {
    initial?: AutomationPlaceInput | null;
    prefillRepo?: string;
    lens?: string;
  },
  repos: ReadonlyArray<{ id: string; default?: boolean }> | undefined,
): string | null {
  if (source.initial)
    return automationProject({ repo: source.initial.repo }, repos);
  if (!repos) return null;
  const registered = (id?: string) =>
    id && repos.some((repo) => repo.id === id) ? id : null;
  return (
    registered(source.prefillRepo) ??
    registered(source.lens) ??
    automationProject({}, repos)
  );
}

/** The part of a create or update call that names the project. */
export interface AutomationRepoPatch {
  repo?: string;
}

/**
 * The `repo` a save sends. A new automation names its project. An edit sends
 * it only when the person picked a different one, so an automation that
 * follows the default project keeps following it, and one whose repo is no
 * longer registered still saves its other fields.
 */
export function automationRepoPayload(
  initial: AutomationPlaceInput | null,
  project: string | null,
  repos: ReadonlyArray<{ id: string; default?: boolean }> | undefined,
): AutomationRepoPatch {
  if (!project) return {};
  if (!initial) return { repo: project };
  return project === automationStartProject({ initial }, repos)
    ? {}
    : { repo: project };
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
  if (place.state !== "ok") return `Can't start: ${place.reason}. ${where}`;
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
