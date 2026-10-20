// Signal rules: observations → signal state. Pure; no I/O.
import type {
  Observation,
  Signal,
  SignalEvaluation,
  SignalRule,
  SignalState,
} from "../../shared/incidents";
import { previousRun } from "../cron";
import { activeMaintenance } from "./maintenance";

export const DEFAULT_RECOVERIES = 2;
export const FLAKY_WINDOW = 20;
export const FLAKY_MIN_FLIPS = 4;
export const FLAKY_CLEAR = 10;
export const STALE_INTERVALS = 3;
export const MIN_STALE_MS = 180_000;
export const REPLAY_TAIL = 200;
/** Detail of the synthetic observation recorded for a missed check-in. */
export const MISSED_CHECK_IN_DETAIL = "Missed check-in";

/** Poll intervals used for staleness when a signal does not set one. */
const DEFAULT_INTERVAL_MS = { http: 60_000, expiry: 6 * 3_600_000 } as const;

/** States an incident treats as a problem. */
export const PROBLEM_STATES: ReadonlySet<SignalState> = new Set<SignalState>([
  "failing",
  "slow",
]);
/** States that open a heads-up rather than an incident. */
export const WARNING_STATES: ReadonlySet<SignalState> = new Set<SignalState>([
  "flaky",
  "upcoming",
]);

/** States hysteresis holds on to until enough clean observations arrive. */
const HELD_STATES: ReadonlySet<SignalState> = new Set<SignalState>([
  "failing",
  "slow",
  "external",
]);

interface Verdict {
  state: SignalState;
  reason: string;
}

/** Whole minutes below 120 minutes, else hours. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 10) / 10);
}

function known(observations: Observation[]): Observation[] {
  return observations.filter((o) => o.result !== "unknown");
}

function trailing(
  observations: Observation[],
  match: (o: Observation) => boolean,
): number {
  let count = 0;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (!match(observations[i])) break;
    count++;
  }
  return count;
}

function consecutive(
  rule: Extract<SignalRule, { kind: "consecutive" }>,
  observations: Observation[],
  wasProblem: boolean,
): Verdict {
  const obs = known(observations);
  const fails = trailing(obs, (o) => o.result === "fail");
  if (fails >= rule.failures)
    return { state: "failing", reason: `${fails} failures in a row` };
  const recoveries = rule.recoveries ?? DEFAULT_RECOVERIES;
  const oks = trailing(obs, (o) => o.result === "ok");
  if (wasProblem && oks < recoveries)
    return {
      state: "failing",
      reason: `Recovering, ${oks} of ${recoveries} checks passed`,
    };
  return { state: "ok", reason: "Passing" };
}

function rate(
  rule: Extract<SignalRule, { kind: "rate" }>,
  observations: Observation[],
  wasProblem: boolean,
  now: number,
): Verdict {
  const since = now - rule.windowMs;
  const inWindow = known(observations).filter((o) => Date.parse(o.at) > since);
  const fails = inWindow.filter((o) => o.result === "fail").length;
  const window = formatDuration(rule.windowMs);
  if (
    fails >= rule.atLeast &&
    (rule.ratio === undefined || fails / inWindow.length >= rule.ratio)
  )
    return { state: "failing", reason: `${fails} failures in ${window}` };
  if (wasProblem && fails >= Math.ceil(rule.atLeast / 2))
    return { state: "failing", reason: `${fails} failures in ${window}` };
  return { state: "ok", reason: "Passing" };
}

function heldFor(
  obs: Observation[],
  over: (o: Observation) => boolean,
  forMs: number,
  now: number,
): boolean {
  const run = trailing(obs, over);
  if (!run) return false;
  return Date.parse(obs[obs.length - run].at) <= now - forMs;
}

function threshold(
  rule: Extract<SignalRule, { kind: "threshold" }>,
  observations: Observation[],
  previous: SignalEvaluation | null,
  wasProblem: boolean,
  now: number,
): Verdict {
  const obs = known(observations);
  const overAbove = (o: Observation) =>
    o.result === "fail" || (o.value !== undefined && o.value > rule.above);
  const duration = formatDuration(rule.forMs);
  if (rule.failingAbove !== undefined) {
    const limit = rule.failingAbove;
    const overFailing = (o: Observation) =>
      o.result === "fail" || (o.value !== undefined && o.value > limit);
    if (heldFor(obs, overFailing, rule.forMs, now))
      return {
        state: "failing",
        reason: `Over ${formatNumber(limit)} for ${duration}`,
      };
  }
  if (heldFor(obs, overAbove, rule.forMs, now))
    return {
      state: "slow",
      reason: `Over ${formatNumber(rule.above)} for ${duration}`,
    };
  const recoveries = rule.recoveries ?? DEFAULT_RECOVERIES;
  if (
    wasProblem &&
    previous &&
    trailing(obs, (o) => !overAbove(o)) < recoveries
  )
    return { state: previous.state, reason: previous.reason };
  return { state: "ok", reason: "Passing" };
}

function deadline(
  rule: Extract<SignalRule, { kind: "deadline" }>,
  observations: Observation[],
): Verdict {
  let latest: Observation | undefined;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].value !== undefined) {
      latest = observations[i];
      break;
    }
  }
  if (!latest || latest.value === undefined)
    return { state: "unknown", reason: "No expiry data yet" };
  const reason = `${formatNumber(latest.value)} days left`;
  if (latest.value <= rule.failDays) return { state: "failing", reason };
  if (latest.value <= rule.warnDays) return { state: "upcoming", reason };
  return { state: "ok", reason };
}

interface MissingVerdict {
  verdict: Verdict;
  /** Set when failing because a check-in slot was missed. */
  slot?: number;
}

