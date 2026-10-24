/**
 * What happens to a session's workspace when the session is deleted.
 *
 * A workspace that only existed for its sessions goes with the last one:
 * auto-wrapped 1:1 workspaces (no `key`) and the workspaces `POST
 * /api/sessions` creates (`session-create:<identity>`, the create request's
 * idempotency key). Otherwise they linger as empty sidebar rows with scratch
 * dirs on disk. Every other key kind (a PR's `ghpr-*`, a local folder, ...)
 * regroups new sessions for the same thing, so those stay.
 */

/** Key prefix of workspaces minted by a session create request. */
export const SESSION_CREATE_WORKSPACE_KEY_PREFIX = "session-create:";

/** Whether a workspace with this key goes once it has no sessions left. */
export function workspaceGoesWithLastSession(key: string | undefined): boolean {
  return !key || key.startsWith(SESSION_CREATE_WORKSPACE_KEY_PREFIX);
}

export interface SessionWorkspaceCleanupDeps {
  getWorkspace(
    id: string,
  ): Promise<{ id: string; key?: string } | null | undefined>;
  listSessions(): Promise<
    ReadonlyArray<{ id: string; workspaceId?: string | null }>
  >;
  /** Removes the workspace row and its scratch dir (workspaces.ts). */
  deleteWorkspace(id: string): Promise<boolean>;
}

/**
 * Delete `workspaceId` if `deletedSessionId` was its last session and the
 * workspace's key says it goes with its sessions. Returns whether this call
 * removed it.
 */
export async function removeWorkspaceAfterSessionDelete(
  deletedSessionId: string,
  workspaceId: string,
  deps: SessionWorkspaceCleanupDeps,
): Promise<boolean> {
  const workspace = await deps.getWorkspace(workspaceId);
  if (!workspace || !workspaceGoesWithLastSession(workspace.key)) return false;
  const remaining = (await deps.listSessions()).some(
    (s) => s.id !== deletedSessionId && s.workspaceId === workspaceId,
  );
  if (remaining) return false;
  return deps.deleteWorkspace(workspace.id);
}
