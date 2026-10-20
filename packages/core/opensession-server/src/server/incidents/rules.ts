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

/** Most earlier slots a missing rule looks at past maintenance windows. */
const MAX_SKIPPED_SLOTS = 1_500;
const MAX_SKIPPED_CRON_SLOTS = 50;
const DAY_MS = 86_400_000;

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
  if (
    wasProblem &&
    fails >= Math.ceil(rule.atLeast / 2) &&
    (rule.ratio === undefined || fails / inWindow.length >= rule.ratio / 2)
  )
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
  signal: Signal,
  rule: Extract<SignalRule, { kind: "threshold" }>,
  observations: Observation[],
  previous: SignalEvaluation | null,
  wasProblem: boolean,
  now: number,
): Verdict {
  const obs = known(observations);
  // A webhook pushes data only when something happens, and staleness does not
  // apply to it: without data inside forMs (at least MIN_STALE_MS), an old
  // run of slow events would hold forever.
  if (signal.source.kind === "webhook") {
    const last = obs[obs.length - 1];
    if (
      !last ||
      Date.parse(last.at) <= now - Math.max(rule.forMs, MIN_STALE_MS)
    )
      return { state: "ok", reason: "Passing" };
  }
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
  now: number,
): Verdict {
  // A rejected certificate (hostname mismatch, untrusted chain) or an
  // unreachable host fails whatever the expiry date says.
  const obs = known(observations);
  const last = obs[obs.length - 1];
  if (last?.result === "fail")
    return { state: "failing", reason: last.detail || "Check failed" };
  let latest: Observation | undefined;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].value !== undefined) {
      latest = observations[i];
      break;
    }
  }
  if (!latest || latest.value === undefined)
    return { state: "unknown", reason: "No expiry data yet" };
  // Days left at `now`: an old reading ages.
  const days = latest.value - (now - Date.parse(latest.at)) / DAY_MS;
  const reason =
    days <= 0
      ? "Expired"
      : `${formatNumber(Math.floor(days * 10) / 10)} days left`;
  if (days <= rule.failDays) return { state: "failing", reason };
  if (days <= rule.warnDays) return { state: "upcoming", reason };
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
  const createdAt = Date.parse(signal.createdAt);
  let okAt: number | null = null;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (observations[i].result === "ok") {
      okAt = Date.parse(observations[i].at);
      break;
    }
  }
  const baseline = okAt ?? createdAt;
  // A slot whose deadline (slot + grace) falls inside a maintenance window is
  // not owed; the latest earlier slot is checked instead.
  const excused = (due: number) =>
    activeMaintenance(signal.maintenance, due) !== null;
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
  const passing: MissingVerdict = {
    verdict: { state: "ok", reason: "Passing" },
  };
  if (rule.everyMs !== undefined) {
    if (now - baseline <= rule.everyMs + rule.graceMs) return passing;
    let k = Math.floor((now - baseline - rule.graceMs) / rule.everyMs);
    for (let n = 0; k >= 1 && n < MAX_SKIPPED_SLOTS; k--, n++) {
      const due = baseline + k * rule.everyMs + rule.graceMs;
      if (!excused(due)) return missed(due);
    }
    return passing;
  }
  if (rule.cron !== undefined) {
    let slot = previousRun(rule.cron, new Date(now - rule.graceMs));
    for (let n = 0; slot && n < MAX_SKIPPED_CRON_SLOTS; n++) {
      const at = slot.getTime();
      // A check-in up to grace before the slot covers it; a signal created
      // before the slot itself owes it.
      const owed = okAt !== null ? okAt < at - rule.graceMs : createdAt < at;
      if (!owed) return passing;
      if (!excused(at + rule.graceMs)) return missed(at + rule.graceMs);
      slot = previousRun(rule.cron, new Date(at - 60_000));
    }
    return passing;
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
      return threshold(signal, rule, observations, previous, wasProblem, now);
    case "deadline":
      return deadline(rule, observations, now);
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

/** Failures taken inside a maintenance window do not count; passes do. */
function countedObservation(o: Observation, inWindow: boolean): boolean {
  return !(inWindow && o.result === "fail");
}

function inPastMaintenance(
  signal: Signal,
  observations: Observation[],
): Observation[] {
  if (!signal.maintenance?.length) return observations;
  // Only failures need the window check; passes always count.
  return observations.filter(
    (o) =>
      o.result !== "fail" ||
      !activeMaintenance(signal.maintenance, Date.parse(o.at)),
  );
}

function withDetail(reason: string, detail: string): string {
  return detail ? `${reason}: ${detail}` : reason;
}

/**
 * Staleness for polled sources, measured from the latest `ok` or `fail`:
 * `unknown` observations (a refused address, a provider's HTML page) say the
 * check ran but learnt nothing, so they neither read as passing nor keep an
 * old state alive.
 */
function staleVerdict(
  signal: Signal,
  observations: Observation[],
  now: number,
): Verdict | null {
  const kind = signal.source.kind;
  if (kind !== "http" && kind !== "expiry") return null;
  const latest = observations[observations.length - 1];
  if (!latest) return { state: "unknown", reason: "No data yet" };
  let lastKnown = observations.length - 1;
  while (lastKnown >= 0 && observations[lastKnown].result === "unknown")
    lastKnown--;
  if (lastKnown < 0)
    return {
      state: "unknown",
      reason: withDetail("No usable data yet", latest.detail),
    };
  const interval = signal.intervalMs ?? DEFAULT_INTERVAL_MS[kind];
  const age = now - Date.parse(observations[lastKnown].at);
  if (age <= Math.max(STALE_INTERVALS * interval, MIN_STALE_MS)) return null;
  if (lastKnown < observations.length - 1)
    return {
      state: "unknown",
      reason: withDetail(
        `No usable data for ${formatDuration(age)}`,
        latest.detail,
      ),
    };
  return { state: "unknown", reason: `No data for ${formatDuration(age)}` };
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

function inMaintenanceNow(
  signal: Signal,
  main: Observation[],
  previous: SignalEvaluation | null,
  now: number,
): SignalEvaluation {
  const held: Verdict = previous
    ? { state: previous.state, reason: previous.reason }
    : { state: "unknown", reason: "In maintenance" };
  return finish(signal, held, main, previous, now, true);
}

/**
 * The layers after "maintenance now", given the main-lane observations and
 * the subset the rule counts (past-maintenance failures dropped).
 */
function evaluateOutsideMaintenance(
  signal: Signal,
  main: Observation[],
  counted: Observation[],
  previous: SignalEvaluation | null,
  now: number,
): SignalEvaluation {
  // Staleness asks whether checks are running at all, so it reads every
  // observation, including those taken during a maintenance window.
  const stale = staleVerdict(signal, main, now);
  if (stale) return finish(signal, stale, main, previous, now, false);
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
 * Evaluates `signal` at `now`. `observations` are ascending by `at`;
 * observations with a `lane` are ignored. Layers, in order: maintenance now
 * (state frozen), staleness (over every observation, from the latest `ok` or
 * `fail`), maintenance past (failures taken in a window left out of the rule;
 * passes still count), the rule, flaky, provider.
 */
export function evaluateSignal(
  signal: Signal,
  observations: Observation[],
  previous: SignalEvaluation | null,
  now: number,
): SignalEvaluation {
  const main = observations.filter((o) => !o.lane);
  if (activeMaintenance(signal.maintenance, now))
    return inMaintenanceNow(signal, main, previous, now);
  const counted = inPastMaintenance(signal, main);
  return evaluateOutsideMaintenance(signal, main, counted, previous, now);
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
 * Same result as folding {@link evaluateSignal}, but each observation's
 * maintenance flag is computed once: a step evaluated at an observation's own
 * instant is in maintenance exactly when that observation is.
 */
export function replaySignal(
  signal: Signal,
  observations: Observation[],
  now: number,
): SignalEvaluation {
  const tail = observations.filter((o) => !o.lane).slice(-REPLAY_TAIL);
  const windows = signal.maintenance?.length ? signal.maintenance : undefined;
  const counted: Observation[] = [];
  let previous: SignalEvaluation | null = null;
  for (let i = 0; i < tail.length; i++) {
    const o = tail[i];
    const at = Date.parse(o.at);
    const inWindow = windows ? activeMaintenance(windows, at) !== null : false;
    if (countedObservation(o, inWindow)) counted.push(o);
    const main = tail.slice(0, i + 1);
    previous = inWindow
      ? inMaintenanceNow(signal, main, previous, at)
      : evaluateOutsideMaintenance(signal, main, counted, previous, at);
  }
  if (activeMaintenance(windows, now))
    return inMaintenanceNow(signal, tail, previous, now);
  return evaluateOutsideMaintenance(signal, tail, counted, previous, now);
}
