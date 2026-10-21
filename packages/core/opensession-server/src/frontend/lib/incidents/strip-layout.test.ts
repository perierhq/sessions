import { expect, test } from "bun:test";
import type { ProofResult } from "../../../shared/incident-response";
import type {
  StripBar,
  StripLane,
  StripMarker,
  StripResponse,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import type { LaneKind } from "./signal-summary";
import {
  barIndexAt,
  layoutStrip,
  packMarkerLabels,
  proofLane,
  type StripLaneMeta,
} from "./strip-layout";

const T = Date.parse("2026-10-20T12:31:00Z");
const iso = (msAgo: number) => new Date(T - msAgo).toISOString();
const bar = (
  i: number,
  n: number,
  result: StripBar["result"],
  extra: Partial<StripBar> = {},
): StripBar => ({
  start: iso((n - i) * 60_000),
  end: iso((n - i - 1) * 60_000),
  result,
  count: result ? 1 : 0,
  ...extra,
});
const strip = (
  results: Array<StripBar["result"]>,
  markers: StripMarker[] = [],
): StripResponse => ({
  from: iso(results.length * 60_000),
  to: iso(0),
  bucketMs: 60_000,
  markers,
  lanes: [
    {
      id: "sig-a",
      signalId: "sig-a",
      label: "Search",
      bars: results.map((r, i) => bar(i, results.length, r)),
    },
  ],
});
const meta =
  (kind: LaneKind, extra: Partial<StripLaneMeta> = {}) =>
  (): StripLaneMeta => ({
    kind,
    label: "Search",
    format: (v: number) => `${v} ms`,
    ...extra,
  });

test("live edge, future zone and slot width", () => {
  const l = layoutStrip({
    strip: strip(Array(100).fill("ok")),
    meta: meta("passfail"),
    width: 1030,
    live: true,
    future: [{ at: new Date(T + 6 * 60_000).toISOString(), label: "Deploys" }],
  });
  expect(l.pastSlots).toBe(100);
  expect(l.futureSlots).toBe(6);
  expect(l.slotWidth).toBeCloseTo(1030 / 106);
  expect(l.liveEdgeX).toBeCloseTo(100 * (1030 / 106));
  expect(l.lanes[0].bars.slice(-6).every((b) => b.tone === "future")).toBe(
    true,
  );
  expect(l.lanes[0].source.slice(-6).every((b) => b === null)).toBe(true);
  expect(
    layoutStrip({
      strip: strip(Array(100).fill("ok")),
      meta: meta("passfail"),
      width: 1000,
      live: false,
    }).liveEdgeX,
  ).toBeNull();
  expect(
    layoutStrip({
      strip: strip(Array(100).fill("ok")),
      meta: meta("passfail"),
      width: 1000,
      live: true,
      future: [{ at: new Date(T + 3_600_000).toISOString(), label: "x" }],
    }).futureSlots,
  ).toBe(15);
});

test("a live strip without future markers keeps three future slots", () => {
  const l = layoutStrip({
    strip: strip(["ok", "ok"]),
    meta: meta("passfail"),
    width: 500,
    live: true,
  });
  expect(l.futureSlots).toBe(3);
  expect(l.slotWidth).toBeCloseTo(100);
});

test("pass/fail tones and empty bars at final size", () => {
  const l = layoutStrip({
    strip: strip(["ok", "fail", "unknown", null]),
    meta: meta("passfail"),
    width: 400,
    live: false,
  });
  expect(l.lanes[0].bars.map((b) => b.tone)).toEqual([
    "ok",
    "fail",
    "neutral",
    "empty",
  ]);
  expect(l.lanes[0].showLabel).toBe(false);
  expect(
    layoutStrip({
      strip: strip(Array(120).fill(null)),
      meta: meta("passfail"),
      width: 400,
      live: false,
    }).lanes[0].bars,
  ).toHaveLength(120);
});

test("value lanes: threshold is amber, never red, and sets the scale", () => {
  const s = strip(["ok", "ok", "ok"]);
  s.lanes[0].bars = s.lanes[0].bars.map((b, i) => ({
    ...b,
    value: [400, 1600, 3500][i],
  }));
  const l = layoutStrip({
    strip: s,
    meta: meta("value", { threshold: 1500 }),
    width: 300,
    live: false,
  });
  expect(l.lanes[0].bars.map((b) => b.tone)).toEqual(["ok", "warn", "warn"]);
  expect(l.lanes[0].bars[2].height).toBeCloseTo(1);
  expect(l.lanes[0].threshold).toBeCloseTo(1500 / 3500);
  expect(l.lanes[0]).toMatchObject({
    thresholdLabel: "Slow above 1500 ms",
    axis: { min: "0 ms", max: "3500 ms" },
  });
});

test("value lanes: a failed observation is red, a tiny value stays visible", () => {
  const s = strip(["fail", "ok", null]);
  s.lanes[0].bars = s.lanes[0].bars.map((b, i) => ({
    ...b,
    value: [200, 1, undefined][i],
  }));
  const l = layoutStrip({
    strip: s,
    meta: meta("value", { threshold: 1500 }),
    width: 300,
    live: false,
  });
  expect(l.lanes[0].bars.map((b) => b.tone)).toEqual(["fail", "ok", "empty"]);
  expect(l.lanes[0].bars[1].height).toBeCloseTo(0.06);
});

test("event lanes scale to the busiest bar", () => {
  const s = strip(["fail", "fail", "ok", null]);
  s.lanes[0].bars[0].count = 2;
  s.lanes[0].bars[1].count = 8;
  const l = layoutStrip({
    strip: s,
    meta: meta("events"),
    width: 400,
    live: false,
  });
  expect(l.lanes[0].bars.map((b) => [b.tone, b.height])).toEqual([
    ["fail", 0.25],
    ["fail", 1],
    ["neutral", 0.15],
    ["empty", 0],
  ]);
});

test("expected runs: a missed check-in is hollow", () => {
  const s = strip(["ok", "fail", "fail"]);
  s.lanes[0].bars[1] = {
    ...s.lanes[0].bars[1],
    sample: { at: iso(0), result: "fail", detail: "Missed check-in" },
  };
  expect(
    layoutStrip({
      strip: s,
      meta: meta("runs"),
      width: 200,
      live: false,
    }).lanes[0].bars.map((b) => b.tone),
  ).toEqual(["ok", "missed", "fail"]);
});

test("day lanes warn and fail by days left", () => {
  const s = strip(["ok", "ok", "ok"]);
  s.lanes[0].bars = s.lanes[0].bars.map((b, i) => ({
    ...b,
    value: [40, 10, 2][i],
  }));
  const l = layoutStrip({
    strip: s,
    meta: meta("days", {
      warnDays: 14,
      failDays: 3,
      format: (v) => `${v} days`,
    }),
    width: 300,
    live: false,
  });
  expect(l.lanes[0].bars.map((b) => b.tone)).toEqual(["ok", "warn", "fail"]);
  expect(l.lanes[0].threshold).toBeCloseTo(14 / 40);
  expect(l.lanes[0].thresholdLabel).toBe("Warn at 14 days");
});

test("markers: past left of the edge, future right of it, labels never overlap", () => {
  const markers = Array.from({ length: 1000 }, (_, i) => ({
    at: iso(i * 6_000),
    kind: "deploy" as const,
    label: "Deploy",
    incidentId: "inc-1",
  }));
  const l = layoutStrip({
    strip: strip(Array(100).fill("fail"), markers),
    meta: meta("passfail"),
    width: 720,
    live: true,
    future: [
      { at: iso(60_000), label: "Too late" },
      { at: new Date(T + 5 * 60_000).toISOString(), label: "Deploys" },
    ],
  });
  expect(l.markers.filter((m) => m.future).map((m) => m.text)).toEqual([
    `Deploys ${clockTime(new Date(T + 5 * 60_000).toISOString())}`,
  ]);
  expect(
    l.markers.filter((m) => !m.future).every((m) => m.x <= (l.liveEdgeX ?? 0)),
  ).toBe(true);
  expect(
    l.markers.filter((m) => m.future).every((m) => m.x > (l.liveEdgeX ?? 0)),
  ).toBe(true);
  const shown = l.markers.filter((m) => !m.future && m.row !== null);
  for (const row of [0, 1]) {
    const boxes = shown
      .filter((m) => m.row === row)
      .map((m) => {
        const w = m.text.length * 6.5 + 8;
        const left =
          m.anchor === "start"
            ? m.x
            : m.anchor === "end"
              ? m.x - w
              : m.x - w / 2;
        return [left, left + w];
      })
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1] + 4);
  }
  expect(l.hiddenMarkers).toBeGreaterThan(900);
});

