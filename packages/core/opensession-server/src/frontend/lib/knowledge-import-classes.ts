// Class strings for a project's Knowledge → Import tab
// (components/settings/knowledge/KnowledgeImport).

/** One source: its words on the left, its button on the right; the button
 *  goes under the words, full width, on a phone. */
export const IMPORT_SOURCE =
  "flex items-start gap-4 px-5 py-4 phone:flex-col phone:items-stretch phone:gap-3";
/** The same row while files are dragged over it: the hover wash, filled to
 *  the card's corners. */
export const IMPORT_SOURCE_DROP = "bg-hover";
export const IMPORT_SOURCE_TEXT = "flex min-w-0 flex-1 flex-col gap-1";
export const IMPORT_SOURCE_TITLE = "text-item-title font-medium text-fg";
export const IMPORT_SOURCE_LINE = "text-supporting text-dim phone:text-meta";
/** A source's button: 44px under a finger, full width on a phone. */
export const IMPORT_SOURCE_ACTION =
  "shrink-0 phone:min-h-11 phone:w-full phone:justify-center";

/** The mailbox's inbox and window selects: side by side under the words on
 *  a desktop, one per line on a phone. */
export const IMPORT_MAILBOX_PICKS =
  "mt-2 grid grid-cols-[minmax(0,1fr)_9rem] gap-2 phone:grid-cols-1";
export const IMPORT_SELECT = "w-full justify-between phone:min-h-11";

/** The Support websites a crawl visits, one per line. */
export const IMPORT_HOSTS =
  "m-0 mt-1.5 flex list-none flex-col gap-1 p-0 text-supporting phone:text-meta";
export const IMPORT_HOST = "min-w-0 font-mono text-fg [overflow-wrap:anywhere]";
export const IMPORT_HOST_SKIPPED = "text-faint";

/** Files the server would refuse, each with its reason. */
export const IMPORT_REFUSED =
  "m-0 mt-1 flex list-none flex-col gap-0.5 p-0 [overflow-wrap:anywhere]";

/** One import: its line, what it is doing now and its progress track
 *  (indeterminate until the total is known), why it skipped, then when it
 *  started with Cancel at the end of that line. */
export const IMPORT_JOB = "flex flex-col gap-2 px-5 py-3.5";
export const IMPORT_JOB_LINE =
  "min-w-0 text-item-title font-medium text-fg [overflow-wrap:anywhere]";
export const IMPORT_JOB_FOOT =
  "flex min-h-7 items-center justify-between gap-3";
/** Cancel sits on the meta line without making it taller on a desktop;
 *  44px under a finger. */
export const IMPORT_JOB_CANCEL = "-my-1 -mr-2 shrink-0 phone:min-h-11";
export const IMPORT_JOB_META = "text-supporting text-dim phone:text-meta";
/** What a running import is doing; its counts hold their width. */
export const IMPORT_JOB_PHASE =
  "text-supporting text-dim tabular-nums phone:text-meta [overflow-wrap:anywhere]";
/** Why it skipped, under the counts. */
export const IMPORT_JOB_SKIPS =
  "text-supporting text-dim phone:text-meta [overflow-wrap:anywhere]";
export const IMPORT_JOB_ERROR =
  "text-supporting text-red phone:text-meta [overflow-wrap:anywhere]";
export const IMPORT_JOB_TRACK = "max-w-[420px] phone:max-w-none";
