// Deleting one session completely, shared by the DELETE /api/sessions/:id
// route and server-side deleters (support retention, forget-customer). It
// returns a status and body instead of a Response so server code never
// depends on a route module.
import { cancelAgentRunAndWait, isAgentSessionBusy } from "./agent-runner";
import { deleteSessionTranscript } from "./actor-transcript";
import { stopAllPortalServices } from "./portal-supervisor";
import { dropRunnerPortalRoutes } from "./runner-portals";
import { cleanupRunnerWorkspace } from "./runner-ws";
import { deleteSessionCheckpoint } from "./sandbox/checkpoint";
import { withSessionLifecycleLane } from "./sandbox/lifecycle-lane";
import {
  findSessionAsync,
  getSessionListSnapshotAsync,
  publishSessionChange,
} from "./session-cache";
import { removeFromSearchIndex } from "./session-index";
import {
  sessionGatewayCommand,
  sessionTombstoneState,
  tombstoneSessionKernel,
} from "./session-kernel";
import { withSessionMutationLock } from "./session-mutation-lock";
import { destroySessionSandbox } from "./session-sandbox";
import { callSearchIndex } from "./session-search-client";
import { removeWorkspaceAfterSessionDelete } from "./session-workspace-cleanup";
import { deleteSession, removeTombstonedSessionArtifacts } from "./sessions";
import type { UnifiedSession } from "./types";
import { deleteWorkspace, getWorkspace } from "./workspaces";
import { removeWorktree, repoForPath } from "./worktree";

export interface SessionDeleteResult {
  status: number;
  body: unknown;
}

/** The status of a deletion refused because the session's run did not
 *  stop in time. Nothing was deleted; a later attempt may succeed. */
const STILL_STOPPING = 409;
const STILL_STOPPING_ERROR =
  "The session is still stopping. Retry deletion shortly.";

/** The whole session deletion: stop its runs, remove its record, transcript,
 *  sandbox, checkpoint and (with `cleanWorktree`) its worktrees. Resolves to
 *  the status and body the DELETE route answers with; a deletion already in
 *  progress throws, as the route always did. */
