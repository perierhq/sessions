/**
 * Archive or unarchive one session the way the sidebar does. Shared by the
 * POST /api/sessions/:id/archive route and the opensession-sessions
 * archive tools, so an agent's archive stops runs, drops pins and clears
 * Plain file flags exactly like a click in the UI.
 *
 * Archiving goes through session-archive.ts, which repository removal
 * shares too. Unarchiving is refused while the session's repository is
 * removed (repo-removal-guard.ts): such a session can't run, so it stays
 * archived until the repository is registered again.
 */
import { setArchived } from "./archive";
import { clearSessionFileArchive } from "./plain-archive";
import { sessionRepoBlocker } from "./repo-removal-guard";
import { archiveSession } from "./session-archive";
import { publishSessionChange } from "./session-cache";
import { executeArchiveOverrideProjection } from "./session-projection-executor";
import type { UnifiedSession } from "./types";

/** An unarchive the server refuses; the message says why. */
export class SessionArchiveRefused extends Error {}

/**
 * `sessionId` is the id the caller addressed the session by (an alias id
 * reaches the same session); it defaults to the session's own id.
 */
export async function setSessionArchivedState(
  session: UnifiedSession,
  archived: boolean,
  sessionId: string = session.id,
): Promise<{ stoppedRun: boolean }> {
  // Stops an owned in-flight run, commits the archive and drops the pins it
  // made stale.
  if (archived) return archiveSession(sessionId, session);
  const repoBlocker = sessionRepoBlocker(session);
  if (repoBlocker) throw new SessionArchiveRefused(repoBlocker);
  await executeArchiveOverrideProjection(sessionId, () =>
    setArchived(sessionId, false),
  );
  // Plain done-tickets are archived via a file-level flag, not the
  // registry; clearing only the registry would leave them archived. On
  // unarchive, also clear the file flag so the session returns to "My
  // sessions".
  clearSessionFileArchive(sessionId);
  await publishSessionChange(sessionId);
  return { stoppedRun: false };
}
