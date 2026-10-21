// Signal scheduler: one 5 s gateway tick polls due http and TLS expiry
// signals (at most four at a time; an http signal with `runOn` runs from
// that production Runner, everything else from this server),
// records missed heartbeat check-ins, re-runs time-based rules (staleness,
// rate decay, missed slots) every 30 s and prunes old observations daily.
// Nothing runs at import: `startIncidentSignals()` is the only live effect.
import type { Signal } from "../../shared/incidents";
import { isShuttingDown } from "../shutdown-state";
import {
  hydrateObservations,
  hydrationLookbackMs,
  pruneObservations,
  recentObservations,
} from "./observation-store";
import { MISSED_CHECK_IN_DETAIL, missedSlotAt } from "./rules";
import {
  allSignalEvaluations,
  bootSignalRuntime,
  forgetSignal,
  ingestObservations,
  reevaluateSignal,
} from "./signal-runtime";
import { listSignals, signalWriteCount } from "./signal-store";
import { type SourceRun, runSignalSource } from "./sources";

export const SCHEDULER_TICK_MS = 5_000;
export const TIME_RULE_EVERY_MS = 30_000;
export const PRUNE_EVERY_MS = 86_400_000;
export const SIGNAL_CACHE_MS = 30_000;
export const MAX_CONCURRENT_RUNS = 4;
/** First runs spread over at most this long. */
export const FIRST_RUN_SPREAD_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

export interface SchedulerDeps {
  runSource?: (signal: Signal) => Promise<SourceRun>;
  prune?: (now: number) => Promise<number>;
  /** Delay before a signal's first run once seen; defaults to
   *  {@link firstRunOffsetMs}. */
  firstRunOffsetMs?: (signalId: string, intervalMs: number) => number;
}

/**
 * A stable delay for a signal's first run after boot or creation: a hash of
 * its id modulo min(interval, 60 s), so signals created or restored together
 * do not all fire on the same tick.
 */
export function firstRunOffsetMs(signalId: string, intervalMs: number): number {
  const window = Math.max(1, Math.min(intervalMs, FIRST_RUN_SPREAD_MS));
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < signalId.length; i++) {
    hash ^= signalId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % window;
}

interface SignalCache {
  signals: Signal[];
  fetchedAt: number;
  writeCount: number;
}

let cache: SignalCache | undefined;
/** Next due instant per polled signal. */
let nextDue = new Map<string, number>();
let inFlight = new Set<string>();
let lastTimeRulesAt: number | undefined;
let timeRulesRunning = false;
let lastPruneAt: number | undefined;
let pruneRunning = false;

export function __resetSchedulerForTest(): void {
  cache = undefined;
  nextDue = new Map();
  inFlight = new Set();
  lastTimeRulesAt = undefined;
  timeRulesRunning = false;
  lastPruneAt = undefined;
  pruneRunning = false;
}

