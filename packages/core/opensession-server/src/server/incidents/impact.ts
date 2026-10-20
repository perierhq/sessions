// The impact of open incidents: how many requests (and people) the problem
// hit, measured from where the signal names it (`Signal.impact`), from the
// signal's own egress. Refreshed once a minute while an incident is open and
// once more after it closes. No audit: an impact carries no secret and
// no decision. No timers at import; `startIncidentImpact` starts the refresh.
import {
  type ImpactSource,
  type Incident,
  type IncidentImpact,
  type Signal,
  isOpenIncident,
} from "../../shared/incidents";
import { isShuttingDown } from "../shutdown-state";
import { listIncidents, updateIncident } from "./incident-store";
import {
  MAIN_LANE,
  OBSERVATION_RETENTION_DAYS,
  scanObservations,
} from "./observation-store";
import { listSignals } from "./signal-store";
import { runSignalSource } from "./sources";

export const IMPACT_REFRESH_MS = 60_000;
/** How long after it closes an incident still gets its final measurement. */
export const IMPACT_FINAL_WINDOW_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The longest range {@link scanObservations} reads. */
const MAX_EVENTS_RANGE_MS = 31 * DAY_MS;
/** Older observations may be pruned: a longer incident's count is approximate. */
const RETAINED_MS = OBSERVATION_RETENTION_DAYS * DAY_MS;
/** Impact queries in flight at once during a refresh. */
export const IMPACT_CONCURRENCY = 4;
/** How long one impact query may take. */
export const IMPACT_QUERY_TIMEOUT_MS = 5_000;
/** Errors in a row after which a signal's impact is paused... */
const BACKOFF_AFTER_ERRORS = 3;
/** ...first for this long, doubling with each further error up to an hour. */
const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 3_600_000;
/** Cached counts of finished days; the oldest go first past this. */
const MAX_CACHED_DAYS = 4096;

export interface ImpactDeps {
  runSource: typeof runSignalSource;
  scan: typeof scanObservations;
  now: () => number;
  queryTimeoutMs: number;
}

const defaultDeps: ImpactDeps = {
  runSource: runSignalSource,
  scan: scanObservations,
  now: () => Date.now(),
  queryTimeoutMs: IMPACT_QUERY_TIMEOUT_MS,
};

interface DayCount {
  failEvents: number;
  valueSum: number;
}

/** Counts of finished UTC days (or the part of one an incident covers), by
 *  signal, lane and range. A finished day takes no new observations. */
let dayCounts = new Map<string, DayCount>();

interface Backoff {
  errors: number;
  pauseMs: number;
  until: number;
}

/** Signals whose impact queries failed in a row, by id. */
let backoffs = new Map<string, Backoff>();

export function __resetImpactForTest(): void {
  dayCounts = new Map();
  backoffs = new Map();
}

function backedOff(signalId: string, now: number): boolean {
  const backoff = backoffs.get(signalId);
  return !!backoff && now < backoff.until;
}

function noteOutcome(signalId: string, failed: boolean, now: number): void {
  if (!failed) {
    backoffs.delete(signalId);
    return;
  }
  const backoff = backoffs.get(signalId) ?? { errors: 0, pauseMs: 0, until: 0 };
  backoff.errors++;
  if (backoff.errors >= BACKOFF_AFTER_ERRORS) {
    backoff.pauseMs = backoff.pauseMs
      ? Math.min(backoff.pauseMs * 2, BACKOFF_MAX_MS)
      : BACKOFF_FIRST_MS;
    backoff.until = now + backoff.pauseMs;
  }
  backoffs.set(signalId, backoff);
}

