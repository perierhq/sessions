/**
 * Health of the gateway's background housekeeping jobs (worktree and Sandbox
 * sweeps, the worktree reaper, the Portal route sweep).
 *
 * These jobs run on timers and only log. A job that throws on every pass looks
 * exactly like a job that has nothing to do, so a broken sweep went unnoticed
 * for days while worktrees and Sandboxes piled up. Each run is recorded here;
 * after FAILING_AFTER consecutive failures the job is marked failing, the
 * server log gets one loud alert line, and `/api/health` (and `opensession
 * doctor`) show it until a run succeeds again.
 *
 * Same shape as `lastSessionResourceSweep` in session-resources.ts: a
 * process-local record read by the health route, nothing persisted.
 */

export const HOUSEKEEPING_FAILING_AFTER = 3;

export type HousekeepingJobHealth = {
  lastRunAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Failed runs since the last successful one. */
  consecutiveFailures: number;
  /** consecutiveFailures reached HOUSEKEEPING_FAILING_AFTER. */
  failing: boolean;
};

export type HousekeepingReclaimed = {
  /** Things the job removed (Sandboxes, images, worktrees). */
  count: number;
  /** Bytes they held, where known; things of unknown size add nothing. */
  bytes: number;
};

const jobs = new Map<string, HousekeepingJobHealth>();
const reclaimed = new Map<
  string,
  { last: HousekeepingReclaimed; sinceBoot: HousekeepingReclaimed }
>();

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Bun prints source context into some error messages; the first line is
  // the reason, and the health payload stays small.
  return (text.split("\n").find((line) => line.trim()) ?? text).slice(0, 300);
}

/** Record one run of `job`. Logs an alert the moment it starts failing and a
 *  recovery line when it works again. */
export function recordHousekeepingRun(
  job: string,
  outcome: { ok: true } | { ok: false; error: unknown },
  now = Date.now(),
): HousekeepingJobHealth {
  const at = new Date(now).toISOString();
  const previous = jobs.get(job);
  if (outcome.ok) {
    if (previous?.failing)
      console.log(
        `[housekeeping] ${job} recovered after ${previous.consecutiveFailures} failed run(s)`,
      );
    const next: HousekeepingJobHealth = {
      lastRunAt: at,
      lastOkAt: at,
      lastError: previous?.lastError ?? null,
      lastErrorAt: previous?.lastErrorAt ?? null,
      consecutiveFailures: 0,
      failing: false,
    };
    jobs.set(job, next);
    return next;
  }
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const next: HousekeepingJobHealth = {
    lastRunAt: at,
    lastOkAt: previous?.lastOkAt ?? null,
    lastError: message(outcome.error),
    lastErrorAt: at,
    consecutiveFailures,
    failing: consecutiveFailures >= HOUSEKEEPING_FAILING_AFTER,
  };
  jobs.set(job, next);
  if (consecutiveFailures === HOUSEKEEPING_FAILING_AFTER)
    console.error(
      `[housekeeping] ALERT: ${job} failed ${consecutiveFailures} runs in a row; nothing it cleans up is being cleaned up. Last error: ${next.lastError}`,
    );
  return next;
}

/** Run one pass of `job`, record its outcome, and never throw. */
export async function runHousekeeping<T>(
  job: string,
  pass: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    const value = await pass();
    recordHousekeepingRun(job, { ok: true });
    return { ok: true, value };
  } catch (error) {
    console.error(`[${job}] Sweep failed:`, error);
    recordHousekeepingRun(job, { ok: false, error });
    return { ok: false, error };
  }
}

/** What one pass of `job` removed. Kept beside the run record and shown
 *  with it, so `/api/health` says how much a cleanup job is reclaiming, not
 *  only that it runs. */
export function noteHousekeepingReclaimed(
  job: string,
  pass: HousekeepingReclaimed,
): void {
  const before = reclaimed.get(job)?.sinceBoot ?? { count: 0, bytes: 0 };
  reclaimed.set(job, {
    last: { ...pass },
    sinceBoot: {
      count: before.count + pass.count,
      bytes: before.bytes + pass.bytes,
    },
  });
}

export type HousekeepingJobReport = HousekeepingJobHealth & {
  /** The last pass's removals, for jobs that report them. */
  lastReclaimed?: HousekeepingReclaimed;
  /** Everything removed since this process started. */
  reclaimedSinceBoot?: HousekeepingReclaimed;
};

/** Every job that has run in this process, for `/api/health`. */
export function housekeepingHealth(): Record<string, HousekeepingJobReport> {
  return Object.fromEntries(
    [...jobs].map(([job, health]) => {
      const counts = reclaimed.get(job);
      return [
        job,
        counts
          ? {
              ...health,
              lastReclaimed: counts.last,
              reclaimedSinceBoot: counts.sinceBoot,
            }
          : health,
      ];
    }),
  );
}

/** Names of the jobs currently failing. */
export function failingHousekeepingJobs(
  health: Record<
    string,
    Pick<HousekeepingJobHealth, "failing">
  > = Object.fromEntries(jobs),
): string[] {
  return Object.entries(health)
    .filter(([, job]) => job?.failing)
    .map(([name]) => name)
    .sort();
}

/** Test seam. */
export function resetHousekeepingHealthForTest(): void {
  jobs.clear();
  reclaimed.clear();
}
