// What the incidents home lists: past incidents and their row text,
// heads-ups, where a signal row leads, and the mini signal's bars. Pure.
import {
  type IncidentSummary,
  isOpenIncident,
  type SignalView,
  type StripResponse,
  stripIntervalMs,
} from "../../../shared/incidents";
import type { BarSpec } from "../../ui/bar-strip";
import { dayMonth, FIXED_BY_LABEL, formatSpan, formatUsd } from "./copy";
import { laneMetaFor } from "./page-model";
import { laneKindFor, miniRange } from "./signal-summary";
import { layoutStrip } from "./strip-layout";

/** The mini signal's box on a desktop row. */
export const MINI_WIDTH = 160;
export const MINI_HEIGHT = 20;
/** Past incidents shown per page. */
export const PAST_PAGE = 20;

const newestFirst = (a: IncidentSummary, b: IncidentSummary) =>
  b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id);

/** Resolved incidents, newest first. Heads-ups that closed on their own are
 *  noise here. */
export function pastIncidents(all: IncidentSummary[]): IncidentSummary[] {
  return all.filter((i) => i.state === "resolved").sort(newestFirst);
}

/** Open heads-up incidents, newest first. */
export function headsUps(all: IncidentSummary[]): IncidentSummary[] {
  return all.filter((i) => i.state === "heads-up").sort(newestFirst);
}

let yearFormat: Intl.DateTimeFormat | undefined;

/** "20 Oct", with the year when it is not this year. */
function shortDate(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  if (d.getFullYear() === new Date(now).getFullYear()) return dayMonth(iso);
  return (yearFormat ??= new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })).format(d);
}

export interface PastIncidentRow {
  title: string;
  fixedBy: string;
  cost: string;
  date: string;
}

export function pastIncidentRow(
  i: IncidentSummary,
  now: number,
): PastIncidentRow {
  const how = i.fixedBy ? FIXED_BY_LABEL[i.fixedBy] : "Fixed";
  const fixedBy = i.closedAt
    ? `${how} · ${formatSpan(Date.parse(i.closedAt) - Date.parse(i.openedAt))}`
    : how;
  return {
    title: i.title,
    fixedBy,
    cost: i.response ? formatUsd(i.response.costUsd) : "—",
    date: shortDate(i.openedAt, now),
  };
}

/** How many more rows `Show <n> more` adds; 0 once all are shown. */
export function showMoreCount(total: number, shown: number): number {
  return Math.max(0, Math.min(PAST_PAGE, total - shown));
}

export type SignalTarget = { kind: "incident"; id: string } | { kind: "edit" };

/** A signal row opens the newest open incident holding the signal, else the
 *  signal's editor. */
export function signalTarget(
  signal: Pick<SignalView, "id">,
  open: IncidentSummary[],
): SignalTarget {
  const hit = open
    .filter((i) => isOpenIncident(i) && i.signalIds.includes(signal.id))
    .sort(newestFirst)[0];
  return hit ? { kind: "incident", id: hit.id } : { kind: "edit" };
}

/**
 * The mini signal's bars: the strip's first lane drawn as the full strip
 * draws it, without markers or a live edge. While the strip loads, the same
 * number of empty bars; an expiry signal draws none (its value says it all).
 */
export function miniBars(
  signal: SignalView,
  strip: StripResponse | undefined,
): BarSpec[] {
  if (laneKindFor(signal) === "days") return [];
  if (!strip?.lanes.length) {
    const range = miniRange(signal, 0);
    const span = Date.parse(range.to) - Date.parse(range.from);
    const interval =
      signal.source.kind === "webhook" ? 60_000 : stripIntervalMs(signal);
    const count = Math.max(1, Math.round(span / interval));
    return Array.from({ length: count }, (_, i) => ({
      key: `${signal.id}:loading:${i}`,
      tone: "empty",
      height: 0,
      label: "",
    }));
  }
  const first = { ...strip, lanes: strip.lanes.slice(0, 1), markers: [] };
  const layout = layoutStrip({
    strip: first,
    meta: laneMetaFor([signal]),
    width: MINI_WIDTH,
    live: false,
  });
  return layout.lanes[0]?.bars ?? [];
}
