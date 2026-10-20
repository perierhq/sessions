// Signal rules: observations → signal state. Pure; no I/O.
import type {
  Observation,
  Signal,
  SignalEvaluation,
  SignalRule,
  SignalState,
} from "../../shared/incidents";

export const DEFAULT_RECOVERIES = 2;

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
      return { state: "unknown", reason: "No data yet" };
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

/**
 * Evaluates `signal` at `now`. `observations` are ascending by `at`;
 * observations with a `lane` are ignored.
 */
export function evaluateSignal(
  signal: Signal,
  observations: Observation[],
  previous: SignalEvaluation | null,
  now: number,
): SignalEvaluation {
  const main = observations.filter((o) => !o.lane);
  return finish(
    signal,
    baseVerdict(signal, main, previous, now),
    main,
    previous,
    now,
    false,
  );
}