function missing(
  signal: Signal,
  rule: Extract<SignalRule, { kind: "missing" }>,
  observations: Observation[],
  now: number,
): MissingVerdict {
  let baseline = Date.parse(signal.createdAt);
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].result === "ok") {
      baseline = Date.parse(observations[i].at);
      break;
    }
  }
  const latest = observations[observations.length - 1];
  if (latest?.result === "fail" && latest.detail !== MISSED_CHECK_IN_DETAIL)
    return {
      verdict: { state: "failing", reason: "Last check-in reported a failure" },
    };
  const missed = (slot: number): MissingVerdict => ({
    verdict: {
      state: "failing",
      reason: `No check-in since ${new Date(baseline).toISOString()}`,
    },
    slot,
  });
  if (rule.everyMs !== undefined) {
    if (now - baseline > rule.everyMs + rule.graceMs) {
      const k = Math.floor((now - baseline - rule.graceMs) / rule.everyMs);
      return missed(baseline + k * rule.everyMs + rule.graceMs);
    }
    return { verdict: { state: "ok", reason: "Passing" } };
  }
  if (rule.cron !== undefined) {
    const slot = previousRun(rule.cron, new Date(now - rule.graceMs));
    if (slot && baseline < slot.getTime() - rule.graceMs)
      return missed(slot.getTime() + rule.graceMs);
    return { verdict: { state: "ok", reason: "Passing" } };
  }
  return { verdict: { state: "unknown", reason: "No check-in schedule" } };
}

function baseVerdict(
  signal: Signal,
  observations: Observation[],
  previous: SignalEvaluation | null,
  now: number,
): Verdict {
  const wasProblem = previous !== null && HELD_STATES.has(previous.state);
  const rule = signal.rule;
  switch (rule.kind) {
    case "consecutive":
      return consecutive(rule, observations, wasProblem);
    case "rate":
      return rate(rule, observations, wasProblem, now);
    case "threshold":
      return threshold(rule, observations, previous, wasProblem, now);
    case "deadline":
      return deadline(rule, observations);
    case "missing":
      return missing(signal, rule, observations, now).verdict;
  }
}

function finish(
  signal: Signal,
  verdict: Verdict,
  observations: Observation[],
  previous: SignalEvaluation | null,
  now: number,
  inMaintenance: boolean,
): SignalEvaluation {
  const at = new Date(now).toISOString();
  const evaluation: SignalEvaluation = {
    signalId: signal.id,
    state: verdict.state,
    since: previous && previous.state === verdict.state ? previous.since : at,
    at,
    reason: verdict.reason,
    inMaintenance,
  };
  const last = observations[observations.length - 1];
  if (last) evaluation.lastObservationAt = last.at;
  return evaluation;
}

