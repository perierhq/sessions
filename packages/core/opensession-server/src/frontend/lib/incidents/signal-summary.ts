// What the incident views say about a signal: refresh cadence, lane kind,
// captions, latest value (never an uptime percentage), sort order and the
// mini strip's range. Pure.
import {
  type Signal,
  type SignalState,
  type SignalView,
  type StripResponse,
  stripIntervalMs,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import { dayMonth, formatSpan } from "./copy";
import { SIGNAL_RANK, signalStateWord } from "./tone";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The mini strip covers this many expected intervals. */
const MINI_INTERVALS = 40;

/** How often an open strip refetches: its bucket, at most once a minute. */
export function stripRefreshMs(strip: StripResponse | undefined): number {
  if (!strip || !(strip.bucketMs > 0)) return MINUTE_MS;
  return Math.min(MINUTE_MS, strip.bucketMs);
}

/** How a signal's observations are drawn. */
export type LaneKind = "passfail" | "value" | "events" | "runs" | "days";

const LANE_KIND: Record<Signal["rule"]["kind"], LaneKind> = {
  consecutive: "passfail",
  threshold: "value",
  rate: "events",
  missing: "runs",
  deadline: "days",
};

export function laneKindFor(signal: Pick<Signal, "rule">): LaneKind {
  return LANE_KIND[signal.rule.kind];
}

/** "every minute", "every 2 min", "every hour", "every 6 h", "every day". */
export function everyPhrase(ms: number): string {
  if (ms === MINUTE_MS) return "every minute";
  if (ms === HOUR_MS) return "every hour";
  if (ms === DAY_MS) return "every day";
  if (ms < HOUR_MS && ms % MINUTE_MS === 0)
    return `every ${ms / MINUTE_MS} min`;
  if (ms < DAY_MS && ms % HOUR_MS === 0) return `every ${ms / HOUR_MS} h`;
  return `every ${formatSpan(ms, true)}`;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A value as its signal measures it: latency, days left, or a number. */
export function formatSignalValue(
  signal: Pick<Signal, "source" | "rule">,
  value: number,
): string {
  if (signal.source.kind === "http" && !signal.source.json?.value) {
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${String(Math.round(value / 100) / 10)} s`;
  }
  if (signal.source.kind === "expiry") return plural(Math.floor(value), "day");
  return value.toLocaleString();
}

export function ruleCaption(signal: Pick<Signal, "rule" | "source">): string {
  const rule = signal.rule;
  switch (rule.kind) {
    case "consecutive":
      return `${plural(rule.failures, "failure")} in a row`;
    case "rate":
      return `${rule.atLeast} in ${formatSpan(rule.windowMs)}`;
    case "threshold":
      return `slow above ${formatSignalValue(signal, rule.above)} for ${formatSpan(rule.forMs)}`;
    case "missing":
      return rule.graceMs > 0
        ? `missed after ${formatSpan(rule.graceMs)} grace`
        : "missed check-in";
    case "deadline":
      return `warn at ${rule.warnDays} days, fail at ${rule.failDays}`;
  }
}

const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/** The row caption under a signal's name: kind, cadence, the rule when it
 *  says more than the kind. */
export function signalCaption(
  signal: Pick<Signal, "source" | "rule" | "intervalMs">,
): string {
  switch (signal.source.kind) {
    case "http": {
      const base = `Check · ${everyPhrase(stripIntervalMs(signal))}`;
      return signal.rule.kind === "threshold"
        ? `${base} · ${ruleCaption(signal)}`
        : base;
    }
    case "webhook":
      return `Webhook · ${ruleCaption(signal)}`;
    case "heartbeat": {
      const rule = signal.rule;
      if (rule.kind !== "missing") return "Check-in";
      if (rule.everyMs) return `Check-in · ${everyPhrase(rule.everyMs)}`;
      if (!rule.cron) return "Check-in";
      const daily = DAILY_CRON.exec(rule.cron.trim());
      if (!daily) return `Check-in · ${rule.cron}`;
      const pad = (n: string) => n.padStart(2, "0");
      return `Check-in · daily at ${pad(daily[2]!)}:${pad(daily[1]!)}`;
    }
    case "expiry":
      return `Certificate · ${signal.source.host}`;
  }
}

type ValueTone = "fg" | "yellow" | "red" | "faint";

export interface LatestValue {
  text: string;
  tone: ValueTone;
}

/** ISO instants, as the strip routes take them. */
export interface StripRange {
  from: string;
  to: string;
}

const STATE_TONE: Record<Exclude<SignalState, "ok">, ValueTone> = {
  failing: "red",
  slow: "yellow",
  flaky: "yellow",
  upcoming: "yellow",
  external: "faint",
  unknown: "faint",
};

/** The value at the end of a signal row: what it measures now, or the state
 *  in words when it is not ok. Never a percentage of uptime. */
export function latestValue(
  signal: SignalView,
  strip: StripResponse | undefined,
  now: number,
): LatestValue {
  if (!signal.enabled) return { text: "off", tone: "faint" };
  const state = signal.evaluation?.state ?? "unknown";
  if (state !== "ok")
    return { text: signalStateWord(state), tone: STATE_TONE[state] };
  switch (signal.source.kind) {
    case "http":
    case "expiry": {
      const value = signal.lastObservation?.value;
      return value === undefined
        ? { text: "ok", tone: "fg" }
        : { text: formatSignalValue(signal, value), tone: "fg" };
    }
    case "webhook": {
      let events = 0;
      for (const lane of strip?.lanes ?? [])
        for (const bar of lane.bars)
          if (bar.result === "fail") events += bar.count;
      return { text: `${events} in 1 h`, tone: "fg" };
    }
    case "heartbeat": {
      const last =
        signal.lastObservation?.at ?? signal.evaluation?.lastObservationAt;
      if (!last) return { text: "no check-in yet", tone: "faint" };
      return {
        text:
          now - Date.parse(last) < DAY_MS
            ? `ran ${clockTime(last)}`
            : `ran ${dayMonth(last)}`,
        tone: "fg",
      };
    }
  }
}

/** Problems first, then by name. A signal without an evaluation ranks as
 *  having no data. */
export function sortSignals<T extends Pick<SignalView, "name" | "evaluation">>(
  signals: T[],
): T[] {
  const rank = (s: T) => SIGNAL_RANK[s.evaluation?.state ?? "unknown"];
  return [...signals].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/** The mini strip on the home: the last 40 intervals, webhooks one hour. */
export function miniRange(
  signal: Pick<Signal, "source" | "rule" | "intervalMs">,
  now: number,
): StripRange {
  const span =
    signal.source.kind === "webhook"
      ? HOUR_MS
      : MINI_INTERVALS * stripIntervalMs(signal);
  return {
    from: new Date(now - span).toISOString(),
    to: new Date(now).toISOString(),
  };
}
