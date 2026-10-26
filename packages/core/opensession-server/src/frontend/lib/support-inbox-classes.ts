// Class strings for Settings → Inboxes and its form.

/** Two short fields side by side (port and security, the two retention
 *  counts); one column on the narrowest phones, under 390px. */
export const INBOX_FORM_PAIR =
  "grid grid-cols-2 items-end gap-3 max-[389px]:grid-cols-1";

/** A form select: full width, a 44px target on a phone. */
export const INBOX_SELECT = "w-full justify-between phone:min-h-11";

/** Test connection's result: IMAP and SMTP on their own lines. */
export const INBOX_TEST_LINES =
  "m-0 flex list-none flex-col gap-1 p-0 text-supporting [overflow-wrap:anywhere]";

/** A row's Edit button and Forget: 44px under a finger. */
export const INBOX_ROW_BUTTON = "phone:min-h-11 phone:min-w-11";

/** Forget a customer: the address field and its button on one line, the
 *  button under the field on a phone. */
export const FORGET_ROW = "flex gap-2 phone:flex-col";
export const FORGET_INPUT =
  "min-w-0 flex-1 phone:min-h-11 phone:text-input-phone";

/** Forget's result and what it couldn't delete. */
export const FORGET_RESULT =
  "m-0 mt-3 flex list-none flex-col gap-1 p-0 text-supporting text-dim";

/** An inbox's health under its address: the dot stays a dot when a long
 *  pause reason wraps. */
export const INBOX_HEALTH =
  "mt-1.5 flex items-start gap-1.5 text-label text-dim [overflow-wrap:anywhere]";
export const INBOX_HEALTH_DOT = "mt-[0.4lh] size-1.5 shrink-0 rounded-full";

/** A group label in the inbox form, in FormField's label type. */
export const INBOX_LEGEND = "m-0 p-0 text-label font-medium text-dim";

/** Autonomy's label with the drafts figure beside it; the figure goes
 *  under the label on a phone. */
export const INBOX_LEGEND_ROW =
  "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 phone:flex-col phone:items-start";

/** Watch, Draft and Routine, one per line. */
export const INBOX_AUTONOMY_CHOICES = "flex flex-col";

/** One autonomy choice: the radio, its name and its one line; the whole
 *  row is the target, 44px under a finger. */
export const INBOX_AUTONOMY_CHOICE =
  "flex min-h-11 cursor-pointer items-start gap-3 py-1.5";

/** "Learn from past replies" after an inbox is connected: its words, then
 *  the window and Import on one line under them; one per line on a phone. */
export const INBOX_LEARN_ROW = "flex flex-col gap-3";
export const INBOX_LEARN_CONTROLS =
  "flex items-center gap-2 phone:flex-col phone:items-stretch";