function inPastMaintenance(
  signal: Signal,
  observations: Observation[],
): Observation[] {
  if (!signal.maintenance?.length) return observations;
  return observations.filter(
    (o) => !activeMaintenance(signal.maintenance, Date.parse(o.at)),
  );
}

function staleVerdict(
  signal: Signal,
  observations: Observation[],
  now: number,
): Verdict | null {
  const kind = signal.source.kind;
  if (kind !== "http" && kind !== "expiry") return null;
  const latest = observations[observations.length - 1];
  if (!latest) return { state: "unknown", reason: "No data yet" };
  const interval = signal.intervalMs ?? DEFAULT_INTERVAL_MS[kind];
  const age = now - Date.parse(latest.at);
  if (age > Math.max(STALE_INTERVALS * interval, MIN_STALE_MS))
    return { state: "unknown", reason: `No data for ${formatDuration(age)}` };
  return null;
}

function isFlaky(observations: Observation[]): boolean {
  const recent = known(observations).slice(-FLAKY_WINDOW);
  let flips = 0;
  for (let i = 1; i < recent.length; i++)
    if (recent[i].result !== recent[i - 1].result) flips++;
  if (flips < FLAKY_MIN_FLIPS) return false;
  return recent.slice(-FLAKY_CLEAR).some((o) => o.result === "fail");
}

const FLAKY_RULES: ReadonlySet<SignalRule["kind"]> = new Set([
  "consecutive",
  "rate",
  "threshold",
]);
const EXTERNAL_FROM: ReadonlySet<SignalState> = new Set<SignalState>([
  "failing",
  "slow",
  "flaky",
]);

/**
 * Evaluates `signal` at `now`. `observations` are ascending by `at`;
 * observations with a `lane` are ignored. Layers, in order: maintenance now
 * (state frozen), staleness (over every observation), maintenance past
 * (observations taken in a window left out of the rule), the rule, flaky,
 * provider.
 */
export function evaluateSignal(
  signal: Signal,
  observations: Observation[],
  previous: SignalEvaluation | null,
  now: number,
): SignalEvaluation {
  const main = observations.filter((o) => !o.lane);
  if (activeMaintenance(signal.maintenance, now)) {
    const held: Verdict = previous
      ? { state: previous.state, reason: previous.reason }
      : { state: "unknown", reason: "In maintenance" };
    return finish(signal, held, main, previous, now, true);
  }
  // Staleness asks whether checks are running at all, so it reads every
  // observation, including those taken during a maintenance window.
  const stale = staleVerdict(signal, main, now);
  if (stale) return finish(signal, stale, main, previous, now, false);
  const counted = inPastMaintenance(signal, main);
  let verdict = baseVerdict(signal, counted, previous, now);
  if (
    verdict.state === "ok" &&
    FLAKY_RULES.has(signal.rule.kind) &&
    isFlaky(counted)
  )
    verdict = { state: "flaky", reason: "Failing on and off" };
  if (signal.provider && EXTERNAL_FROM.has(verdict.state))
    verdict = { ...verdict, state: "external" };
  return finish(signal, verdict, main, previous, now, false);
}

/**
 * The deterministic instant of the latest missed check-in slot, or `null`
 * when the signal is not failing because of a missed slot.
 */
export function missedSlotAt(
  signal: Signal,
  observations: Observation[],
  now: number,
): number | null {
  if (signal.rule.kind !== "missing") return null;
  if (activeMaintenance(signal.maintenance, now)) return null;
  const counted = inPastMaintenance(
    signal,
    observations.filter((o) => !o.lane),
  );
  return missing(signal, signal.rule, counted, now).slot ?? null;
}

/**
 * Rebuilds an evaluation from stored observations by folding the rule over
 * the last `REPLAY_TAIL` of them, so hysteresis holds across a restart.
 */
export function replaySignal(
  signal: Signal,
  observations: Observation[],
  now: number,
): SignalEvaluation {
  const tail = observations.filter((o) => !o.lane).slice(-REPLAY_TAIL);
  let previous: SignalEvaluation | null = null;
  for (let i = 0; i < tail.length; i++)
    previous = evaluateSignal(
      signal,
      tail.slice(0, i + 1),
      previous,
      Date.parse(tail[i].at),
    );
  return evaluateSignal(signal, tail, previous, now);
}
