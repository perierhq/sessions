/**
 * Quiet hours and the daily digest time for a person's supervisor inbox
 * (supervisor-inbox.ts, adrs/supervisor-and-leads.md section 5). Pure: every
 * function takes the instant it reasons about, so tests drive it with a fake
 * clock.
 *
 * Times are wall-clock `HH:MM` in the person's IANA time zone, compared the
 * way incident maintenance windows are (incidents/maintenance.ts): a window
 * is half-open [start, end) and one whose end is before its start crosses
 * midnight. A time zone that cannot be resolved falls back to UTC.
 *
 * The prefs also carry the owner's report style (supervisor-report-style.ts)
 * and when their background watch looks around (supervisor-watch.ts).
 */
import {
  DEFAULT_REPORT_STYLE,
  isReportStyle,
  REPORT_STYLES,
  type ReportStyle,
} from "./supervisor-report-style";

/** When the person's watch (supervisor-watch.ts) wakes on its schedule. */
export interface WatchPrefs {
  /** The watch runs at all. Off: nothing wakes it, events included. */
  enabled: boolean;
  /** Minutes between scheduled wakes inside the active hours. */
  everyMinutes: number;
  /** Start of the active hours, `HH:MM` local. */
  activeStart: string;
  /** End of the active hours, `HH:MM` local. Equal to the start: all day. */
  activeEnd: string;
}

export const WATCH_EVERY_MIN = 10;
export const WATCH_EVERY_MAX = 240;

export const DEFAULT_WATCH_PREFS: WatchPrefs = {
  enabled: true,
  everyMinutes: 30,
  activeStart: "08:00",
  activeEnd: "22:00",
};

export interface SupervisorPrefs {
  /** Start of quiet hours, `HH:MM` local. Equal to `quietEnd`: no quiet. */
  quietStart: string;
  /** End of quiet hours, `HH:MM` local. */
  quietEnd: string;
  /** When the daily digest goes out, `HH:MM` local. */
  digestAt: string;
  /** IANA time zone. Empty: the person's profile time zone. */
  timezone: string;
  /** The shape of the supervisor's replies and the leads' proposals. */
  reportStyle: ReportStyle;
  /** The background watch's schedule. */
  watch: WatchPrefs;
}

/** A prefs change from a client: every field optional, `watch` too. */
export type SupervisorPrefsPatch = Partial<Omit<SupervisorPrefs, "watch">> & {
  watch?: Partial<WatchPrefs>;
};

export const DEFAULT_SUPERVISOR_PREFS: SupervisorPrefs = {
  quietStart: "02:00",
  quietEnd: "08:00",
  digestAt: "09:00",
  timezone: "",
  reportStyle: DEFAULT_REPORT_STYLE,
  watch: DEFAULT_WATCH_PREFS,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && HHMM.test(value);
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function minutesOf(hhmm: string): number {
  const match = HHMM.exec(hhmm);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

const FORMATTERS_MAX = 100;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size >= FORMATTERS_MAX) formatters.clear();
    formatters.set(timeZone, found);
  }
  return found;
}

/** The local calendar day (`YYYY-MM-DD`) and minute of the day at `at`. */
export function localClock(
  at: number,
  timeZone: string,
): { day: string; minutes: number } {
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(at))
    parts[part.type] = part.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/** The calendar day before `day` (`YYYY-MM-DD`). */
export function previousDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! - 1))
    .toISOString()
    .slice(0, 10);
}

/** Whether local `minutes` fall in the half-open window [start, end),
 *  which crosses midnight when its end is before its start. */
