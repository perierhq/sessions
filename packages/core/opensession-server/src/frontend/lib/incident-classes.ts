// Class strings for the incident page, its signal strip and the home rows.
import { WS_SUMMARY_PAGE_SECTION } from "./workspace-summary-classes";

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

/** A marker label inside its row. It sits on the page's own fill, above
 *  the marker lines, so an upper-row line passes behind a lower-row label
 *  instead of through its text. */
export const STRIP_MARKER_LABEL =
  "absolute top-0 z-10 whitespace-nowrap bg-bg text-meta leading-[18px] text-dim tabular-nums";

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

/** The cause, rendered Markdown: content, so it is selectable. The first
 *  block is the sentence; any block after it is detail, one step quieter. */
export const INCIDENT_CAUSE_TEXT =
  "markdown select-text text-body text-fg [overflow-wrap:anywhere] [&>:not(:first-child)]:text-supporting [&>:not(:first-child)]:text-dim";

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

/** A button that stays focusable while it cannot be pressed
 *  (`aria-disabled`), so focus is not dropped when it flips. */
export const NEXT_BUTTON_INERT =
  "aria-disabled:pointer-events-none aria-disabled:opacity-40";

/** The next action's buttons: right on a desktop, left and wrapping under
 *  a finger. */
export const NEXT_BUTTONS =
  "mt-3 flex flex-wrap items-center gap-2 desktop:justify-end";

/** "What the agents did": a quiet link, 44px tall under a finger. */
export const NEXT_AUDIT_LINK =
  "min-h-6 cursor-pointer border-none bg-transparent p-0 text-left text-meta text-dim hover:text-fg hover:underline focus-ring desktop:mr-auto phone:min-h-11 phone:basis-full";

/** A summary band: its label and rows outdented so the labels line up with
 *  the cause text above. */
export const DETAIL_BAND = "-mx-2 flex min-w-0 flex-col";

/** The Agents band's sentence when an agent works on the host. Words, so
 *  the warning never rests on the colour alone. */
export const DETAIL_BAND_NOTE = "m-0 px-2 pb-1 text-meta text-yellow";

/** A summary row. Page-scale workspace-summary row; on a phone it may wrap
 *  its value onto a second line (DETAIL_VALUE_WRAP), so it grows past 44px
 *  instead of truncating both halves. */
export const DETAIL_ROW =
  "phone:h-auto phone:min-h-11 phone:flex-wrap phone:py-1.5 no-underline";

/** A summary row's value: right-aligned meta, truncating on a desktop
 *  before the label does. */
export const DETAIL_VALUE =
  "flex min-w-0 max-w-[60%] shrink items-center justify-end gap-2 truncate text-right text-meta text-dim tabular-nums";

/** The value under its label on a phone, aligned with the label's text. */
export const DETAIL_VALUE_WRAP =
  "phone:order-last phone:max-w-none phone:basis-full phone:justify-start phone:pl-6.5 phone:text-left";

/** The text inside a value, truncating with the value. */
export const DETAIL_VALUE_TEXT = "min-w-0 truncate";

/** The budget meter in the Agent cost row. */
export const DETAIL_METER = "w-14 shrink-0";

/** A row's trailing chevron: only rows that open something carry one. */
export const DETAIL_CHEVRON = "shrink-0 text-faint";

/** The incident page: its own bar above one scroller. */
export const INCIDENT_PAGE = "flex min-h-0 flex-1 flex-col bg-bg";

/** The page's desktop bar: project, chevron, title. A row across the top
 *  of the pane, so `wco-chrome` makes it the window's drag region. */
export const INCIDENT_TOPBAR =
  "wco-chrome flex h-[var(--desktop-header-h)] shrink-0 items-center gap-2 px-4 text-item-title text-fg phone:hidden";

/** The phone's bar: back to Incidents, the project centred. */
export const INCIDENT_PHONE_TOPBAR =
  "desktop:hidden w-full bg-bg pt-[env(safe-area-inset-top)] phone:h-auto phone:min-h-11";

/** The page's scroller. */
export const INCIDENT_SCROLL = "min-h-0 flex-1 overflow-y-auto";

/** The sections: 32px between them, each section keeps 16px inside (the 2×
 *  proximity rule). Bottom room clears the home indicator. */
export const INCIDENT_SECTIONS =
  "flex flex-col gap-8 pt-10 pb-16 phone:pt-4 phone:pb-[calc(32px+env(safe-area-inset-bottom))]";

/** The next action's plate while the incident loads. */
export const INCIDENT_PLATE_SKELETON = "h-[140px] rounded-xl bg-raised";

