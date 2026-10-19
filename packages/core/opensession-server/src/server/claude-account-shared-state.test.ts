/**
 * The cross-process lock and the locked updates behind the Claude pool's
 * shared files. The races are driven step by step through the lock
 * primitives, plus one run with real processes contending at once.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AccountUsage } from "./claude-accounts";
import * as realCache from "./shared/json-file-cache";
import * as realAtomic from "./shared/atomic-write";

// Seams around the real modules: a stale parse for one path from the stat
// cache, and failing writes.
let staleRead: { path: string; value: unknown } | undefined;
let failWrites = false;
const readJsonFileShared = realCache.readJsonFileShared;
const writeFileAtomic = realAtomic.writeFileAtomic;
mock.module("./shared/json-file-cache", () => ({
  ...realCache,
  readJsonFileShared: (path: string) =>
    staleRead?.path === path ? staleRead.value : readJsonFileShared(path),
}));
mock.module("./shared/atomic-write", () => ({
  ...realAtomic,
  writeFileAtomic: (path: string, data: string, mode?: number) => {
    if (failWrites) throw new Error("disk full");
    writeFileAtomic(path, data, mode);
  },
}));

const shared = await import("./claude-account-shared-state");
const lock = shared.__lockForTest;

const root = mkdtempSync(join(tmpdir(), "claude-shared-state-"));
const savedStore = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
const savedJournal = process.env.OPENSESSION_RUN_JOURNAL;
let dir = root;

beforeEach(() => {
  // A fresh store directory per test: paths resolve per call.
  dir = mkdtempSync(join(root, "store-"));
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(dir, "accounts.json");
  delete process.env.OPENSESSION_RUN_JOURNAL;
  staleRead = undefined;
  failWrites = false;
});

afterAll(() => {
  if (savedStore === undefined)
    delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = savedStore;
  if (savedJournal === undefined) delete process.env.OPENSESSION_RUN_JOURNAL;
  else process.env.OPENSESSION_RUN_JOURNAL = savedJournal;
  rmSync(root, { recursive: true, force: true });
});

/** A lock file a crashed holder left behind. */
function staleLock(path: string, holder = "4242.crashed-holder") {
  writeFileSync(path, holder);
  const old = (Date.now() - lock.staleMs - 5_000) / 1000;
  utimesSync(path, old, old);
}

const leftovers = (name: string) =>
  readdirSync(dir).filter((f) => f.startsWith(`${name}.lock.`));

describe("breaking a stale lock", () => {
  test("two contenders that saw the same stale lock: only one breaks it", () => {
    const path = lock.path(join(dir, "race.json"));
    staleLock(path);
    // Both contenders find the lock stale before either acts.
    const seenByA = lock.read(path);
    const seenByB = lock.read(path);
    expect(lock.breakStale(path, seenByA)).toBe(true);
    const a = lock.acquire(path);
    expect(a).toBeDefined();
    // B acts on what it saw: it must not take A's fresh lock for it.
    expect(lock.breakStale(path, seenByB)).toBe(false);
    expect(lock.read(path)?.token).toBe(a!.token);
    expect(lock.acquire(path)).toBeUndefined();
    lock.release(a!);
    expect(existsSync(path)).toBe(false);
    expect(leftovers("race.json")).toEqual([]);
  });

  test("a live lock is never broken", () => {
    const path = lock.path(join(dir, "live.json"));
    const held = lock.acquire(path)!;
    expect(lock.breakStale(path, lock.read(path))).toBe(false);
    expect(lock.acquire(path)).toBeUndefined();
    lock.release(held);
  });

  test("processes contending for a stale lock hold it one at a time", async () => {
    const path = lock.path(join(dir, "contended.json"));
    const log = join(dir, "holds.jsonl");
    staleLock(path);
    const fixture = join(
      import.meta.dir,
      "testing/shared-state-lock-process.ts",
    );
    const startAt = Date.now() + 500;
    const contenders = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, fixture, path, log, "20", String(startAt)], {
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(contenders.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const holds = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { from: number; to: number })
      .sort((x, y) => x.from - y.from);
    expect(holds).toHaveLength(4);
    for (let i = 1; i < holds.length; i++)
      expect(holds[i]!.from).toBeGreaterThanOrEqual(holds[i - 1]!.to);
    expect(existsSync(path)).toBe(false);
    expect(leftovers("contended.json")).toEqual([]);
  }, 30_000);
});

