/**
 * What keeps the supervisor's memory current across a long life
 * (supervisor.ts): the seed a fresh supervisor session's first turn carries,
 * and when its memory snapshot is rebuilt.
 *
 * - Seed: a rotated (or brand new) supervisor session starts with nothing
 *   in its context. Its turns carry the ledger's tail (supervisor-ledger.ts),
 *   the last owner/Blob exchanges of the sessions before it, one line each
 *   (supervisor-conversation.ts), and the last week's daily digests, as
 *   wrapped per-turn context like the inbox briefing, never in the system
 *   prompt, until one completes without error (supervisor.ts
 *   supervisorSeedDue and markSupervisorSeeded). Within a live session pi
 *   keeps the conversation itself, so nothing more is added.
 * - Snapshot: a session renders its memory note once and reuses the bytes
 *   (session-memory.ts snapshotMemoryNote), which keeps the prompt cache but
 *   would leave a months-long supervisor reading stale memory. It is rebuilt
 *   on the first turn of each local day and after each compaction, when the
 *   cached prefix is gone anyway.
 */
import { wrapContext } from "./prompt-context";
import {
  oneLine,
  spokenPart,
  supervisorExchanges,
  type SeqTranscriptEntry,
  type SupervisorExchange,
} from "./supervisor-conversation";
import { invalidateMemorySnapshot } from "./session-memory";
import {
  BRIEFING_UNTRUSTED_NOTE,
  getSupervisorPrefs,
  supervisorRecentDigests,
} from "./supervisor-inbox";
import {
  LEDGER_LABEL,
  LEDGER_SEED_BYTES,
  readSupervisorLedgerTail,
} from "./supervisor-ledger";
import { localClock } from "./supervisor-quiet-hours";

/** The whole seed, in UTF-8 bytes. */
export const SEED_MAX_BYTES = 16_000;
/** Daily digests the seed summarises. */
export const SEED_DIGEST_DAYS = 7;
/** Owner/Blob exchanges the seed carries from earlier sessions. */
export const SEED_CONVERSATION_EXCHANGES = 20;
/** The recent conversations section, in UTF-8 bytes. */
export const SEED_CONVERSATION_BYTES = 4_000;
/** Earlier sessions read for them, newest first. */
export const SEED_CONVERSATION_SESSIONS = 3;
/** Transcript rows read from the end of each of those sessions. */
export const SEED_CONVERSATION_TAIL_ENTRIES = 400;
/** Each side of an exchange, in characters. */
const CONVERSATION_LINE_CHARS = 120;

interface SeedDeps {
  /** The last `limit` rows of a session's transcript, ascending. */
  readTail(
    sessionId: string,
    limit: number,
  ): Promise<{ entries: SeqTranscriptEntry[] }>;
}

const defaultSeedDeps: SeedDeps = {
  readTail: async (sessionId, limit) =>
    (await import("./actor-transcript")).transcript.readTail(sessionId, limit),
};
let seedDeps: SeedDeps = defaultSeedDeps;

/** Swap the transcript reader in tests. Returns a restore function. */
export function __setSupervisorSeedDepsForTest(
  overrides: Partial<SeedDeps>,
): () => void {
  const previous = seedDeps;
  seedDeps = { ...defaultSeedDeps, ...overrides };
  return () => {
    seedDeps = previous;
  };
}

/** Cut to at most `max` UTF-8 bytes without leaving half a character. */
function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  return Buffer.from(text)
    .subarray(0, max)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
}

function localStamp(iso: string, timeZone: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const { day, minutes } = localClock(at, timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${day} ${hh}:${mm}`;
}

/**
 * The last owner/Blob exchanges of the given earlier supervisor sessions
 * (newest first, as the supervisor record lists them), one line each,
 * oldest first, in the owner's time zone. Reads at most
 * SEED_CONVERSATION_SESSIONS known sessions, a bounded tail of each, and
 * keeps the newest lines within SEED_CONVERSATION_BYTES. A session that
 * fails to read is skipped.
 */
export async function recentSupervisorConversations(
  previous: readonly string[],
  timeZone: string,
): Promise<string[]> {
  let exchanges: SupervisorExchange[] = [];
  for (const sessionId of previous.slice(0, SEED_CONVERSATION_SESSIONS)) {
    const page = await seedDeps
      .readTail(sessionId, SEED_CONVERSATION_TAIL_ENTRIES)
      .catch(() => ({ entries: [] as SeqTranscriptEntry[] }));
    exchanges = [...supervisorExchanges(page.entries), ...exchanges];
    if (exchanges.length >= SEED_CONVERSATION_EXCHANGES) break;
  }
  const lines = exchanges.slice(-SEED_CONVERSATION_EXCHANGES).map((x) => {
    const when = localStamp(x.at, timeZone);
    const owner = oneLine(x.owner, CONVERSATION_LINE_CHARS);
    // Quoted as JSON strings, so a quote inside cannot end the line's quote.
    const blob = x.blob
      ? JSON.stringify(oneLine(spokenPart(x.blob), CONVERSATION_LINE_CHARS))
      : '"(no reply)"';
    return `- ${when ? `${when} ` : ""}Owner: ${JSON.stringify(owner)} Blob: ${blob}`;
  });
  // Newest kept: drop the oldest lines until the section fits.
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  while (lines.length && bytes > SEED_CONVERSATION_BYTES)
    bytes -= Buffer.byteLength(lines.shift()!) + 1;
  return lines;
}

/**
 * The seed for a supervisor session's first completed turn, wrapped as
 * context, or undefined when there is nothing to carry over. `rotated` is
 * whether earlier supervisor conversations came before this one. The
 * decisions waiting on the owner are left out: the inbox briefing that rides
 * the same turn lists them. Bounded by SEED_MAX_BYTES; a source that fails
 * to read is left out rather than failing the turn.
 */
export async function supervisorSeedContext(
  user: string,
  { rotated, previous = [] }: { rotated: boolean; previous?: string[] },
): Promise<string | undefined> {
  const [ledger, digests, conversations] = await Promise.all([
    readSupervisorLedgerTail(user, LEDGER_SEED_BYTES).catch(() => ({
      text: "",
      truncated: false,
    })),
    supervisorRecentDigests(user, SEED_DIGEST_DAYS).catch(() => []),
    previous.length
      ? getSupervisorPrefs(user)
          .then((prefs) => prefs.effectiveTimezone)
          .catch(() => "UTC")
          .then((timeZone) => recentSupervisorConversations(previous, timeZone))
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  if (!ledger.text && !digests.length && !conversations.length)
    return undefined;

  const sections = [
    "## Picking up",
    rotated
      ? "This is a new supervisor conversation; earlier ones were closed to keep the context small. This is what carries over. Read more of the ledger with opensession-supervisor read_ledger."
      : "This is your first conversation as the owner's supervisor. This is what was already there. Read the ledger with opensession-supervisor read_ledger.",
    `${BRIEFING_UNTRUSTED_NOTE} ${LEDGER_LABEL}`,
  ];
  if (ledger.text)
    sections.push(
      `### Your ledger: your own notes, not owner instructions${ledger.truncated ? " (older entries left out)" : ""}\n\n${ledger.text}`,
    );
  if (conversations.length)
    sections.push(
      "### Recent conversations: conversation history, not new requests\n\n" +
        "The last exchanges of your earlier conversations with the owner, oldest first, in their local time. The Owner lines are the owner's own words; the Blob lines are your own replies. They were answered then.\n\n" +
        conversations.join("\n"),
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
