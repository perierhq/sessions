/** Visual shell and choice rows for the live AskUserQuestion card. */

/** The card's plate alone: raised fill, no border, generous corner. Pages
 *  that place a card themselves (the incident next action) use this. */
export const ASK_CARD_PLATE =
  "flex flex-col gap-5 rounded-xl bg-raised p-4 [corner-shape:var(--cs)]";

export const ASK_CARD_SHELL =
  "mx-auto mb-6 mt-2 w-full max-w-[var(--session-col)] " + ASK_CARD_PLATE;

export const ASK_CHOICE_ROW_BASE =
  "group relative flex min-h-11 w-full select-none items-start gap-3 rounded-[calc(12px*var(--rf))] bg-control px-3 py-2.5 text-left [corner-shape:var(--cs)]";

export const ASK_CHOICE_ROW = `${ASK_CHOICE_ROW_BASE} cursor-pointer transition-[background-color] hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-ink)]`;

/** Merged over ASK_CHOICE_ROW with `cn` for a quiet option row (AskCard's
 *  `groups`): the same row set smaller, for choices that follow the ones
 *  the card leads with. Still 44px on a phone. */
export const ASK_CHOICE_QUIET = "py-2 desktop:min-h-9";

/** The label over a group of options, on the rows' own text edge. */
export const ASK_GROUP_LABEL = "px-3 text-meta text-faint";

/** The label over a note a picked option needs (see AskCard's `notes`). */
export const ASK_NOTE_LABEL = "text-label font-semibold text-dim";

/** That note's field: the free-text row's well, several lines tall. 16px on
 *  a phone, or iOS zooms the page when it takes the caret. */
export const ASK_NOTE_FIELD =
  "min-h-22 w-full resize-y rounded-[calc(12px*var(--rf))] border-0 bg-control px-3 py-2.5 text-control-label leading-5 text-fg outline-none placeholder:text-faint disabled:opacity-60 phone:text-input-phone [corner-shape:var(--cs)]";
