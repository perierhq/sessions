/**
 * Where a supervisor reply will be shown when it comes from the Blob app, so
 * the supervisor can write a view that fits (adrs/blob-views.md). Blob talks
 * to the supervisor (supervisor.ts, adrs/supervisor-and-leads.md), not the
 * Desk, so only supervisor sessions listen.
 *
 * Blob sends `surface: { app: "blob", panes, width, viewport? }` with each
 * prompt; `viewport` is the board camera (shared/blob-board.ts BoardViewport):
 * its size, origin and zoom, the fold's band and the clock strip on an open
 * Duo, and the closed camera's size. It is
 * persisted on the session file like the composer's effort and speed
 * (maybePersistEffort/Speed), so a queued or resumed turn still sees it, and
 * cleared by a prompt that carries none, so the same supervisor opened on the
 * web goes back to ordinary replies. A supervisor turn then gets it as wrapped
 * per-turn context, the way it already gets `deskStateContext`.
 */
import {
  BOARD_LIMITS,
  DEFAULT_BOARD_VIEWPORT,
  DUO_OPEN,
  visibleRect,
  type BoardViewport,
} from "../shared/blob-board";
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
  const viewport = parseBoardViewport(r.viewport);
  return {
    panes,
    width,
    ...(viewport ? { viewport } : {}),
    at: now.toISOString(),
  };
}

const CAMERA_MAX = 10_000;

function num(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

function pair(
  value: unknown,
  min: number,
  max: number,
): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const a = num(value[0], min, max);
  const b = num(value[1], min, max);
  return a !== undefined && b !== undefined ? [a, b] : undefined;
}

/** The board camera Blob reports, validated; anything malformed is no
 *  viewport (the turn still gets the rest of the surface). */
export function parseBoardViewport(raw: unknown): BoardViewport | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const w = num(r.w, 1, CAMERA_MAX);
  const h = num(r.h, 1, CAMERA_MAX);
  const origin = pair(
    r.origin ?? [0, 0],
    -BOARD_LIMITS.size,
    2 * BOARD_LIMITS.size,
  );
  const zoom = num(r.zoom ?? 1, 0.25, 2);
  if (w === undefined || h === undefined || !origin || zoom === undefined)
    return undefined;
  const band = (value: unknown) => {
    if (value === undefined) return undefined;
    const p = pair(value, 0, w);
    return p && p[0] < p[1] ? p : null;
  };
  const hinge = band(r.hinge);
  const strip = band(r.strip);
  if (hinge === null || strip === null) return undefined;
  let closed: { w: number; h: number } | undefined;
  if (r.closed !== undefined) {
    const c = r.closed as Record<string, unknown> | null;
    const cw = num(c?.w, 1, CAMERA_MAX);
    const ch = num(c?.h, 1, CAMERA_MAX);
    if (cw === undefined || ch === undefined) return undefined;
    closed = { w: cw, h: ch };
  }
  return {
    w,
    h,
    origin,
    zoom,
    ...(hinge ? { hinge } : {}),
    ...(strip ? { strip } : {}),
    ...(closed ? { closed } : {}),
  };
}

const pt = (n: number) => String(Math.round(n * 2) / 2);

/** The board lines of the turn's Blob context: the camera now, what it
 *  shows, the fold and the closed camera, and the placement rule. A turn
 *  whose app sent no camera gets the closed Duo (DEFAULT_BOARD_VIEWPORT),
 *  so every Blob turn knows where its drawing lands. */
