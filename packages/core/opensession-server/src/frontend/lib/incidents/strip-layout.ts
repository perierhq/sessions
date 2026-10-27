// Signal strip geometry: bars per lane kind, the live edge, the future zone
// and packed marker labels. Time maps as bucket × elapsed with the live edge
// at the right; future markers sit only right of it. Pure, no DOM.
import type { ProofResult } from "../../../shared/incident-response";
import type {
  ObservationResult,
  SignalSourceKind,
  StripBar,
  StripLane,
  StripResponse,
} from "../../../shared/incidents";
import type { BarSpec, BarTone } from "../../ui/bar-strip";
import { clockTime } from "../time";
import type { LaneKind } from "./signal-summary";
import type { DotTone } from "./tone";

/** A live strip always shows at least this many future slots. */
export const STRIP_FUTURE_MIN_SLOTS = 3;
/** The future zone never takes more than this share of the past bars. */
export const STRIP_FUTURE_MAX_SHARE = 0.15;
/** Lanes shown before the lane list scrolls. */
export const STRIP_LANES_VISIBLE = 8;
/** Estimated width of one marker label character (`text-meta`). */
export const MARKER_CHAR_PX = 6.5;
/** Padding around one marker label. */
export const MARKER_PAD_PX = 8;
/** The least space between two labels in one row. */
const MARKER_GAP_PX = 4;

export interface StripLaneMeta {
  kind: LaneKind;
  label: string;
  format: (value: number) => string;
  threshold?: number;
  warnDays?: number;
  failDays?: number;
}

export interface LaidLane {
  id: string;
  label: string;
  showLabel: boolean;
  kind: LaneKind;
  verification: boolean;
  bars: BarSpec[];
  /** The bar behind each slot; `null` for future slots. */
  source: Array<StripBar | null>;
  threshold?: number;
  thresholdLabel?: string;
  axis?: { min: string; max: string };
}

export interface LaidMarker {
  key: string;
  at: string;
  x: number;
  text: string;
  future: boolean;
  /** `null`: no room for the label; the line still draws. */
  row: 0 | 1 | null;
  anchor: "start" | "middle" | "end";
}

export interface StripLayout {
  width: number;
  pastSlots: number;
  futureSlots: number;
  slotWidth: number;
  liveEdgeX: number | null;
  lanes: LaidLane[];
  markers: LaidMarker[];
  hiddenMarkers: number;
}

/** What a result is called in a tooltip and the observation detail. */
export const RESULT_WORD: Record<ObservationResult, string> = {
  ok: "Passed",
  fail: "Failed",
  unknown: "No answer",
};

