// Class strings for the project settings page (components/settings/project).

/** The page frame: a Settings tool view brings its own scroll and padding.
 *  On a phone the sheet already pads its column. */
export const PROJECT_PAGE_FRAME =
  "flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pt-11 pb-22 phone:px-0 phone:pt-0 phone:pb-12";

/** The project header: tile, name, and where it lives. */
export const PROJECT_HEADER = "mb-6 flex items-center gap-3 px-5";
export const PROJECT_HEADER_NAME =
  "m-0 truncate text-page-title font-title tracking-[-0.02em] text-fg";
export const PROJECT_HEADER_SUB =
  "m-0 mt-0.5 truncate text-supporting text-dim";

/** A section's heading, at the weight of "Where agents run" in the
 *  designs. `scroll-mt` keeps an anchored section clear of the top edge. */
export const PROJECT_SECTION = "scroll-mt-6";
export const PROJECT_SECTION_HEAD =
  "mt-10 mb-2.5 flex min-h-11 items-center justify-between gap-3 px-5";
export const PROJECT_SECTION_TITLE =
  "m-0 text-section-title font-semibold tracking-[-0.01em] text-fg";

// ── Readiness checklist ───────────────────────────────────────────────────

export const CHECKLIST_HEAD =
  "flex items-start justify-between gap-4 px-5 py-4";
/** The title at section-heading weight, so the checklist reads first. */
export const CHECKLIST_TITLE =
  "m-0 text-section-title font-semibold tracking-[-0.01em] text-fg";
export const CHECKLIST_SUB = "m-0 mt-1 text-supporting text-dim";
export const CHECKLIST_SEGMENTS = "mt-1.5 flex shrink-0 gap-1";
const SEGMENT = "h-3.5 w-2.5 rounded-sm";
export const CHECKLIST_SEGMENT = {
  ready: `${SEGMENT} bg-green/45`,
  todo: `${SEGMENT} bg-fg/10`,
  blocked: `${SEGMENT} bg-red`,
} as const;

/** One step: its mark, its words, and its fix on the right. */
export const CHECKLIST_ROW =
  "flex flex-wrap items-start gap-x-3 gap-y-3 px-5 py-3.5";
export const CHECKLIST_MARK =
  "mt-0.5 flex size-5 shrink-0 items-center justify-center";
export const CHECKLIST_TODO_MARK =
  "size-[18px] rounded-full border-[1.5px] border-dashed border-faint";
export const CHECKLIST_BLOCKED_MARK =
  "flex size-[18px] items-center justify-center rounded-full bg-red text-[11px] font-bold leading-none text-white";
export const CHECKLIST_READY_MARK =
  "flex size-[18px] items-center justify-center rounded-full bg-green text-white";
export const CHECKLIST_TEXT = "min-w-0 flex-1";
export const CHECKLIST_STEP_TITLE = "text-item-title font-medium text-fg";
export const CHECKLIST_STEP_DETAIL =
  "mt-0.5 text-supporting text-dim phone:text-meta";
/** The fix: visibly 44px on a phone, beside the words on a desktop. */
export const CHECKLIST_FIX =
  "shrink-0 phone:min-h-11 phone:ml-8 phone:basis-auto";
/** A folded group ("4 ready", "2 more to do"): the whole row toggles. */
export const CHECKLIST_FOLD =
  "focus-ring flex min-h-11 w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-hover";
export const CHECKLIST_FOLD_SUMMARY =
  "min-w-0 flex-1 truncate text-supporting text-dim phone:whitespace-normal";
export const CHECKLIST_FOLD_TOGGLE =
  "flex shrink-0 items-center gap-1 text-supporting text-dim";

// ── Connect a sandbox (blocked on where agents run) ──────────────────────

export const CONNECT_FORM = "flex w-full flex-col gap-3 pl-8 phone:pl-0";
export const CONNECT_CHOICES = "grid grid-cols-2 gap-2";
export const CONNECT_CHOICE =
  "focus-ring flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left has-[:checked]:border-fg";
export const CONNECT_FIELDS =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)_auto] items-end gap-2 phone:grid-cols-1";
export const CONNECT_INPUT = "phone:min-h-11 phone:text-input-phone";
export const CONNECT_BUTTON = "phone:min-h-11 phone:w-full";

// ── Where agents run ─────────────────────────────────────────────────────

/** "Default" / "Set here": one slot, one shape, paint changes only. */
export const SETTING_CHIP =
  "inline-flex h-6 shrink-0 items-center rounded-md px-2 text-meta font-medium";
export const SETTING_CHIP_DEFAULT = `${SETTING_CHIP} bg-fg/6 text-faint`;
export const SETTING_CHIP_SET = `${SETTING_CHIP} bg-fg/10 text-fg`;
/** "Set here" is also the way back to the default: a 44px target around
 *  the chip without moving it. */
export const SETTING_CHIP_BUTTON =
  "focus-ring relative before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] hover:bg-fg/14";
export const ROW_CONTROLS =
  "ml-auto flex shrink-0 items-center gap-2 phone:max-w-[60%] phone:flex-wrap phone:justify-end";

export const ROLE_GRID =
  "grid grid-cols-4 gap-x-4 gap-y-3 px-5 pb-3 phone:grid-cols-2";
