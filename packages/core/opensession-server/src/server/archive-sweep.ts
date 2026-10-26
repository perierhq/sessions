/**
 * Archive sweep: worktrees and Sandboxes of sessions archived long ago.
 *
 * - Worktrees of sessions archived more than ARCHIVE_SWEEP_DAYS ago with no
 *   WIP are removed (sweepArchivedWorktrees, worktree.ts).
 * - Sandboxes of long-idle archived sessions are torn down: containers and
 *   engine-state volumes are provider-owned and safe to drop (bind-mode
 *   worktrees belong to the worktree sweep and are untouched). Volume-mode
 *   workspaces die with the Sandbox, the documented contract of that mode
 *   (push your work). A revived session re-ensures a fresh one on its next
 *   prompt.
 *
 * The session list comes from the list index / catalogs
 * (getSessionListSnapshotAsync), never from the offline directory scanner:
 * that scanner throws in a live gateway, which is how both sweeps failed on
 * every pass without anyone noticing. Each pass is recorded in
 * housekeeping-health.ts so a repeat failure shows in `/api/health`.
 */

import { runHousekeeping } from "./housekeeping-health";
import type { UnifiedSession } from "./types";

export const ARCHIVE_SWEEP_DAYS = 14;
const ARCHIVE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After boot, staggered behind the worktree reaper's first pass (10 min).
 *  The gateway restarts on every deploy, often more than once in 6 hours, so
 *  an interval with no first run hardly ever ran. */
const ARCHIVE_SWEEP_FIRST_DELAY_MS = 15 * 60 * 1000;

export type ArchiveSweepDeps = {
  /** Sessions with live run state, from the list index. */
  sessions: () => Promise<UnifiedSession[]>;
  sweepWorktrees: (
    sessions: UnifiedSession[],
    days: number,
  ) => Promise<string[]>;
  destroySandbox: (
    session: UnifiedSession,
    why: string,
    clearSandboxId: boolean,
  ) => void;
  /** Called after worktrees were removed so the list drops their paths. */
  invalidate: () => void;
  now?: () => number;
};

async function defaultDeps(): Promise<ArchiveSweepDeps> {
  const [cache, worktree, sandbox] = await Promise.all([
    import("./session-cache"),
    import("./worktree"),
    import("./session-sandbox"),
  ]);
  return {
    sessions: async () =>
      cache.enrichSessionRuntime(
        await cache.getSessionListSnapshotAsync("include"),
      ),
    sweepWorktrees: worktree.sweepArchivedWorktrees,
    destroySandbox: sandbox.destroySessionSandbox,
    invalidate: cache.invalidateSessionsCache,
  };
}

/** One pass of both sweeps. Never throws; each sweep's outcome is recorded
 *  under its own housekeeping job. */
export async function runArchiveSweep(
  deps?: ArchiveSweepDeps,
): Promise<{ worktrees: string[]; sandboxes: string[] }> {
  const d = deps ?? (await defaultDeps());
  const now = d.now ?? Date.now;
  const removed: string[] = [];
  const retired: string[] = [];
  // One snapshot for both sweeps. A failed listing fails both: neither may
  // treat an unknown list as "nothing archived".
  let sessions: UnifiedSession[] | null = null;
  let listError: unknown = null;
  try {
    sessions = await d.sessions();
  } catch (error) {
    listError = error;
  }
  const list = () => {
    if (!sessions) throw listError;
    return sessions;
  };
  await runHousekeeping("worktree-sweep", async () => {
    const swept = await d.sweepWorktrees(list(), ARCHIVE_SWEEP_DAYS);
    if (swept.length > 0) {
      console.log(
        `[worktree-sweep] Removed ${swept.length} clean worktree(s): ${swept.join(", ")}`,
      );
      d.invalidate();
    }
    removed.push(...swept);
  });
  await runHousekeeping("sandbox-sweep", () => {
    const cutoff = now() - ARCHIVE_SWEEP_DAYS * 86_400_000;
    for (const s of list()) {
      if (!s.sandbox?.sandboxId || !s.archived || s.isRunning) continue;
      if (new Date(s.lastActivity).getTime() >= cutoff) continue;
      d.destroySandbox(s, "archive-sweep", true);
      retired.push(s.id);
    }
  });
  return { worktrees: removed, sandboxes: retired };
}

let started = false;

/** Start the archive sweep: once shortly after boot, then every 6 hours. */
export function startArchiveSweep(): void {
  if (started) return;
  started = true;
  const run = () => void runArchiveSweep();
  setTimeout(run, ARCHIVE_SWEEP_FIRST_DELAY_MS).unref?.();
  setInterval(run, ARCHIVE_SWEEP_INTERVAL_MS).unref?.();
}