test("a finished strip drops future markers", () => {
  const l = layoutStrip({
    strip: strip(["ok", "ok"]),
    meta: meta("passfail"),
    width: 200,
    live: false,
    future: [{ at: new Date(T + 60_000).toISOString(), label: "Deploys" }],
  });
  expect(l.markers).toEqual([]);
});

test("label packing anchors at the edges and fills the first free row", () => {
  expect(
    packMarkerLabels(
      [
        { x: 2, text: "Detected 10:41" },
        { x: 10, text: "Sent back 11:52" },
        { x: 30, text: "Fix ready 12:27" },
        { x: 398, text: "Deploy" },
      ],
      400,
      2,
    ),
  ).toEqual([
    { row: 0, anchor: "start" },
    { row: 1, anchor: "start" },
    { row: null, anchor: "start" },
    { row: 0, anchor: "end" },
  ]);
  expect(packMarkerLabels([{ x: 200, text: "Mid" }], 400, 1)).toEqual([
    { row: 0, anchor: "middle" },
  ]);
});

test("verification lane draws nothing where nothing ran", () => {
  const v: StripLane = {
    id: "verify",
    signalId: "sig-a",
    label: "Fix branch",
    bars: strip([null, "fail", "ok"]).lanes[0].bars,
  };
  const l = layoutStrip({
    strip: strip(["fail", "fail", "fail"]),
    meta: meta("passfail"),
    verification: [v],
    width: 300,
    live: true,
  });
  expect(l.lanes[1]).toMatchObject({
    label: "Fix branch",
    verification: true,
    showLabel: true,
  });
  expect(l.lanes[0].showLabel).toBe(true);
  expect(l.lanes[1].bars.map((b) => b.tone)).toEqual([
    "none",
    "fail",
    "ok",
    "none",
    "none",
    "none",
  ]);
});

