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
/** The tabs scroll sideways on a phone rather than wrapping or shrinking. */
export const KNOWLEDGE_TABS_SCROLL =
  "mb-5 overflow-x-auto px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
export const KNOWLEDGE_TAB = "phone:min-h-11";
/** A count beside a tab's name. */
export const KNOWLEDGE_TAB_COUNT = "tabular-nums text-faint";

/** One item in a list: its title and badges, then its freshness line. */
export const KNOWLEDGE_ROW = "flex w-full flex-col gap-1 px-5 py-3.5";
export const KNOWLEDGE_ROW_HEAD = "flex min-w-0 flex-wrap items-center gap-1.5";
export const KNOWLEDGE_ROW_TITLE =
  "min-w-0 text-item-title font-medium text-fg [overflow-wrap:anywhere]";
export const KNOWLEDGE_ROW_LINE = "text-supporting text-dim phone:text-meta";
