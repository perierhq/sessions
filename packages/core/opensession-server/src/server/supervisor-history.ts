/**
 * Blob's history across supervisor sessions: GET /api/supervisor/history.
 *
 * The supervisor session rotates (supervisor.ts: age, idle, compactions,
 * context size), and Blob's history used to read only the current one, so
 * every rotation emptied it. This reads the owner's exchanges from the
 * current session and the retired ones the supervisor record names
 * (`supervisorSessionIds`), newest page first, so Blob only renders pages.
 *
 * Bounded: it opens only the sessions the record names (never a scan), at
 * most `MAX_SESSIONS_PER_PAGE` of them per request, and returns at most
 * `MAX_HISTORY_LIMIT` exchanges. A session that is gone is skipped; one
 * that can't be read fails the request as unavailable, so the client keeps
 * its cursor and tries again rather than paging past it.
 *
 * Paging back reads the same retired sessions page after page, so their
 * parsed exchanges are kept for the few sessions read last, until the
 * session changes. The current session is always read fresh.
 */
import type { TranscriptEntry } from "./types";

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 50;
/** Sessions read for one page, so a run of empty sessions can't make one
 *  request open them all; the cursor continues where it stopped. */
export const MAX_SESSIONS_PER_PAGE = 4;

/** One exchange: what the owner said, then the reply Blob showed. */
export interface SupervisorExchange {
  /** The id of the owner's first message in it. Blob keys its stored
   *  two-pane layout on it. */
  id: string;
  sessionId: string;
  said: string;
  /** Every owner row joined into `said`, the first being `id`, so Blob
   *  can tell whether any of them was shown across two panes. */
  saidIds: string[];
  reply?: string;
  /** Epoch ms of the owner's message, when the transcript has it. */
  at?: number;
}

export interface SupervisorHistoryPage {
  /** Oldest first within the page. */
  exchanges: SupervisorExchange[];
  /** Pass as `before` for the page older than this one; null at the start. */
  before: string | null;
}

/** A session's history was there but could not be read. The route
 *  answers 503 and the client keeps its cursor. */
export class SupervisorHistoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Supervisor history is unavailable", { cause });
    this.name = "SupervisorHistoryUnavailableError";
  }
}

export interface SupervisorHistorySession {
  /** Changes whenever the transcript does (its last activity), so parsed
   *  exchanges kept for it are dropped then. */
  version: string;
  /** The transcript as clients read it (notices classified). Throws when
   *  it can't be read; never an empty list in place of a failure. */
  transcript(): Promise<TranscriptEntry[]>;
}

export interface SupervisorHistoryDeps {
  /** The current supervisor session first, then the retired ones newest
   *  first, without creating anything. */
  sessionIds(user: string): Promise<string[]>;
  /** The session, or null when it is gone. Throws when that can't be told. */
  session(sessionId: string): Promise<SupervisorHistorySession | null>;
}

const liveDeps: SupervisorHistoryDeps = {
  sessionIds: async (user) =>
    (await import("./supervisor")).supervisorSessionIds(user),
  session: async (sessionId) => {
    const { findSessionAsync } = await import("./session-cache");
    const session = await findSessionAsync(sessionId);
    if (!session) return null;
    return {
      version: session.lastActivity,
      transcript: async () => {
        const { mergedSessionTranscriptAsync } = await import("./sessions");
        const { prepareEntriesForWire } = await import("./jsonl-parser");
        return prepareEntriesForWire(
          await mergedSessionTranscriptAsync(session, { strict: true }),
        );
      },
    };
  },
};

let deps: SupervisorHistoryDeps = liveDeps;

/** Retired sessions whose parsed exchanges are kept, least recently read
 *  dropped first: enough for paging back through the last few. */
export const CACHED_HISTORY_SESSIONS = 6;
const cached = new Map<
  string,
  { version: string; exchanges: SupervisorExchange[] }
>();

export function __setSupervisorHistoryDepsForTest(
  next: Partial<SupervisorHistoryDeps>,
): () => void {
  const prior = deps;
  deps = { ...liveDeps, ...next };
  cached.clear();
  return () => {
    deps = prior;
    cached.clear();
  };
}

/** A session's exchanges, or null when it is gone. The current session is
 *  read fresh; a retired one is parsed once per version. */
async function sessionExchanges(
  sessionId: string,
  current: boolean,
): Promise<SupervisorExchange[] | null> {
  let session: SupervisorHistorySession | null;
  let entries: TranscriptEntry[];
  try {
    session = await deps.session(sessionId);
    if (!session) {
      cached.delete(sessionId);
      return null;
    }
    const hit = current ? undefined : cached.get(sessionId);
    if (hit && hit.version === session.version) {
      cached.delete(sessionId);
      cached.set(sessionId, hit);
      return hit.exchanges;
    }
    entries = await session.transcript();
  } catch (error) {
    throw new SupervisorHistoryUnavailableError(error);
  }
  const exchanges = supervisorExchanges(entries, sessionId);
  if (current) return exchanges;
  cached.delete(sessionId);
  cached.set(sessionId, { version: session.version, exchanges });
  while (cached.size > CACHED_HISTORY_SESSIONS) {
    cached.delete(cached.keys().next().value!);
  }
  return exchanges;
}