function inWindow(minutes: number, start: number, end: number): boolean {
  return end > start
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/** Whether quiet hours are on at `at`. */
export function inQuietHours(
  prefs: Pick<SupervisorPrefs, "quietStart" | "quietEnd">,
  timeZone: string,
  at: number,
): boolean {
  const start = minutesOf(prefs.quietStart);
  const end = minutesOf(prefs.quietEnd);
  if (start === end) return false;
  return inWindow(localClock(at, timeZone).minutes, start, end);
}

/** Whether the watch's active hours are on at `at`. Equal start and end
 *  mean all day. */
export function inActiveHours(
  watch: Pick<WatchPrefs, "activeStart" | "activeEnd">,
  timeZone: string,
  at: number,
): boolean {
  const start = minutesOf(watch.activeStart);
  const end = minutesOf(watch.activeEnd);
  if (start === end) return true;
  return inWindow(localClock(at, timeZone).minutes, start, end);
}

/** Minutes from `at` until the local clock next reads `hhmm`: 1 to a day. */
function minutesUntil(hhmm: string, timeZone: string, at: number): number {
  const { minutes } = localClock(at, timeZone);
  return (minutesOf(hhmm) - minutes + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
}

/** The next local midnight after `at`, to the minute. */
export function nextLocalMidnight(timeZone: string, at: number): number {
  return (
    Math.floor(at / MINUTE_MS) * MINUTE_MS +
    minutesUntil("00:00", timeZone, at) * MINUTE_MS
  );
}

/** Whether a scheduled watch wake may run at `at`: inside the active
 *  hours and outside quiet hours. */
export function watchScheduleOpen(
  prefs: Pick<SupervisorPrefs, "quietStart" | "quietEnd" | "watch">,
  timeZone: string,
  at: number,
): boolean {
  return (
    inActiveHours(prefs.watch, timeZone, at) &&
    !inQuietHours(prefs, timeZone, at)
  );
}

/**
 * The watch's next scheduled wake after `at`: `everyMinutes` on when that
 * falls inside the active hours and outside quiet hours, else the next
 * time both hold (the active hours' start, or the end of quiet hours inside
 * them), to the minute. Never during the night. Across a daylight saving
 * change it can be an hour out; the wake check looks again before it runs.
 */
export function nextWatchWake(
  prefs: Pick<SupervisorPrefs, "quietStart" | "quietEnd" | "watch">,
  timeZone: string,
  at: number,
): number {
  const floor = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const step = floor + prefs.watch.everyMinutes * MINUTE_MS;
  if (watchScheduleOpen(prefs, timeZone, step)) return step;
  // The candidates: the next start of the active hours and the next end
  // of quiet hours. The earliest one where both hold wins; one of the two
  // always does, unless quiet hours cover the active hours whole.
  const candidates = [
    floor + minutesUntil(prefs.watch.activeStart, timeZone, at) * MINUTE_MS,
    floor + minutesUntil(prefs.quietEnd, timeZone, at) * MINUTE_MS,
  ].sort((a, b) => a - b);
  for (const candidate of candidates)
    if (watchScheduleOpen(prefs, timeZone, candidate)) return candidate;
  // Never open (quiet hours cover the active hours): look again in a day.
  return floor + DAY_MINUTES * MINUTE_MS;
}

/**
 * When the quiet hours on at `at` end, to the minute. Across a daylight
 * saving change the estimate can be an hour out either way; callers still
 * check `inQuietHours` before acting, so an early estimate only waits.
 */
export function quietHoursEnd(
  prefs: SupervisorPrefs,
  timeZone: string,
  at: number,
): number {
  const { minutes } = localClock(at, timeZone);
  const ahead =
    (minutesOf(prefs.quietEnd) - minutes + DAY_MINUTES) % DAY_MINUTES ||
    DAY_MINUTES;
  return Math.floor(at / MINUTE_MS) * MINUTE_MS + ahead * MINUTE_MS;
}

/**
 * The digest day due at `at`, or null. Each local day has one digest at
 * `digestAt`; once that time has passed the day is due until a digest for it
 * (or a later day) ran, so a missed day sends one digest, not several. Never during quiet hours: a digest that falls in them
 * waits for their end, even past midnight.
 */
export function digestDayDue(
  prefs: SupervisorPrefs,
  timeZone: string,
  at: number,
  lastDigestDay: string | undefined,
): string | null {
  if (inQuietHours(prefs, timeZone, at)) return null;
  const { day, minutes } = localClock(at, timeZone);
  const scheduled =
    minutes >= minutesOf(prefs.digestAt) ? day : previousDay(day);
  // A person with no digest yet waits for their first digest time.
  if (!lastDigestDay) return scheduled === day ? day : null;
  return lastDigestDay < scheduled ? scheduled : null;
}

/** Stored prefs with defaults filled in; anything invalid is the default. */
export function cleanPrefs(value: unknown): SupervisorPrefs {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    quietStart: isClockTime(raw.quietStart)
      ? raw.quietStart
      : DEFAULT_SUPERVISOR_PREFS.quietStart,
    quietEnd: isClockTime(raw.quietEnd)
      ? raw.quietEnd
      : DEFAULT_SUPERVISOR_PREFS.quietEnd,
    digestAt: isClockTime(raw.digestAt)
      ? raw.digestAt
      : DEFAULT_SUPERVISOR_PREFS.digestAt,
    timezone: isTimeZone(raw.timezone) ? raw.timezone : "",
    reportStyle: isReportStyle(raw.reportStyle)
      ? raw.reportStyle
      : DEFAULT_REPORT_STYLE,
    watch: cleanWatchPrefs(raw.watch),
  };
}

function isEveryMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= WATCH_EVERY_MIN &&
    value <= WATCH_EVERY_MAX
  );
}

