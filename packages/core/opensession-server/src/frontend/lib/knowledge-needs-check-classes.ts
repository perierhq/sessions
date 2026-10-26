// Class strings for the Knowledge page's Needs check tab
// (components/settings/knowledge/KnowledgeNeedsCheck).

/** "Check now" above the queue, on the header's x. */
export const NC_TOOLBAR = "mb-4 flex items-center justify-end gap-2 px-5";
/** A control a finger takes: 44px on a phone. */
export const NC_TAP = "phone:min-h-11";
/** The first group's label sits right under the toolbar. */
export const NC_FIRST_GROUP = "mt-0";
/** A row that opens its item: the whole row is the target. */
export const NC_ROW =
  "flex w-full min-h-11 flex-col gap-1 px-5 py-3.5 hover:bg-hover active:bg-pressed";

/** One item: back, its title and why it needs a check. */
export const NC_BACK = "mb-3 px-5";
export const NC_HEAD = "mb-4 flex flex-col gap-1.5 px-5";
export const NC_TITLE =
  "m-0 text-section-title font-title tracking-[-0.01em] text-fg [overflow-wrap:anywhere]";
export const NC_REASON = "m-0 text-supporting text-dim";
/** Still true, Edit, Retire: a row on a desktop, equal thirds on a phone. */
export const NC_ACTIONS = "mb-5 flex flex-wrap items-center gap-2 px-5";
export const NC_ACTION = "phone:min-h-11 phone:flex-1";

/** "Article / What changed": a phone shows one pane at a time. */
export const NC_SWITCH = "mb-3 px-5 desktop:hidden";
/** Two panes side by side on a desktop, one column on a phone. */
export const NC_PANES = "grid grid-cols-2 gap-3 phone:grid-cols-1";
/** A pane's own scroll on a desktop keeps the two the same height; on a
 *  phone the page scrolls. */
export const NC_PANE = "min-w-0";
/** The pane's label and text are one child of the card, so no row rule
 *  falls between them. */
export const NC_PANE_BODY = "flex min-w-0 flex-col";
/** The text's top room when a phone leaves the label out. */
export const NC_PANE_TEXT_ALONE = "phone:pt-5";
export const NC_PANE_LABEL =
  "flex min-h-11 items-center justify-between gap-2 px-5 pt-1 text-label font-medium text-dim";
export const NC_PANE_TEXT =
  "m-0 px-5 pb-5 leading-relaxed text-fg whitespace-pre-wrap [overflow-wrap:anywhere] desktop:max-h-[60vh] desktop:overflow-auto";
/** A patch, a source file or a "couldn't be read" note: as written, in
 *  the data face. */
export const NC_PANE_CODE = "font-mono text-meta";
/** An article, a page or release notes: rendered Markdown (`markdown` is
 *  the shared prose styling in base.css), with the pane's own scroll. */
export const NC_PANE_PROSE =
  "markdown px-5 pb-5 [overflow-wrap:anywhere] desktop:max-h-[60vh] desktop:overflow-auto";
/** A patch line, toned like the memory repository's diffs. */
export const NC_PATCH_LINE = "whitespace-pre-wrap [overflow-wrap:anywhere]";
export const NC_MISSING = "text-dim";
/** A link in a pane's label row, as tall as the row (44px) so a finger
 *  takes it. */
export const NC_LINK =
  "min-w-0 truncate leading-11 text-meta font-normal text-dim underline decoration-line-strong underline-offset-2 hover:text-fg";
