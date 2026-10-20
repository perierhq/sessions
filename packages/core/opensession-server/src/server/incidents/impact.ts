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
/** Cached counts of finished days; the oldest go first past this. */
const MAX_CACHED_DAYS = 4096;

export interface ImpactDeps {
  runSource: typeof runSignalSource;
  scan: typeof scanObservations;
  now: () => number;
}

const defaultDeps: ImpactDeps = {
  runSource: runSignalSource,
  scan: scanObservations,
  now: () => Date.now(),
};

interface DayCount {
  failEvents: number;
  valueSum: number;
}

/** Counts of finished UTC days (or the part of one an incident covers), by
 *  signal, lane and range. A finished day takes no new observations. */
let dayCounts = new Map<string, DayCount>();

export function __resetImpactForTest(): void {
  dayCounts = new Map();
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
  previous: IncidentImpact | undefined,
  deps: ImpactDeps,
): Promise<Numbers> {
  const failed = (error: string) => kept(previous, error, true);
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

/**
 * Measure `incident`'s impact from `signal.impact` now. Never throws: a
 * failed measurement keeps `previous`'s numbers and says why in `error`.
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
  let numbers: Numbers;
  try {
    numbers =
      impact.kind === "http"
        ? await measureHttp(incident, signal, impact, previous, d)
        : await measureEvents(incident, signal, impact, d);
  } catch (error) {
    numbers = kept(previous, message(error), impact.kind === "http");
  }
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
 * The impact signal is the first of the incident's signals that still
 * exists, is enabled and has an impact source. Measure every open incident, and every incident closed within the last
 * {@link IMPACT_FINAL_WINDOW_MS} that has not been measured since it closed.
 * An open incident is written only when the numbers change (a steady count
 * causes no incident change event); a closed one's final measurement is
 * always written, so it is measured once. Resolves to the number of
 * incidents written.
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
  let written = 0;
  for (const incident of incidents) {
    const signal = incident.signalIds
      .map((id) => signals.get(id))
      // A disabled signal is not queried, not even for its impact.
      .find((s) => s?.enabled && s.impact);
    if (!signal) continue;
    const previous =
      incident.impact?.signalId === signal.id ? incident.impact : undefined;
    const impact = await measureImpact(
      { incident, signal, previous },
      { ...deps, now: () => now },
    );
    const final = needsFinal(incident);
    if (!final && sameImpact(incident.impact, impact)) continue;
    let changed = false;
    const result = await updateIncident(incident.id, (current) => {
      changed = needsFinal(current) || !sameImpact(current.impact, impact);
      return changed ? { ...current, impact } : current;
    });
    if (changed && result && !("error" in result)) written++;
  }
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