export function boardViewportLines(sent: BoardViewport | undefined): string[] {
  const lines = [
    "Your board: the Blob app shows one board of yours, kept across replies. Read it with opensession-supervisor board_read and edit it with board_apply, by id.",
  ];
  const viewport = sent ?? DEFAULT_BOARD_VIEWPORT;
  if (!sent)
    lines.push(
      "No camera came with this message, so assume the closed Duo below.",
    );
  const view = visibleRect(viewport);
  const kind = viewport.hinge
    ? "the open Duo"
    : viewport.closed
      ? "the closed Duo"
      : "a single screen";
  lines.push(
    `Camera now: ${kind}, ${pt(viewport.w)}×${pt(viewport.h)} pt at board (${pt(viewport.origin[0])}, ${pt(viewport.origin[1])}), zoom ${viewport.zoom}. Visible board: x ${pt(view.x)}–${pt(view.x + view.w)}, y ${pt(view.y)}–${pt(view.y + view.h)}${viewport.strip ? " (the clock strip on the trailing edge is not board)" : ""}.`,
  );
  if (viewport.hinge)
    lines.push(
      `The fold: board x ${pt(viewport.hinge[0])}–${pt(viewport.hinge[1])} at the home camera. No text there: the server moves text off it and tells you.`,
    );
  if (viewport.closed)
    lines.push(
      `Closed, the camera shows x 0–${pt(viewport.closed.w)}: put what the owner must see first there, so it is on screen closed and open; use x ≥ ${pt(viewport.hinge?.[1] ?? DUO_OPEN.hinge[1])} for what can wait a pan.`,
    );
  if (viewport.hinge && viewport.closed)
    lines.push(
      `Open now, the right screen shows board x ${pt(viewport.hinge[1])}–${pt(view.x + view.w)} too: put new content that doesn't fit the closed view there (a region, a timeline, the detail), never by moving what is already on the board.`,
    );
  if (viewport.closed && !viewport.hinge)
    lines.push(
      `Opened, the fold is board x ${pt(DUO_OPEN.hinge[0])}–${pt(DUO_OPEN.hinge[1])}: no text there.`,
    );
  return lines;
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

/** When a Blob reply goes on the board instead of into text. */
export const BOARD_ANSWER_LINE =
  "Draw, don't write: when the owner asks anything with structure (status, why something is stuck, what changed, a plan, a comparison, a timeline), answer on your board with board_apply and keep the say to a sentence or two that points at it, then put the canvas fence board_apply returns right after the say fence, so the reply in history shows the board as it was. Plain text replies are for simple chat only.";

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
  "Show: everything after the say fence is shown and never spoken. View first, prose minimal: point at the real things (sessions, pull requests, incidents, people) as links the app can open, with their status. On Blob, timelines, images and screenshots, and choices for a decision go on your board, as the next line says; the block catalog in docs/blocks.md is for other clients.",
  BOARD_ANSWER_LINE,
  "Cues: only when pointing helps, and at most one per sentence, put {#id} in the script where the speech turns to a shown element, at a sentence start or mid-sentence (\"Checkout flapped again right after 2.3.4, {#pr-12} and Pat's fix is waiting.\"), and give that element the same id: after a fence's language (```metrics {#stats}), right after a link ([PR #12](url){#pr-12}), or at the end of a line. Blob focuses the element when the words after the cue start; the cue itself is never read. Keep at least four words between cues; ids are short, made of letters, digits and dashes.",
  "Tables only when the owner asked for data. No paragraph recaps. Keep it to what fits; offer the rest as choices instead of writing it out.",
] as const;

/** The whole block when the supervisor is written to from elsewhere (the
 *  web), so it replaces an older Blob block (supervisor-briefing-trim.ts). */
export const NOT_IN_BLOB =
  "Not in Blob this turn: write a normal reply with no say fence.";

/** The session's Blob surface while it is fresh, else undefined. */
export function freshBlobSurface(
  session: Pick<UnifiedSession, "blobSurface">,
  now: Date = new Date(),
): BlobSurface | undefined {
  const s = session.blobSurface;
  const at = s ? Date.parse(s.at) : NaN;
  if (!s || !Number.isFinite(at) || now.getTime() - at > FRESH_MS)
    return undefined;
  return s;
}

/** The context note for this turn: where Blob shows the reply, or
 *  `NOT_IN_BLOB`. Nothing for a session that isn't the supervisor. */
export function blobSurfaceContext(
  session: Pick<UnifiedSession, "supervisor" | "blobSurface">,
  now: Date = new Date(),
): string | undefined {
  if (!session.supervisor) return undefined;
  const s = freshBlobSurface(session, now);
  if (!s) return wrapContext(NOT_IN_BLOB, "blob-surface");
  const room =
    s.panes === 2
      ? "two panes side by side (an open foldable): a view may put a chart or table in one and the detail in the other"
      : s.width === "compact"
        ? "one narrow phone screen"
        : "one wide screen";
  return wrapContext(
    [
      [
        `This reply is shown in the Blob app on ${room}, under a small character that speaks for you.`,
        ...SAY_SHOW_LINES,
      ].join(" "),
      boardViewportLines(s.viewport).join(" "),
    ].join("\n\n"),
    "blob-surface",
  );
}
