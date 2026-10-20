// Maintenance windows: half-open [start, end). `once` compares instants;
// `weekly` compares wall-clock time in its IANA time zone, so a window inside
// a skipped DST hour does not happen that day and a repeated hour matches
// twice. A weekly window crossing midnight belongs to its start day.
import type { MaintenanceWindow } from "../../shared/incidents";

export const MAX_MAINTENANCE_WINDOWS = 20;
const MAX_NOTE = 200;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const FORMATTERS_MAX = 100;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size >= FORMATTERS_MAX) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

function localDayAndMinutes(
  at: number,
  timeZone: string,
): { day: number; minutes: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter(timeZone).formatToParts(at);
  } catch {
    return null;
  }
  let day = -1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "weekday") day = WEEKDAYS[part.value] ?? -1;
    else if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
  }
  if (day < 0) return null;
  return { day, minutes: hour * 60 + minute };
}

function toMinutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function windowActive(window: MaintenanceWindow, at: number): boolean {
  if (window.kind === "once") {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    return at >= start && at < end;
  }
  const local = localDayAndMinutes(at, window.timeZone);
  if (!local) return false;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  if (end > start)
    return (
      window.days.includes(local.day) &&
      local.minutes >= start &&
      local.minutes < end
    );
  if (end < start) {
    const previous = (local.day + 6) % 7;
    return (
      (window.days.includes(local.day) && local.minutes >= start) ||
      (window.days.includes(previous) && local.minutes < end)
    );
  }
  return false;
}

export function activeMaintenance(
  windows: MaintenanceWindow[] | undefined,
  at: number,
): MaintenanceWindow | null {
  if (!windows?.length) return null;
  for (const window of windows) if (windowActive(window, at)) return window;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function validateNote(
  note: unknown,
  label: string,
): string | undefined | { error: string } {
  if (note === undefined || note === null || note === "") return undefined;
  if (typeof note !== "string") return { error: `${label}: note must be text` };
  if (note.length > MAX_NOTE)
    return { error: `${label}: note is longer than ${MAX_NOTE} characters` };
  return note;
}

function validateWindow(
  value: unknown,
  index: number,
): MaintenanceWindow | { error: string } {
  const label = `Maintenance window ${index + 1}`;
  if (!isRecord(value)) return { error: `${label} must be an object` };
  const note = validateNote(value.note, label);
  if (typeof note === "object") return note;
  if (value.kind === "once") {
    const start =
      typeof value.start === "string" ? Date.parse(value.start) : NaN;
    const end = typeof value.end === "string" ? Date.parse(value.end) : NaN;
    if (Number.isNaN(start) || Number.isNaN(end))
      return { error: `${label}: start and end must be dates` };
    if (end <= start) return { error: `${label}: end must be after start` };
    const window: MaintenanceWindow = {
      kind: "once",
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
    if (note) window.note = note;
    return window;
  }
  if (value.kind === "weekly") {
    const { start, end, days, timeZone } = value;
    if (
      typeof start !== "string" ||
      !HHMM.test(start) ||
      typeof end !== "string" ||
      !HHMM.test(end)
    )
      return { error: `${label}: start and end must be HH:MM` };
    if (start === end) return { error: `${label}: start and end must differ` };
    if (
      !Array.isArray(days) ||
      days.length < 1 ||
      days.length > 7 ||
      !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ||
      new Set(days).size !== days.length
    )
      return {
        error: `${label}: days must be 1 to 7 different weekdays, 0 = Sunday`,
      };
    if (
      typeof timeZone !== "string" ||
      !timeZone.trim() ||
      !validTimeZone(timeZone)
    )
      return { error: `${label}: unknown time zone` };
    const window: MaintenanceWindow = {
      kind: "weekly",
      days: [...(days as number[])],
      start,
      end,
      timeZone,
    };
    if (note) window.note = note;
    return window;
  }
  return { error: `${label}: kind must be "once" or "weekly"` };
}

export function validateMaintenanceWindows(
  value: unknown,
): MaintenanceWindow[] | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    return { error: "Maintenance must be a list of windows" };
  if (!value.length) return undefined;
  if (value.length > MAX_MAINTENANCE_WINDOWS)
    return { error: `At most ${MAX_MAINTENANCE_WINDOWS} maintenance windows` };
  const out: MaintenanceWindow[] = [];
  for (const [index, item] of value.entries()) {
    const window = validateWindow(item, index);
    if ("error" in window) return window;
    out.push(window);
  }
  return out;
}
