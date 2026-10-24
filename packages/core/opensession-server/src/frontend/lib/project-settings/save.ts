// Sending a project settings patch with the revision the page loaded, and
// what happens when another tab saved first: refetch, send the same change
// once more on the fresh revision, and say so.

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
  /** A stale revision was refused (the toast). */
  onStale: () => void;
}

export function isStaleRevision(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/** Sends `body` at `revision`. A 409 refetches and re-sends once at the
 *  fresh revision, so the person's change survives; a second refusal, or
 *  any other error, rejects. */
export async function sendProjectPatch(
  body: ProjectPatchBody,
  revision: number,
  deps: SendPatchDeps,
): Promise<ProjectSettingsView> {
  try {
    return await deps.send({ ...body, expectedRevision: revision });
  } catch (error) {
    if (!isStaleRevision(error)) throw error;
    deps.onStale();
    const fresh = await deps.refetch();
    if (!fresh) throw error;
    return deps.send({ ...body, expectedRevision: fresh.document.revision });
  }
}
