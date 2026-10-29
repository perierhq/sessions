/**
 * Archive sweep: worktrees and Sandboxes of sessions archived long ago.
 *
 * - Worktrees of sessions archived more than ARCHIVE_SWEEP_DAYS ago with no
 *   WIP are removed (sweepArchivedWorktrees, worktree.ts). The hourly
 *   worktree reaper parks them sooner, banking any WIP first.
 * - Sandboxes are torn down through the same path a session delete uses
 *   (destroySessionSandbox): for This machine (container) that is the pod,
 *   its containers and its home volume. Archiving only puts a Sandbox to
 *   sleep, which keeps all of it on disk, so this is what frees the space:
 *   - an archived session's, once it has been archived and idle for
 *     archiveRetentionDays() (default 7, `OPENSESSION_ARCHIVE_RETENTION_DAYS`),
 *     counted from the archive (archive registry), or from its last activity
 *     when the registry has no time for it. Unarchiving it stops the clock.
 *   - an automation session's (incident agents and the like), once it has
 *     been idle that long. Nobody archives those by hand, so without this
 *     their sleeping pods and volumes stayed forever. Like the worktree
 *     reaper's shorter automation horizon.
 *   Volume-mode workspaces die with the Sandbox, the documented contract of
 *   that mode (push your work; checkpoints are restored into a fresh one). A
 *   revived session re-ensures a fresh Sandbox on its next prompt. What was
 *   removed, and its size where the provider measured it, shows under
 *   `housekeeping` in `/api/health`.
 *
 * The session list comes from the list index / catalogs
 * (getSessionListSnapshotAsync), never from the offline directory scanner:
 * that scanner throws in a live gateway, which is how both sweeps failed on
 * every pass without anyone noticing. Each pass is recorded in
 * housekeeping-health.ts so a repeat failure shows in `/api/health`.
 */

import {
  noteHousekeepingReclaimed,
  runHousekeeping,
} from "./housekeeping-health";
import type { UnifiedSession } from "./types";

export const ARCHIVE_SWEEP_DAYS = 14;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const DEFAULT_ARCHIVE_SWEEP_MINUTES = 6 * 60;
/** After boot, staggered behind the worktree reaper's first pass (10 min).
 *  The gateway restarts on every deploy, often more than once in 6 hours, so
 *  an interval with no first run hardly ever ran. */
const ARCHIVE_SWEEP_FIRST_DELAY_MS = 15 * 60 * 1000;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Days a Sandbox outlives its session's archive (or an automation
 *  session's last activity): `OPENSESSION_ARCHIVE_RETENTION_DAYS`, read on
 *  every pass. Fractions are allowed, for a test instance. */
export function archiveRetentionDays(
  raw: string | undefined = process.env.OPENSESSION_ARCHIVE_RETENTION_DAYS,
): number {
  return positiveNumber(raw, DEFAULT_ARCHIVE_RETENTION_DAYS);
}

/** Minutes between passes: `OPENSESSION_ARCHIVE_SWEEP_MINUTES` (default 6
 *  hours). A test instance sets it low together with the retention. */
function archiveSweepIntervalMs(): number {
  return (
    positiveNumber(
      process.env.OPENSESSION_ARCHIVE_SWEEP_MINUTES,
      DEFAULT_ARCHIVE_SWEEP_MINUTES,
    ) * 60_000
  );
}

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
  /** When the session was archived (ms), or null when unknown. */
  archivedAt?: (session: UnifiedSession) => number | null;
  /** The Sandbox's disk use as last measured, or null when unknown. */
  sandboxBytes?: (session: UnifiedSession) => number | null;
  /** Called after worktrees were removed so the list drops their paths. */
  invalidate: () => void;
  now?: () => number;
};

async function defaultDeps(): Promise<ArchiveSweepDeps> {
  const [cache, worktree, sandbox, archive, podmanDisk] = await Promise.all([
    import("./session-cache"),
    import("./worktree"),
    import("./session-sandbox"),
    import("./archive"),
    import("./sandbox/adapters/podman-disk"),
  ]);
  return {
    sessions: async () =>
      cache.enrichSessionRuntime(
        await cache.getSessionListSnapshotAsync("include"),
      ),
    sweepWorktrees: worktree.sweepArchivedWorktrees,
    destroySandbox: sandbox.destroySessionSandbox,
    // The latest archive among the row and its aliases: the window starts
    // from the most recent one.
    archivedAt: (s) => {
      const times = [s.id, ...(s.aliasIds ?? [])]
        .map(archive.getArchivedAt)
        .filter((at): at is number => at !== null);
      return times.length ? Math.max(...times) : null;
    },
    sandboxBytes: (s) =>
      s.sandbox?.provider === "podman" && s.sandbox.sandboxId
        ? podmanDisk.podmanSandboxHomeBytes(s.sandbox.sandboxId)
        : null,
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
    const days = archiveRetentionDays();
    const cutoff = now() - days * DAY_MS;
    let bytes = 0;
    for (const s of list()) {
      if (!s.sandbox?.sandboxId || s.isRunning) continue;
      const since = retentionClock(s, d.archivedAt);
      if (since === null || since >= cutoff) continue;
      bytes += d.sandboxBytes?.(s) ?? 0;
      d.destroySandbox(
        s,
        s.archived ? "archive-retention" : "automation-retention",
        true,
      );
      retired.push(s.id);
    }
    if (retired.length)
      console.log(
        `[sandbox-sweep] Retired ${retired.length} Sandbox(es) idle >${days}d: ${retired.join(", ")}`,
      );
    noteHousekeepingReclaimed("sandbox-sweep", {
      count: retired.length,
      bytes,
    });
  });
  return { worktrees: removed, sandboxes: retired };
}

/** When a Sandbox's retention window started, or null when it has none:
 *  an open session's Sandbox is kept however old. Archived: the later of
 *  the archive and the last activity. Automation (never archived by hand):
 *  the last activity. */
function retentionClock(
  s: UnifiedSession,
  archivedAt: ArchiveSweepDeps["archivedAt"],
): number | null {
  const last = Date.parse(s.lastActivity);
  if (s.archived) {
    const at = archivedAt?.(s) ?? null;
    const since = Math.max(at ?? -Infinity, last);
    return Number.isFinite(since) ? since : null;
  }
  if (s.automation) return Number.isFinite(last) ? last : null;
  return null;
}

let started = false;

/** Start the archive sweep: once shortly after boot, then every 6 hours
 *  (`OPENSESSION_ARCHIVE_SWEEP_MINUTES`). */
export function startArchiveSweep(): void {
  if (started) return;
  started = true;
  const run = () => void runArchiveSweep();
  const interval = archiveSweepIntervalMs();
  setTimeout(run, Math.min(ARCHIVE_SWEEP_FIRST_DELAY_MS, interval)).unref?.();
  setInterval(run, interval).unref?.();
}
