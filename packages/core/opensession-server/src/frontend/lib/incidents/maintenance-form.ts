// Maintenance windows in the settings: how a window reads, what is wrong
// with one before the server refuses it (mirrors server
// incidents/maintenance.ts), datetime-local conversion, new windows, and
// the project view that groups identical windows across signals. Pure.
import type { MaintenanceWindow, SignalView } from "../../../shared/incidents";
import { formatTimeOfDay, isTimeOfDay } from "../time-of-day";

/** Server MAX_MAINTENANCE_WINDOWS, per signal. */
export const MAX_WINDOWS = 20;
export const MAX_NOTE = 200;

/** Days as a week reads them, Monday first; values are the server's (0 is
 *  Sunday). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** English fallbacks, by server day number. */
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const HOUR_MS = 3_600_000;

let weekdayFormat: Intl.DateTimeFormat | undefined;
let dateTimeFormat: Intl.DateTimeFormat | undefined;
let timeFormat: Intl.DateTimeFormat | undefined;

/** The locale's short weekday for a server day number (0 = Sunday). */
export function dayLabel(day: number): string {
  try {
    weekdayFormat ??= new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: "UTC",
    });
    // 2 Jan 2000 was a Sunday.
    return weekdayFormat.format(Date.UTC(2000, 0, 2 + day));
  } catch {
    return DAY_LABELS[day] ?? String(day);
  }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `Weekly · Mon, Tue · 22:00–02:00 next day · Europe/Warsaw`, or
 *  `Once · 20 Oct 2026, 12:00–13:00`. */
export function describeWindow(w: MaintenanceWindow): string {
  if (w.kind === "weekly") {
    const days = WEEK_ORDER.filter((day) => w.days.includes(day))
      .map(dayLabel)
      .join(", ");
    const next = w.end < w.start ? " next day" : "";
    return `Weekly · ${days} · ${formatTimeOfDay(w.start)}–${formatTimeOfDay(w.end)}${next} · ${w.timeZone}`;
  }
  const start = new Date(w.start);
  const end = new Date(w.end);
  if (Number.isNaN(+start) || Number.isNaN(+end)) return "Once";
  dateTimeFormat ??= new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  timeFormat ??= new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  const until = sameLocalDay(start, end)
    ? timeFormat.format(end)
    : dateTimeFormat.format(end);
  return `Once · ${dateTimeFormat.format(start)}–${until}`;
}

/** What is wrong with a window, in the words the field under it shows. */
export function windowProblem(w: MaintenanceWindow): string | null {
  if (w.kind === "weekly") {
    if (!isTimeOfDay(w.start) || !isTimeOfDay(w.end))
      return "Use a time like 23:00";
    if (w.start === w.end) return "Pick two different times";
    if (!w.days.length) return "Pick at least one day";
    return null;
  }
  const start = Date.parse(w.start);
  const end = Date.parse(w.end);
  if (Number.isNaN(start) || Number.isNaN(end))
    return "Pick a start and an end";
  if (start === end) return "Pick two different times";
  if (end < start) return "The end must be after the start";
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as a `datetime-local` value, in the viewer's zone. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` value (viewer's zone) as an ISO instant; "" when
 *  empty or invalid. */
export function localInputToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(+d) ? "" : d.toISOString();
}

export function newWeeklyWindow(timeZone: string): MaintenanceWindow {
  return { kind: "weekly", days: [0], start: "02:00", end: "03:00", timeZone };
}

/** The next whole hour, one hour long. */
export function newOnceWindow(now: number): MaintenanceWindow {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  return {
    kind: "once",
    start: new Date(start).toISOString(),
    end: new Date(start + HOUR_MS).toISOString(),
  };
}

const windowKey = (w: MaintenanceWindow) =>
  JSON.stringify(
    w.kind === "weekly"
      ? [w.kind, [...w.days].sort(), w.start, w.end, w.timeZone, w.note ?? ""]
      : [w.kind, w.start, w.end, w.note ?? ""],
  );

export interface ProjectWindow {
  window: MaintenanceWindow;
  signalIds: string[];
}

/** Every window of the project's signals, identical ones merged, in the
 *  order they first appear. */
export function projectWindows(signals: SignalView[]): ProjectWindow[] {
  const groups = new Map<string, ProjectWindow>();
  for (const signal of signals)
    for (const window of signal.maintenance ?? []) {
      const key = windowKey(window);
      const group = groups.get(key);
      if (!group) groups.set(key, { window, signalIds: [signal.id] });
      else if (!group.signalIds.includes(signal.id))
        group.signalIds.push(signal.id);
    }
  return [...groups.values()];
}

/** Each signal's windows as the edited groups give them, in group order. */
export function signalWindows(
  signals: SignalView[],
  groups: ProjectWindow[],
): Array<{ id: string; name: string; maintenance: MaintenanceWindow[] }> {
  return signals.map((signal) => ({
    id: signal.id,
    name: signal.name,
    maintenance: groups
      .filter((group) => group.signalIds.includes(signal.id))
      .map((group) => group.window),
  }));
}

/** The signal's windows changed: compared by what they say, not identity. */
export function windowsChanged(
  before: MaintenanceWindow[] | undefined,
  after: MaintenanceWindow[],
): boolean {
  const a = (before ?? []).map(windowKey);
  const b = after.map(windowKey);
  return a.length !== b.length || a.some((key, i) => key !== b[i]);
}
