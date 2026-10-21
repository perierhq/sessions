// Wall times of day ("23:00") for night rules and maintenance windows: a
// clock reading with no date and no zone of its own. Pure.

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

let wallFormat: Intl.DateTimeFormat | undefined;

/** `HH:MM`, 00:00 to 23:59. */
export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

/** The locale's clock text for a wall time ("23:00", "11:00 PM"). Anything
 *  that is not `HH:MM` comes back as it is. */
export function formatTimeOfDay(hhmm: string): string {
  if (!isTimeOfDay(hhmm)) return hhmm;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));
  // A fixed UTC date, formatted in UTC: the reading never moves with the
  // viewer's zone or a daylight-saving jump.
  return (wallFormat ??= new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  })).format(Date.UTC(2000, 0, 1, h, m));
}

/** The viewer's own zone, or UTC when the platform does not say. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

let zones: string[] | undefined;

/** Every IANA zone the platform knows, with `extra` (a stored zone the
 *  platform no longer lists) kept so a saved value always has its option. */
export function timeZoneOptions(extra: string): string[] {
  zones ??= Intl.supportedValuesOf("timeZone");
  return zones.includes(extra) ? zones : [extra, ...zones];
}