function barLabel(bar: StripBar, format: (value: number) => string): string {
  const when = clockTime(bar.start);
  if (bar.result === null) return `${when} · No data`;
  const value = bar.value === undefined ? "" : ` · ${format(bar.value)}`;
  return `${when} · ${RESULT_WORD[bar.result]}${value}`;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function spec(
  laneId: string,
  i: number,
  tone: BarTone,
  height: number,
  label: string,
): BarSpec {
  return { key: `${laneId}:${i}`, tone, height: clamp01(height), label };
}

interface LaneBars {
  bars: BarSpec[];
  threshold?: number;
  thresholdLabel?: string;
  axis?: { min: string; max: string };
}

function maxValue(bars: StripBar[]): number {
  let max = 0;
  for (const bar of bars)
    if (bar.result !== null && bar.value !== undefined && bar.value > max)
      max = bar.value;
  return max;
}

function passFailBars(lane: StripLane, meta: StripLaneMeta, nullTone: BarTone) {
  return lane.bars.map((bar, i) => {
    const label = barLabel(bar, meta.format);
    if (bar.result === null) return spec(lane.id, i, nullTone, 0, label);
    const tone: BarTone =
      bar.result === "ok" ? "ok" : bar.result === "fail" ? "fail" : "neutral";
    return spec(lane.id, i, tone, 1, label);
  });
}

function valueBars(lane: StripLane, meta: StripLaneMeta): LaneBars {
  const threshold = meta.threshold ?? 0;
  const scale = Math.max(threshold * 2, maxValue(lane.bars), 1);
  const bars = lane.bars.map((bar, i) => {
    const label = barLabel(bar, meta.format);
    if (bar.result === null) return spec(lane.id, i, "empty", 0, label);
    const h = bar.value === undefined ? 1 : Math.max(0.06, bar.value / scale);
    if (bar.result === "fail") return spec(lane.id, i, "fail", h, label);
    if (bar.value === undefined) return spec(lane.id, i, "empty", 0, label);
    // Over the threshold is slow, not down: amber, never red.
    const tone: BarTone =
      meta.threshold !== undefined && bar.value > meta.threshold
        ? "warn"
        : "ok";
    return spec(lane.id, i, tone, h, label);
  });
  const out: LaneBars = {
    bars,
    axis: { min: meta.format(0), max: meta.format(scale) },
  };
  if (meta.threshold !== undefined) {
    out.threshold = meta.threshold / scale;
    out.thresholdLabel = `Slow above ${meta.format(meta.threshold)}`;
  }
  return out;
}

function eventBars(lane: StripLane, meta: StripLaneMeta): BarSpec[] {
  let maxFail = 0;
  for (const bar of lane.bars)
    if (bar.result === "fail" && bar.count > maxFail) maxFail = bar.count;
  return lane.bars.map((bar, i) => {
    const label = barLabel(bar, meta.format);
    if (bar.result === null) return spec(lane.id, i, "empty", 0, label);
    if (bar.result === "fail")
      return spec(
        lane.id,
        i,
        "fail",
        Math.max(0.15, maxFail ? bar.count / maxFail : 1),
        label,
      );
    return spec(lane.id, i, "neutral", 0.15, label);
  });
}

function runBars(lane: StripLane, meta: StripLaneMeta): BarSpec[] {
  return lane.bars.map((bar, i) => {
    const label = barLabel(bar, meta.format);
    if (bar.result === null) return spec(lane.id, i, "empty", 0, label);
    if (bar.result === "ok") return spec(lane.id, i, "ok", 1, label);
    if (bar.result === "fail")
      return spec(
        lane.id,
        i,
        bar.sample?.detail === "Missed check-in" ? "missed" : "fail",
        1,
        label,
      );
    return spec(lane.id, i, "neutral", 1, label);
  });
}

function dayBars(lane: StripLane, meta: StripLaneMeta): LaneBars {
  const warn = meta.warnDays ?? 0;
  const fail = meta.failDays ?? 0;
  const scale = Math.max(warn * 2, maxValue(lane.bars), 1);
  const bars = lane.bars.map((bar, i) => {
    const label = barLabel(bar, meta.format);
    if (bar.result === null || bar.value === undefined)
      return spec(lane.id, i, "empty", 0, label);
    const tone: BarTone =
      bar.value <= fail ? "fail" : bar.value <= warn ? "warn" : "ok";
    return spec(lane.id, i, tone, Math.max(0.06, bar.value / scale), label);
  });
  const out: LaneBars = {
    bars,
    axis: { min: meta.format(0), max: meta.format(scale) },
  };
  if (meta.warnDays !== undefined) {
    out.threshold = meta.warnDays / scale;
    out.thresholdLabel = `Warn at ${meta.warnDays} days`;
  }
  return out;
}

function laneBars(lane: StripLane, meta: StripLaneMeta): LaneBars {
  switch (meta.kind) {
    case "passfail":
      return { bars: passFailBars(lane, meta, "empty") };
    case "value":
      return valueBars(lane, meta);
    case "events":
      return { bars: eventBars(lane, meta) };
    case "runs":
      return { bars: runBars(lane, meta) };
    case "days":
      return dayBars(lane, meta);
  }
}

function labelWidth(text: string): number {
  return text.length * MARKER_CHAR_PX + MARKER_PAD_PX;
}

/**
 * Packs labels left to right into `rows` rows. A label is centred on its
 * line unless that would cross an edge; one that fits no row gets
 * `row: null`. Results come back in the input order.
 */
export function packMarkerLabels(
  items: Array<{ x: number; text: string }>,
  width: number,
  rows: 1 | 2,
): Array<{ row: 0 | 1 | null; anchor: "start" | "middle" | "end" }> {
  const out: Array<{ row: 0 | 1 | null; anchor: "start" | "middle" | "end" }> =
    items.map(() => ({ row: null, anchor: "middle" }));
  const rowEnds: number[] = Array.from({ length: rows }, () => -Infinity);
  const order = items.map((_, i) => i).sort((a, b) => items[a].x - items[b].x);
  for (const i of order) {
    const { x, text } = items[i];
    const w = labelWidth(text);
    const anchor =
      x - w / 2 < 0 ? "start" : x + w / 2 > width ? "end" : "middle";
    const left = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
    out[i].anchor = anchor;
    const row = rowEnds.findIndex((end) => left >= end + MARKER_GAP_PX);
    if (row === -1) continue;
    rowEnds[row] = left + w;
    out[i].row = row === 0 ? 0 : 1;
  }
  return out;
}

export function layoutStrip(input: {
  strip: StripResponse;
  meta: (lane: StripLane) => StripLaneMeta;
  verification?: StripLane[];
  future?: Array<{ at: string; label: string }>;
  /** Labelled times a findings block adds: past markers keyed `note:<i>`,
   *  drawn only inside [from, to], labelled with the text as given. */
  annotations?: Array<{ at: string; label: string }>;
  width: number;
  live: boolean;
}): StripLayout {
  const { strip, width, live } = input;
  const from = Date.parse(strip.from);
  const to = Date.parse(strip.to);
  const bucketMs = strip.bucketMs > 0 ? strip.bucketMs : 60_000;
  const pastSlots = strip.lanes[0]?.bars.length ?? 0;

  const future = live
    ? (input.future ?? []).filter((m) => Date.parse(m.at) > to)
    : [];
  let futureSlots = 0;
  if (live) {
    const latest = Math.max(to, ...future.map((m) => Date.parse(m.at)));
    const cap = Math.max(
      STRIP_FUTURE_MIN_SLOTS,
      Math.ceil(pastSlots * STRIP_FUTURE_MAX_SHARE),
    );
    futureSlots = Math.min(
      cap,
      Math.max(STRIP_FUTURE_MIN_SLOTS, Math.ceil((latest - to) / bucketMs)),
    );
  }
  const slots = pastSlots + futureSlots;
  const slotWidth = slots ? width / slots : 0;
  const liveEdgeX = live ? pastSlots * slotWidth : null;
  const xAt = (at: string) =>
    Math.max(
      0,
      Math.min(width, ((Date.parse(at) - from) / bucketMs) * slotWidth),
    );

  const verification = input.verification ?? [];
  const showLabel = strip.lanes.length + verification.length > 1;
  const pad = <T>(bars: T[], fill: T): T[] => [
    ...bars,
    ...Array.from({ length: futureSlots }, () => fill),
  ];
  const futureBar = (laneId: string, i: number, tone: BarTone): BarSpec => ({
    key: `${laneId}:f${i}`,
    tone,
    height: tone === "future" ? 1 : 0,
    label: "",
  });
  const padBars = (laneId: string, bars: BarSpec[], tone: BarTone) => [
    ...bars,
    ...Array.from({ length: futureSlots }, (_, i) =>
      futureBar(laneId, i, tone),
    ),
  ];

  const lanes: LaidLane[] = [];
  for (const lane of strip.lanes) {
    const meta = input.meta(lane);
    const laid = laneBars(lane, meta);
    const laidLane: LaidLane = {
      id: lane.id,
      label: meta.label,
      showLabel,
      kind: meta.kind,
      verification: false,
      bars: padBars(lane.id, laid.bars, "future"),
      source: pad<StripBar | null>(lane.bars, null),
    };
    if (laid.threshold !== undefined) laidLane.threshold = laid.threshold;
    if (laid.thresholdLabel) laidLane.thresholdLabel = laid.thresholdLabel;
    if (laid.axis) laidLane.axis = laid.axis;
    lanes.push(laidLane);
  }
  for (const lane of verification) {
    const meta: StripLaneMeta = {
      kind: "passfail",
      label: lane.label,
      format: String,
    };
    lanes.push({
      id: lane.id,
      label: lane.label,
      showLabel,
      kind: "passfail",
      verification: true,
      bars: padBars(lane.id, passFailBars(lane, meta, "none"), "none"),
      source: pad<StripBar | null>(lane.bars, null),
    });
  }

  const past = strip.markers
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => Date.parse(m.at) <= to)
    .map(({ m, i }) => ({
      key: `past:${i}`,
      at: m.at,
      x: xAt(m.at),
      text: `${m.label} ${clockTime(m.at)}`,
      future: false,
    }));
  for (const [i, note] of (input.annotations ?? []).entries()) {
    const at = Date.parse(note.at);
    if (!(at >= from && at <= to)) continue;
    past.push({
      key: `note:${i}`,
      at: note.at,
      x: xAt(note.at),
      text: note.label,
      future: false,
    });
  }
  const ahead = future.map((m, i) => ({
    key: `future:${i}`,
    at: m.at,
    x: xAt(m.at),
    text: `${m.label} ${clockTime(m.at)}`,
    future: true,
  }));
  const pastPacked = packMarkerLabels(past, width, 2);
  const aheadPacked = packMarkerLabels(ahead, width, 1);
  const markers: LaidMarker[] = [
    ...past.map((m, i) => ({ ...m, ...pastPacked[i] })),
    ...ahead.map((m, i) => ({ ...m, ...aheadPacked[i] })),
  ];

  return {
    width,
    pastSlots,
    futureSlots,
    slotWidth,
    liveEdgeX,
    lanes,
    markers,
    hiddenMarkers: markers.filter((m) => m.row === null).length,
  };
}

