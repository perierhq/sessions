/**
 * A meter's fill. Normal usage is neutral ink, not green: an account that is
 * fine already says so in its "In rotation" pill, and three green bars per
 * account across nine accounts turned the whole page into colour with nothing
 * to look at. Colour here means "this one is running out" — so the two
 * accounts near a limit are the only things that catch the eye.
 */
export const USAGE_TONE_CLASSES = {
  unknown: "bg-line",
  high: "bg-red",
  warn: "bg-yellow",
  normal: "bg-faint",
} as const;

export type UsageTone = keyof typeof USAGE_TONE_CLASSES;

/** Utilization → tone. Shared so a meter and its neighbours can't drift. */
export function usageTone(pct: number | null): UsageTone {
  return pct === null
    ? "unknown"
    : pct >= 90
      ? "high"
      : pct >= 70
        ? "warn"
        : "normal";
}