describe("releasing a lock", () => {
  test("release removes only the caller's own lock", () => {
    const path = lock.path(join(dir, "own.json"));
    const mine = lock.acquire(path)!;
    // Held past the stale age: another process broke it and holds it now.
    rmSync(path);
    writeFileSync(path, "777.next-holder");
    lock.release(mine);
    expect(lock.read(path)?.token).toBe("777.next-holder");
    expect(leftovers("own.json")).toEqual([]);
  });

  test("a pick that succeeded does not fail on its release", () => {
    let picked: { id: string } | undefined;
    try {
      picked = shared.recordPick(["a"], () => {
        // Neither the write nor the release can touch the directory now.
        chmodSync(dir, 0o500);
        return { id: "a" };
      });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(picked).toEqual({ id: "a" });
  });
});

describe("locked updates", () => {
  test("read the file itself, not the stat cache", () => {
    const turns = lock.turnsPath();
    writeFileSync(turns, JSON.stringify({ lastPickedAt: { a: 5 } }));
    // The cache hands back a stale parse for the file.
    staleRead = { path: turns, value: { lastPickedAt: {} } };
    expect(shared.lastPickedTimes()).toEqual({});
    let seen: Record<string, number> | undefined;
    shared.recordPick(["a", "b"], (times) => {
      seen = { ...times };
      return { id: "b" };
    });
    expect(seen).toEqual({ a: 5 });
    const written = JSON.parse(readFileSync(turns, "utf8")).lastPickedAt;
    expect(written.a).toBe(5);
    expect(written.b).toBeGreaterThan(0);
  });

  test("the first write after a failed one keeps what others wrote meanwhile", () => {
    const turns = lock.turnsPath();
    failWrites = true;
    shared.recordPick(["a", "b", "c"], () => ({ id: "a" }));
    expect(existsSync(turns)).toBe(false);
    // This process still rotates on its own copy.
    expect(shared.lastPickedTimes().a).toBeGreaterThan(0);
    failWrites = false;
    // Another process writes its turn.
    writeFileSync(turns, JSON.stringify({ lastPickedAt: { b: 7 } }));
    shared.recordPick(["a", "b", "c"], () => ({ id: "c" }));
    const written = JSON.parse(readFileSync(turns, "utf8")).lastPickedAt;
    expect(written.b).toBe(7);
    expect(written.c).toBeGreaterThan(0);
    expect(shared.lastPickedTimes()).toEqual(written);
  });

  test("the gateway's synchronous callers barely wait; run hosts wait longer", () => {
    expect(lock.syncWaitMs()).toBeLessThanOrEqual(10);
    const held = lock.acquire(lock.path(lock.turnsPath()))!;
    const started = performance.now();
    // Unlocked past the budget: load spreading only.
    expect(shared.recordPick(["a"], () => ({ id: "a" }))).toEqual({ id: "a" });
    expect(performance.now() - started).toBeLessThan(100);
    lock.release(held);
    process.env.OPENSESSION_RUN_JOURNAL = join(dir, "journal.json");
    expect(lock.syncWaitMs()).toBe(250);
  });
});

describe("usage offers", () => {
  const at = Date.parse("2026-07-01T12:00:00.000Z");
  const snapshot = (minutes: number, pct: number | null): AccountUsage => ({
    fetchedAt: new Date(at + minutes * 60_000).toISOString(),
    fiveHour: { utilization: pct, resetsAt: null },
    sevenDay: null,
    extraUsage: null,
  });
  const failed = (minutes: number, error: string): AccountUsage => ({
    ...snapshot(minutes, null),
    fiveHour: null,
    error,
  });

  test("an error does not replace a good snapshot", async () => {
    const good = snapshot(0, 40);
    expect(await shared.sharedUsageCache.offer("a", good)).toEqual(good);
    const err = failed(5, "usage endpoint returned 503");
    expect(await shared.sharedUsageCache.offer("a", err)).toEqual(good);
    expect(shared.sharedUsageCache.get("a")).toEqual(good);
    // Unless the error is what readers must see.
    const broken = failed(6, "Couldn't read OAuth credentials");
    expect(
      await shared.sharedUsageCache.offer("a", broken, { replaceGood: true }),
    ).toEqual(broken);
    // A later good snapshot replaces an error.
    const later = snapshot(7, 10);
    expect(await shared.sharedUsageCache.offer("a", later)).toEqual(later);
  });

  test("an older snapshot does not replace a newer one", async () => {
    const newer = snapshot(10, 80);
    await shared.sharedUsageCache.offer("a", newer);
    expect(await shared.sharedUsageCache.offer("a", snapshot(5, 20))).toEqual(
      newer,
    );
    expect(
      await shared.sharedUsageCache.offer("a", failed(5, "timeout"), {
        replaceGood: true,
      }),
    ).toEqual(newer);
    expect(shared.sharedUsageCache.get("a")).toEqual(newer);
  });

  test("an offer waits for the lock without blocking the event loop", async () => {
    const held = lock.acquire(lock.path(lock.usagePath()))!;
    const value = snapshot(0, 30);
    const started = performance.now();
    const offered = shared.sharedUsageCache.offer("a", value);
    expect(performance.now() - started).toBeLessThan(20);
    let ticked = false;
    setTimeout(() => (ticked = true), 1);
    await Bun.sleep(30);
    expect(ticked).toBe(true);
    expect(shared.sharedUsageCache.get("a")).toBeUndefined();
    lock.release(held);
    expect(await offered).toEqual(value);
    expect(shared.sharedUsageCache.get("a")).toEqual(value);
  });
});
