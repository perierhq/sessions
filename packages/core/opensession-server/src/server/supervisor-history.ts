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
 * `MAX_HISTORY_LIMIT` exchanges. A session that is gone is skipped.
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

export interface SupervisorHistoryDeps {
  /** The current supervisor session first, then the retired ones newest
   *  first, without creating anything. */
  sessionIds(user: string): Promise<string[]>;
  /** A session's transcript as clients read it (notices classified), or
   *  null when the session is gone. */
  transcript(sessionId: string): Promise<TranscriptEntry[] | null>;
}

const liveDeps: SupervisorHistoryDeps = {
  sessionIds: async (user) =>
    (await import("./supervisor")).supervisorSessionIds(user),
  transcript: async (sessionId) => {
    const { findSessionAsync } = await import("./session-cache");
    const session = await findSessionAsync(sessionId);
    if (!session) return null;
    const { mergedSessionTranscriptAsync } = await import("./sessions");
    const { prepareEntriesForWire } = await import("./jsonl-parser");
    return prepareEntriesForWire(await mergedSessionTranscriptAsync(session));
  },
};

let deps: SupervisorHistoryDeps = liveDeps;

export function __setSupervisorHistoryDepsForTest(
  next: Partial<SupervisorHistoryDeps>,
): () => void {
  const prior = deps;
  deps = { ...liveDeps, ...next };
  return () => {
    deps = prior;
  };
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
      } else {
        flush();
        const at = Date.parse(entry.timestamp ?? "");
        current = {
          id: entry.id,
          sessionId,
          said: text,
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
 * keeps, is the end of history, never a scan.
 */
export async function readSupervisorHistory(
  user: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<SupervisorHistoryPage> {
  const limit = Math.min(
    MAX_HISTORY_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT)),
  );
  const ids = await deps.sessionIds(user);
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
    const entries = await deps.transcript(sessionId).catch(() => null);
    let exchanges = entries ? supervisorExchanges(entries, sessionId) : [];
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
