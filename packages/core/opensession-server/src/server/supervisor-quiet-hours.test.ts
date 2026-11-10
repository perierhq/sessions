/**
 * Quiet hours and digest timing for the supervisor inbox: wall-clock windows
 * in the person's time zone, across midnight and daylight saving changes.
 */
import { describe, expect, test } from "bun:test";
import {
  cleanPrefs,
  DEFAULT_SUPERVISOR_PREFS,
  digestDayDue,
  inActiveHours,
  inQuietHours,
  localClock,
  nextLocalMidnight,
  nextWatchWake,
  previousDay,
  quietHoursEnd,
  validatePrefsPatch,
  type SupervisorPrefs,
} from "./supervisor-quiet-hours";

const at = (iso: string) => Date.parse(iso);
const prefs = (patch: Partial<SupervisorPrefs> = {}): SupervisorPrefs => ({
  ...DEFAULT_SUPERVISOR_PREFS,
  ...patch,
});

describe("localClock", () => {
  test("reads the day and minute in the zone", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Warsaw (UTC+1 in winter).
    expect(localClock(at("2026-12-31T23:30:00Z"), "Europe/Warsaw")).toEqual({
      day: "2027-01-01",
      minutes: 30,
    });
    expect(localClock(at("2026-07-01T06:15:00Z"), "America/New_York")).toEqual({
      day: "2026-07-01",
      minutes: 2 * 60 + 15,
    });
  });

  test("an unknown zone reads as UTC", () => {
    expect(localClock(at("2026-07-01T06:15:00Z"), "Mars/Olympus")).toEqual({
      day: "2026-07-01",
      minutes: 6 * 60 + 15,
    });
  });

  test("previousDay crosses months and years", () => {
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(previousDay("2028-03-01")).toBe("2028-02-29");
  });
});

describe("quiet hours", () => {
  test("default 02:00 to 08:00 local, half-open", () => {
    const zone = "Europe/Warsaw"; // UTC+2 in summer
    expect(inQuietHours(prefs(), zone, at("2026-07-01T23:59:00Z"))).toBe(false);
    expect(inQuietHours(prefs(), zone, at("2026-07-02T00:00:00Z"))).toBe(true);
    expect(inQuietHours(prefs(), zone, at("2026-07-02T05:59:00Z"))).toBe(true);
    expect(inQuietHours(prefs(), zone, at("2026-07-02T06:00:00Z"))).toBe(false);
  });

  test("a window across midnight", () => {
    const night = prefs({ quietStart: "22:00", quietEnd: "07:00" });
    expect(inQuietHours(night, "UTC", at("2026-07-01T21:59:00Z"))).toBe(false);
    expect(inQuietHours(night, "UTC", at("2026-07-01T22:00:00Z"))).toBe(true);
    expect(inQuietHours(night, "UTC", at("2026-07-02T03:00:00Z"))).toBe(true);
    expect(inQuietHours(night, "UTC", at("2026-07-02T07:00:00Z"))).toBe(false);
  });

  test("equal start and end means no quiet hours", () => {
    const none = prefs({ quietStart: "05:00", quietEnd: "05:00" });
    expect(inQuietHours(none, "UTC", at("2026-07-01T05:00:00Z"))).toBe(false);
  });

  test("the end of quiet hours in the person's zone", () => {
    // 03:10 local in New York (UTC-4 in summer) ends at 08:00 local, 12:00 UTC.
    expect(
      quietHoursEnd(prefs(), "America/New_York", at("2026-07-01T07:10:30Z")),
    ).toBe(at("2026-07-01T12:00:00Z"));
    const night = prefs({ quietStart: "22:00", quietEnd: "07:00" });
    expect(quietHoursEnd(night, "UTC", at("2026-07-01T23:00:00Z"))).toBe(
      at("2026-07-02T07:00:00Z"),
    );
  });

  test("across a daylight saving change the estimate is checked, not trusted", () => {
    // Europe/Warsaw springs forward at 02:00 local on 29 March 2026; 02:30
    // local does not exist and 03:30 local is 01:30 UTC.
    const zone = "Europe/Warsaw";
    const now = at("2026-03-29T01:30:00Z");
    expect(inQuietHours(prefs(), zone, now)).toBe(true);
    const end = quietHoursEnd(prefs(), zone, now);
    // Real end: 08:00 local = 06:00 UTC. The estimate may be an hour out,
    // and is never past quiet hours by more than that.
    expect(Math.abs(end - at("2026-03-29T06:00:00Z"))).toBeLessThanOrEqual(
      3_600_000,
    );
    expect(inQuietHours(prefs(), zone, at("2026-03-29T06:00:00Z"))).toBe(false);
  });
});