/** Where the strip would be when it failed to load: about its own height,
 *  so the sections below do not jump when Retry brings it back. */
export const INCIDENT_STRIP_ERROR =
  "flex min-h-[110px] flex-col justify-center";

/** A section label on the incident page ("Cause", "Fix"): the page-scale
 *  summary label, with the heading's own bottom margin taken off so the
 *  label sits on its rows. */
export const INCIDENT_SECTION_LABEL = `${WS_SUMMARY_PAGE_SECTION} mb-0`;

/** The Findings blocks: one column on a phone, two on a desktop, where a
 *  half block takes one and a full block both. Outdented by the blocks' own
 *  padding so their text lines up with the section label. */
export const FINDINGS_GRID =
  "-mx-2 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 desktop:grid-cols-2";

/** One block: no fill and no border, separated by spacing. The padding is
 *  room for the highlight's tint, which fades on the background colour
 *  only and not at all with reduced motion. */
export const FINDINGS_BLOCK =
  "flex min-w-0 flex-col gap-2 rounded-xl px-2 py-2 transition-colors duration-[var(--dur)] ease-[var(--ease)] motion-reduce:transition-none";

/** The short tint on a block whose content just changed. */
export const FINDINGS_HIGHLIGHT = "bg-accent-soft";

/** A block's heading: its title, or the kind's name. */
export const FINDINGS_BLOCK_TITLE =
  "m-0 text-item-title font-medium text-fg [overflow-wrap:anywhere]";

/** Who put the block there and when ("from the investigator, 14:32"). */
export const FINDINGS_BYLINE = "m-0 text-meta text-dim tabular-nums";

/** Agent prose in a block: content, so it is selectable. */
export const FINDINGS_PROSE =
  "markdown select-text text-body text-fg [overflow-wrap:anywhere]";

/** Prose one step quieter (what would answer a question, why a change). */
export const FINDINGS_PROSE_QUIET =
  "markdown select-text text-supporting text-dim [overflow-wrap:anywhere]";

/** One line of agent prose inside a row (a timeline event): Markdown for
 *  inline code and emphasis, in the row's own size and colour. */
export const FINDINGS_INLINE_PROSE =
  "markdown min-w-0 select-text [overflow-wrap:anywhere] [&_p]:m-0";

/** A small label inside a block ("What would answer it", "Rests on"). */
export const FINDINGS_LABEL = "m-0 text-label text-faint";

/** Quoted log lines: the code well, one line per row, wrapping anywhere so
 *  a long line never scrolls the page sideways. */
export const FINDINGS_LOG =
  "m-0 max-h-80 overflow-auto rounded-control bg-code-well px-3 py-2.5 font-mono text-meta leading-relaxed whitespace-pre-wrap text-code-well-ink [overflow-wrap:anywhere] select-text phone:max-h-64";

/** A highlighted line (`<mark>`): a tint across the well and a stripe on
 *  its leading edge, so the mark never rests on the colour alone. */
export const FINDINGS_LOG_MARK =
  "-mx-3 block border-l-2 border-yellow bg-yellow-soft pr-3 pl-2.5 text-inherit";

/** Where a quote came from ("from Datadog"). */
export const FINDINGS_SOURCE = "m-0 text-meta text-dim";

/** The same, quieter, when the agent could have produced the output
 *  itself (its shell, its workspace). */
export const FINDINGS_SOURCE_QUIET = "m-0 text-meta text-faint";

/** A hypothesis or claim status, in words with the colour behind them. */
export const FINDINGS_STATUS_TONE = {
  verified: "text-green",
  refuted: "text-red",
  "cant-tell": "text-dim",
  unchecked: "text-faint",
} as const;

/** A claim row: the claim, then its status and evidence under it. */
export const FINDINGS_CLAIM_ROW =
  "flex min-w-0 flex-col gap-0.5 border-b border-line py-2 last:border-b-0";

/** A sidebar incident row: the workspace row's shape without the room it
 *  clears for hover actions, because the trailing state never hides. */
export const SIDEBAR_INCIDENT_ROW = "flex items-center gap-[7px]";

/** The row's trailing state ("deploys 12:37", "needs you"): always shown,
 *  never shrinking, so the title gives way first. */
export const SIDEBAR_INCIDENT_STATE =
  "ml-auto shrink-0 whitespace-nowrap pl-1.5 pr-1.5 text-meta tabular-nums desktop:pr-1";

