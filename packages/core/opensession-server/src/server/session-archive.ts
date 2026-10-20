/**
 * Archiving one session the way a person does it from the sidebar: stop the
 * run this process owns, commit the archive through the session's projection
 * (which stops its Portals, containers and units, see archive.ts), tell
 * subscribed clients, and drop the pins the archive made stale.
 *
 * The single-session archive route and repository removal
 * (repo-removal.ts) both go through here, so a session archived because its
 * repository left gets exactly the teardown a manual archive gets.
 */

import { currentAgentRunToken, isAgentSessionBusy } from "./agent-runner";
import { setArchived, unpinArchivedSessions } from "./archive";
import { audit } from "./audit";
import { requestTurnCancel } from "./run-session";
import {
  getSessionListSnapshotAsync,
  publishSessionChange,
} from "./session-cache";
import { sessionKernel } from "./session-kernel";
import { executeArchiveOverrideProjection } from "./session-projection-executor";
import type { UnifiedSession } from "./types";

/**
 * Archiving means "I'm done with this", so stop an owned in-flight run rather
 * than leaving an orphaned turn burning tokens after the session already reads
 * as archived. Only runs owned by this process (busyHere) are stoppable;
 * external/CLI runs can't be reached from here. Graceful Esc-style stop (fall
 * back to hard cancel for runs with no interrupt support) keeps the transcript
 * clean and resumable on unarchive.
 */
async function stopRunForArchive(session: UnifiedSession): Promise<boolean> {
  if (
    !isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      session.id,
    )
  )
    return false;
  const target = sessionKernel(session.id).runStateProjection();
  const targetRunId =
    target.currentRunId ||
    (target.state === "starting" || target.state === "preparing"
      ? currentAgentRunToken(session.id)
      : undefined);
  if (!targetRunId) return false;
  try {
    await requestTurnCancel(session.id, session, {
      cancelId: `archive-stop:${session.id}:${targetRunId}:${target.generation}`,
      expectedRunId: targetRunId,
      expectedGeneration: target.generation,
      source: "archive",
    });
    audit({
      msg: "run_cancelled",
      session_id: session.id,
      source: "archive",
    });
    return true;
  } catch {
    // The actor fences cancels by run id + generation; losing the race (the
    // run settled between our busy check and prepare) throws out of
    // requestTurnCancel. That must not fail the archive — the usual case is
    // the run having finished anyway.
    return false;
  }
}

/**
 * Archive one session. `sessionId` is the id the caller addressed it by (an
 * alias id reaches the same session). Unpinning is skipped when `unpin` is
 * false so a batch can drop the stale pins once, after every archive is
 * written (see archiveSessions).
 */
export async function archiveSession(
  sessionId: string,
  session: UnifiedSession,
  opts: { unpin?: boolean } = {},
): Promise<{ stoppedRun: boolean }> {
  const stoppedRun = await stopRunForArchive(session);
  await executeArchiveOverrideProjection(sessionId, () =>
    setArchived(sessionId, true),
  );
  await publishSessionChange(sessionId);
  if (opts.unpin !== false) {
    // setArchived drops the plain id pin; also drop legacy alias-id pins,
    // and the workspace pin once its last live session is archived (else the
    // row resurfaces in Pinned when a new session joins the workspace).
    await unpinArchivedSessions([session], await getSessionListSnapshotAsync());
  }
  return { stoppedRun };
}

/** Archive several sessions, then drop the pins they made stale in one pass. */
export async function archiveSessions(
  sessions: UnifiedSession[],
): Promise<void> {
  if (!sessions.length) return;
  for (const session of sessions)
    await archiveSession(session.id, session, { unpin: false });
  await unpinArchivedSessions(sessions, await getSessionListSnapshotAsync());
}
