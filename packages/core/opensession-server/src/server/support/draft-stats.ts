// How an inbox's agent drafts were settled in the last 30 days: sent as
// the agent wrote them, sent after a person edited them, or discarded
// (Front's "draft drift"). The evidence an operator reads next to the
// autonomy choice. One small record per inbox in the `support-inboxes`
// namespace (key `draft-stats:<inboxId>`, which listInboxes skips and
// deleteInbox removes): times and outcomes only, never text, ids or
// addresses. Nothing runs at import.
import { DRAFT_STATS_DAYS, type InboxDraftStats } from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";

export type DraftOutcome = "unchanged" | "edited" | "discarded";

interface StatsRecord {
  inboxId: string;
  entries: Array<{ at: number; outcome: DraftOutcome }>;
}

const DAY_MS = 86_400_000;
const WINDOW_MS = DRAFT_STATS_DAYS * DAY_MS;
/** Entries kept at most, newest last; a busy inbox keeps its newest. */
const MAX_ENTRIES = 5_000;

let docs: ReturnType<typeof catalogDocuments> | undefined;
const store = () => (docs ??= catalogDocuments("support-inboxes"));
const key = (inboxId: string) => `draft-stats:${inboxId}`;

function live(value: unknown, now: number): StatsRecord["entries"] {
  const entries = (value as StatsRecord | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e) =>
      typeof e?.at === "number" &&
      e.at > now - WINDOW_MS &&
      (e.outcome === "unchanged" ||
        e.outcome === "edited" ||
        e.outcome === "discarded"),
  );
}

/** Records one settled agent draft. Failures are logged, never thrown: a
 *  missed figure must not undo a send. */
export async function recordDraftOutcome(
  inboxId: string,
  outcome: DraftOutcome,
  now = Date.now(),
): Promise<void> {
  try {
    await store().update<StatsRecord>(key(inboxId), (value) => ({
      inboxId,
      entries: [...live(value, now), { at: now, outcome }].slice(-MAX_ENTRIES),
    }));
  } catch (error) {
    console.warn(
      "[support] draft figure not recorded:",
      error instanceof Error ? error.name : typeof error,
    );
  }
}

/** The inbox's figures over the last DRAFT_STATS_DAYS days. */
export async function draftStats(
  inboxId: string,
  now = Date.now(),
): Promise<InboxDraftStats> {
  const stats: InboxDraftStats = {
    days: DRAFT_STATS_DAYS,
    sentUnchanged: 0,
    sentEdited: 0,
    discarded: 0,
  };
  let value: unknown = null;
  try {
    value = await store().get(key(inboxId));
  } catch {
    return stats;
  }
  for (const e of live(value, now)) {
    if (e.outcome === "unchanged") stats.sentUnchanged++;
    else if (e.outcome === "edited") stats.sentEdited++;
    else stats.discarded++;
  }
  return stats;
}