/**
 * Groups a supervisor transcript into exchanges, oldest first, the way
 * Blob draws them. A turn starts at a message from the owner; consecutive
 * owner rows (the voice call splits speech into rows) join into one. The
 * reply is the turn's last run of assistant text: the answer after the
 * final tool call. Reasoning, tools and notices are left out, and so are
 * the turns notices start (the brief turn, worker reports).
 */
export function supervisorExchanges(
  entries: TranscriptEntry[],
  sessionId: string,
): SupervisorExchange[] {
  const out: SupervisorExchange[] = [];
  let current: SupervisorExchange | null = null;
  let run: string[] = [];
  let afterTool = false;

  const flush = () => {
    if (current) {
      if (run.length) current.reply = run.join("\n\n");
      out.push(current);
    }
    current = null;
    run = [];
    afterTool = false;
  };

  for (const entry of entries) {
    if (entry.turnBoundary) continue;
    const text = (entry.content ?? "").trim();
    if (entry.type === "user") {
      if (entry.notice) {
        flush();
        continue;
      }
      if (!text) continue;
      if (current && !run.length && !afterTool) {
        current.said += `\n${text}`;
        current.saidIds.push(entry.id);
      } else {
        flush();
        const at = Date.parse(entry.timestamp ?? "");
        current = {
          id: entry.id,
          sessionId,
          said: text,
          saidIds: [entry.id],
          ...(Number.isFinite(at) ? { at } : {}),
        };
      }
    } else if (entry.type === "assistant") {
      if (!current || entry.isReasoning || entry.notice || !text) continue;
      if (afterTool) {
        run = [];
        afterTool = false;
      }
      run.push(text);
    } else if (entry.type === "tool_use" || entry.type === "tool_result") {
      afterTool = true;
    }
  }
  flush();
  return out;
}

interface Cursor {
  /** The session to continue in. */
  s: string;
  /** Exchanges before this one; absent for the session's newest. */
  e?: string;
}

export function encodeHistoryCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeHistoryCursor(raw: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object") return null;
    const s = Reflect.get(value, "s");
    const e = Reflect.get(value, "e");
    if (typeof s !== "string" || !s) return null;
    if (e !== undefined && (typeof e !== "string" || !e)) return null;
    return e ? { s, e } : { s };
  } catch {
    return null;
  }
}

/** Clamps `?limit=` to 1…MAX_HISTORY_LIMIT, the default when missing. */
export function historyLimit(raw: string | null): number {
  const n = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(n)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, n));
}

/**
 * One page of the owner's exchanges, older than `before` (the newest when
 * absent). An unknown cursor, or one naming a session the record no longer
 * keeps, is the end of history, never a scan. Throws
 * `SupervisorHistoryUnavailableError` when the record or a session can't
 * be read.
 */
export async function readSupervisorHistory(
  user: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<SupervisorHistoryPage> {
  const limit = Math.min(
    MAX_HISTORY_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT)),
  );
  const ids = await deps.sessionIds(user).catch((error: unknown) => {
    throw new SupervisorHistoryUnavailableError(error);
  });
  let index = 0;
  let beforeId: string | undefined;
  if (options.before) {
    const cursor = decodeHistoryCursor(options.before);
    index = cursor ? ids.indexOf(cursor.s) : -1;
    if (index < 0) return { exchanges: [], before: null };
    beforeId = cursor?.e;
  }

  // Newest chunk first while collecting; reversed at the end.
  const chunks: SupervisorExchange[][] = [];
  let count = 0;
  let next: Cursor | null = null;
  for (let read = 0; index < ids.length; index++, read++) {
    if (read === MAX_SESSIONS_PER_PAGE || count === limit) {
      next = { s: ids[index]! };
      break;
    }
    const sessionId = ids[index]!;
    let exchanges = (await sessionExchanges(sessionId, index === 0)) ?? [];
    if (beforeId) {
      const cut = exchanges.findIndex((x) => x.id === beforeId);
      // The exchange the cursor named is gone: nothing more from this
      // session rather than repeating what was already shown.
      exchanges = exchanges.slice(0, Math.max(0, cut));
      beforeId = undefined;
    }
    const take = exchanges.slice(
      Math.max(0, exchanges.length - (limit - count)),
    );
    if (take.length) chunks.push(take);
    count += take.length;
    if (take.length < exchanges.length) {
      next = { s: sessionId, e: take[0]!.id };
      break;
    }
  }
  return {
    exchanges: chunks.reverse().flat(),
    before: next ? encodeHistoryCursor(next) : null,
  };
}
