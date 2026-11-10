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

/** The context note for this turn, or nothing when Blob isn't the reader. */
export function blobSurfaceContext(
  session: Pick<UnifiedSession, "supervisor" | "blobSurface">,
  now: Date = new Date(),
): string | undefined {
  const s = session.blobSurface;
  if (!session.supervisor || !s) return undefined;
  const at = Date.parse(s.at);
  if (!Number.isFinite(at) || now.getTime() - at > FRESH_MS) return undefined;
  const room =
    s.panes === 2
      ? "two panes side by side (an open foldable): a view may put a chart or table in one and the detail in the other"
      : s.width === "compact"
        ? "one narrow phone screen"
        : "one wide screen";
  return wrapContext(
    [
      `This reply is shown in the Blob app on ${room}, under a small character that may read the prose aloud (never the blocks).`,
      "Lead with the answer in one short bold sentence, then show rather than tell: prefer metrics, csv tables, charts and choices blocks to paragraphs.",
      "Keep it to what fits; offer the rest as choices instead of writing it out.",
    ].join(" "),
    "blob-surface",
  );
}
