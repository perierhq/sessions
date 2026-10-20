// Signal runtime: observations in, evaluations out, incidents moved. Keeps
// each signal's current evaluation in memory, audits state changes, and
// hands every change to the engine, serialized per project so two signals
// of one project never decide against the same stale incident list. No
// timers: the scheduler and the hook intake drive it.
import {
  type Incident,
  type Observation,
  type Signal,
  type SignalEvaluation,
  isOpenIncident,
} from "../../shared/incidents";
import { incidentAudit } from "./audit-sink";
import {
  type EngineSnapshot,
  REOPEN_WINDOW_MS,
  applyIncidentOps,
  decideIncidentOps,
} from "./engine";
import { listIncidents } from "./incident-store";
import {
  appendObservations,
  hydrateObservations,
  hydrationLookbackMs,
  recentObservations,
} from "./observation-store";
import { evaluateSignal, replaySignal } from "./rules";
import { getSignal, listSignals } from "./signal-store";

let evaluations = new Map<string, SignalEvaluation>();
/** The engine's work queue per project. */
let projectChains = new Map<string, Promise<void>>();
/**
 * The boot replay in progress. Intake waits for it: an observation taken
 * meanwhile would otherwise be judged against no previous state, and the
 * replay would then overwrite its evaluation.
 */
let booting: Promise<void> | null = null;

export function getSignalEvaluation(id: string): SignalEvaluation | null {
  return evaluations.get(id) ?? null;
}

export function allSignalEvaluations(): ReadonlyMap<string, SignalEvaluation> {
  return evaluations;
}

/** Drop a signal's evaluation (deleted or disabled). */
export function forgetSignal(id: string): void {
  evaluations.delete(id);
}

export function __resetSignalRuntimeForTest(): void {
  evaluations = new Map();
  projectChains = new Map();
  booting = null;
}

function hydrate(signal: Signal, now: number): Promise<void> {
  return hydrateObservations(signal.id, now, hydrationLookbackMs(signal, now));
}

/** Open incidents and those closed recently enough to reopen. */
function engineIncidents(all: Incident[], now: number): Incident[] {
  return all.filter((incident) => {
    if (isOpenIncident(incident)) return true;
    const closed = incident.closedAt ? Date.parse(incident.closedAt) : NaN;
    return Number.isFinite(closed) && now - closed <= REOPEN_WINDOW_MS;
  });
}

async function snapshotAt(now: number): Promise<EngineSnapshot> {
  const [signals, incidents] = await Promise.all([
    listSignals(),
    listIncidents(),
  ]);
  return {
    // A disabled signal is as good as gone: its stale state must not hold
    // an incident open or correlate with anything.
    signals: new Map(signals.filter((s) => s.enabled).map((s) => [s.id, s])),
    evaluations,
    incidents: engineIncidents(incidents, now),
    now,
  };
}

/** Run the engine for one change, after earlier changes in the project. */
function runEngine(
  signal: Signal,
  previous: SignalEvaluation | null,
  current: SignalEvaluation,
  now: number,
): Promise<void> {
  const key = signal.project;
  const run = (projectChains.get(key) ?? Promise.resolve()).then(async () => {
    try {
      const snapshot = await snapshotAt(now);
      const ops = decideIncidentOps(signal, previous, current, snapshot);
      if (ops.length) await applyIncidentOps(ops, new Date(now).toISOString());
    } catch (error) {
      console.error(
        `[incidents] engine failed for ${signal.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  });
  projectChains.set(key, run);
  void run.then(() => {
    if (projectChains.get(key) === run) projectChains.delete(key);
  });
  return run;
}

export async function reevaluateSignal(
  signal: Signal,
  now: number = Date.now(),
): Promise<SignalEvaluation | null> {
  await bootSettled();
  if (!signal.enabled) {
    forgetSignal(signal.id);
    return null;
  }
  // A signal enabled or created after boot reads its stored history once.
  await hydrate(signal, now);
  const previous = evaluations.get(signal.id) ?? null;
  const current = evaluateSignal(
    signal,
    recentObservations(signal.id),
    previous,
    now,
  );
  evaluations.set(signal.id, current);
  if (previous?.state !== current.state) {
    incidentAudit({
      kind: "incident_signal_state",
      signalId: signal.id,
      from: previous?.state ?? null,
      to: current.state,
      reason: current.reason,
    });
    await runEngine(signal, previous, current, now);
  }
  return current;
}

export async function ingestObservations(
  signalId: string,
  observations: Observation[],
  now: number = Date.now(),
): Promise<SignalEvaluation | null> {
  await bootSettled();
  const signal = await getSignal(signalId);
  if (!signal?.enabled) return null;
  if (observations.length) appendObservations(signal.id, observations);
  return reevaluateSignal(signal, now);
}

/**
 * Rebuild every enabled signal's evaluation from stored observations, then
 * let the engine see each one as if new (`previous = null`): only a bad
 * signal that no open incident covers yet opens anything, so a restart adds
 * no duplicates and no events. Intake ({@link ingestObservations},
 * {@link reevaluateSignal}) called from the moment this is called waits
 * until it resolves.
 */
export function bootSignalRuntime(now: number = Date.now()): Promise<void> {
  const run = replayAll(now);
  booting = run;
  const clear = () => {
    if (booting === run) booting = null;
  };
  run.then(clear, clear);
  return run;
}

/** Wait out a boot replay in progress; a failed one does not block intake. */
async function bootSettled(): Promise<void> {
  if (booting) await booting.catch(() => {});
}

async function replayAll(now: number): Promise<void> {
  const signals = (await listSignals()).filter((s) => s.enabled);
  for (const signal of signals) {
    try {
      await hydrate(signal, now);
      evaluations.set(
        signal.id,
        replaySignal(signal, recentObservations(signal.id), now),
      );
    } catch (error) {
      console.error(
        `[incidents] could not restore ${signal.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  // Every evaluation is restored before the engine runs, so correlations
  // (providers, attached signals) see the whole picture.
  await Promise.all(
    signals.map((signal) => {
      const current = evaluations.get(signal.id);
      return current ? runEngine(signal, null, current, now) : undefined;
    }),
  );
}