/** The past bar under `x`, or null outside the past bars. */
export function barIndexAt(layout: StripLayout, x: number): number | null {
  if (!(layout.slotWidth > 0)) return null;
  if (x < 0 || x >= layout.pastSlots * layout.slotWidth) return null;
  return Math.min(layout.pastSlots - 1, Math.floor(x / layout.slotWidth));
}

const RESULT_RANK: Record<ObservationResult, number> = {
  ok: 0,
  unknown: 1,
  fail: 2,
};

/**
 * The latest round's candidate samples, bucketed into the strip's bars
 * (worst result per bar), drawn as the fix branch's lane. `null` without
 * samples or when the candidate is only checked after it deploys.
 */
export function proofLane(
  proof: ProofResult | undefined,
  strip: StripResponse,
): StripLane | null {
  const first = strip.lanes[0];
  if (!proof || !first || proof.candidate.kind === "after-deploy") return null;
  if (!proof.candidate.samples.length) return null;
  const bars: StripBar[] = first.bars.map((b) => ({
    start: b.start,
    end: b.end,
    result: null,
    count: 0,
  }));
  const last = bars.length - 1;
  for (const sample of proof.candidate.samples) {
    const at = Date.parse(sample.at);
    const i = bars.findIndex((b, index) => {
      const start = Date.parse(b.start);
      const end = Date.parse(b.end);
      return at >= start && (at < end || (index === last && at <= end));
    });
    if (i === -1) continue;
    const bar = bars[i];
    bar.count += 1;
    if (
      bar.result === null ||
      RESULT_RANK[sample.result] > RESULT_RANK[bar.result]
    ) {
      bar.result = sample.result;
      bar.sample = {
        at: sample.at,
        result: sample.result,
        detail: sample.detail,
      };
    }
  }
  return {
    id: "verification",
    signalId: first.signalId,
    label: "Fix branch",
    bars,
  };
}

