import { expect, test } from "bun:test";
import type { MaintenanceWindow, SignalView } from "../../../shared/incidents";
import { formatTimeOfDay } from "../time-of-day";
import {
  dayLabel,
  describeWindow,
  isoToLocalInput,
  localInputToIso,
  MAX_WINDOWS,
  newOnceWindow,
  newWeeklyWindow,
  projectWindows,
  signalWindows,
  windowProblem,
} from "./maintenance-form";

const weekly = {
  kind: "weekly",
  days: [1, 2],
  start: "22:00",
  end: "02:00",
  timeZone: "Europe/Warsaw",
} as const satisfies MaintenanceWindow;

/** A stored signal with only the fields a test sets. */
function view(fields: Partial<SignalView>): SignalView {
  // SAFETY: the helpers under test read only id, name and maintenance.
  return fields as SignalView;
}

test("describe", () => {
  expect(describeWindow(weekly)).toBe(
    `Weekly · ${dayLabel(1)}, ${dayLabel(2)} · ${formatTimeOfDay("22:00")}–${formatTimeOfDay("02:00")} next day · Europe/Warsaw`,
  );
  expect(
    describeWindow({
      ...weekly,
      days: [0, 6, 1],
      start: "02:00",
      end: "03:00",
    }),
  ).toBe(
    `Weekly · ${dayLabel(1)}, ${dayLabel(6)}, ${dayLabel(0)} · ${formatTimeOfDay("02:00")}–${formatTimeOfDay("03:00")} · Europe/Warsaw`,
  );
  const once = describeWindow({
    kind: "once",
    start: "2026-10-20T10:00:00.000Z",
    end: "2026-10-20T11:00:00.000Z",
  });
  expect(once.startsWith("Once · ")).toBe(true);
  expect(once).toContain("–");
});

test("day labels follow the locale, Sunday is 0", () => {
  expect(dayLabel(0)).toBe(
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: "UTC",
    }).format(Date.UTC(2000, 0, 2)),
  );
});

test("problems", () => {
  expect(windowProblem({ ...weekly, end: "22:00" })).toBe(
    "Pick two different times",
  );
  expect(windowProblem({ ...weekly, days: [] })).toBe("Pick at least one day");
  expect(windowProblem({ ...weekly, start: "25:00" })).toBe(
    "Use a time like 23:00",
  );
  expect(
    windowProblem({
      kind: "once",
      start: "2026-10-20T11:00:00Z",
      end: "2026-10-20T10:00:00Z",
    }),
  ).toBe("The end must be after the start");
  expect(
    windowProblem({
      kind: "once",
      start: "2026-10-20T11:00:00Z",
      end: "2026-10-20T11:00:00Z",
    }),
  ).toBe("Pick two different times");
  expect(windowProblem(weekly)).toBeNull();
});

test("local datetime round trip", () => {
  const iso = "2026-10-20T10:00:00.000Z";
  expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  expect(localInputToIso("")).toBe("");
});

test("new windows", () => {
  expect(newWeeklyWindow("Europe/Warsaw")).toEqual({
    kind: "weekly",
    days: [0],
    start: "02:00",
    end: "03:00",
    timeZone: "Europe/Warsaw",
  });
  const once = newOnceWindow(Date.UTC(2026, 9, 20, 10, 25));
  expect(once).toEqual({
    kind: "once",
    start: "2026-10-20T11:00:00.000Z",
    end: "2026-10-20T12:00:00.000Z",
  });
});

test("project windows group identical windows", () => {
  expect(
    projectWindows([
      view({ id: "a", maintenance: [weekly] }),
      view({ id: "b", maintenance: [{ ...weekly }] }),
      view({ id: "c" }),
    ]),
  ).toEqual([{ window: weekly, signalIds: ["a", "b"] }]);
});

test("signal windows rebuild each signal's list from the groups", () => {
  const once: MaintenanceWindow = {
    kind: "once",
    start: "2026-10-20T10:00:00.000Z",
    end: "2026-10-20T11:00:00.000Z",
  };
  const plan = signalWindows(
    [
      view({ id: "a", name: "A", maintenance: [weekly] }),
      view({ id: "b", name: "B", maintenance: [weekly] }),
      view({ id: "c", name: "C" }),
    ],
    [
      { window: weekly, signalIds: ["a"] },
      { window: once, signalIds: ["a", "c"] },
    ],
  );
  expect(plan).toEqual([
    { id: "a", name: "A", maintenance: [weekly, once] },
    { id: "b", name: "B", maintenance: [] },
    { id: "c", name: "C", maintenance: [once] },
  ]);
  expect(MAX_WINDOWS).toBe(20);
});
