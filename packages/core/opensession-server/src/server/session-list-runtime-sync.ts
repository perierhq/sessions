import { setJournalClearListener } from "./run-journal";
import { publishSessionChange } from "./session-cache";
import { indexedSession } from "./session-list-store";
import { onSessionStateChange } from "./session-state-events";

type RuntimeSyncState = {
  stop?: () => void;
  pending: Set<string>;
  queued: boolean;
  settleTimers: Map<string, ReturnType<typeof setTimeout>>;
};

const g = globalThis as { __osSessionListRuntimeSync?: RuntimeSyncState };

const state: RuntimeSyncState = (g.__osSessionListRuntimeSync ??= {
  pending: new Set<string>(),
  queued: false,
  settleTimers: new Map(),
});
// A state object parked by an older build may predate the timers.
state.settleTimers ??= new Map();

/** How long after a turn ends the row is checked once more. Teardown (engine
 * release, run-state settlement, journal clear) can finish after the turn-end
 * write, which then still saw the run as live. */
export const SESSION_ROW_SETTLE_DELAY_MS = 5_000;

/** Settle checks after one turn end at most. A row republished while the
 * runtime still reported the run busy reads running again, so it is checked
 * again after another delay, up to this many times in all. */
export const SESSION_ROW_SETTLE_CHECKS = 3;

export interface SessionListRuntimeSyncOptions {
  settleDelayMs?: number;
  /** Whether the index row still reads as running. */
  rowRunning?: (sessionId: string) => Promise<boolean>;
}

const indexedRowRunning = async (sessionId: string) =>
  !!(await indexedSession(sessionId))?.isRunning;

/**
 * Refresh a session's list row when its run starts or settles. The live
 * status frame itself is room-scoped, so a client that leaves the conversation
 * between the final transcript append and `stream_done` otherwise misses the
 * transition and keeps the row in In progress until the fallback poll.
 *
 * This used to invalidate the whole list for every client on every run
 * boundary, which at fleet scale was the dominant source of refetch storms.
 * It now publishes exactly the changed row (session-row-events), once per
 * session per synchronous boundary: stream_start/session_status and
 * stream_done/session_status arrive in pairs.
 *
 * The row's `is_running` column is whatever that write saw, and the sidebar
 * keeps every automation row with it set. A turn-end write can still see the
 * run as live, because its journal entry and engine handle are released
 * during teardown after `stream_done`. So a journal clear republishes the
 * row too, and a row still marked running a few seconds after its turn
 * ended is republished, and checked again a couple of times while it keeps
 * reading running.
 */
export function startSessionListRuntimeSync(
  publish: (sessionId: string) => void = publishSessionChange,
  options: SessionListRuntimeSyncOptions = {},
): void {
  if (state.stop) return;
  const settleDelayMs = options.settleDelayMs ?? SESSION_ROW_SETTLE_DELAY_MS;
  const rowRunning = options.rowRunning ?? indexedRowRunning;

  const queue = (sessionId: string) => {
    state.pending.add(sessionId);
    if (state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      const ids = [...state.pending];
      state.pending.clear();
      for (const id of ids) publish(id);
    });
  };

  const scheduleSettle = (sessionId: string, check = 1) => {
    const prior = state.settleTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      // The entry stays until the check settles, so a turn that starts or
      // ends meanwhile (which replaces or drops it) supersedes this check.
      const current = () => state.settleTimers.get(sessionId) === timer;
      void rowRunning(sessionId)
        .then((running) => {
          if (!current()) return;
          state.settleTimers.delete(sessionId);
          if (!running) return;
          queue(sessionId);
          // Teardown may still hold the run, so the republish can read
          // running again. Look again after another delay.
          if (check < SESSION_ROW_SETTLE_CHECKS)
            scheduleSettle(sessionId, check + 1);
        })
        .catch(() => {
          if (current()) state.settleTimers.delete(sessionId);
          // The index is unavailable; the boot reconciliation repairs it.
        });
    }, settleDelayMs);
    (timer as { unref?: () => void }).unref?.();
    state.settleTimers.set(sessionId, timer);
  };

  const stopStateChanges = onSessionStateChange((event) => {
    queue(event.sessionId);
    if (event.isRunning) {
      const timer = state.settleTimers.get(event.sessionId);
      if (timer) clearTimeout(timer);
      state.settleTimers.delete(event.sessionId);
    } else scheduleSettle(event.sessionId);
  });
  setJournalClearListener((records) => {
    for (const record of records)
      if (record.osSessionId) queue(record.osSessionId);
  });
  state.stop = () => {
    stopStateChanges();
    setJournalClearListener(undefined);
  };
}

export function stopSessionListRuntimeSync(): void {
  state.stop?.();
  state.stop = undefined;
  state.queued = false;
  state.pending.clear();
  for (const timer of state.settleTimers.values()) clearTimeout(timer);
  state.settleTimers.clear();
}
