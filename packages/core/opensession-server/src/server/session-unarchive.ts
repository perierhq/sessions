import { isArchivedId, setArchived } from "./archive";
import { clearSessionFileArchive } from "./plain-archive";
import { sessionRepoBlocker } from "./repo-removal-guard";
import { publishSessionChange } from "./session-cache";
import type { UnifiedSession } from "./types";

type ArchivableSession = Pick<UnifiedSession, "id" | "aliasIds" | "archived"> &
  Partial<Pick<UnifiedSession, "repo" | "repoLess" | "attachedRepos">>;

export interface HumanTurnUnarchiveDeps {
  isArchivedId: typeof isArchivedId;
  setArchived: typeof setArchived;
  clearSessionFileArchive: typeof clearSessionFileArchive;
  publishSessionChange: typeof publishSessionChange;
}

const defaultDeps: HumanTurnUnarchiveDeps = {
  isArchivedId,
  setArchived,
  clearSessionFileArchive,
  publishSessionChange,
};

/** Restore an archived session when accepting a person's turn. One whose
 *  repository was removed stays archived: its turn is refused at admission
 *  with the reason (run-session.ts), and it should not come back as a live
 *  session that can't run. */
export async function unarchiveForHumanTurn(
  session: ArchivableSession,
  deps: HumanTurnUnarchiveDeps = defaultDeps,
): Promise<boolean> {
  const ids = new Set([session.id, ...(session.aliasIds || [])]);
  if (!session.archived && ![...ids].some(deps.isArchivedId)) return false;
  if (sessionRepoBlocker(session)) return false;

  for (const id of ids) await deps.setArchived(id, false);
  await deps.clearSessionFileArchive(session.id);
  await deps.publishSessionChange(session.id);
  return true;
}
