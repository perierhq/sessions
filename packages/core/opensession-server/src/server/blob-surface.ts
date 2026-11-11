/**
 * Where a supervisor reply will be shown when it comes from the Blob app, so
 * the supervisor can write a view that fits (adrs/blob-views.md). Blob talks
 * to the supervisor (supervisor.ts, adrs/supervisor-and-leads.md), not the
 * Desk, so only supervisor sessions listen.
 *
 * Blob sends `surface: { app: "blob", panes, width }` with each prompt. It is
 * persisted on the session file like the composer's effort and speed
 * (maybePersistEffort/Speed), so a queued or resumed turn still sees it, and
 * cleared by a prompt that carries none, so the same supervisor opened on the
 * web goes back to ordinary replies. A supervisor turn then gets it as wrapped
 * per-turn context, the way it already gets `deskStateContext`.
 */
import { wrapContext } from "./prompt-context";
import { touchNativeSession } from "./session-cache";
import type { BlobSurface, UnifiedSession } from "./types";

/** A surface older than this is a Blob that has gone away; ignore it. */
const FRESH_MS = 30 * 60 * 1000;

/** The wire shape, validated. Anything else is no surface. */
export function parseBlobSurface(
  raw: unknown,
  now: Date = new Date(),
): BlobSurface | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.app !== "blob") return undefined;
  const panes = r.panes === 2 ? 2 : r.panes === 1 ? 1 : undefined;
  const width =
    r.width === "regular"
      ? "regular"
      : r.width === "compact"
        ? "compact"
        : undefined;
  if (!panes || !width) return undefined;
  return { panes, width, at: now.toISOString() };
}

/**
 * Record or clear the session's Blob surface from a prompt's `surface` field.
 * Only the supervisor listens, so other sessions are left alone.
 */
export function maybePersistBlobSurface(
  session: UnifiedSession | undefined,
  raw: unknown,
): void {
  if (!session?.supervisor || session.source !== "opensession") return;
  const next = parseBlobSurface(raw);
  if (!next && !session.blobSurface) return;
  touchNativeSession(session.id, { blobSurface: next });
  session.blobSurface = next;
}

/**
 * Say and show: how a reply is split in Blob. A ```say fence opens the reply
 * with the script Blob speaks, written for the ear; everything after it is
 * shown and never spoken. A `{#id}` cue in the script points at the shown
 * element carrying the same id (docs/blocks.md, "Spoken script"). The
 * app reads the fence (BlobReply.swift, BlobCues.swift); a reply without one
 * falls back to speaking its first paragraph.
 */
export const SAY_SHOW_LINES = [
  "Write every reply in two parts: what Blob says, then what Blob shows.",
  "Say: open with a ```say fence holding the script Blob speaks aloud. Write it for the ear: one to three short sentences, natural spoken words and contractions, no markdown, lists, tables, URLs or ids read aloud, and no numbers read out like a table.",
  'It talks about what is shown and never repeats it ("Here\'s what happened overnight. The two things that matter are on screen."). It may start with a delivery hint in square brackets, like [warm, unhurried], only when the tone helps.',
  "Show: everything after the say fence is shown and never spoken. View first, prose minimal: point at the real things (sessions, pull requests, incidents, people) as links the app can open, with their status, and use timelines, images and screenshots, and choices for a decision, from the block catalog in docs/blocks.md.",
  "Cues: only when pointing helps, and at most one per sentence, put {#id} in the script where the speech turns to a shown element, at a sentence start or mid-sentence (\"Checkout flapped again right after 2.3.4, {#pr-12} and Pat's fix is waiting.\"), and give that element the same id: after a fence's language (```metrics {#stats}), right after a link ([PR #12](url){#pr-12}), or at the end of a line. Blob focuses the element when the words after the cue start; the cue itself is never read. Keep at least four words between cues; ids are short, made of letters, digits and dashes.",
  "Tables only when the owner asked for data. No paragraph recaps. Keep it to what fits; offer the rest as choices instead of writing it out.",
] as const;

/** The whole block when the supervisor is written to from elsewhere (the
 *  web), so it replaces an older Blob block (supervisor-briefing-trim.ts). */
export const NOT_IN_BLOB =
  "Not in Blob this turn: write a normal reply with no say fence.";

/** The context note for this turn: where Blob shows the reply, or
 *  `NOT_IN_BLOB`. Nothing for a session that isn't the supervisor. */
export function blobSurfaceContext(
  session: Pick<UnifiedSession, "supervisor" | "blobSurface">,
  now: Date = new Date(),
): string | undefined {
  if (!session.supervisor) return undefined;
  const s = session.blobSurface;
  const at = s ? Date.parse(s.at) : NaN;
  if (!s || !Number.isFinite(at) || now.getTime() - at > FRESH_MS)
    return wrapContext(NOT_IN_BLOB, "blob-surface");
  const room =
    s.panes === 2
      ? "two panes side by side (an open foldable): a view may put a chart or table in one and the detail in the other"
      : s.width === "compact"
        ? "one narrow phone screen"
        : "one wide screen";
  return wrapContext(
    [
      `This reply is shown in the Blob app on ${room}, under a small character that speaks for you.`,
      ...SAY_SHOW_LINES,
    ].join(" "),
    "blob-surface",
  );
}
