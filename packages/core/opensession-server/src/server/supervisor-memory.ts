/**
 * What keeps the supervisor's memory current across a long life
 * (supervisor.ts): the seed a fresh supervisor session's first turn carries,
 * and when its memory snapshot is rebuilt.
 *
 * - Seed: a rotated (or brand new) supervisor session starts with nothing
 *   in its context. Its first engine turn gets the ledger's tail
 *   (supervisor-ledger.ts), the decisions still waiting on the owner and the
 *   last week's daily digests, as wrapped per-turn context like the inbox
 *   briefing, never in the system prompt.
 * - Snapshot: a session renders its memory note once and reuses the bytes
 *   (session-memory.ts snapshotMemoryNote), which keeps the prompt cache but
 *   would leave a months-long supervisor reading stale memory. It is rebuilt
 *   on the first turn of each local day and after each compaction, when the
 *   cached prefix is gone anyway.
 */
import { wrapContext } from "./prompt-context";
import { invalidateMemorySnapshot } from "./session-memory";
import {
  BRIEFING_UNTRUSTED_NOTE,
  getSupervisorPrefs,
  listSupervisorItems,
  supervisorRecentDigests,
} from "./supervisor-inbox";
import {
  LEDGER_SEED_BYTES,
  readSupervisorLedgerTail,
} from "./supervisor-ledger";
import { localClock } from "./supervisor-quiet-hours";

/** The whole seed, in UTF-8 bytes. */
export const SEED_MAX_BYTES = 12_000;
/** Open needs-you items the seed lists. */
export const SEED_NEEDS_YOU = 8;
/** Daily digests the seed summarises. */
export const SEED_DIGEST_DAYS = 7;

/** Cut to at most `max` UTF-8 bytes without leaving half a character. */
function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  return Buffer.from(text)
    .subarray(0, max)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
}

/** Whether a session has run on an engine yet: no engine id means its next
 *  turn is its first. */
export function isFirstEngineTurn(session: {
  claudeSessionId?: string | null;
  codexThreadId?: string | null;
  piSessionId?: string | null;
}): boolean {
  return (
    !session.claudeSessionId && !session.codexThreadId && !session.piSessionId
  );
}

/**
 * The seed for a supervisor session's first turn, wrapped as context, or
 * undefined when there is nothing to carry over. Bounded by SEED_MAX_BYTES;
 * a source that fails to read is left out rather than failing the turn.
 */
export async function supervisorSeedContext(
  user: string,
): Promise<string | undefined> {
  const [ledger, needsYou, digests] = await Promise.all([
    readSupervisorLedgerTail(user, LEDGER_SEED_BYTES).catch(() => ({
      text: "",
      truncated: false,
    })),
    listSupervisorItems(user, {
      state: "open",
      kind: "needs-you",
      limit: SEED_NEEDS_YOU,
    }).catch(() => []),
    supervisorRecentDigests(user, SEED_DIGEST_DAYS).catch(() => []),
  ]);
  if (!ledger.text && !needsYou.length && !digests.length) return undefined;

  const sections = [
    "## Picking up",
    "This is a new supervisor conversation; earlier ones were closed to keep the context small. This is what carries over. Read more of the ledger with opensession-supervisor read_ledger.",
  ];
  if (ledger.text)
    sections.push(
      `### Your ledger, latest entries${ledger.truncated ? " (older ones left out)" : ""}\n\n${ledger.text}`,
    );
  if (needsYou.length || digests.length) sections.push(BRIEFING_UNTRUSTED_NOTE);
  if (needsYou.length)
    sections.push(
      "### Still waiting on the owner\n\n" +
        needsYou
          .map(
            (item) =>
              `- [${item.id}] ${item.title}${item.project ? ` (${item.project})` : ""}`,
          )
          .join("\n"),
    );
  if (digests.length)
    sections.push(
      "### Recent daily digests\n\n" +
        digests
          .map(
            (digest) =>
              `- ${digest.day}: ${digest.titles.join("; ")}${digest.more ? ` (and ${digest.more} more)` : ""}`,
          )
          .join("\n"),
    );
  return wrapContext(
    capBytes(sections.join("\n\n"), SEED_MAX_BYTES),
    "supervisor-seed",
  );
}

/** The local day each supervisor session's memory snapshot was last
 *  checked on. In memory: a restart drops every snapshot anyway. */
const snapshotDays = new Map<string, string>();
const MAX_TRACKED = 512;

/**
 * Rebuild a supervisor session's memory snapshot on the first turn of a new
 * local day (the owner's supervisor time zone). The first turn this process
 * sees only records the day: its snapshot was built fresh in this process.
 * True when it invalidated.
 */
export async function refreshSupervisorMemoryDaily(
  sessionId: string,
  user: string,
  now: number = Date.now(),
): Promise<boolean> {
  const timeZone = await getSupervisorPrefs(user)
    .then((prefs) => prefs.effectiveTimezone)
    .catch(() => "UTC");
  const { day } = localClock(now, timeZone);
  const last = snapshotDays.get(sessionId);
  snapshotDays.delete(sessionId);
  snapshotDays.set(sessionId, day);
  if (snapshotDays.size > MAX_TRACKED) {
    const oldest = snapshotDays.keys().next().value;
    if (oldest) snapshotDays.delete(oldest);
  }
  if (last === undefined || last === day) return false;
  invalidateMemorySnapshot(sessionId);
  return true;
}

/** A supervisor session compacted: its next turn rebuilds the memory note,
 *  since the cached prefix behind it is already gone. */
export function refreshSupervisorMemoryAfterCompaction(
  sessionId: string,
): void {
  invalidateMemorySnapshot(sessionId);
}

export function __resetSupervisorMemoryForTest(): void {
  snapshotDays.clear();
}
