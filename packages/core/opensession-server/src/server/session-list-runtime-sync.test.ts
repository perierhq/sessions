import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setActiveRunsPathForTest,
  journalClear,
  journalSet,
} from "./run-journal";
import { emitSessionStateChange } from "./session-state-events";
import {
  SESSION_ROW_SETTLE_CHECKS,
  startSessionListRuntimeSync,
  stopSessionListRuntimeSync,
} from "./session-list-runtime-sync";

const scratch = mkdtempSync(join(tmpdir(), "session-list-runtime-sync-"));
let priorJournal: string;
beforeAll(() => {
  priorJournal = __setActiveRunsPathForTest(join(scratch, "active-runs.json"));
});
afterAll(() => {
  __setActiveRunsPathForTest(priorJournal);
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => stopSessionListRuntimeSync());

const noSettle = { settleDelayMs: 60_000, rowRunning: async () => false };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("session list runtime sync", () => {
  test("publishes the changed row once per session when a run starts or settles", async () => {
    const published: string[] = [];
    startSessionListRuntimeSync((id) => published.push(id), noSettle);

    emitSessionStateChange({ sessionId: "session-1", isRunning: true, at: 1 });
    emitSessionStateChange({ sessionId: "session-1", isRunning: true, at: 1 });
    emitSessionStateChange({ sessionId: "session-2", isRunning: true, at: 1 });
    expect(published).toEqual([]);
    await Promise.resolve();
    expect(published).toEqual(["session-1", "session-2"]);

    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 2 });
    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 2 });
    await Promise.resolve();
    expect(published).toEqual(["session-1", "session-2", "session-1"]);
  });

  test("starts only one listener", async () => {
    let first = 0;
    let second = 0;
    startSessionListRuntimeSync(() => first++, noSettle);
    startSessionListRuntimeSync(() => second++, noSettle);

    emitSessionStateChange({ sessionId: "session-1", isRunning: false, at: 1 });
    await Promise.resolve();

    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  // The turn-end write can still see the run journaled: the journal entry is
  // cleared during teardown, after stream_done. Without a republish the row
  // kept is_running = 1 and stayed in the sidebar as running.
  test("republishes the row when its run leaves the journal", async () => {
    const published: string[] = [];
    startSessionListRuntimeSync((id) => published.push(id), noSettle);
    await journalSet(
      {
        runKey: "run-1",
        osSessionId: "bks-ghpr-7-review",
        cwd: "/tmp",
        startedAt: "2026-09-01T00:00:00.000Z",
      },
      async () => {},
    );
    emitSessionStateChange({
      sessionId: "bks-ghpr-7-review",
      isRunning: false,
      at: 1,
    });
    await Promise.resolve();
    expect(published).toEqual(["bks-ghpr-7-review"]);

    journalClear("run-1");
    await Promise.resolve();
    expect(published).toEqual(["bks-ghpr-7-review", "bks-ghpr-7-review"]);
  });

  test("stops observing the journal when stopped", async () => {
    const published: string[] = [];
    startSessionListRuntimeSync((id) => published.push(id), noSettle);
    stopSessionListRuntimeSync();
    await journalSet(
      {
        runKey: "run-2",
        osSessionId: "bks-ghpr-8-review",
        cwd: "/tmp",
        startedAt: "2026-09-01T00:00:00.000Z",
      },
      async () => {},
    );
    journalClear("run-2");
    await Promise.resolve();
    expect(published).toEqual([]);
  });

  test("re-checks a turn-end row and republishes it only while it still reads running", async () => {
    const published: string[] = [];
    const running = new Set(["stale"]);
    startSessionListRuntimeSync((id) => published.push(id), {
      settleDelayMs: 5,
      rowRunning: async (id) => running.has(id),
    });

    emitSessionStateChange({ sessionId: "stale", isRunning: false, at: 1 });
    emitSessionStateChange({ sessionId: "settled", isRunning: false, at: 1 });
    await Promise.resolve();
    expect(published).toEqual(["stale", "settled"]);

    await tick(15);
    expect(published.slice(0, 3)).toEqual(["stale", "settled", "stale"]);
    expect(published.filter((id) => id === "settled")).toEqual(["settled"]);
  });

  test("re-arms the check while the row keeps reading running, a bounded number of times", async () => {
    const published: string[] = [];
    let checks = 0;
    startSessionListRuntimeSync((id) => published.push(id), {
      settleDelayMs: 2,
      // Teardown outlasts every check: the runtime still reports it busy.
      rowRunning: async () => {
        checks++;
        return true;
      },
    });

    emitSessionStateChange({ sessionId: "slow", isRunning: false, at: 1 });
    await tick(60);

    expect(checks).toBe(SESSION_ROW_SETTLE_CHECKS);
    expect(published).toEqual(
      Array(1 + SESSION_ROW_SETTLE_CHECKS).fill("slow"),
    );
  });

  test("a turn starting while a check reads the row cancels the re-arm", async () => {
    const published: string[] = [];
    let checks = 0;
    startSessionListRuntimeSync((id) => published.push(id), {
      settleDelayMs: 2,
      rowRunning: async () => {
        checks++;
        // The next turn starts while this check is reading the row.
        emitSessionStateChange({ sessionId: "next", isRunning: true, at: 2 });
        return true;
      },
    });

    emitSessionStateChange({ sessionId: "next", isRunning: false, at: 1 });
    await tick(30);

    expect(checks).toBe(1);
    // The turn end and the turn start; the stale check publishes nothing.
    expect(published).toEqual(["next", "next"]);
  });

  test("stops re-checking once the row reads idle", async () => {
    const published: string[] = [];
    let checks = 0;
    startSessionListRuntimeSync((id) => published.push(id), {
      settleDelayMs: 2,
      // Busy at the first check, idle after its republish.
      rowRunning: async () => ++checks === 1,
    });

    emitSessionStateChange({ sessionId: "late", isRunning: false, at: 1 });
    await tick(60);

    expect(checks).toBe(2);
    expect(published).toEqual(["late", "late"]);
  });

  test("a new turn cancels the pending re-check", async () => {
    const published: string[] = [];
    startSessionListRuntimeSync((id) => published.push(id), {
      settleDelayMs: 5,
      rowRunning: async () => true,
    });

    emitSessionStateChange({ sessionId: "busy", isRunning: false, at: 1 });
    emitSessionStateChange({ sessionId: "busy", isRunning: true, at: 2 });
    await tick(30);
    expect(published).toEqual(["busy"]);
  });
});