/** "All incidents" at the end of the band heading: shown on hover with a
 *  pointer, while the heading has keyboard focus (so Tab can reach it),
 *  and always under a finger (there is no hover to find it). */
export const SIDEBAR_INCIDENTS_ALL =
  "phone:inline-flex group-hover/band:inline-flex group-focus-within/band:inline-flex";

/** The home's rows, outdented so the tiles share the section labels' x. */
export const HOME_LIST = "-mx-2 flex min-w-0 flex-col";

/**
 * A home signal row: tile, name over caption, the mini signal, the latest
 * value. On a phone the mini signal takes its own full-width line under the
 * first. Rows are divided by a line; nothing is boxed.
 */
export const HOME_SIGNAL_ROW =
  "grid w-full min-w-0 cursor-pointer items-center gap-x-3 gap-y-2 border-b border-line bg-transparent px-2 py-2.5 text-left hover:bg-hover focus-ring " +
  "grid-cols-[auto_minmax(0,1fr)_auto] [grid-template-areas:'tile_text_value'_'mini_mini_mini'] " +
  "desktop:min-h-14 desktop:grid-cols-[auto_minmax(0,1fr)_160px_7rem] desktop:[grid-template-areas:'tile_text_mini_value']";

/** A heads-up row: tile, title over the reason, the state word. */
export const HOME_HEADS_UP_ROW =
  "flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 border-b border-line bg-transparent px-2 py-2.5 text-left hover:bg-hover focus-ring";

export const HOME_ROW_NAME = "truncate text-item-title text-fg";
export const HOME_ROW_CAPTION = "truncate text-meta text-dim";

/** The latest value, right-aligned, its width held by tabular numerals. */
export const HOME_ROW_VALUE =
  "justify-self-end whitespace-nowrap text-right text-supporting tabular-nums [grid-area:value]";

/** The mini signal's box: 160px on a desktop row, the row's width on a
 *  phone, always its final height so bars landing do not move it. */
export const HOME_MINI =
  "block h-5 w-full min-w-0 [grid-area:mini] desktop:w-40";

/** A past incident: a table row whose title button covers the row. */
export const PAST_ROW = "relative border-b border-line hover:bg-hover";
export const PAST_HEAD =
  "border-b border-line text-label font-normal text-faint phone:sr-only";
export const PAST_CELL =
  "h-12 px-2 py-2 align-middle phone:h-auto phone:py-2.5";
export const PAST_TITLE_BUTTON =
  "block w-full min-w-0 cursor-pointer truncate bg-transparent p-0 text-left text-item-title text-fg focus-ring after:absolute after:inset-0";
export const PAST_NUMBER =
  "whitespace-nowrap text-right text-supporting tabular-nums text-dim";

/** A home button (`Add a signal`, `Show 20 more`): a finger-sized target on
 *  a phone. */
export const HOME_BUTTON = "phone:min-h-11";

/** A findings signal window's bars in words, under the chart: one line,
 *  kept while the window loads so the block does not grow when it lands. */
export const FINDINGS_STRIP_SUMMARY =
  "m-0 text-meta text-dim tabular-nums [overflow-wrap:anywhere]";

/** A compare block's two sides; the caller adds the desktop's two columns
 *  when the block spans both. */
export const FINDINGS_COMPARE = "grid min-w-0 grid-cols-1 gap-x-4 gap-y-4";

/** A change block's line: `PR #12 · title` or `abc1234 · title`. Its height
 *  is held while the change loads. */
export const FINDINGS_CHANGE_TITLE =
  "m-0 text-body font-medium text-fg [overflow-wrap:anywhere]";

/** The Findings section's heading and its "Round 2 under way" line,
 *  outdented like the Cause section's so the label's text lines up with
 *  the blocks' text and the rest of the page. */
export const FINDINGS_SECTION_HEAD = "-mx-2 flex min-w-0 flex-col";

/** "Round 2 under way": quiet, under the heading. */
export const FINDINGS_UNDER_WAY = "m-0 px-2 text-supporting text-faint";

/** A cell of the Findings grid: one column on a phone; a half block takes
 *  one desktop column, a full block both. */
export const FINDINGS_CELL_HALF = "min-w-0 desktop:col-span-1";
export const FINDINGS_CELL_FULL = "min-w-0 desktop:col-span-2";

/** A findings marker the agent added without a checked reference: its
 *  own note, so a dashed, lighter line and a quieter label than the
 *  strip's checked markers. */
export const STRIP_NOTE_LINE =
  "pointer-events-none absolute w-0 border-l border-dashed border-line";
export const STRIP_NOTE_LABEL = "text-faint";
