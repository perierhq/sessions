// A signal window for a findings block: the strip narrowed to one lane, and
// the text a screen reader (and anyone skimming) reads instead of the bars.
// Pure, no DOM.
import type { StripResponse } from "../../../shared/incidents";
import { clockTime } from "../time";

/** The strip with only the window's lane: `lane` when given, else the lane
 *  without one (the main lane). */
export function windowStrip(
  strip: StripResponse,
  lane?: string,
): StripResponse {
  return {
    ...strip,
    lanes: strip.lanes.filter((l) =>
      lane === undefined ? l.lane === undefined : l.lane === lane,
    ),
  };
}

/**
 * `<from>–<to>: <n> checks, <f> failed, values <min>–<max>.`, from the same
 * bars the chart draws. The values part only when a bar has a value.
 */
export function stripSummary(
  strip: StripResponse,
  opts?: { clock?: (iso: string) => string; format?: (v: number) => string },
): string {
  const clock = opts?.clock ?? clockTime;
  const format = opts?.format ?? String;
  const range = `${clock(strip.from)}–${clock(strip.to)}`;
  let checks = 0;
  let failed = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const lane of strip.lanes)
    for (const bar of lane.bars) {
      checks += bar.count;
      if (bar.result === "fail") failed += bar.count;
      if (bar.value !== undefined && Number.isFinite(bar.value)) {
        min = Math.min(min, bar.value);
        max = Math.max(max, bar.value);
      }
    }
  if (checks === 0) return `${range}: no checks.`;
  const values = min <= max ? `, values ${format(min)}–${format(max)}` : "";
  return `${range}: ${checks} checks, ${failed} failed${values}.`;
}