export async function deleteSessionCompletely(
  session: UnifiedSession,
  cleanWorktree: boolean,
): Promise<SessionDeleteResult> {
  // Purge any transcript-v2 store rows for a deleted session. Guarded on
  // the DB file existing — NOT the flag — so a kill-switch window can't
  // leave resurrectable rows behind for deterministic session ids
  // (bks-ghpr-*). Best-effort: a store hiccup must never block deletion.
  const purgeTranscriptRows = async (id: string) => {
    try {
      await deleteSessionTranscript(id);
    } catch {}
    try {
      await removeFromSearchIndex(`session:${id}`);
    } catch {}
    try {
      await callSearchIndex("removeTranscript", id);
    } catch {}
  };
  // Every deletion step works on the record as it stands once the lifecycle
  // lane is held, not on the one this request found before it waited: a
  // checkpoint that finished meanwhile recorded its ref on the session,
  // and a deletion still holding the earlier copy would leave that ref,
  // uncommitted files included, on origin for good.
  const finishDeletion = async (session: UnifiedSession) => {
    // Runner workspace deletion is opt-in on the Runner. It remains
    // best-effort so an offline machine never blocks deleting a session.
    if (session.runner && session.repo && session.worktreeDir) {
      void cleanupRunnerWorkspace({
        runnerId: session.runner.id,
        sessionId: session.id,
        repo: session.repo,
        workspacePath: session.worktreeDir,
        user: session.createdBy || undefined,
      }).catch((error) =>
        console.warn(
          `[runners] Workspace retained after deleting ${session.id}:`,
          error,
        ),
      );
    }
    await purgeTranscriptRows(session.id);
    // Deletion already owns this session lock. Publish after it releases.
    void publishSessionChange(session.id);
    // Tear down the session's sandbox (container + engine-state volumes,
    // and in volume-workspace mode the workspace volume itself; that data
    // loss is the mode's documented contract). Best-effort and detached:
    // a docker hiccup must never block the delete.
    destroySessionSandbox(session, "delete");
    // The hidden checkpoint ref on origin goes with the session; an
    // archived session keeps it because it may be the only copy of its work.
    // Awaited on the lifecycle lane this deletion holds, so no checkpoint
    // still queued behind the last turn can push the ref back afterwards
    // (it finds no session and skips). Best-effort: a refused push is
    // logged there and never blocks the delete.
    await deleteSessionCheckpoint(session).catch(() => {});
    // If that was the workspace's last session, delete the workspace and
    // its scratch dir too, when the workspace only existed for its sessions
    // (no key, or a `session-create:` key). Otherwise they linger as empty
    // sidebar rows. PR-backed and other keyed workspaces stay because they
    // regroup new sessions for the same PR. Detached: removing a scratch
    // dir must not hold the session lock.
    if (session.workspaceId) {
      const workspaceId = session.workspaceId;
      void removeWorkspaceAfterSessionDelete(session.id, workspaceId, {
        getWorkspace,
        listSessions: () => getSessionListSnapshotAsync(),
        deleteWorkspace,
      }).catch((error) =>
        console.warn(
          `[workspaces] Workspace ${workspaceId} retained after deleting ${session.id}:`,
          error,
        ),
      );
    }
    // Setup still running for the session's worktree goes with it, unless
    // a live sibling session still works in that tree, and so do the
    // containers and units labelled with its id. Detached: stopping a
    // container takes seconds and must not hold the session lock; the
    // worktree removal below stops setup in the tree itself, and the
    // reaper retries anything this misses.
    void (async () => {
      const { mayHaveSessionOwnedResources, stopSessionOwnedResources } =
        await import("./session-resources");
      if (await mayHaveSessionOwnedResources())
        await stopSessionOwnedResources(
          session,
          await getSessionListSnapshotAsync(),
          { reason: "removed" },
        );
    })().catch((error) => {
      console.warn(
        `[session-resources] cleanup failed after deleting ${session.id}:`,
        error,
      );
    });
    if (cleanWorktree && session.worktreeDir && session.branch) {
      await removeWorktree(session.branch, repoForPath(session.worktreeDir).id);
      // A session can span repos, and each one it spans has a checkout
      // of its own. Cleaning up only the first would leave the rest on
      // disk for the reaper to find days later.
      for (const attached of session.attachedRepos || [])
        if (attached.branch)
          await removeWorktree(attached.branch, attached.repo);
    }
  };

  // An older delete path could write the permanent tombstone before removing
  // the session file. That leaves a visible ghost which the mailbox correctly
  // refuses to mutate. Finish that already-authorized deletion without trying
  // to re-enter its permanently closed mailbox.
  const recoverTombstonedDeletion = () =>
    withSessionLifecycleLane(session.id, async () => {
      try {
        const ghost = (await findSessionAsync(session.id)) ?? session;
        await removeTombstonedSessionArtifacts(ghost);
        await finishDeletion(ghost);
        return { status: 200, body: { ok: true } };
      } catch (e: any) {
        return { status: 500, body: { error: e.message } };
      }
    });
  if (await sessionTombstoneState(session.id))
    return recoverTombstonedDeletion();

  const deleteRequestId = `delete:${session.id}`;
  let deleteExecuting = false;
  let deletePhysicalFinished = false;
  try {
    const plan = await sessionGatewayCommand({
      op: "request",
      sessionId: session.id,
      requestId: deleteRequestId,
      operation: "delete_session",
      identity: { cleanWorktree },
    });
    if (plan.status === "in_progress")
      throw Object.assign(
        new Error("Session deletion is already in progress"),
        {
          retryable: true,
        },
      );
    if (plan.status === "completed") {
      return plan.result as SessionDeleteResult;
    }
    deleteExecuting = true;
    // Deletion is a Sandbox lifecycle operation like a move or a rebuild:
    // it runs on the session's lifecycle lane so it waits for a checkpoint
    // or move already in flight, and one queued behind it finds no session
    // and refuses instead of acting on the deleted one. The mutation lock
    // is taken inside the lane, the same order every lifecycle operation
    // uses when it writes the session record.
    const result: SessionDeleteResult = await withSessionLifecycleLane(
      session.id,
      () =>
        withSessionMutationLock(session.id, async () => {
          try {
            // The lane may have been held by a checkpoint or a move; what
            // they wrote is what gets deleted. A session gone meanwhile has
            // been deleted by someone else, which is the outcome asked for.
            const current = await findSessionAsync(session.id);
            if (!current) return { status: 200, body: { ok: true } };
            const runIds = [
              current.claudeSessionId,
              current.codexThreadId,
              current.id,
            ];
            if (
              runIds.some((id) => !!id && isAgentSessionBusy(id!)) &&
              !(await cancelAgentRunAndWait(runIds))
            ) {
              return {
                status: STILL_STOPPING,
                body: { error: STILL_STOPPING_ERROR },
              };
            }
            // Local Portals are their own detached process groups. Stop them before
            // deleting session metadata or optionally removing the worktree.
            if (current.runner)
              await dropRunnerPortalRoutes(
                current.id,
                current.runner.id,
                current.startedBy || undefined,
              );
            else if (current.worktreeDir && !current.sandbox?.sandboxId)
              await stopAllPortalServices({
                sessionId: current.id,
                worktreeDir: current.worktreeDir,
              });
            // The serialized delete must remove the file before its permanent tombstone.
            // Tombstoning first drops this active kernel from the map, so deleteSession's
            // nested compatibility write re-enters through a fresh kernel and is fenced
            // as a late writer, leaving a visible but immutable ghost session behind.
            await deleteSession(current);
            await tombstoneSessionKernel(current.id);
            await finishDeletion(current);
            return { status: 200, body: { ok: true } };
          } catch (e: any) {
            return { status: 500, body: { error: e.message } };
          }
        }),
    );
    deletePhysicalFinished = true;
    // A run that did not stop in time left everything in place: the
    // request stays retryable, so "Retry deletion shortly" retries rather
    // than replaying this refusal under the same request id.
    if (result.status === STILL_STOPPING) {
      await sessionGatewayCommand({
        op: "fail",
        sessionId: session.id,
        requestId: deleteRequestId,
        operation: "delete_session",
        error: STILL_STOPPING_ERROR,
        retryable: true,
      });
      return result;
    }
    await sessionGatewayCommand({
      op: "complete",
      sessionId: session.id,
      requestId: deleteRequestId,
      operation: "delete_session",
      result,
    });
    return result;
  } catch (error) {
    if (deleteExecuting && !deletePhysicalFinished)
      await sessionGatewayCommand({
        op: "fail",
        sessionId: session.id,
        requestId: deleteRequestId,
        operation: "delete_session",
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    // A concurrent delete can write the tombstone after the check above but
    // before this request reaches the mailbox. Treat that race as the same
    // idempotent recovery instead of surfacing a false failure.
    if (await sessionTombstoneState(session.id))
      return recoverTombstonedDeletion();
    throw error;
  }
}
