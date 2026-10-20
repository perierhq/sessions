// The impact of open incidents: how many requests (and people) the problem
// hit, measured from where the signal names it (`Signal.impact`), from the
// signal's own egress. Refreshed once a minute while an incident is open and
// once more right after it closes. No audit: an impact carries no secret and
// no decision. No timers at import; `startIncidentImpact` starts the refresh.
import {
  type ImpactSource,
  type Incident,
  type IncidentImpact,
  type Observation,
  type Signal,
  isOpenIncident,
} from "../../shared/incidents";
import { isShuttingDown } from "../shutdown-state";
import { listIncidents, updateIncident } from "./incident-store";
import { MAIN_LANE, queryObservations } from "./observation-store";
import { listSignals } from "./signal-store";
import { runSignalSource } from "./sources";

export const IMPACT_REFRESH_MS = 60_000;
/** The longest range {@link queryObservations} reads. */
const MAX_EVENTS_RANGE_MS = 31 * 86_400_000;

export interface ImpactDeps {
  runSource: typeof runSignalSource;
  observations: typeof queryObservations;
  now: () => number;
}

const defaultDeps: ImpactDeps = {
  runSource: runSignalSource,
  observations: queryObservations,
  now: () => Date.now(),
};

type HttpImpact = Extract<ImpactSource, { kind: "http" }>;
type EventsImpact = Extract<ImpactSource, { kind: "events" }>;
type Numbers = Pick<IncidentImpact, "count" | "people" | "approximate"> & {
  error?: string;
};

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
  const kept = (error: string): Numbers => ({
    ...(previous?.count === undefined ? {} : { count: previous.count }),
    ...(previous?.people === undefined ? {} : { people: previous.people }),
    approximate: true,
    error,
  });
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
    return kept(message(error));
  }
  const main =
    run.observations.find((o) => o.lane === undefined) ?? run.observations[0];
  if (main?.result !== "ok") return kept(main?.detail || "No answer");
  const matches = run.preview?.matches ?? {};
  const count = firstCount(matches[impact.countPath]);
  if (count === undefined) return kept(`Nothing at ${impact.countPath}`);
  const people = impact.peoplePath
    ? firstCount(matches[impact.peoplePath])
    : undefined;
  return {
    count,
    ...(people === undefined ? {} : { people }),
    approximate: true,
  };
}

async function measureEvents(
  incident: Incident,
  signal: Signal,
  impact: EventsImpact,
  deps: ImpactDeps,
): Promise<Numbers> {
  const to = incident.closedAt ? Date.parse(incident.closedAt) : deps.now();
  const opened = Date.parse(incident.openedAt);
  // Observations are kept for a month: a longer incident counts its last
  // 31 days, and says the count is approximate.
  const from = Math.max(opened, to - MAX_EVENTS_RANGE_MS);
  let observations: Observation[];
  try {
    observations = await deps.observations(signal.id, from, to, {
      lane: MAIN_LANE,
    });
  } catch (error) {
    return { approximate: false, error: message(error) };
  }
  const failed = observations.filter((o) => o.result === "fail");
  const count =
    impact.count === "fail-events"
      ? failed.length
      : failed.reduce(
          (sum, o) =>
            typeof o.value === "number" && Number.isFinite(o.value)
              ? sum + o.value
              : sum,
          0,
        );
  return { count, approximate: from > opened };
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
    numbers = { approximate: impact.kind === "http", error: message(error) };
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

function needsMeasuring(incident: Incident, now: number): boolean {
  if (isOpenIncident(incident)) return true;
  if (!incident.closedAt) return false;
  const closed = Date.parse(incident.closedAt);
  if (!(now - closed <= IMPACT_REFRESH_MS)) return false;
  // One final measurement that covers the whole incident.
  return !incident.impact || Date.parse(incident.impact.at) < closed;
}

/**
 * Measure every open incident, and every incident closed within the last
 * refresh that has not been measured since it closed. Writes only when the
 * numbers change (a steady count causes no incident change event). Resolves
 * to the number of incidents written.
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
      .find((s) => s?.impact);
    if (!signal) continue;
    const previous =
      incident.impact?.signalId === signal.id ? incident.impact : undefined;
    const impact = await measureImpact(
      { incident, signal, previous },
      { ...deps, now: () => now },
    );
    if (sameImpact(incident.impact, impact)) continue;
    let changed = false;
    const result = await updateIncident(incident.id, (current) => {
      changed = !sameImpact(current.impact, impact);
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
