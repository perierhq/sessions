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
 * The prefs also carry the owner's report style (supervisor-report-style.ts).
 */
import {
  DEFAULT_REPORT_STYLE,
  isReportStyle,
  REPORT_STYLES,
  type ReportStyle,
} from "./supervisor-report-style";

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
}

export const DEFAULT_SUPERVISOR_PREFS: SupervisorPrefs = {
  quietStart: "02:00",
  quietEnd: "08:00",
  digestAt: "09:00",
  timezone: "",
  reportStyle: DEFAULT_REPORT_STYLE,
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

/** Whether quiet hours are on at `at`. */
export function inQuietHours(
  prefs: SupervisorPrefs,
  timeZone: string,
  at: number,
): boolean {
  const start = minutesOf(prefs.quietStart);
  const end = minutesOf(prefs.quietEnd);
  if (start === end) return false;
  const { minutes } = localClock(at, timeZone);
  return end > start
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
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
  };
}

/** Validate a prefs patch from a client. */
export function validatePrefsPatch(
  value: unknown,
): Partial<SupervisorPrefs> | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "prefs must be an object" };
  const raw = value as Record<string, unknown>;
  const patch: Partial<SupervisorPrefs> = {};
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
  return patch;
}