function duration(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** `work`, or an error once `ms` pass without an answer. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer within ${duration(ms)}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `tasks` with at most `limit` at once. */
async function runLimited(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
}

type HttpImpact = Extract<ImpactSource, { kind: "http" }>;
type EventsImpact = Extract<ImpactSource, { kind: "events" }>;
type Numbers = Pick<IncidentImpact, "count" | "people" | "approximate"> & {
  error?: string;
};

/** A failed measurement: the numbers before it, and why. */
function kept(
  previous: IncidentImpact | undefined,
  error: string,
  approximate: boolean,
): Numbers {
  return {
    ...(previous?.count === undefined ? {} : { count: previous.count }),
    ...(previous?.people === undefined ? {} : { people: previous.people }),
    approximate: previous?.approximate ?? approximate,
    error,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A finite number ≥ 0, or text that reads as one. */
function countOf(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function firstCount(values: unknown[] | undefined): number | undefined {
  for (const value of values ?? []) {
    const n = countOf(value);
    if (n !== undefined) return n;
  }
  return undefined;
}

function impactUrl(impact: HttpImpact, openedAt: string): string {
  return impact.url
    .replaceAll("{{since}}", encodeURIComponent(openedAt))
    .replaceAll("{{sinceMs}}", String(Date.parse(openedAt)));
}

async function measureHttp(
  incident: Incident,
  signal: Signal,
  impact: HttpImpact,
  deps: ImpactDeps,
): Promise<Numbers> {
  const failed = (error: string): Numbers => ({ approximate: true, error });
  const json = {
    value: impact.countPath,
    ...(impact.peoplePath ? { detail: impact.peoplePath } : {}),
  };
  let run: Awaited<ReturnType<typeof runSignalSource>>;
  try {
    run = await deps.runSource({
      ...signal,
      provider: false,
      source: {
        kind: "http",
        url: impactUrl(impact, incident.openedAt),
        ...(impact.headers ? { headers: impact.headers } : {}),
        timeoutMs: deps.queryTimeoutMs,
        json,
      },
    });
  } catch (error) {
    return failed(message(error));
  }
  const main =
    run.observations.find((o) => o.lane === undefined) ?? run.observations[0];
  if (main?.result !== "ok") return failed(main?.detail || "No answer");
  const matches = run.preview?.matches ?? {};
  const count = firstCount(matches[impact.countPath]);
  if (count === undefined) return failed(`Nothing at ${impact.countPath}`);
  const people = impact.peoplePath
    ? firstCount(matches[impact.peoplePath])
    : undefined;
  return {
    count,
    ...(people === undefined ? {} : { people }),
    approximate: true,
  };
}

async function countSpan(
  signalId: string,
  from: number,
  to: number,
  scan: ImpactDeps["scan"],
): Promise<DayCount> {
  const out: DayCount = { failEvents: 0, valueSum: 0 };
  await scan(
    signalId,
    from,
    to,
    (o) => {
      if (o.result !== "fail") return;
      out.failEvents++;
      if (typeof o.value === "number" && Number.isFinite(o.value))
        out.valueSum += o.value;
    },
    { lane: MAIN_LANE },
  );
  return out;
}

async function measureEvents(
  incident: Incident,
  signal: Signal,
  impact: EventsImpact,
  deps: ImpactDeps,
): Promise<Numbers> {
  const now = deps.now();
  const to = incident.closedAt ? Date.parse(incident.closedAt) : now;
  const opened = Date.parse(incident.openedAt);
  // Observations are kept for a month: a longer incident counts its last
  // 31 days, and says the count is approximate.
  const from = Math.max(opened, to - MAX_EVENTS_RANGE_MS);
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  let total = 0;
  // One span per UTC day; a finished day is counted once and cached.
  for (let start = from; start <= to;) {
    const dayEnd = Math.floor(start / DAY_MS) * DAY_MS + DAY_MS - 1;
    const end = Math.min(dayEnd, to);
    const key = `${signal.id}\0${MAIN_LANE}\0${start}\0${end}`;
    let counted = dayCounts.get(key);
    if (!counted) {
      counted = await countSpan(signal.id, start, end, deps.scan);
      if (dayEnd < today) {
        if (dayCounts.size >= MAX_CACHED_DAYS)
          dayCounts.delete(dayCounts.keys().next().value!);
        dayCounts.set(key, counted);
      }
    }
    total +=
      impact.count === "fail-events" ? counted.failEvents : counted.valueSum;
    start = dayEnd + 1;
  }
  return { count: total, approximate: to - opened > RETAINED_MS };
}

/** The numbers of one measurement; never throws. */
async function measureNumbers(
  incident: Incident,
  signal: Signal,
  impact: ImpactSource,
  deps: ImpactDeps,
): Promise<Numbers> {
  try {
    return await withTimeout(
      impact.kind === "http"
        ? measureHttp(incident, signal, impact, deps)
        : measureEvents(incident, signal, impact, deps),
      deps.queryTimeoutMs,
    );
  } catch (error) {
    return { approximate: impact.kind === "http", error: message(error) };
  }
}

function impactOf(
  signal: Signal,
  impact: ImpactSource,
  at: string,
  measured: Numbers,
  previous: IncidentImpact | undefined,
): IncidentImpact {
  const numbers =
    measured.error === undefined
      ? measured
      : kept(previous, measured.error, measured.approximate);
  return {
    signalId: signal.id,
    at,
    ...(numbers.count === undefined ? {} : { count: numbers.count }),
    ...(numbers.people === undefined ? {} : { people: numbers.people }),
    approximate: numbers.approximate,
    noun: impact.noun,
    label: impact.label,
    ...(numbers.error === undefined ? {} : { error: numbers.error }),
  };
}

/**
 * Measure `incident`'s impact from `signal.impact` now. Never throws: a
 * failed measurement (or one with no answer within the query timeout) keeps
 * `previous`'s numbers and says why in `error`.
 */
export async function measureImpact(
  input: { incident: Incident; signal: Signal; previous?: IncidentImpact },
  deps: Partial<ImpactDeps> = {},
): Promise<IncidentImpact> {
  const d: ImpactDeps = { ...defaultDeps, ...deps };
  const { incident, signal, previous } = input;
  const impact = signal.impact;
  const at = new Date(d.now()).toISOString();
  if (!impact)
    return {
      signalId: signal.id,
      at,
      approximate: true,
      noun: "",
      label: "",
      error: "No impact source",
    };
  const numbers = await measureNumbers(incident, signal, impact, d);
  return impactOf(signal, impact, at, numbers, previous);
}

/** The same impact apart from when it was measured. */
function sameImpact(a: IncidentImpact | undefined, b: IncidentImpact): boolean {
  if (!a) return false;
  const { at: _a, ...restA } = a;
  const { at: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/** A closed incident not yet measured since it closed. */
function needsFinal(incident: Incident): boolean {
  if (isOpenIncident(incident) || !incident.closedAt) return false;
  const closed = Date.parse(incident.closedAt);
  return !incident.impact || !(Date.parse(incident.impact.at) >= closed);
}

function needsMeasuring(incident: Incident, now: number): boolean {
  if (isOpenIncident(incident)) return true;
  if (!needsFinal(incident)) return false;
  // One final measurement that covers the whole incident, while it is recent.
  return now - Date.parse(incident.closedAt!) <= IMPACT_FINAL_WINDOW_MS;
}

/**
 * Measure every open incident, and every incident closed within the last
 * {@link IMPACT_FINAL_WINDOW_MS} that has not been measured since it closed,
 * from its impact signal: the first of its signals that still exists, is
 * enabled and has an impact source. An open incident is written only when
 * the numbers change (a steady count causes no incident change event); a
 * closed one's final measurement is always written, so it is measured once.
 *
 * At most {@link IMPACT_CONCURRENCY} queries run at once, and incidents of
 * one signal over the same range share one. Each incident is refreshed on
 * its own: one that fails is logged and the rest go on. A signal whose
 * query failed {@link BACKOFF_AFTER_ERRORS} times in a row is skipped for a
 * while. Resolves to the number of incidents written.
 */
export async function refreshIncidentImpacts(
  now: number,
  deps: Partial<ImpactDeps> = {},
): Promise<number> {
  const incidents = (await listIncidents()).filter((i) =>
    needsMeasuring(i, now),
  );
  if (!incidents.length) return 0;
  const signals = new Map((await listSignals()).map((s) => [s.id, s]));
  const d: ImpactDeps = { ...defaultDeps, ...deps, now: () => now };
  const at = new Date(now).toISOString();
  // One query per signal and range this tick, however many incidents share it.
  const measured = new Map<string, Promise<Numbers>>();
  let written = 0;
  const refreshOne = async (incident: Incident) => {
    const signal = incident.signalIds
      .map((id) => signals.get(id))
      // A disabled signal is not queried, not even for its impact.
      .find((s) => s?.enabled && s.impact);
    if (!signal?.impact || backedOff(signal.id, now)) return;
    const key = JSON.stringify([
      signal.id,
      incident.openedAt,
      incident.closedAt ?? "",
    ]);
    let pending = measured.get(key);
    if (!pending) {
      pending = measureNumbers(incident, signal, signal.impact, d).then(
        (numbers) => {
          noteOutcome(signal.id, numbers.error !== undefined, now);
          return numbers;
        },
      );
      measured.set(key, pending);
    }
    const previous =
      incident.impact?.signalId === signal.id ? incident.impact : undefined;
    const impact = impactOf(signal, signal.impact, at, await pending, previous);
    const final = needsFinal(incident);
    if (!final && sameImpact(incident.impact, impact)) return;
    let changed = false;
    const result = await updateIncident(incident.id, (current) => {
      changed = needsFinal(current) || !sameImpact(current.impact, impact);
      return changed ? { ...current, impact } : current;
    });
    if (changed && result && !("error" in result)) written++;
  };
  await runLimited(
    incidents.map((incident) => async () => {
      try {
        await refreshOne(incident);
      } catch (error) {
        console.error(
          `[incidents] impact of ${incident.id} failed:`,
          message(error),
        );
      }
    }),
    IMPACT_CONCURRENCY,
  );
  return written;
}

interface IncidentImpactHandle {
  interval: ReturnType<typeof setInterval>;
}

declare global {
  var __incidentImpact: IncidentImpactHandle | undefined;
}

/**
 * Refresh impacts every {@link IMPACT_REFRESH_MS}. Idempotent per process; a
 * refresh is skipped while shutting down or while the previous one runs.
 */
export function startIncidentImpact(): void {
  if (globalThis.__incidentImpact) return;
  let refreshing = false;
  const interval = setInterval(() => {
    if (isShuttingDown() || refreshing) return;
    refreshing = true;
    void refreshIncidentImpacts(Date.now())
      .catch((error) =>
        console.error("[incidents] impact refresh failed:", message(error)),
      )
      .finally(() => {
        refreshing = false;
      });
  }, IMPACT_REFRESH_MS);
  globalThis.__incidentImpact = { interval };
}
