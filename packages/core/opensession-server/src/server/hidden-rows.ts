/**
 * Resolve a user's sidebar hides (hides.ts) into the rows they stand for, for
 * the sidebar's "Hidden" list. The sidebar's own session projection drops
 * hidden rows (sidebar-session-scope.ts), so the client has no title or repo
 * for them; this is the small, per-user read that names them.
 *
 * Only keys that still point at live work come back. A hide whose workspace or
 * session was archived or deleted resolves to nothing and is left out, so the
 * list never offers to restore something that is gone. The stored entry is
 * left alone: it is harmless, and a read is not the place to write.
 *
 * `repo:<id>` keys hide a whole repository band. They are not rows, so they are
 * skipped here; the client names them from its own repository list.
 */

import type { Hides } from "./hides";
import type { UnifiedSession } from "./types";

const REPO_HIDE_PREFIX = "repo:";

export interface HiddenRow {
  /** The hide key, exactly as stored. */
  key: string;
  /** ISO timestamp of when the row was hidden. */
  hiddenAt: string;
  title: string;
  /** The repo the row files under, or null for repo-less work. */
  repo: string | null;
  /** The row's most recently active session, which opening the row shows. */
  sessionId: string;
}

type HiddenRowSession = Pick<
  UnifiedSession,
  | "id"
  | "title"
  | "lastActivity"
  | "repo"
  | "repoLess"
  | "workspaceId"
  | "worktreeDir"
  | "archived"
  | "aliasIds"
>;

export interface HiddenRowWorkspace {
  name: string;
  repo?: string;
}

function latest<T extends HiddenRowSession>(sessions: T[]): T {
  return sessions.reduce((best, session) =>
    (Date.parse(session.lastActivity) || 0) >
    (Date.parse(best.lastActivity) || 0)
      ? session
      : best,
  );
}

function sessionRepo(session: HiddenRowSession): string | null {
  return session.repoLess ? null : session.repo || null;
}

/**
 * Pure: hides × live sessions × the hidden workspaces' records → the rows to
 * list, most recently hidden first. `workspaces` only needs the workspaces
 * named by `workspace:<id>` keys.
 */
export function resolveHiddenRows(
  hides: Hides,
  sessions: readonly HiddenRowSession[],
  workspaces: ReadonlyMap<string, HiddenRowWorkspace>,
): HiddenRow[] {
  const byWorkspace = new Map<string, HiddenRowSession[]>();
  const byWorktree = new Map<string, HiddenRowSession[]>();
  const byId = new Map<string, HiddenRowSession>();
  for (const session of sessions) {
    if (session.archived) continue;
    if (session.workspaceId) {
      const list = byWorkspace.get(session.workspaceId) ?? [];
      list.push(session);
      byWorkspace.set(session.workspaceId, list);
    } else if (session.worktreeDir) {
      const list = byWorktree.get(session.worktreeDir) ?? [];
      list.push(session);
      byWorktree.set(session.worktreeDir, list);
    }
    for (const id of [session.id, ...(session.aliasIds ?? [])])
      if (!byId.has(id)) byId.set(id, session);
  }

  const rows: HiddenRow[] = [];
  for (const [key, hiddenAt] of Object.entries(hides)) {
    if (key.startsWith(REPO_HIDE_PREFIX)) continue;
    if (key.startsWith("workspace:")) {
      const id = key.slice("workspace:".length);
      const members = byWorkspace.get(id);
      if (!members?.length) continue;
      const head = latest(members);
      const workspace = workspaces.get(id);
      rows.push({
        key,
        hiddenAt,
        title: workspace?.name || head.title,
        repo: workspace?.repo || sessionRepo(head),
        sessionId: head.id,
      });
      continue;
    }
    if (key.startsWith("wt:")) {
      const members = byWorktree.get(key.slice("wt:".length));
      if (!members?.length) continue;
      const head = latest(members);
      rows.push({
        key,
        hiddenAt,
        title: head.title,
        repo: sessionRepo(head),
        sessionId: head.id,
      });
      continue;
    }
    const session = byId.get(key);
    if (!session) continue;
    rows.push({
      key,
      hiddenAt,
      title: session.title,
      repo: sessionRepo(session),
      sessionId: session.id,
    });
  }
  return rows.sort(
    (a, b) => (Date.parse(b.hiddenAt) || 0) - (Date.parse(a.hiddenAt) || 0),
  );
}

/** The workspace ids a hides map names, for fetching just those records. */
export function hiddenWorkspaceIds(hides: Hides): string[] {
  return Object.keys(hides)
    .filter((key) => key.startsWith("workspace:"))
    .map((key) => key.slice("workspace:".length));
}
