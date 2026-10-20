import { expect, test } from "bun:test";
import type { Signal, StripMarkerKind } from "../../shared/incidents";
import {
  bucketStrip,
  defaultStripRange,
  markersFromEvents,
  stripBucketMs,
  stripIntervalMs,
} from "./strip";

const T = Date.parse("2026-10-20T10:00:00Z");
const at = (msAgo: number) => new Date(T - msAgo).toISOString();

test("bucket size: interval times elapsed, capped at 120 bars", () => {
  expect(stripBucketMs(60_000, T - 3_600_000, T)).toBe(60_000);
  expect(stripBucketMs(60_000, T - 6 * 3_600_000, T)).toBe(180_000);
});

test("bars align to the live edge; worst wins; empty is null", () => {
  const [main] = bucketStrip({
    signalId: "sig-a",
    label: "Search",
    from: T - 180_000,
    to: T,
    bucketMs: 60_000,
    observations: [
      { at: at(170_000), result: "ok", detail: "", value: 120 },
      { at: at(150_000), result: "fail", detail: "HTTP 503", value: 90 },
      { at: at(0), result: "unknown", detail: "" },
    ],
  });
  expect(main.bars.map((b) => [b.start, b.result, b.count])).toEqual([
    [at(180_000), "fail", 2],
    [at(120_000), null, 0],
    [at(60_000), "unknown", 1],
  ]);
  expect(main.bars[0].sample?.detail).toBe("HTTP 503");
  expect(main.bars[0].value).toBe(120);
});

test("deadline lanes keep the smallest value; lanes sorted after main", () => {
  const lanes = bucketStrip({
    signalId: "sig-a",
    label: "Status",
    from: T - 60_000,
    to: T,
    bucketMs: 60_000,
    valueWorst: "min",
    observations: [
      { at: at(30_000), result: "ok", detail: "", value: 9 },
      { at: at(20_000), result: "ok", detail: "", value: 7 },
      { at: at(10_000), result: "fail", detail: "", lane: "Search" },
      { at: at(10_000), result: "ok", detail: "", lane: "API" },
    ],
  });
  expect(lanes.map((l) => l.id)).toEqual([
    "sig-a",
    "sig-a:API",
    "sig-a:Search",
  ]);
  expect(lanes[0].bars[0].value).toBe(7);
});

test("markers from the timeline, inside the range only", () => {
  const ev = (msAgo: number, marker?: StripMarkerKind) => ({
    id: `e${msAgo}`,
    at: at(msAgo),
    kind: "state" as const,
    by: "sessions",
    detail: "",
    marker,
  });
  expect(
    markersFromEvents(
      "inc-1",
      [
        ev(7_200_000, "detected"),
        ev(600_000, "detected"),
        ev(300_000),
        ev(60_000, "fix-ready"),
      ],
      T - 3_600_000,
      T,
    ),
  ).toEqual([
    {
      at: at(600_000),
      kind: "detected",
      label: "Detected",
      incidentId: "inc-1",
    },
    {
      at: at(60_000),
      kind: "fix-ready",
      label: "Fix ready",
      incidentId: "inc-1",
    },
  ]);
});

test("interval per source and the default range", () => {
  const base = {
    id: "sig-a",
    name: "Search",
    project: "acme",
    enabled: true,
    severity: "major",
    createdBy: "Ada",
    createdAt: at(0),
    updatedAt: at(0),
  } as const;
  const http: Signal = {
    ...base,
    source: { kind: "http", url: "https://acme.example.test" },
    rule: { kind: "consecutive", failures: 3 },
    intervalMs: 60_000,
  };
  const heartbeat: Signal = {
    ...base,
    source: { kind: "heartbeat" },
    rule: { kind: "missing", cron: "0 3 * * *", graceMs: 0 },
  };
  const webhook: Signal = {
    ...base,
    source: { kind: "webhook" },
    rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
  };
  expect(stripIntervalMs(http)).toBe(60_000);
  expect(stripIntervalMs(heartbeat)).toBe(3_600_000);
  expect(stripIntervalMs(webhook)).toBe(60_000);
  expect(defaultStripRange(http, T)).toEqual({ from: T - 7_200_000, to: T });
  expect(defaultStripRange(heartbeat, T)).toEqual({
    from: T - 5 * 86_400_000,
    to: T,
  });
  expect(defaultStripRange({ ...http, intervalMs: 10_000 }, T).from).toBe(
    T - 3_600_000,
  );
});
