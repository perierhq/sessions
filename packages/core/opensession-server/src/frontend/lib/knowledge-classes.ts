import { cn } from "../ui/cn";
import { PROJECT_PAGE_FRAME } from "./project-settings-classes";

// Class strings for a project's Knowledge: the summary on the project page
// (components/settings/project/KnowledgeSection) and the Knowledge page
// (components/settings/knowledge).

/** The four counts: a row of four on a desktop, two by two on a phone.
 *  `p-2` with `rounded-lg` cells keeps them concentric in the card's
 *  `rounded-2xl`. */
export const KNOWLEDGE_SECTION_COUNTS =
  "grid grid-cols-4 gap-1 p-2 phone:grid-cols-2";
/** One count: a button into its tab, 44px and more on both widths. */
export const KNOWLEDGE_SECTION_COUNT =
  "flex min-h-11 flex-col items-start gap-0.5 rounded-lg px-3 py-2.5 hover:bg-hover active:bg-pressed";
export const KNOWLEDGE_SECTION_COUNT_VALUE =
  "text-section-title font-title tabular-nums text-fg";
export const KNOWLEDGE_SECTION_COUNT_LABEL = "text-meta text-dim";

/** The back link and the tab bar under the page header. */
export const KNOWLEDGE_PAGE_BACK = "mb-3 px-5";
/** The tabs scroll sideways on a phone rather than wrapping or shrinking.
 *  The trailing edge fades (ui/overflow-fade-text's mask) so a cut tab reads
 *  as more to scroll; `pr-8` lets the last tab clear the fade once the bar
 *  is scrolled to its end, and the scroll padding keeps a tab brought into
 *  view clear of it too. */
export const KNOWLEDGE_TABS_SCROLL =
  "mb-5 overflow-x-auto px-5 scroll-px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
  "phone:pr-8 phone:scroll-pr-8 phone:[-webkit-mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_24px),transparent_100%)] " +
  "phone:[mask-image:linear-gradient(to_right,#000_0,#000_calc(100%_-_24px),transparent_100%)]";
export const KNOWLEDGE_TAB = "phone:min-h-11";
/** A count beside a tab's name. */
export const KNOWLEDGE_TAB_COUNT = "tabular-nums text-faint";

/** One item in a list: its title and badges, then its freshness line. */
export const KNOWLEDGE_ROW = "flex w-full flex-col gap-1 px-5 py-3.5";
export const KNOWLEDGE_ROW_HEAD = "flex min-w-0 flex-wrap items-center gap-1.5";
export const KNOWLEDGE_ROW_TITLE =
  "min-w-0 text-item-title font-medium text-fg [overflow-wrap:anywhere]";
export const KNOWLEDGE_ROW_LINE = "text-supporting text-dim phone:text-meta";

/** A row that opens its item: the whole row is the target, 44px and more,
 *  and the hover wash fills it to the card's corners. */
export const KNOWLEDGE_ROW_BUTTON =
  "flex w-full min-h-11 flex-col gap-1 px-5 py-3.5 hover:bg-hover active:bg-pressed";
/** A later page's ghost rows, at a row's padding. */
export const KNOWLEDGE_ROW_GHOST = "px-5 py-3.5";
/** A later page that couldn't load, as a row of the list: the alert's text
 *  and Retry without its own plate, which would be a card in the card. */
export const KNOWLEDGE_ROW_ALERT =
  "rounded-none border-0 bg-transparent px-5 py-3.5";

/** The search box and the new-article button above the list, on the
 *  header's x. */
export const KNOWLEDGE_TOOLBAR = "mb-3 flex items-center gap-2 px-5";
export const KNOWLEDGE_SEARCH =
  "min-w-0 flex-1 phone:min-h-11 phone:text-input-phone";
/** The filter chips: one line that scrolls sideways on a phone. */
export const KNOWLEDGE_CHIPS =
  "mb-4 flex gap-1 overflow-x-auto px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
export const KNOWLEDGE_CHIP = "shrink-0 phone:min-h-11";
/** The chip in effect: a grey plate in ink, quieter than the accent, which
 *  stays for the page's one action. */
export const KNOWLEDGE_CHIP_ON = `${KNOWLEDGE_CHIP} text-fg hover:text-fg`;
/** "Show more" under the list. */
export const KNOWLEDGE_MORE = "mt-3 flex justify-center";

/** The editor's page frame: the project page's frame without its own
 *  overflow, so the page's scroller (not this box, which never scrolls) is
 *  what the sticky Save bar sticks to. */
export const KNOWLEDGE_EDITOR_FRAME = cn(
  PROJECT_PAGE_FRAME,
  "overflow-visible",
);

/** The editor: groups of fields on the settings plate. */
export const KNOWLEDGE_EDITOR_GROUP = "mb-3 flex flex-col gap-4 p-5";
/** Two short controls side by side on a desktop, one column on a phone. */
export const KNOWLEDGE_EDITOR_PAIR = "grid grid-cols-2 gap-4 phone:grid-cols-1";
/** A control's label when the control isn't a single labelable element. */
export const KNOWLEDGE_EDITOR_LABEL = "text-label font-medium text-dim";
export const KNOWLEDGE_EDITOR_CONTROL = "flex min-w-0 flex-col gap-1.5";
/** Text fields: 16px on a phone so iOS doesn't zoom, 44px tall. */
export const KNOWLEDGE_EDITOR_INPUT = "phone:min-h-11 phone:text-input-phone";
export const KNOWLEDGE_EDITOR_LINES =
  "min-h-20 font-mono text-meta phone:text-input-phone";
export const KNOWLEDGE_EDITOR_BODY =
  "min-h-80 font-mono text-meta leading-relaxed phone:min-h-64 phone:text-input-phone";
export const KNOWLEDGE_EDITOR_HINT = "text-meta text-dim";
export const KNOWLEDGE_EDITOR_ERROR = "text-meta text-red";
/** "Confirm against the current docs": a row the switch sits at the end of. */
export const KNOWLEDGE_EDITOR_SWITCH_ROW =
  "flex min-h-11 items-center justify-between gap-3";
export const KNOWLEDGE_EDITOR_ATTACHMENTS = "flex flex-col gap-1";
export const KNOWLEDGE_EDITOR_ATTACHMENT =
  "min-h-8 truncate text-supporting text-fg underline underline-offset-2 phone:flex phone:min-h-11 phone:items-center";
/** Save and Retire, stuck to the bottom of the page while it scrolls, over
 *  the home indicator on a phone. */
export const KNOWLEDGE_EDITOR_BAR =
  "sticky bottom-0 z-10 flex flex-col gap-2 border-t border-divider-soft bg-bg px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]";
export const KNOWLEDGE_EDITOR_ACTIONS = "flex items-center justify-end gap-2";
export const KNOWLEDGE_EDITOR_ACTION = "phone:min-h-11";