const HOUR_MS = 3_600_000;

/**
 * The strip's live line: when the next check runs, what the last hour
 * brought, or when the incident ended.
 */
export function liveLineText(input: {
  kind: SignalSourceKind;
  nextRunAt?: string;
  strip?: StripResponse;
  lastCheckIn?: string;
  closedAt?: string;
  now: number;
}): string {
  if (input.closedAt) return `Ended ${clockTime(input.closedAt)}`;
  switch (input.kind) {
    case "http":
    case "expiry": {
      if (!input.nextRunAt) return "Live";
      const ms = Date.parse(input.nextRunAt) - input.now;
      if (!(ms > 0)) return "Live · next run now";
      if (ms < 60_000) return `Live · next run in ${Math.ceil(ms / 1000)} s`;
      return `Live · next run in ${Math.max(1, Math.round(ms / 60_000))} min`;
    }
    case "webhook": {
      const since = input.now - HOUR_MS;
      let fails = 0;
      for (const lane of input.strip?.lanes ?? [])
        for (const bar of lane.bars)
          if (bar.result === "fail" && Date.parse(bar.end) > since)
            fails += bar.count;
      return `Live · ${fails} in the last hour`;
    }
    case "heartbeat":
      return input.lastCheckIn
        ? `Live · last check-in ${clockTime(input.lastCheckIn)}`
        : "Live · no check-in yet";
  }
}

/** The strip's live line. With `nextRunAt` the strip counts down to the
 *  next check itself, so the text keeps up between refreshes. */
export interface StripLiveLine {
  tone: DotTone;
  text: string;
  nextRunAt?: string;
}

/** Bars a strip shows before its data arrives: 120 empty slots, the most
 *  plan 1 ever returns, so nothing grows when the data lands. */
export const LOADING_STRIP_BARS = 120;

/** An empty one-lane strip, drawn at final height while the real one loads. */
export function loadingStrip(label: string): StripResponse {
  const bucketMs = 60_000;
  return {
    from: new Date(0).toISOString(),
    to: new Date(LOADING_STRIP_BARS * bucketMs).toISOString(),
    bucketMs,
    markers: [],
    lanes: [
      {
        id: "loading",
        signalId: "loading",
        label,
        bars: Array.from({ length: LOADING_STRIP_BARS }, (_, i) => ({
          start: new Date(i * bucketMs).toISOString(),
          end: new Date((i + 1) * bucketMs).toISOString(),
          result: null,
          count: 0,
        })),
      },
    ],
  };
}
