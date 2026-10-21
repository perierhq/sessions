// Signal strips: observations bucketed into bars aligned to the live edge,
// one lane per JSON component, plus markers from an incident's timeline.
// Pure; no I/O.
import type {
  IncidentEvent,
  Observation,
  ObservationResult,
  Signal,
  StripBar,
  StripLane,
  StripMarker,
  StripMarkerKind,
} from "../../shared/incidents";
import { stripIntervalMs } from "../../shared/incidents";

export { stripIntervalMs } from "../../shared/incidents";

export const MAX_STRIP_BARS = 120;
/** Component lanes drawn beside the main lane (the JSON mapping's cap). */
export const MAX_STRIP_SIDE_LANES = 24;

const HOUR_MS = 3_600_000;
const MIN_RANGE_MS = HOUR_MS;
const MAX_RANGE_MS = 7 * 24 * HOUR_MS;

export const MARKER_LABELS: Record<StripMarkerKind, string> = {
  detected: "Detected",
  "sent-back": "Sent back",
  "fix-ready": "Fix ready",
  released: "Released",
  deploy: "Deploy",
  "rolled-back": "Rolled back",
  resolved: "Resolved",
  reopened: "Reopened",
};

const RANK: Record<ObservationResult, number> = { ok: 1, unknown: 2, fail: 3 };

/** The interval, multiplied up so the range fits in {@link MAX_STRIP_BARS}. */
export function stripBucketMs(
  intervalMs: number,
  from: number,
  to: number,
): number {
  return (
    intervalMs *
    Math.max(1, Math.ceil((to - from) / (intervalMs * MAX_STRIP_BARS)))
  );
}

export function defaultStripRange(
  signal: Signal,
  now: number,
): { from: number; to: number } {
  const span = Math.min(
    MAX_RANGE_MS,
    Math.max(MIN_RANGE_MS, MAX_STRIP_BARS * stripIntervalMs(signal)),
  );
  return { from: now - span, to: now };
}

function emptyBars(firstStart: number, count: number, bucketMs: number) {
  return Array.from({ length: count }, (_, i): StripBar => {
    const start = firstStart + i * bucketMs;
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + bucketMs).toISOString(),
      result: null,
      count: 0,
    };
  });
}

function addToBar(
  bar: StripBar,
  observation: Observation,
  valueWorst: "max" | "min",
): void {
  bar.count++;
  const rank = RANK[observation.result];
  const current = bar.sample;
  if (
    !current ||
    rank > RANK[current.result] ||
    (rank === RANK[current.result] && observation.at >= current.at)
  )
    bar.sample = observation;
  if (!bar.result || rank > RANK[bar.result]) bar.result = observation.result;
  if (typeof observation.value === "number") {
    if (bar.value === undefined) bar.value = observation.value;
    else
      bar.value =
        valueWorst === "min"
          ? Math.min(bar.value, observation.value)
          : Math.max(bar.value, observation.value);
  }
}

export interface StripRange {
  signalId: string;
  label: string;
  from: number;
  to: number;
  bucketMs: number;
  valueWorst?: "max" | "min";
}

/**
 * A strip built one observation at a time, so a caller can stream a long
 * range into it. Bars end at `to`: bar 0 is the oldest and the last bar also
 * includes `to` itself. The main lane always comes first, then one lane per
 * component name (at most {@link MAX_STRIP_SIDE_LANES}, first seen first
 * kept), sorted by name. Throws a RangeError for a range or bucket size that
 * is not finite and positive, or that needs more than {@link MAX_STRIP_BARS}
 * bars.
 */
export function createStripBucketer(input: StripRange): {
  add(observation: Observation): void;
  lanes(): StripLane[];
} {
  const { signalId, label, from, to, bucketMs } = input;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0)
    throw new RangeError("Bucket size must be a positive number");
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new RangeError("A strip needs a finite range");
  const valueWorst = input.valueWorst ?? "max";
  const count = Math.max(1, Math.ceil((to - from) / bucketMs));
  if (count > MAX_STRIP_BARS)
    throw new RangeError(`A strip has at most ${MAX_STRIP_BARS} bars`);
  const firstStart = to - count * bucketMs;
  const main: StripLane = {
    id: signalId,
    signalId,
    label,
    bars: emptyBars(firstStart, count, bucketMs),
  };
  const sides = new Map<string, StripLane>();
  return {
    add(observation) {
      const at = Date.parse(observation.at);
      if (!Number.isFinite(at) || at < firstStart || at > to) return;
      let lane = main;
      if (observation.lane !== undefined) {
        let side = sides.get(observation.lane);
        if (!side) {
          if (sides.size >= MAX_STRIP_SIDE_LANES) return;
          side = {
            id: `${signalId}:${observation.lane}`,
            signalId,
            lane: observation.lane,
            label: observation.lane,
            bars: emptyBars(firstStart, count, bucketMs),
          };
          sides.set(observation.lane, side);
        }
        lane = side;
      }
      const index = Math.min(
        count - 1,
        Math.floor((at - firstStart) / bucketMs),
      );
      addToBar(lane.bars[index]!, observation, valueWorst);
    },
    lanes() {
      const sorted = [...sides.values()].sort((a, b) =>
        a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
      );
      return [main, ...sorted];
    },
  };
}

/** Bucket a list of observations into lanes; see {@link createStripBucketer}. */
export function bucketStrip(
  input: StripRange & { observations: Observation[] },
): StripLane[] {
  const bucketer = createStripBucketer(input);
  for (const observation of input.observations) bucketer.add(observation);
  return bucketer.lanes();
}

export function markersFromEvents(
  incidentId: string,
  events: IncidentEvent[],
  from: number,
  to: number,
): StripMarker[] {
  const out: StripMarker[] = [];
  for (const event of events) {
    if (!event.marker) continue;
    const at = Date.parse(event.at);
    if (!(at >= from && at <= to)) continue;
    out.push({
      at: event.at,
      kind: event.marker,
      label: MARKER_LABELS[event.marker],
      incidentId,
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
