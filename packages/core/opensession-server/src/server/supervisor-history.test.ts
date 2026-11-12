/**
 * Blob's history across supervisor sessions: exchanges grouped the way Blob
 * draws them, paged newest first across the current and retired sessions
 * the record names, bounded, and only for the signed-in owner. Fake
 * session ids and transcripts; no stores.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import {
  CACHED_HISTORY_SESSIONS,
  MAX_SESSIONS_PER_PAGE,
  SupervisorHistoryUnavailableError,
  __setSupervisorHistoryDepsForTest,
  decodeHistoryCursor,
  historyLimit,
  readSupervisorHistory,
  supervisorExchanges,
} from "./supervisor-history";

let restore: () => void = () => {};
afterEach(() => restore());

let seq = 0;
function entry(
  type: TranscriptEntry["type"],
  content: string,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    type,
    content,
    timestamp: new Date(Date.UTC(2026, 10, 12, 0, seq)).toISOString(),
    ...extra,
  } as TranscriptEntry;
}

/** A transcript of `n` plain exchanges, ids `<prefix>-u<i>`. */
function talk(prefix: string, n: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      entry("user", `${prefix} question ${i}`, { id: `${prefix}-u${i}` }),
    );
    out.push(entry("assistant", `${prefix} answer ${i}`));
  }
  return out;
}

/** Sessions looked up by the last `fake`, gone ones included. */
let looked: string[] = [];

/** Fake sessions; a session's version is its entry count, and `failing`
 *  names sessions whose transcript read throws. Returns the transcripts
 *  read. */
function fake(
  sessions: Record<string, TranscriptEntry[] | null>,
  order = Object.keys(sessions),
  failing = new Set<string>(),
) {
  const read: string[] = [];
  looked = [];
  restore = __setSupervisorHistoryDepsForTest({
    sessionIds: async () => order,
    session: async (id) => {
      looked.push(id);
      const entries = sessions[id];
      if (!entries) return null;
      return {
        version: String(entries.length),
        transcript: async () => {
          read.push(id);
          if (failing.has(id)) throw new Error("store read failed");
          return sessions[id] ?? [];
        },
      };
    },
  });
  return read;
}

describe("exchanges", () => {
  test("a turn is the owner's message and the reply after the last tool", () => {
    const entries = [
      entry("user", "Did the fix go out?", { id: "u1" }),
      entry("user", "the payout one", { id: "u1b" }),
      entry("assistant", "thinking", { isReasoning: true }),
      entry("assistant", "Let me check."),
      entry("tool_use", "gh pr view"),
      entry("tool_result", "merged"),
      entry("assistant", "Yes, it merged."),
      entry("assistant", "No errors since."),
      // A notice starts a turn of its own, left out (the brief turn).
      entry("user", "Write the morning brief", {
        notice: { kind: "server" } as never,
      }),
      entry("assistant", "Brief stored."),
      entry("user", "Thanks", { id: "u2" }),
      entry("user", "", { turnBoundary: true }),
    ];
    const out = supervisorExchanges(entries, "os-a");
    expect(
      out.map(({ id, said, reply, sessionId }) => ({
        id,
        said,
        reply,
        sessionId,
      })),
    ).toEqual([
      {
        id: "u1",
        said: "Did the fix go out?\nthe payout one",
        reply: "Yes, it merged.\n\nNo errors since.",
        sessionId: "os-a",
      },
      { id: "u2", said: "Thanks", reply: undefined, sessionId: "os-a" },
    ]);
    expect(out.map((x) => x.saidIds)).toEqual([["u1", "u1b"], ["u2"]]);
    expect(out[0]!.at).toBe(Date.parse(entries[0]!.timestamp));
  });
});

