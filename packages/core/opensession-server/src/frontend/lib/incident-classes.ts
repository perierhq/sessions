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

/** The status line's headline: page-title size, wrapping anywhere so a long
 *  or unbroken title never scrolls the page sideways. */
export const STATUS_LINE_HEADLINE =
  "m-0 flex min-w-0 items-start gap-3 text-page-title font-title text-fg";

/** Holds the dot at the height of the headline's first line. */
export const STATUS_LINE_DOT_SLOT = "flex h-[1lh] shrink-0 items-center";

/** The facts under the headline, aligned with its text past the dot. */
export const STATUS_LINE_FACTS =
  "m-0 pl-6 text-supporting text-dim [overflow-wrap:anywhere]";

/** The cause sentence: content, so it is selectable. */
export const INCIDENT_CAUSE_TEXT =
  "m-0 select-text text-body text-fg [overflow-wrap:anywhere]";

/** Where the cause came from and whether it was verified. */
export const INCIDENT_CAUSE_PROVENANCE =
  "m-0 text-meta text-dim [overflow-wrap:anywhere]";

/** One line of "What the agents did": a time, then what happened. */
export const AUDIT_ROW =
  "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3";

/** A group label inside "What the agents did". */
export const AUDIT_SECTION_LABEL = "m-0 text-label font-medium text-faint";

/** The next action's eyebrow: the dot, then what comes next. */
export const NEXT_EYEBROW =
  "flex min-w-0 items-center gap-1.5 text-meta font-medium text-dim";

/** The next action's buttons: right on a desktop, left and wrapping under
 *  a finger. */
export const NEXT_BUTTONS =
  "mt-3 flex flex-wrap items-center gap-2 desktop:justify-end";

/** "What the agents did": a quiet link, 44px tall under a finger. */
export const NEXT_AUDIT_LINK =
  "min-h-6 cursor-pointer border-none bg-transparent p-0 text-left text-meta text-dim hover:text-fg hover:underline focus-ring desktop:mr-auto phone:min-h-11";