describe("digestDayDue", () => {
  const zone = "UTC";
  test("due once the digest time passed, once per day", () => {
    expect(
      digestDayDue(prefs(), zone, at("2026-07-01T08:59:00Z"), "2026-06-30"),
    ).toBeNull();
    expect(
      digestDayDue(prefs(), zone, at("2026-07-01T09:00:00Z"), "2026-06-30"),
    ).toBe("2026-07-01");
    expect(
      digestDayDue(prefs(), zone, at("2026-07-01T20:00:00Z"), "2026-07-01"),
    ).toBeNull();
  });

  test("a first digest waits for the digest time", () => {
    expect(
      digestDayDue(prefs(), zone, at("2026-07-01T08:30:00Z"), undefined),
    ).toBeNull();
    expect(
      digestDayDue(prefs(), zone, at("2026-07-01T09:30:00Z"), undefined),
    ).toBe("2026-07-01");
  });

  test("never in quiet hours; a digest inside them waits for their end", () => {
    const early = prefs({ digestAt: "03:00" });
    expect(
      digestDayDue(early, zone, at("2026-07-01T03:00:00Z"), "2026-06-30"),
    ).toBeNull();
    expect(
      digestDayDue(early, zone, at("2026-07-01T08:00:00Z"), "2026-06-30"),
    ).toBe("2026-07-01");
  });

  test("a digest inside quiet hours across midnight still goes out once", () => {
    const late = prefs({
      quietStart: "23:00",
      quietEnd: "07:00",
      digestAt: "23:30",
    });
    expect(
      digestDayDue(late, zone, at("2026-07-01T23:30:00Z"), "2026-06-30"),
    ).toBeNull();
    // After the night the missed day is due, once.
    expect(
      digestDayDue(late, zone, at("2026-07-02T07:00:00Z"), "2026-06-30"),
    ).toBe("2026-07-01");
    expect(
      digestDayDue(late, zone, at("2026-07-02T12:00:00Z"), "2026-07-01"),
    ).toBeNull();
  });

  test("a missed week sends one digest", () => {
    expect(
      digestDayDue(prefs(), zone, at("2026-07-08T10:00:00Z"), "2026-07-01"),
    ).toBe("2026-07-08");
  });
});

describe("prefs", () => {
  test("invalid stored values read as the defaults", () => {
    expect(
      cleanPrefs({
        quietStart: "25:00",
        digestAt: "7:00",
        timezone: "Nowhere",
      }),
    ).toEqual(DEFAULT_SUPERVISOR_PREFS);
    expect(cleanPrefs({ timezone: "Europe/Warsaw" }).timezone).toBe(
      "Europe/Warsaw",
    );
  });

  test("a patch is validated", () => {
    expect(validatePrefsPatch({ quietStart: "23:00" })).toEqual({
      quietStart: "23:00",
    });
    expect(validatePrefsPatch({ digestAt: "9" })).toEqual({
      error: "digestAt must be HH:MM",
    });
    expect(validatePrefsPatch({ timezone: "Nowhere/Else" })).toEqual({
      error: "unknown time zone",
    });
    expect(validatePrefsPatch({ timezone: "" })).toEqual({ timezone: "" });
  });

  test("the report style defaults to BLUF and fails closed", () => {
    expect(DEFAULT_SUPERVISOR_PREFS.reportStyle).toBe("bluf");
    expect(cleanPrefs({ reportStyle: "sbar" }).reportStyle).toBe("sbar");
    expect(cleanPrefs({ reportStyle: "plain" }).reportStyle).toBe("plain");
    expect(cleanPrefs({ reportStyle: "memo" }).reportStyle).toBe("bluf");
    expect(cleanPrefs({}).reportStyle).toBe("bluf");
    expect(validatePrefsPatch({ reportStyle: "plain" })).toEqual({
      reportStyle: "plain",
    });
    for (const reportStyle of ["SBAR", "memo", "", 1, null])
      expect(validatePrefsPatch({ reportStyle })).toEqual({
        error: "reportStyle must be one of bluf, sbar, plain",
      });
  });
});

