/**
 * The support conversation's surfaces — a Plain thread as it renders in the
 * ticket pane, the workspace Conversation tab and the swipe deck.
 *
 * Every block here used to be drawn inside a hairline: a message, a note, an
 * attachment and each action all carried a box of their own, so a thread was
 * four nested outlines deep on a page whose only job is to be read.
 * `src/frontend/AGENTS.md` has the rule — a block sitting on its own fill is
 * already separated from the page, and an edge around it adds a second one. So
 * a message is a plate, a note takes the yellow wash the transcript already
 * gives a team note (lib/tinted-surface.ts), and the actions are the Button
 * primitive at its quiet weight.
 *
 * The two sides are deliberately not symmetrical, and a thread is read the way
 * a session transcript is. What you came here to read carries no surface at
 * all; your own half of the conversation is a bubble hugging the right edge.
 * Plating both sides put two facing walls of grey down the page and said who
 * spoke three times over — in the name, in the edge the message hugs, and
 * again in colour.
 */

/** A message: the head, then the message under it. Full width on both sides —
 *  which edge a message hugs is decided by the block inside, not by this row. */
export const plainEntryRow = "flex flex-col gap-1";

/** A message from the customer. No surface: this is the page's content, not a
 *  card on it. */
export const plainEntryIn = "flex flex-col gap-1";

/** A message from our side: a teammate's reply, the autoresponder, an agent.
 *  The transcript's own reply bubble, at the same cap, corner and padding
 *  (`msgBubbleUser`, lib/msg-classes.ts). */
export const plainEntryOut =
  "flex max-w-[min(600px,90%)] flex-col gap-1 self-end rounded-lg bg-panel " +
  "px-3.5 py-2.5";

/** An internal note. Full width and washed rather than plated, so it reads as
 *  an aside on the thread instead of another message in it. The wash itself is
 *  inline: `color-mix` on a token can't be a compiled utility. */
export const plainEntryNote = "flex flex-col gap-1 rounded-2xl px-4 py-3";

/** The name / channel / time line over a message. Mirrored on our own side so
 *  the name lands on the edge the message hugs — the transcript's own rule for
 *  a speaker label (lib/msg-classes.ts). */
export const plainEntryHead = "flex flex-wrap items-baseline gap-x-2 gap-y-0.5";

/** Who spoke. */
export const plainEntryName = "text-supporting font-semibold text-fg";

/** Channel and time, in one faint run: two separate spans read as two facts
 *  when they are one aside. */
export const plainEntryMeta = "text-meta text-faint";

/** The message itself, at the transcript's reading size — this is the page's
 *  content, not a preview of it. Rendered markdown, the same as a session
 *  message: a customer writing `**test**` means it, and a pasted stack trace
 *  belongs in a fence rather than in the prose. `breaks: true` on the shared
 *  renderer (lib/markdown.ts) keeps an email's hard line breaks, which is why
 *  this no longer needs `whitespace-pre-wrap`: that would double every one. */
export const plainEntryBody =
  "markdown break-words text-body leading-relaxed text-fg " +
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0";

/** An email's quoted history and signature, once shown: the message's own
 *  reading type, a step quieter, so what the sender wrote this time stays
 *  the loudest thing in the row. */
export const plainEntryQuoted =
  "markdown break-words text-body leading-relaxed text-dim " +
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0";

/** The "Show quoted text" / "Show signature" toggle: a small pill under the new text, the way
 *  a mail client folds the history. `before:` grows the 24px pill to a 44px
 *  target without moving the text around it. */
export const plainEntryQuoteToggle =
  "relative inline-flex h-6 items-center gap-1.5 self-start rounded-[999px] " +
  "bg-active px-2.5 text-meta text-dim transition-colors hover:bg-hover " +
  "hover:text-fg before:absolute before:-inset-x-1 before:-inset-y-2.5 " +
  "before:content-['']";
