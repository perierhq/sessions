// Sending a project settings patch with the revision the page loaded, and
// what happens when another tab saved first. A small change (one cell, one
// value, a row added or removed) is refetched and sent once more on the
// fresh revision. A whole list or object would overwrite the other tab's
// edit, so it refetches and rejects instead, and the person looks again.

import type {
  ProjectSettingsPatch,
  ProjectSettingsView,
} from "../../../shared/project-settings";
import { ApiError } from "../api/request";

export type ProjectPatchBody = Omit<ProjectSettingsPatch, "expectedRevision">;

export const STALE_SETTINGS_MESSAGE = "Settings changed since you loaded them";

export interface SendPatchDeps {
  send: (patch: ProjectSettingsPatch) => Promise<ProjectSettingsView>;
  /** Load the settings again; the fresh view, or undefined if it failed. */
  refetch: () => Promise<ProjectSettingsView | undefined>;
  /** A stale revision was refused and the change is sent again on `fresh`
   *  (the toast, and painting the change over the fresh view). */
  onRetry: (fresh: ProjectSettingsView) => void | Promise<void>;
}

export function isStaleRevision<Rejected>(error: Rejected): boolean {
  return error instanceof ApiError && error.status === 409;
}

/** Incident policy fields that are one value each. */
const SCALAR_INCIDENT_FIELDS = new Set([
  "agentsPaused",
  "autonomy",
  "vetoMs",
  "watchMs",
  "maxRounds",
]);

/**
 * Whether sending `body` again on a newer revision keeps the other tab's
 * edits: true for access cells and row deltas, sandbox, previews, models
 * and single incident values; false for whole lists (actions, runners,
 * "never without you") and objects (budget, night rule).
 */
export function isRetrySafePatch(body: ProjectPatchBody): boolean {
  if (body.production) return false;
  for (const [key, value] of Object.entries(body.incidents ?? {})) {
    if (key === "night" && value === null) continue;
    if (!SCALAR_INCIDENT_FIELDS.has(key)) return false;
  }
  return true;
}

/** Sends `body` at `revision`. On a 409 it refetches; a retry-safe change
 *  is sent once more at the fresh revision, anything else rejects with the
 *  stale message. A second refusal, or any other error, rejects. */
export async function sendProjectPatch(
  body: ProjectPatchBody,
  revision: number,
  deps: SendPatchDeps,
): Promise<ProjectSettingsView> {
  try {
    return await deps.send({ ...body, expectedRevision: revision });
  } catch (error) {
    if (!isStaleRevision(error)) throw error;
    const fresh = await deps.refetch();
    if (!fresh || !isRetrySafePatch(body))
      throw new ApiError(STALE_SETTINGS_MESSAGE, 409);
    await deps.onRetry(fresh);
    return deps.send({ ...body, expectedRevision: fresh.document.revision });
  }
}