describe("the watch's schedule", () => {
  const watch = (patch: Partial<SupervisorPrefs["watch"]> = {}) =>
    prefs({ watch: { ...DEFAULT_SUPERVISOR_PREFS.watch, ...patch } });

  test("defaults: on, every 30 minutes from 08:00 to 22:00", () => {
    expect(cleanPrefs({}).watch).toEqual({
      enabled: true,
      everyMinutes: 30,
      activeStart: "08:00",
      activeEnd: "22:00",
    });
    expect(
      cleanPrefs({
        watch: { enabled: "yes", everyMinutes: 3, activeStart: "8am" },
      }).watch,
    ).toEqual(DEFAULT_SUPERVISOR_PREFS.watch);
  });

  test("a watch patch is validated", () => {
    expect(
      validatePrefsPatch({ watch: { enabled: false, everyMinutes: 60 } }),
    ).toEqual({ watch: { enabled: false, everyMinutes: 60 } });
    expect(validatePrefsPatch({ watch: "on" })).toEqual({
      error: "watch must be an object",
    });
    expect(validatePrefsPatch({ watch: { enabled: 1 } })).toEqual({
      error: "watch.enabled must be true or false",
    });
    expect(validatePrefsPatch({ watch: { everyMinutes: 5 } })).toEqual({
      error: "watch.everyMinutes must be a whole number from 10 to 240",
    });
    expect(validatePrefsPatch({ watch: { activeEnd: "25:00" } })).toEqual({
      error: "watch.activeEnd must be HH:MM",
    });
  });

  test("active hours are half-open; equal ends mean all day", () => {
    const p = watch();
    expect(inActiveHours(p.watch, "UTC", at("2026-11-10T07:59:00Z"))).toBe(
      false,
    );
    expect(inActiveHours(p.watch, "UTC", at("2026-11-10T08:00:00Z"))).toBe(
      true,
    );
    expect(inActiveHours(p.watch, "UTC", at("2026-11-10T22:00:00Z"))).toBe(
      false,
    );
    const all = watch({ activeStart: "00:00", activeEnd: "00:00" }).watch;
    expect(inActiveHours(all, "UTC", at("2026-11-10T03:00:00Z"))).toBe(true);
  });

  test("every step inside the window, none at night", () => {
    const p = watch();
    expect(nextWatchWake(p, "UTC", at("2026-11-10T12:00:20Z"))).toBe(
      at("2026-11-10T12:30:00Z"),
    );
    // Past the end: the next morning's start.
    expect(nextWatchWake(p, "UTC", at("2026-11-10T21:45:00Z"))).toBe(
      at("2026-11-11T08:00:00Z"),
    );
    // In the owner's zone: 08:00 in Warsaw is 07:00 UTC in winter.
    expect(nextWatchWake(p, "Europe/Warsaw", at("2026-11-10T22:00:00Z"))).toBe(
      at("2026-11-11T07:00:00Z"),
    );
  });

  test("quiet hours inside the active hours hold it until they end", () => {
    const p = prefs({
      quietStart: "12:00",
      quietEnd: "13:00",
      watch: DEFAULT_SUPERVISOR_PREFS.watch,
    });
    expect(nextWatchWake(p, "UTC", at("2026-11-10T11:45:00Z"))).toBe(
      at("2026-11-10T13:00:00Z"),
    );
    // Quiet hours covering the whole window: a day later, still looking.
    const never = prefs({
      quietStart: "07:00",
      quietEnd: "23:00",
      watch: DEFAULT_SUPERVISOR_PREFS.watch,
    });
    expect(nextWatchWake(never, "UTC", at("2026-11-10T12:00:00Z"))).toBe(
      at("2026-11-11T12:00:00Z"),
    );
  });

  test("the next local midnight", () => {
    expect(nextLocalMidnight("UTC", at("2026-11-10T12:00:30Z"))).toBe(
      at("2026-11-11T00:00:00Z"),
    );
    expect(nextLocalMidnight("Europe/Warsaw", at("2026-11-10T12:00:00Z"))).toBe(
      at("2026-11-10T23:00:00Z"),
    );
  });
});