describe("paging", () => {
  test("newest page first, then back across a rotation, oldest first in each page", async () => {
    fake({ current: talk("c", 3), old: talk("o", 4) });
    const first = await readSupervisorHistory("Ada", { limit: 2 });
    expect(first.exchanges.map((x) => x.id)).toEqual(["c-u2", "c-u3"]);
    const second = await readSupervisorHistory("Ada", {
      before: first.before,
      limit: 2,
    });
    // The rest of the current session, then the newest of the one before.
    expect(second.exchanges.map((x) => x.id)).toEqual(["o-u4", "c-u1"]);
    expect(second.exchanges.map((x) => x.sessionId)).toEqual([
      "old",
      "current",
    ]);
    const third = await readSupervisorHistory("Ada", {
      before: second.before,
      limit: 5,
    });
    expect(third.exchanges.map((x) => x.id)).toEqual(["o-u1", "o-u2", "o-u3"]);
    expect(third.before).toBeNull();
  });

  test("a full page that ends a session continues in the next one", async () => {
    fake({ current: talk("c", 2), old: talk("o", 1) });
    const first = await readSupervisorHistory("Ada", { limit: 2 });
    expect(first.exchanges.map((x) => x.id)).toEqual(["c-u1", "c-u2"]);
    expect(decodeHistoryCursor(first.before!)).toEqual({ s: "old" });
    const second = await readSupervisorHistory("Ada", { before: first.before });
    expect(second).toEqual({
      exchanges: [expect.objectContaining({ id: "o-u1" })],
      before: null,
    });
  });

  test("a deleted session is skipped, and one page reads a bounded number of sessions", async () => {
    const sessions: Record<string, TranscriptEntry[] | null> = {
      current: talk("c", 1),
      gone: null,
    };
    for (let i = 0; i < 6; i++) sessions[`empty${i}`] = [];
    sessions.last = talk("l", 1);
    fake(sessions);
    const first = await readSupervisorHistory("Ada", { limit: 10 });
    expect(first.exchanges.map((x) => x.id)).toEqual(["c-u1"]);
    expect(looked).toHaveLength(MAX_SESSIONS_PER_PAGE);
    let page = first;
    const ids = [...first.exchanges.map((x) => x.id)];
    while (page.before) {
      page = await readSupervisorHistory("Ada", {
        before: page.before,
        limit: 10,
      });
      ids.unshift(...page.exchanges.map((x) => x.id));
    }
    expect(ids).toEqual(["l-u1", "c-u1"]);
  });

  test("a cursor the record no longer knows, or garbage, ends history without reading", async () => {
    const read = fake({ current: talk("c", 3) });
    const page = await readSupervisorHistory("Ada", { limit: 1 });
    restore();
    const read2 = fake({ other: talk("x", 3) });
    expect(await readSupervisorHistory("Ada", { before: page.before })).toEqual(
      {
        exchanges: [],
        before: null,
      },
    );
    expect(
      await readSupervisorHistory("Ada", { before: "not a cursor" }),
    ).toEqual({
      exchanges: [],
      before: null,
    });
    expect(read).toEqual(["current"]);
    expect(read2).toEqual([]);
  });

  test("an exchange the cursor named that is gone ends that session, never repeats", async () => {
    const sessions = { current: talk("c", 3), old: talk("o", 1) };
    fake(sessions);
    const first = await readSupervisorHistory("Ada", { limit: 1 });
    sessions.current = sessions.current.filter((e) => e.id !== "c-u3");
    const second = await readSupervisorHistory("Ada", { before: first.before });
    expect(second.exchanges.map((x) => x.id)).toEqual(["o-u1"]);
  });

  test("a session that can't be read fails the page and keeps the cursor; it is never skipped", async () => {
    const failing = new Set(["old"]);
    const read = fake(
      { current: talk("c", 1), old: talk("o", 2), older: talk("p", 1) },
      undefined,
      failing,
    );
    const first = await readSupervisorHistory("Ada", { limit: 1 });
    expect(first.exchanges.map((x) => x.id)).toEqual(["c-u1"]);
    expect(decodeHistoryCursor(first.before!)).toEqual({ s: "old" });
    await expect(
      readSupervisorHistory("Ada", { before: first.before }),
    ).rejects.toBeInstanceOf(SupervisorHistoryUnavailableError);
    // The same cursor works once the read does, from where it was.
    failing.clear();
    const second = await readSupervisorHistory("Ada", { before: first.before });
    expect(second.exchanges.map((x) => x.id)).toEqual(["p-u1", "o-u1", "o-u2"]);
    expect(read).toEqual(["current", "old", "old", "older"]);
  });

  test("a record that can't be read fails the page", async () => {
    restore = __setSupervisorHistoryDepsForTest({
      sessionIds: async () => {
        throw new Error("catalog down");
      },
    });
    await expect(readSupervisorHistory("Ada")).rejects.toBeInstanceOf(
      SupervisorHistoryUnavailableError,
    );
  });

  test("paging back parses a retired session once until it changes; the current one every time", async () => {
    const sessions = { current: talk("c", 1), old: talk("o", 6) };
    const read = fake(sessions);
    let page = await readSupervisorHistory("Ada", { limit: 1 });
    while (page.before) {
      page = await readSupervisorHistory("Ada", {
        before: page.before,
        limit: 1,
      });
    }
    expect(read).toEqual(["current", "old"]);
    await readSupervisorHistory("Ada", { limit: 2 });
    // The current session again; the retired one from the cache.
    expect(read).toEqual(["current", "old", "current"]);
    // A retired session that changed is read again.
    sessions.old = [...sessions.old, ...talk("o2", 1)];
    const again = await readSupervisorHistory("Ada", { limit: 2 });
    expect(again.exchanges.map((x) => x.id)).toEqual(["o2-u1", "c-u1"]);
    expect(read).toEqual(["current", "old", "current", "current", "old"]);
  });

  test("the cache keeps a bounded number of sessions", async () => {
    const sessions: Record<string, TranscriptEntry[]> = {
      current: talk("c", 1),
    };
    const count = CACHED_HISTORY_SESSIONS + 2;
    for (let i = 0; i < count; i++) sessions[`s${i}`] = talk(`s${i}`, 1);
    const read = fake(sessions);
    const walk = async () => {
      let page = await readSupervisorHistory("Ada", { limit: 50 });
      while (page.before)
        page = await readSupervisorHistory("Ada", {
          before: page.before,
          limit: 50,
        });
    };
    await walk();
    read.length = 0;
    await walk();
    // Walking newest to oldest drops the newest retired ones first, so all
    // of them are read again; none is kept past the bound.
    expect(read.filter((id) => id !== "current")).toHaveLength(count);
  });

  test("limit is clamped", () => {
    expect(historyLimit(null)).toBe(20);
    expect(historyLimit("abc")).toBe(20);
    expect(historyLimit("0")).toBe(1);
    expect(historyLimit("500")).toBe(50);
    expect(historyLimit("7")).toBe(7);
  });
});

