/**
 * A list row's `is_running` column is whatever its last write saw. A run that
 * ended across a restart left the column set while the run journal was empty,
 * and the sidebar keeps every automation row with it set, so those rows read
 * as running forever. Boot reconciliation re-derives the column from the
 * runtime state the list already overlays on reads.
 */
import { getConfigAsync } from "./config";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedSession } from "./types";

const home = join(
  tmpdir(),
  `session-list-stale-running-${crypto.randomUUID()}`,
);
const sessionsDir = join(home, ".opensession-sessions");
const prior = {
  HOME: process.env.HOME,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
  OPENSESSION_CONFIG: process.env.OPENSESSION_CONFIG,
};
let priorSessionsDir: string;
let priorJournalPath: string;
let cache: typeof import("./session-cache");
let index: typeof import("./session-list-store");
let journal: typeof import("./run-journal");
let rows: typeof import("./session-row-events");
let store: import("./session-list-store").SessionListStore;

function row(id: string, patch: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    createdBy: "GitHub (automation)",
    title: id,
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    automation: "github-pr-review",
    ...patch,
  } as UnifiedSession;
}

beforeAll(async () => {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ repos: {} }));
  process.env.HOME = home;
  process.env.OPENSESSION_STATE_DIR = home;
  process.env.OPENSESSION_CONFIG = join(home, "config.json");
  await getConfigAsync();
  priorSessionsDir = (await import("./paths")).__setSessionsDirForTest(
    sessionsDir,
  );
  journal = await import("./run-journal");
  priorJournalPath = journal.__setActiveRunsPathForTest(
    join(sessionsDir, "active-runs.json"),
  );
  cache = await import("./session-cache");
  index = await import("./session-list-store");
  rows = await import("./session-row-events");
  store = new index.SessionListStore(":memory:");
  index.__setSessionListStoreForTest(store);
});
afterEach(() => {
  rows.__resetSessionRowPublishesForTest();
  for (const record of journal.activeRunRecords())
    journal.journalClear(record.runKey);
});
afterAll(async () => {
  index.__setSessionListStoreForTest(undefined);
  store.close();
  journal.__setActiveRunsPathForTest(priorJournalPath);
  (await import("./paths")).__setSessionsDirForTest(priorSessionsDir);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("clears a running mark no live run owns and keeps journaled runs", async () => {
  await index.upsertIndexedSessions(
    [
      row("bks-ghpr-1-review", {
        isRunning: true,
        runStartedAt: "2026-09-01T00:00:00.000Z",
      }),
      row("bks-ghpr-2-review", { isRunning: true }),
      row("bks-ghpr-3-review"),
    ],
    "include",
  );
  await journal.journalSet(
    {
      runKey: "run-2",
      osSessionId: "bks-ghpr-2-review",
      cwd: "/tmp",
      startedAt: "2026-09-01T00:00:00.000Z",
    },
    async () => {},
  );

  expect(await cache.reconcileStaleRunningRows()).toEqual([
    "bks-ghpr-1-review",
  ]);

  expect(store.listRunning(10).map((r) => r.id)).toEqual(["bks-ghpr-2-review"]);
  const cleared = await index.indexedSession("bks-ghpr-1-review");
  expect(cleared?.isRunning).toBe(false);
  expect(cleared?.runStartedAt).toBeUndefined();
  expect(rows.__scheduledSessionRowsForTest()).toEqual(["bks-ghpr-1-review"]);

  // Once its journal entry is gone the other row reconciles the same way.
  journal.journalClear("run-2");
  expect(await cache.reconcileStaleRunningRows()).toEqual([
    "bks-ghpr-2-review",
  ]);
  expect(store.listRunning(10)).toEqual([]);
});

test("rewrites at most the bounded candidate set", async () => {
  await index.upsertIndexedSessions(
    [
      row("bks-ghpr-4-review", {
        isRunning: true,
        lastActivity: "2026-09-02T00:00:00.000Z",
      }),
      row("bks-ghpr-5-review", { isRunning: true }),
    ],
    "include",
  );

  expect(await cache.reconcileStaleRunningRows(1)).toEqual([
    "bks-ghpr-4-review",
  ]);
  expect(store.listRunning(10).map((r) => r.id)).toEqual(["bks-ghpr-5-review"]);
  expect(await cache.reconcileStaleRunningRows()).toEqual([
    "bks-ghpr-5-review",
  ]);
});

test("does nothing when no row is marked running", async () => {
  expect(await cache.reconcileStaleRunningRows()).toEqual([]);
  expect(rows.__scheduledSessionRowsForTest()).toEqual([]);
});