test("proof samples become the fix-branch lane", () => {
  const s = strip(["fail", "fail", "fail"]);
  const proof: ProofResult = {
    round: 2,
    at: iso(0),
    baseline: { samples: [], verdict: "fails" },
    candidate: {
      kind: "request",
      verdict: "passes",
      samples: [
        { at: iso(90_000), result: "ok", detail: "200" },
        { at: iso(30_000), result: "ok", detail: "200" },
        { at: iso(10 * 60_000), result: "ok", detail: "old" },
      ],
    },
  };
  const lane = proofLane(proof, s);
  expect(lane).toMatchObject({
    id: "verification",
    label: "Fix branch",
    signalId: "sig-a",
  });
  expect(lane?.bars.map((b) => b.result)).toEqual([null, "ok", "ok"]);
  expect(
    proofLane(
      {
        ...proof,
        candidate: { ...proof.candidate, kind: "after-deploy" },
      },
      s,
    ),
  ).toBeNull();
  expect(proofLane(undefined, s)).toBeNull();
});

test("proof bars keep the worst sample", () => {
  const s = strip(["fail"]);
  const proof: ProofResult = {
    round: 1,
    at: iso(0),
    baseline: { samples: [], verdict: "fails" },
    candidate: {
      kind: "request",
      verdict: "fails",
      samples: [
        { at: iso(50_000), result: "ok", detail: "200" },
        { at: iso(40_000), result: "fail", detail: "HTTP 503" },
        { at: iso(30_000), result: "unknown", detail: "timeout" },
      ],
    },
  };
  expect(proofLane(proof, s)?.bars[0]).toMatchObject({
    result: "fail",
    count: 3,
    sample: { result: "fail", detail: "HTTP 503" },
  });
});

test("bar index from x", () => {
  const l = layoutStrip({
    strip: strip(["ok", "ok", "ok", "ok"]),
    meta: meta("passfail"),
    width: 400,
    live: false,
  });
  expect(barIndexAt(l, 0)).toBe(0);
  expect(barIndexAt(l, 399)).toBe(3);
  expect(barIndexAt(l, 400)).toBeNull();
  expect(barIndexAt(l, -1)).toBeNull();
});
