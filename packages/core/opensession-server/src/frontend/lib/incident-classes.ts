// Class strings for the incident page, its signal strip and the home rows.

/** The page column: the status line, strip, next action, cause and details
 *  share one measure. */
export const INCIDENT_COLUMN = "mx-auto w-full max-w-[720px] px-6 phone:px-4";

/** The strip's title and its live line, on one row. */
export const STRIP_HEADER =
  "flex h-5 min-w-0 items-center justify-between gap-3 text-meta text-dim";

const STRIP_LANE_BASE =
  "relative cursor-pointer select-none rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-ink)] phone:h-11";

/** One lane of bars: 36px, 44px under a finger. Focus is drawn on the lane,
 *  the bar under it carries the active outline. */
export const STRIP_LANE = `h-9 ${STRIP_LANE_BASE}`;

/** The fix branch's lane under the main one: shorter on a desktop, so it
 *  reads as a footnote to the signal; still 44px under a finger. */
export const STRIP_VERIFY_LANE = `h-5 ${STRIP_LANE_BASE}`;

/** A lane's name, above its bars when the strip has more than one lane. */
export const STRIP_LANE_LABEL =
  "block h-4 truncate text-meta leading-4 text-faint";

/** One row of marker labels; fixed height, so packing never moves a lane. */
export const STRIP_MARKER_ROW = "relative h-[18px]";

/** A marker label inside its row. */
export const STRIP_MARKER_LABEL =
  "absolute top-0 whitespace-nowrap text-meta leading-[18px] text-dim tabular-nums";

/** A marker line through every lane. */
export const STRIP_MARKER_LINE =
  "pointer-events-none absolute w-px bg-line-strong";

/** Where the past ends: a dashed vertical rule. */
export const STRIP_LIVE_EDGE =
  "pointer-events-none absolute w-0 border-l border-dashed border-line-strong";

/** The lanes past eight scroll: 8 × (36 + 16 label) px, 8 × (44 + 16) on a
 *  phone. The gutter is reserved so the bars never shift under a scrollbar. */
export const STRIP_LANES_SCROLL =
  "max-h-[416px] overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] phone:max-h-[480px]";

/** A value lane's axis: min left, max right, under the lanes. */
export const STRIP_AXIS =
  "flex h-4 justify-between text-meta leading-4 text-faint tabular-nums";

/** The threshold's name, at the left of its dotted line. */
export const STRIP_THRESHOLD_LABEL =
  "pointer-events-none absolute left-0 -translate-y-full text-meta leading-4 text-faint";

/** Key/value grid of one observation. */
export const OBSERVATION_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-label text-fg";
