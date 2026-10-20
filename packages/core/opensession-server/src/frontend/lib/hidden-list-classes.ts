/**
 * The sidebar's Hidden list (components/sidebar/HiddenEntry.tsx): a popover
 * beside the sidebar on desktop and a bottom sheet on phones. Rows follow the
 * Archived list (lib/archived-classes.ts): an open button stretched over the
 * whole row and an inset hairline between rows. Restore stays visible rather
 * than appearing on hover, because the list exists to offer it.
 */

/** Desktop popover. Wide enough for a title beside its Restore button. */
export const HIDDEN_POPUP =
  "flex max-h-[min(480px,calc(100vh-96px))] w-[340px] flex-col overflow-hidden";

export const HIDDEN_POPUP_HEADER = "shrink-0 px-4 pt-3.5 pb-1.5";

export const HIDDEN_POPUP_TITLE = "text-control-label font-semibold text-fg";

export const HIDDEN_POPUP_LIST =
  "m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 px-1 pb-1.5";

/** The phone sheet's header: the title and its close button. */
export const HIDDEN_SHEET_HEADER =
  "flex shrink-0 items-center gap-3 px-6 pt-0.5 pb-2";

export const HIDDEN_SHEET_TITLE =
  "m-0 min-w-0 flex-1 text-dialog-title leading-tight font-semibold tracking-[-0.01em] text-fg";

export const HIDDEN_SHEET_LIST = "m-0 list-none p-0";

/**
 * A row. The separator is the row's own `::after`, inset past the tile and
 * gone on the last row and around a lit one, as in Archived.
 */
export const HIDDEN_ROW =
  "group relative flex items-center gap-3 rounded-control py-2 pr-2 pl-3 " +
  "transition-colors duration-[var(--dur-micro)] ease-[var(--ease)] " +
  "hover:bg-hover focus-within:bg-hover " +
  "after:pointer-events-none after:absolute after:right-3 after:bottom-0 after:left-[42px] " +
  "after:h-px after:bg-line after:transition-opacity after:duration-[var(--dur-micro)] " +
  "hover:after:opacity-0 focus-within:after:opacity-0 " +
  "phone:min-h-11 phone:py-3 phone:pr-1.5 phone:pl-3.5 phone:after:left-[46px]";

/** The last row, and the row above a lit one, drop their separator. */
export const HIDDEN_ROW_ITEM =
  "last:[&>div]:after:opacity-0 [&:has(+li:hover)>div]:after:opacity-0 " +
  "[&:has(+li:focus-within)>div]:after:opacity-0";

/** The leading mark: the repo tile, or an empty slot of the same size. */
export const HIDDEN_ROW_MARK =
  "flex size-[18px] shrink-0 items-center justify-center";

/** Stretched over the row, so a click anywhere but Restore opens it. */
export const HIDDEN_ROW_OPEN =
  "focus-ring min-w-0 flex-1 cursor-pointer rounded-sm border-none bg-transparent p-0 " +
  "text-left after:absolute after:inset-0 after:content-['']";

export const HIDDEN_ROW_TITLE =
  "block min-w-0 truncate text-label text-fg phone:text-body";

export const HIDDEN_ROW_META =
  "mt-0.5 flex min-w-0 items-center gap-2.5 text-meta text-faint";

/** Restore sits above the stretched open button. */
export const HIDDEN_ROW_RESTORE = "relative z-[1] shrink-0 phone:min-h-11";
