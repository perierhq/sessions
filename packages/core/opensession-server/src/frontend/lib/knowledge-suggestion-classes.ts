// Class strings for the Knowledge page's Suggestions tab
// (components/settings/knowledge/KnowledgeSuggestions).

/** "Select all" and the batch actions over the list. On a phone the
 *  actions move to the bottom bar and only "Select all" stays here. */
export const SUGGESTIONS_TOOLBAR =
  "flex min-h-14 items-center gap-2 px-5 py-2 phone:min-h-12";
/** A label around a checkbox: the whole label is the hit area, 44px tall
 *  on both widths. */
export const SUGGESTIONS_CHECK_LABEL =
  "flex min-h-11 min-w-0 cursor-pointer items-center gap-3 text-supporting text-dim select-none";
export const SUGGESTIONS_TOOLBAR_ACTIONS =
  "ml-auto flex items-center gap-2 phone:hidden";

/** One suggestion: a checkbox with its title and line, then Edit. */
export const SUGGESTION_ROW = "flex items-center gap-2 py-1 pr-3 pl-5";
/** The label: the checkbox and the text, so tapping the title picks it. */
export const SUGGESTION_ROW_LABEL =
  "flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 py-2.5";
/** Drops the checkbox onto the title's first line. */
export const SUGGESTION_ROW_CHECK = "mt-0.5";
export const SUGGESTION_ROW_TEXT = "flex min-w-0 flex-col gap-1";
export const SUGGESTION_ROW_EDIT = "shrink-0 phone:min-h-11";

/** The phone's bottom bar with the batch actions, over a fade so rows pass
 *  behind it legibly; it clears the home indicator. */
export const SUGGESTIONS_PHONE_BAR =
  "fixed inset-x-0 bottom-0 z-30 hidden gap-2 px-3.5 pt-6 " +
  "pb-[max(12px,env(safe-area-inset-bottom,0px))] phone:flex " +
  "bg-[linear-gradient(to_bottom,transparent_0%,var(--bg)_40%)]";
export const SUGGESTIONS_PHONE_BAR_BUTTON = "min-h-11 flex-1";
/** Room under the list for the bottom bar while it shows. */
export const SUGGESTIONS_PHONE_BAR_SPACE = "phone:pb-24";

/** The approve-with-edits form. */
export const SUGGESTION_EDIT_FORM = "flex flex-col gap-3.5 p-5";
export const SUGGESTION_EDIT_TITLE = "text-item-title font-semibold text-fg";
export const SUGGESTION_EDIT_INPUT = "phone:min-h-11 phone:text-input-phone";
export const SUGGESTION_EDIT_BODY =
  "min-h-48 resize-y py-2 phone:text-input-phone";
export const SUGGESTION_EDIT_ERROR = "text-meta text-red";
export const SUGGESTION_EDIT_ACTIONS =
  "flex justify-end gap-2 phone:[&>*]:min-h-11 phone:[&>*]:flex-1";