export const ROLE_GRID_LABEL = "text-meta text-faint";
export const ROLE_GRID_VALUE =
  "mt-0.5 flex items-center gap-1.5 text-supporting text-fg";
export const ROLE_GRID_VALUE_BAD = "text-red";
/** The note under the role grid: plain secondary text, never a banner. */
export const ROLE_GRID_NOTE =
  "px-5 pb-4 text-supporting text-dim phone:text-meta";

// ── Production ───────────────────────────────────────────────────────────

export const PRODUCTION_ROW =
  "flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5";
export const PRODUCTION_ROW_BUTTON = `focus-ring w-full text-left hover:bg-hover ${PRODUCTION_ROW}`;
export const PRODUCTION_TILE =
  "flex size-8 shrink-0 items-center justify-center rounded-md bg-fg/6 text-dim";
export const PRODUCTION_TEXT = "min-w-0 flex-1";
export const PRODUCTION_TITLE = "block text-item-title font-medium text-fg";
export const PRODUCTION_DESC =
  "mt-0.5 block text-supporting text-dim phone:text-meta";
/** The full command; on a phone it keeps both ends and drops the middle. */
export const PRODUCTION_COMMAND =
  "mt-0.5 flex min-w-0 items-baseline gap-1.5 font-mono text-meta text-dim";
export const PRODUCTION_VALUE =
  "ml-auto flex shrink-0 items-center gap-1.5 text-supporting text-dim";
export const ONLINE_DOT = "size-1.5 rounded-full bg-green";
export const OFFLINE_DOT = "size-1.5 rounded-full bg-faint";

// ── What agents may use ──────────────────────────────────────────────────

/** Five equal 96px role columns beside the row titles. */
export const ACCESS_GRID =
  "grid grid-cols-[minmax(0,1fr)_repeat(5,96px)] items-center";
export const ACCESS_HEAD_CELL =
  "py-2.5 text-center text-meta font-medium text-dim";
export const ACCESS_GROUP_LABEL =
  "col-span-6 px-5 pt-3.5 pb-1 text-meta font-medium text-faint";
export const ACCESS_ROW_RULE = "col-span-6 mx-5 h-px bg-line";
export const ACCESS_TITLE_CELL = "min-w-0 py-2.5 pl-5 pr-3";
export const ACCESS_ROW_TITLE =
  "flex items-center gap-1.5 text-body font-medium text-fg";
export const ACCESS_ROW_DETAIL = "mt-0.5 text-meta text-faint";
export const ACCESS_ROW_WARNING = "mt-0.5 text-meta text-yellow";
export const ACCESS_ALLOW = "mt-1.5 phone:min-h-11";
/** An editable cell: the whole column-width, 44px tall target. */
export const ACCESS_CELL_BUTTON =
  "focus-ring relative flex min-h-11 w-full items-center justify-center rounded-control text-supporting hover:bg-hover";
/** A cell that can't change: words, with why on hover, focus or tap. */
export const ACCESS_CELL_STATIC =
  "focus-ring relative flex min-h-11 w-full cursor-default items-center justify-center rounded-control text-supporting before:absolute before:inset-0 before:content-['']";
export const ACCESS_KEY = "mt-2 px-5 text-supporting text-faint";

/** The phone role picker: sticky, wrapping, every chip a 44px target. */
export const ROLE_CHIPS =
  "sticky top-0 z-10 -mx-1 flex flex-wrap gap-x-1.5 gap-y-0 bg-surface px-1 py-1";
export const ROLE_CHIP =
  "focus-ring relative inline-flex h-8 items-center rounded-[999px] px-3 text-supporting font-medium my-1.5 before:absolute before:-inset-y-1.5 before:-inset-x-0.5 before:content-['']";
export const ROLE_CHIP_OFF = `${ROLE_CHIP} bg-fg/7 text-dim`;
export const ROLE_CHIP_ON = `${ROLE_CHIP} bg-fg text-surface`;
export const ROLE_LIST_HINT = "px-5 pt-3 pb-1 text-meta text-dim";
export const ROLE_LIST_ROW = "flex min-h-11 items-center gap-3 px-5 py-2.5";
export const ROLE_LIST_TOGGLE =
  "focus-ring relative flex size-11 shrink-0 items-center justify-center rounded-control hover:bg-hover";
export const ROLE_LIST_CHECK_ON =
  "flex size-6 items-center justify-center rounded-md bg-fg text-surface";
export const ROLE_LIST_CHECK_OFF =
  "size-6 rounded-md border-[1.5px] border-line-strong";
export const ROLE_LIST_VALUE_BUTTON =
  "focus-ring flex min-h-11 shrink-0 items-center gap-1 rounded-control px-2 text-supporting text-dim hover:bg-hover";

// ── Sheets ────────────────────────────────────────────────────────────────

export const SHEET_CHOICE =
  "focus-ring flex min-h-11 w-full items-center gap-3 rounded-row px-3 py-2.5 text-left hover:bg-hover";
export const SHEET_CHOICE_TITLE = "block text-item-title font-medium text-fg";
export const SHEET_CHOICE_DESC = "mt-0.5 block text-meta text-dim";

/** The access table's rows and groups, each separated by an inset rule. */
export const ACCESS_RULES =
  "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']";
/** A small button grown to a 44px target without moving anything. */
export const HIT_44 =
  "relative before:absolute before:-inset-y-[9px] before:-inset-x-1 before:content-['']";
