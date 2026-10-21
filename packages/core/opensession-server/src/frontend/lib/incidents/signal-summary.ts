// What the incident views say about a signal: refresh cadence, latest value,
// lane kind, sort order. Pure.
import type { StripResponse } from "../../../shared/incidents";

const MINUTE_MS = 60_000;

/** How often an open strip refetches: its bucket, at most once a minute. */
export function stripRefreshMs(strip: StripResponse | undefined): number {
  if (!strip || !(strip.bucketMs > 0)) return MINUTE_MS;
  return Math.min(MINUTE_MS, strip.bucketMs);
}