/** Stored watch prefs with defaults filled in. */
export function cleanWatchPrefs(value: unknown): WatchPrefs {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled:
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : DEFAULT_WATCH_PREFS.enabled,
    everyMinutes: isEveryMinutes(raw.everyMinutes)
      ? raw.everyMinutes
      : DEFAULT_WATCH_PREFS.everyMinutes,
    activeStart: isClockTime(raw.activeStart)
      ? raw.activeStart
      : DEFAULT_WATCH_PREFS.activeStart,
    activeEnd: isClockTime(raw.activeEnd)
      ? raw.activeEnd
      : DEFAULT_WATCH_PREFS.activeEnd,
  };
}

/** Validate a watch prefs patch from a client. */
function validateWatchPatch(
  value: unknown,
): Partial<WatchPrefs> | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "watch must be an object" };
  const raw = value as Record<string, unknown>;
  const patch: Partial<WatchPrefs> = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean")
      return { error: "watch.enabled must be true or false" };
    patch.enabled = raw.enabled;
  }
  if (raw.everyMinutes !== undefined) {
    if (!isEveryMinutes(raw.everyMinutes))
      return {
        error: `watch.everyMinutes must be a whole number from ${WATCH_EVERY_MIN} to ${WATCH_EVERY_MAX}`,
      };
    patch.everyMinutes = raw.everyMinutes;
  }
  for (const key of ["activeStart", "activeEnd"] as const) {
    if (raw[key] === undefined) continue;
    if (!isClockTime(raw[key])) return { error: `watch.${key} must be HH:MM` };
    patch[key] = raw[key];
  }
  return patch;
}

/** Validate a prefs patch from a client. */
export function validatePrefsPatch(
  value: unknown,
): SupervisorPrefsPatch | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "prefs must be an object" };
  const raw = value as Record<string, unknown>;
  const patch: SupervisorPrefsPatch = {};
  for (const key of ["quietStart", "quietEnd", "digestAt"] as const) {
    if (raw[key] === undefined) continue;
    if (!isClockTime(raw[key])) return { error: `${key} must be HH:MM` };
    patch[key] = raw[key];
  }
  if (raw.timezone !== undefined) {
    if (raw.timezone !== "" && !isTimeZone(raw.timezone))
      return { error: "unknown time zone" };
    patch.timezone = raw.timezone as string;
  }
  if (raw.reportStyle !== undefined) {
    if (!isReportStyle(raw.reportStyle))
      return {
        error: `reportStyle must be one of ${REPORT_STYLES.join(", ")}`,
      };
    patch.reportStyle = raw.reportStyle;
  }
  if (raw.watch !== undefined) {
    const watch = validateWatchPatch(raw.watch);
    if ("error" in watch) return watch;
    patch.watch = watch;
  }
  return patch;
}
