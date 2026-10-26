// Signal runtime: observations in, evaluations out, incidents moved. Keeps
// each signal's current evaluation in memory, audits state changes, and
// hands every change to the engine, one at a time across all projects, so
// no two decisions read the same stale incident list (dependencies and
// providers reach across projects). No timers: the scheduler and the hook
// intake drive it.
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
  QUIET_WINDOW_MS,
  REOPEN_WINDOW_MS,
  type SignalRun,
  applyIncidentOps,
  decideIncidentOps,
  nextSignalRun,
} from "./engine";
import { listIncidents } from "./incident-store";
import {
  appendObservations,
  hydrateObservations,
  hydrationLookbackMs,
  recentObservations,
} from "./observation-store";
import { getProjectSettings } from "./response/project-settings";
import { evaluateSignal, replaySignal } from "./rules";
import { signalOwner } from "./owner";
import { getSignal, listSignals } from "./signal-store";

let evaluations = new Map<string, SignalEvaluation>();
/** Each signal's current healthy or bad run, for the engine's quiet. */
let runs = new Map<string, SignalRun>();
/**
 * Signals bad while an incident closed without action stays quiet: the
 * change the engine held, to decide again (unchanged state) once `until`
 * has come. Without `until`, only the next change decides again.
 */
let held = new Map<
  string,
  { previous: SignalEvaluation | null; until?: number }
>();
/** The state last audited per signal. A change the engine failed on is
 *  undone and made again; it is audited once. */
let auditedStates = new Map<string, SignalEvaluation["state"]>();
/** The engine's work queue: one decision at a time. */
let engineChain: Promise<void> = Promise.resolve();
/**
 * The boot replay in progress. Intake waits for it: an observation taken
 * meanwhile would otherwise be judged against no previous state, and the
 * replay would then overwrite its evaluation.
 */
let booting: Promise<void> | null = null;
/** Background evaluations of recorded observations, the newest per signal. */
let intake = new Map<string, Promise<void>>();

/** Told when a signal's state changes; never for the boot replay. */
export type SignalStateListener = (
  signal: Readonly<Pick<Signal, "id" | "project" | "name">>,
  current: Readonly<SignalEvaluation>,
  previous: Readonly<SignalEvaluation> | null,
) => void;

const stateListeners = new Set<SignalStateListener>();

/** Subscribe to signal state changes; returns the unsubscribe function. */
export function onSignalStateChange(listener: SignalStateListener): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * Tell every listener, each on its own microtask: a listener that throws,
 * rejects or never settles cannot fail the evaluation or hold up the engine.
 * Listeners get frozen copies, so none can change the stored evaluation or
 * what the next listener sees.
 */
function notifyStateChange(
  signal: Signal,
  current: SignalEvaluation,
  previous: SignalEvaluation | null,
): void {
  const view = Object.freeze({
    id: signal.id,
    project: signal.project,
    name: signal.name,
  });
  const now = Object.freeze({ ...current });
  const before = previous ? Object.freeze({ ...previous }) : null;
  for (const listener of [...stateListeners])
    void Promise.resolve()
      .then(() => listener(view, now, before))
      .catch((error: unknown) => {
        console.warn(
          "[incidents] signal state listener failed:",
          error instanceof Error ? error.message : error,
        );
      });
}

export function getSignalEvaluation(id: string): SignalEvaluation | null {
  return evaluations.get(id) ?? null;
}

export function allSignalEvaluations(): ReadonlyMap<string, SignalEvaluation> {
  return evaluations;
}

/** Drop a signal's evaluation (deleted or disabled). */
export function forgetSignal(id: string): void {
  evaluations.delete(id);
  auditedStates.delete(id);
  runs.delete(id);
  held.delete(id);
}

interface IncidentEngine {
  decide: typeof decideIncidentOps;
  apply: typeof applyIncidentOps;
}
const defaultEngine: IncidentEngine = {
  decide: decideIncidentOps,
  apply: applyIncidentOps,
};
let engine = defaultEngine;

/** Swap parts of the engine in tests; undefined restores it. */
export function __setIncidentEngineForTest(
  parts: Partial<IncidentEngine> | undefined,
): void {
  engine = { ...defaultEngine, ...parts };
}

export function __resetSignalRuntimeForTest(): void {
  evaluations = new Map();
  runs = new Map();
  held = new Map();
  auditedStates = new Map();
  engineChain = Promise.resolve();
  booting = null;
  intake = new Map();
  stateListeners.clear();
}

function hydrate(signal: Signal, now: number): Promise<void> {
  return hydrateObservations(signal.id, now, hydrationLookbackMs(signal, now));
}

/**
 * Open incidents, those closed recently enough to reopen, those holding the
 * changed signal that closed during its current run (from `current.since`
 * on): the engine reads the last as "closed knowingly", and those holding
 * it whose quiet its bad run began in.
 */