function isPolled(signal: Signal): boolean {
  return signal.source.kind === "http" || signal.source.kind === "expiry";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The cached signal list, refreshed when stale or after a local write. */
async function currentSignals(now: number): Promise<Signal[]> {
  const writes = signalWriteCount();
  if (
    cache &&
    cache.writeCount === writes &&
    now >= cache.fetchedAt &&
    now - cache.fetchedAt < SIGNAL_CACHE_MS
  )
    return cache.signals;
  const signals = await listSignals();
  cache = { signals, fetchedAt: now, writeCount: writes };
  return signals;
}

/** Forget every signal that is gone, disabled, or no longer polled. */
function dropInactive(signals: Signal[]): void {
  const enabled = new Map<string, Signal>();
  for (const signal of signals)
    if (signal.enabled) enabled.set(signal.id, signal);
  for (const id of [...allSignalEvaluations().keys()])
    if (!enabled.has(id)) forgetSignal(id);
  for (const id of [...nextDue.keys()]) {
    const signal = enabled.get(id);
    if (!signal || !isPolled(signal)) nextDue.delete(id);
  }
}

async function runOne(
  signal: Signal,
  runSource: (signal: Signal) => Promise<SourceRun>,
): Promise<void> {
  try {
    const run = await runSource(signal);
    await ingestObservations(signal.id, run.observations, Date.now());
  } catch (error) {
    console.error(`[incidents] check failed for ${signal.id}:`, message(error));
  } finally {
    inFlight.delete(signal.id);
  }
}

/**
 * Missed heartbeat slots become one synthetic failure each (the slot instant
 * is deterministic, so a repeat pass or a restart adds nothing), then every
 * enabled signal is re-evaluated so time alone can move its state.
 */
async function runTimeRules(signals: Signal[], now: number): Promise<void> {
  for (const signal of signals) {
    if (!signal.enabled) continue;
    try {
      if (signal.source.kind === "heartbeat") {
        await hydrateObservations(
          signal.id,
          now,
          hydrationLookbackMs(signal, now),
        );
        const recent = recentObservations(signal.id);
        const slot = missedSlotAt(signal, recent, now);
        if (slot !== null && !recent.some((o) => Date.parse(o.at) === slot)) {
          await ingestObservations(
            signal.id,
            [
              {
                at: new Date(slot).toISOString(),
                result: "fail",
                detail: MISSED_CHECK_IN_DETAIL,
              },
            ],
            now,
          );
          continue;
        }
      }
      await reevaluateSignal(signal, now);
    } catch (error) {
      console.error(
        `[incidents] time rules failed for ${signal.id}:`,
        message(error),
      );
    }
  }
}

function startPrune(
  now: number,
  prune: (now: number) => Promise<number>,
): void {
  if (pruneRunning) return;
  if (lastPruneAt !== undefined && now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  pruneRunning = true;
  void prune(now)
    .catch((error) =>
      console.error("[incidents] observation prune failed:", message(error)),
    )
    .finally(() => {
      pruneRunning = false;
    });
}

/**
 * One scheduler pass at `now`. Resolves once due checks are started;
 * `settled` resolves when those checks and this pass's time rules are done
 * (the daily prune is not waited for).
 */
export async function runSchedulerTick(
  now: number,
  deps: SchedulerDeps = {},
): Promise<{ started: string[]; settled: Promise<void> }> {
  const runSource =
    deps.runSource ?? ((signal: Signal) => runSignalSource(signal));
  const offset = deps.firstRunOffsetMs ?? firstRunOffsetMs;
  const signals = await currentSignals(now);
  dropInactive(signals);

  const started: string[] = [];
  const work: Promise<void>[] = [];
  for (const signal of signals) {
    if (inFlight.size >= MAX_CONCURRENT_RUNS) break;
    if (!signal.enabled || !isPolled(signal) || inFlight.has(signal.id))
      continue;
    const intervalMs = signal.intervalMs ?? DEFAULT_INTERVAL_MS;
    let due = nextDue.get(signal.id);
    if (due === undefined) {
      due = now + offset(signal.id, intervalMs);
      nextDue.set(signal.id, due);
    }
    if (due > now) continue;
    nextDue.set(signal.id, now + intervalMs);
    inFlight.add(signal.id);
    started.push(signal.id);
    work.push(runOne(signal, runSource));
  }

  if (
    !timeRulesRunning &&
    (lastTimeRulesAt === undefined ||
      now < lastTimeRulesAt ||
      now - lastTimeRulesAt >= TIME_RULE_EVERY_MS)
  ) {
    lastTimeRulesAt = now;
    timeRulesRunning = true;
    work.push(
      runTimeRules(signals, now).finally(() => {
        timeRulesRunning = false;
      }),
    );
  }

  startPrune(now, deps.prune ?? pruneObservations);
  return { started, settled: Promise.all(work).then(() => undefined) };
}

/** When the scheduler next polls a signal (ISO), if it is scheduled. */
export function signalNextRunAt(signalId: string): string | undefined {
  const due = nextDue.get(signalId);
  return due === undefined ? undefined : new Date(due).toISOString();
}

interface IncidentSignalsHandle {
  interval?: ReturnType<typeof setInterval>;
}

declare global {
  var __incidentSignals: IncidentSignalsHandle | undefined;
}

/**
 * Restore every signal's evaluation, then tick every 5 s. Idempotent per
 * process. A tick is skipped while shutting down or while the previous one
 * is still fetching the signal list.
 */
export function startIncidentSignals(): void {
  if (globalThis.__incidentSignals) return;
  const handle: IncidentSignalsHandle = {};
  globalThis.__incidentSignals = handle;
  let ticking = false;
  void bootSignalRuntime()
    .catch((error) =>
      console.error("[incidents] signal restore failed:", message(error)),
    )
    .finally(() => {
      handle.interval = setInterval(() => {
        if (isShuttingDown() || ticking) return;
        ticking = true;
        void runSchedulerTick(Date.now())
          .catch((error) =>
            console.error("[incidents] scheduler tick failed:", message(error)),
          )
          .finally(() => {
            ticking = false;
          });
      }, SCHEDULER_TICK_MS);
      console.log(
        `[incidents] Signals started (${SCHEDULER_TICK_MS / 1000}s tick)`,
      );
    });
}