describe("route", () => {
  async function call(
    path: string,
    authUser: Record<string, unknown> | null = { login: "ada", name: "Ada" },
  ) {
    const { handleSupervisorRoutes } = await import("./routes/supervisor");
    const url = new URL(`http://localhost${path}`);
    return handleSupervisorRoutes({
      req: new Request(url, { method: "GET" }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser: authUser as never,
    });
  }

  test("only the signed-in person's history, never a claimed name", async () => {
    const asked: string[] = [];
    restore = __setSupervisorHistoryDepsForTest({
      sessionIds: async (user) => {
        asked.push(user);
        return ["current"];
      },
      session: async () => ({
        version: "1",
        transcript: async () => talk("c", 2),
      }),
    });
    expect((await call("/api/supervisor/history?user=Ada", null))?.status).toBe(
      401,
    );
    expect(
      (
        await call("/api/supervisor/history", {
          login: "ada",
          name: "Ada",
          automation: true,
        })
      )?.status,
    ).toBe(401);
    const res = await call("/api/supervisor/history?limit=1&user=Grace");
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      exchanges: Array<{ id: string }>;
      before: string;
    };
    expect(body.exchanges.map((x) => x.id)).toEqual(["c-u2"]);
    expect(typeof body.before).toBe("string");
    expect(asked).toEqual(["Ada"]);
  });

  test("a read that fails answers 503 with fixed copy", async () => {
    restore = __setSupervisorHistoryDepsForTest({
      sessionIds: async () => ["current"],
      session: async () => ({
        version: "1",
        transcript: async () => {
          throw new Error("secret store detail");
        },
      }),
    });
    const res = await call("/api/supervisor/history");
    expect(res?.status).toBe(503);
    expect(await res!.json()).toEqual({
      error: "History is unavailable right now. Try again.",
    });
  });
});