function engineIncidents(
  all: Incident[],
  now: number,
  signalId: string,
  current: SignalEvaluation,
): Incident[] {
  const runStarted = Date.parse(current.since);
  const badSince = runs.get(signalId)?.badSince ?? now;
  return all.filter((incident) => {
    if (isOpenIncident(incident)) return true;
    const closed = incident.closedAt ? Date.parse(incident.closedAt) : NaN;
    if (!Number.isFinite(closed)) return false;
    if (now - closed <= REOPEN_WINDOW_MS) return true;
    if (!incident.signalIds.includes(signalId)) return false;
    if (
      incident.state === "closed-without-action" &&
      badSince - closed <= QUIET_WINDOW_MS
    )
      return true;
    return Number.isFinite(runStarted) && closed >= runStarted;
  });
}

async function snapshotAt(
  now: number,
  signal: Signal,
  current: SignalEvaluation,
): Promise<EngineSnapshot> {
  const [signals, incidents, settings] = await Promise.all([
    listSignals(),
    listIncidents(),
    getProjectSettings(signal.project),
  ]);
  return {
    // A disabled signal is as good as gone: its stale state must not hold
    // an incident open or correlate with anything.
    signals: new Map(signals.filter((s) => s.enabled).map((s) => [s.id, s])),
    evaluations,
    incidents: engineIncidents(incidents, now, signal.id, current),
    now,
    runs,
    ...(settings.incidentsPaused
      ? { incidentsPaused: new Set([signal.project]) }
      : {}),
  };
}

/**
 * Run the engine for one change, after every earlier change. When it fails,
 * the change is undone (unless a newer evaluation replaced it meanwhile), so
 * the next evaluation sees it as a change again and the engine retries.
 */
function runEngine(
  signal: Signal,
  previous: SignalEvaluation | null,
  current: SignalEvaluation,
  now: number,
): Promise<void> {
  const run = engineChain.then(async () => {
    try {
      const snapshot = await snapshotAt(now, signal, current);
      // A person owns what it opens, never the principal that created it:
      // "" when there is nobody, which the notifier reports.
      const owned = { ...signal, owner: signalOwner(signal) };
      const ops = engine.decide(owned, previous, current, snapshot);
      const hold = ops.find((op) => op.op === "hold");
      if (hold?.op === "hold")
        held.set(signal.id, {
          previous,
          ...(hold.until ? { until: Date.parse(hold.until) } : {}),
        });
      else held.delete(signal.id);
      if (ops.length) await engine.apply(ops, new Date(now).toISOString());
    } catch (error) {
      console.error(
        `[incidents] engine failed for ${signal.id}:`,
        error instanceof Error ? error.message : error,
      );
      if (evaluations.get(signal.id) === current) {
        if (previous) evaluations.set(signal.id, previous);
        else evaluations.delete(signal.id);
      }
    }
  });
  engineChain = run;
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
  runs.set(signal.id, nextSignalRun(runs.get(signal.id), current));
  const audited = auditedStates.get(signal.id);
  if (audited !== current.state) {
    auditedStates.set(signal.id, current.state);
    incidentAudit({
      kind: "incident_signal_state",
      signalId: signal.id,
      from: audited ?? null,
      to: current.state,
      reason: current.reason,
    });
    notifyStateChange(signal, current, previous);
  }
  if (previous?.state !== current.state) {
    held.delete(signal.id);
    await runEngine(signal, previous, current, now);
  } else {
    // Held by a quiet incident: the same change, decided again when due.
    const hold = held.get(signal.id);
    if (hold?.until !== undefined && now >= hold.until)
      await runEngine(signal, hold.previous, current, now);
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
 * Record observations now and evaluate them in the background, after every
 * earlier recording for the same signal, so a stalled engine never holds the
 * caller (a hook answer). The evaluation reads the signal again (it may have
 * been disabled meanwhile) and logs its errors.
 */
export function recordObservations(
  signal: Signal,
  observations: Observation[],
  now: number = Date.now(),
): void {
  if (observations.length) appendObservations(signal.id, observations);
  const evaluate = async () => {
    await bootSettled();
    const fresh = await getSignal(signal.id);
    if (fresh) await reevaluateSignal(fresh, now);
    else forgetSignal(signal.id);
  };
  const next = (intake.get(signal.id) ?? Promise.resolve())
    .then(evaluate)
    .catch((error) =>
      console.error(
        `[incidents] evaluation failed for ${signal.id}:`,
        error instanceof Error ? error.message : error,
      ),
    );
  intake.set(signal.id, next);
  void next.then(() => {
    if (intake.get(signal.id) === next) intake.delete(signal.id);
  });
}

/** Resolves once every background evaluation queued so far is done. */
export async function intakeSettled(): Promise<void> {
  while (intake.size) await Promise.all([...intake.values()]);
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
      const replayed = replaySignal(signal, recentObservations(signal.id), now);
      evaluations.set(signal.id, replayed);
      runs.set(signal.id, nextSignalRun(undefined, replayed));
      // Taken back, not changed: later changes audit from here.
      auditedStates.set(signal.id, replayed.state);
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
