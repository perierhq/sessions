import { expect, test } from "bun:test";
import type {
  StripBar,
  StripLane,
  StripResponse,
} from "../../../shared/incidents";
import { stripSummary, windowStrip } from "./strip-summary";

const FROM = "2026-10-27T14:00:00.000Z";
const TO = "2026-10-27T15:00:00.000Z";
const utc = (iso: string) => iso.slice(11, 16);

function bar(minute: number, rest: Partial<StripBar>): StripBar {
  const start = new Date(Date.parse(FROM) + minute * 60_000).toISOString();
  const end = new Date(Date.parse(start) + 20 * 60_000).toISOString();
  return { start, end, result: "ok", count: 0, ...rest };
}

function strip(lanes: StripLane[]): StripResponse {
  return { from: FROM, to: TO, bucketMs: 20 * 60_000, lanes, markers: [] };
}

function lane(id: string, bars: StripBar[], extra?: { lane?: string }) {
  return { id, signalId: "sig-a", label: id, bars, ...extra };
}

test("summary of a window", () => {
  const withValues = strip([
    lane("sig-a", [
      bar(0, { result: "ok", count: 10, value: 120 }),
      bar(20, { result: "fail", count: 3, value: 980 }),
      bar(40, { result: "ok", count: 5 }),
    ]),
  ]);
  expect(stripSummary(withValues, { clock: utc })).toBe(
    "14:00–15:00: 18 checks, 3 failed, values 120–980.",
  );

  const noValues = strip([
    lane("sig-a", [
      bar(0, { result: "ok", count: 4 }),
      bar(20, { result: "fail", count: 1 }),
      bar(40, { result: null, count: 0 }),
    ]),
  ]);
  expect(stripSummary(noValues, { clock: utc })).toBe(
    "14:00–15:00: 5 checks, 1 failed.",
  );

  expect(stripSummary(strip([lane("sig-a", [])]), { clock: utc })).toBe(
    "14:00–15:00: no checks.",
  );
  expect(stripSummary(strip([]), { clock: utc })).toBe(
    "14:00–15:00: no checks.",
  );

  const formatted = stripSummary(withValues, {
    clock: utc,
    format: (v) => `${v} ms`,
  });
  expect(formatted).toBe(
    "14:00–15:00: 18 checks, 3 failed, values 120 ms–980 ms.",
  );
});

test("the window's lane is kept", () => {
  const main = lane("sig-a", [bar(0, { count: 1 })]);
  const p95 = lane("sig-a:p95", [bar(0, { count: 2 })], { lane: "p95" });
  const s = strip([main, p95]);

  expect(windowStrip(s, "p95").lanes).toEqual([p95]);
  expect(windowStrip(s).lanes).toEqual([main]);
  expect(windowStrip(s, "p99").lanes).toEqual([]);
  // The rest of the strip is untouched.
  expect(windowStrip(s, "p95").from).toBe(FROM);
  expect(windowStrip(s, "p95").bucketMs).toBe(s.bucketMs);
});
