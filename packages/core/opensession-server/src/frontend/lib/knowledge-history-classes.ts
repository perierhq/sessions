// Class strings for a knowledge item's history
// (components/settings/knowledge/KnowledgeHistory), on the Knowledge page's
// row inset (lib/knowledge-classes KNOWLEDGE_ROW).

/** One commit: the toggle and Revert side by side on a desktop; on a phone
 *  Revert drops under the toggle, both 44px tall. */
export const HISTORY_ROW = "flex flex-col gap-3 px-5 py-3";
export const HISTORY_ROW_HEAD =
  "flex items-start gap-3 phone:flex-col phone:items-stretch";
/** The toggle: the subject and the line under it, outdented by its own
 *  padding so the text sits on the row's x. */
export const HISTORY_TOGGLE =
  "-mx-2 min-h-11 min-w-0 flex-1 items-start justify-start gap-2 whitespace-normal px-2 py-1 text-left font-normal";
export const HISTORY_CHEVRON = "mt-1 shrink-0 text-faint transition-transform";
export const HISTORY_SUBJECT =
  "block text-item-title leading-snug text-fg [overflow-wrap:anywhere]";
export const HISTORY_LINE = "mt-0.5 block text-meta text-dim";
export const HISTORY_SHA = "font-mono";
export const HISTORY_ACTIONS = "flex shrink-0 items-center gap-2";
export const HISTORY_REVERT = "phone:min-h-11 phone:w-full";
export const HISTORY_LOADING = "text-meta text-dim";
