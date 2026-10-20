import { expect, test } from "bun:test";
import { activeMaintenance, validateMaintenanceWindows } from "./maintenance";

const at = (iso: string) => Date.parse(iso);
const weekly = (
  days: number[],
  start: string,
  end: string,
  timeZone = "Europe/Warsaw",
) => [{ kind: "weekly" as const, days, start, end, timeZone }];

test("once is half-open", () => {
  const w = [
    {
      kind: "once" as const,
      start: "2026-10-20T10:00:00Z",
      end: "2026-10-20T11:00:00Z",
    },
  ];
  expect(activeMaintenance(w, at("2026-10-20T10:00:00Z"))).not.toBeNull();
  expect(activeMaintenance(w, at("2026-10-20T11:00:00Z"))).toBeNull();
});
test("weekly in a time zone, crossing midnight, anchored on the start day", () => {
  const w = weekly([1], "22:00", "02:00"); // Monday night, Warsaw (CEST, UTC+2, on 2026-10-19/20)
  expect(activeMaintenance(w, at("2026-10-19T19:59:00Z"))).toBeNull(); // Mon 21:59
  expect(activeMaintenance(w, at("2026-10-19T20:00:00Z"))).not.toBeNull(); // Mon 22:00
  expect(activeMaintenance(w, at("2026-10-19T23:30:00Z"))).not.toBeNull(); // Tue 01:30
  expect(activeMaintenance(w, at("2026-10-20T00:00:00Z"))).toBeNull(); // Tue 02:00
  expect(activeMaintenance(w, at("2026-10-20T20:30:00Z"))).toBeNull(); // Tue 22:30, Tuesday not listed
});
test("Sunday into Monday", () => {
  expect(
    activeMaintenance(
      weekly([0], "23:00", "01:00", "UTC"),
      at("2026-10-19T00:30:00Z"),
    ),
  ).not.toBeNull();
});
test("spring forward: wall clock across the skipped hour", () => {
  const w = weekly([0], "01:00", "04:00"); // 2026-03-29, 02:00 CET -> 03:00 CEST
  expect(activeMaintenance(w, at("2026-03-29T00:30:00Z"))).not.toBeNull(); // 01:30 CET
  expect(activeMaintenance(w, at("2026-03-29T01:30:00Z"))).not.toBeNull(); // 03:30 CEST
  expect(activeMaintenance(w, at("2026-03-29T02:00:00Z"))).toBeNull(); // 04:00 CEST
});
test("fall back: the repeated hour matches twice", () => {
  const w = weekly([0], "02:00", "02:30"); // 2026-10-25, 03:00 CEST -> 02:00 CET
  expect(activeMaintenance(w, at("2026-10-25T00:15:00Z"))).not.toBeNull(); // 02:15 CEST
  expect(activeMaintenance(w, at("2026-10-25T01:15:00Z"))).not.toBeNull(); // 02:15 CET
});
test("validation", () => {
  expect(
    validateMaintenanceWindows([
      {
        kind: "weekly",
        days: [1],
        start: "02:00",
        end: "02:00",
        timeZone: "UTC",
      },
    ]),
  ).toEqual({ error: expect.any(String) });
  expect(
    validateMaintenanceWindows([
      {
        kind: "weekly",
        days: [1],
        start: "02:00",
        end: "03:00",
        timeZone: "Mars/Base",
      },
    ]),
  ).toEqual({ error: expect.any(String) });
  expect(
    validateMaintenanceWindows([
      {
        kind: "once",
        start: "2026-10-20T11:00:00Z",
        end: "2026-10-20T10:00:00Z",
      },
    ]),
  ).toEqual({ error: expect.any(String) });
  expect(validateMaintenanceWindows([])).toBeUndefined();
  expect(
    validateMaintenanceWindows([
      {
        kind: "weekly",
        days: [1, 1],
        start: "02:00",
        end: "03:00",
        timeZone: "UTC",
      },
    ]),
  ).toEqual({ error: expect.any(String) });
  expect(
    validateMaintenanceWindows([
      {
        kind: "weekly",
        days: [1],
        start: "24:00",
        end: "03:00",
        timeZone: "UTC",
      },
    ]),
  ).toEqual({ error: expect.any(String) });
});
