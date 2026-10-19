/**
 * Claude pool bookkeeping shared by every process that picks an account.
 *
 * A hosted turn binds its Claude account inside its own run-host process
 * (runner-host/host.ts → runAgent → runPi → createPiRuntimeBinding), and a
 * run host owns exactly one turn. Anything the pick read from module memory
 * was therefore empty on every turn:
 * - the usage snapshot, which only the gateway polls, so every account
 *   looked unused and shared one utilization bucket;
 * - the round-robin's last-picked times, so that bucket's tiebreak always
 *   fell to the first account in store order;
 * - the session → account memory, so a turn never stuck to the account
 *   that served the session before it.
 * Every turn picked the same account, and stickiness never applied.
 *
 * This keeps that state in files beside the account store, as the sidelines
 * already live in claude-accounts-state.json: paths resolve per call, writes
 * are atomic renames with mode 0600, and plain reads go through the
 * stat-keyed JSON cache, so an unchanged file costs one stat. Read-modify-
 * write updates hold a short exclusive lock and read the file itself, so two
 * processes picking at once see each other's turn instead of both taking the
 * same account.
 *
 * Nothing here holds a credential: usage windows, account ids, timestamps,
 * and session keys hashed together with their user.
 */
import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import type { AccountUsage } from "./claude-accounts";
import { stateDir } from "./paths";
import { writeFileAtomic } from "./shared/atomic-write";
import { readJsonFileShared } from "./shared/json-file-cache";

/** The account store. The env override is a test seam (bun tests point it at
 *  a temp store); resolved per call so import order never latches it. */
export function claudeAccountsStorePath(): string {
  return (
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH ||
    stateDir("claude-accounts.json")
  );
}

function siblingPath(suffix: string): string {
  return claudeAccountsStorePath().replace(/\.json$/, "") + `-${suffix}.json`;
}

const usagePath = () => siblingPath("usage");
// Round-robin turns and session memory are separate files: every pick
// rewrites the turns, a handful of timestamps, under the lock; the session
// map (up to SESSION_PICK_LIMIT entries) is rewritten only when a session
// changes account or its entry needs restamping.
const turnsPath = () => siblingPath("turns");
const sessionsPath = () => siblingPath("sessions");

// ── Locked read-modify-write ─────────────────────────────────────────────────
// A lock is held for one read, one small decision and one write: well under
// a millisecond. A holder that died leaves its lock file behind, so a lock
// older than LOCK_STALE_MS is broken. A caller never waits long for one: past
// its budget it goes ahead unlocked, because this is load spreading, never an
// access decision (the pin, owner gate and sidelines do not read it).
//
// Each lock file holds a random token written by the process that created
// it. Breaking a stale lock and releasing one both rename the lock aside
// first, which only one process can do to a given file, then check the
// token of the file they moved: a lock that turns out to be someone else's
// is put back instead of deleted.
const LOCK_STALE_MS = 2_000;
// A run host owns one turn and has nothing else to do while it waits.
const RUN_HOST_LOCK_WAIT_MS = 250;
// The gateway's event loop serves every session, so its synchronous callers
// (one-shot picks, account edits) give up almost at once. The usage poller
// and refresh wait off the loop instead (updateSharedAsync).
const GATEWAY_SYNC_LOCK_WAIT_MS = 5;
const ASYNC_LOCK_MAX_BACKOFF_MS = 16;

/** Run hosts point the run journal at a file of their own; the gateway
 *  never sets it. The same signal run-state.ts uses for detachedRunHost. */
function inRunHost(): boolean {
  return !!process.env.OPENSESSION_RUN_JOURNAL;
}

function syncLockWaitMs(): number {
  return inRunHost() ? RUN_HOST_LOCK_WAIT_MS : GATEWAY_SYNC_LOCK_WAIT_MS;
}

interface LockHandle {
  lock: string;
  token: string;
}

interface LockSeen {
  token: string;
  mtimeMs: number;
}

/** The token and age of a lock file, read through one descriptor so both
 *  describe the same file. */
function readLock(lock: string): LockSeen | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(lock, "r");
    const { mtimeMs } = fstatSync(fd);
    return { token: readFileSync(fd, "utf8"), mtimeMs };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

function asidePath(lock: string, why: string): string {
  return `${lock}.${why}.${process.pid}.${randomUUID()}`;
}

/** Move `lock` aside and delete it only when `isTheOne` accepts the moved
 *  file; otherwise put it back. True when the lock was removed. */
function removeLockIf(
  lock: string,
  why: string,
  isTheOne: (moved: LockSeen | undefined) => boolean,
): boolean {
  const aside = asidePath(lock, why);
  try {
    renameSync(lock, aside);
  } catch {
    return false;
  }
  const removed = isTheOne(readLock(aside));
  if (!removed) {
    // Fails only when yet another process created a lock in the moment it
    // was away; that holder keeps it.
    try {
      linkSync(aside, lock);
    } catch {}
  }
  try {
    rmSync(aside, { force: true });
  } catch {}
  return removed;
}

/** Break the lock `seen` described, if it is stale and still the file at
 *  `lock`. Two contenders that both saw the same stale lock cannot both
 *  break it: the second one moves the first one's fresh lock, finds a
 *  different token, and puts it back. */
function breakStaleLock(lock: string, seen: LockSeen | undefined): boolean {
  if (!seen || Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return false;
  return removeLockIf(
    lock,
    "stale",
    (moved) => moved?.token === seen.token && moved.mtimeMs === seen.mtimeMs,
  );
}

/** Release a lock this process holds. Never throws: a pick that already
 *  succeeded must not fail on its cleanup. A lock that is no longer ours
 *  (broken as stale while held) is left to its new holder. */
function releaseLock(handle: LockHandle): void {
  try {
    removeLockIf(
      handle.lock,
      "release",
      (moved) => moved?.token === handle.token,
    );
  } catch {}
}

type AcquireStep = LockHandle | "retry" | "give-up";

function tryAcquire(lock: string): AcquireStep {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      try {
        mkdirSync(dirname(lock), { recursive: true });
      } catch {}
      return "retry";
    }
    if (code === "EEXIST") {
      breakStaleLock(lock, readLock(lock));
      return "retry";
    }
    return "give-up";
  }
  const token = `${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(fd, token);
  } catch {
    // A lock nobody can identify would only ever be broken as stale.
    try {
      closeSync(fd);
      rmSync(lock, { force: true });
    } catch {}
    return "give-up";
  }
  try {
    closeSync(fd);
  } catch {}
  return { lock, token };
}

function acquireLockSync(lock: string, waitMs: number): LockHandle | undefined {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const step = tryAcquire(lock);
    if (typeof step === "object") return step;
    if (step === "give-up" || Date.now() >= deadline) return undefined;
    Bun.sleepSync(1);
  }
}

async function acquireLockAsync(
  lock: string,
  waitMs: number,
): Promise<LockHandle | undefined> {
  const deadline = Date.now() + waitMs;
  let backoff = 1;
  for (;;) {
    const step = tryAcquire(lock);
    if (typeof step === "object") return step;
    if (step === "give-up" || Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, ASYNC_LOCK_MAX_BACKOFF_MS);
  }
}

function runLocked<T>(handle: LockHandle | undefined, fn: () => T): T {
  try {
    return fn();
  } finally {
    if (handle) releaseLock(handle);
  }
}

const lockPath = (path: string) => `${path}.lock`;

// When a write fails (a read-only or full disk), this process keeps its own
// copy so its picks still rotate and stick, as they did before the files.
const fallback = new Map<string, unknown>();
const unwritable = new Set<string>();

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function fallbackCopy<T extends object>(path: string): T | undefined {
  const value = fallback.get(path) as T | undefined;
  return value === undefined ? undefined : structuredClone(value);
}

/** Unlocked reads: the stat-keyed cache, or this process's own copy while
 *  the file cannot be written. The value is shared: never mutate it. */
function readShared<T extends object>(path: string, empty: () => T): T {
  if (unwritable.has(path)) return (fallback.get(path) as T) ?? empty();
  try {
    const value = readJsonFileShared<T>(path);
    return value && typeof value === "object" ? value : empty();
  } catch {
    // Unparsable: treat as empty; the next update rewrites it whole.
    return (fallback.get(path) as T) ?? empty();
  }
}

/** The read inside a locked update. Always the file itself, never the
 *  stat-keyed cache: a replaced file can, rarely, match a cached stat (an
 *  inode reused within one timestamp tick at the same size), and an update
 *  built on that stale parse would drop other processes' writes. Also read
 *  after a failed write, so a write that succeeds again starts from what
 *  the others wrote meanwhile instead of this process's own copy. */
function readForUpdate<T extends object>(path: string, empty: () => T): T {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value && typeof value === "object") return value as T;
  } catch (error) {
    // Missing: nothing was ever written, or it was removed. This process's
    // own copy only stands in while it cannot write the file itself.
    if (isMissing(error))
      return (unwritable.has(path) && fallbackCopy<T>(path)) || empty();
  }
  // Unparsable: start from this process's copy; the write replaces it whole.
  return fallbackCopy<T>(path) ?? empty();
}

function applyUpdate<T extends object, R>(
  path: string,
  empty: () => T,
  fn: (draft: T) => R,
): R {
  const draft = readForUpdate(path, empty);
  const result = fn(draft);
  fallback.set(path, draft);
  try {
    writeFileAtomic(path, JSON.stringify(draft) + "\n", 0o600);
    unwritable.delete(path);
  } catch (error) {
    if (!unwritable.has(path))
      console.warn(`[claude-accounts] could not persist ${path}:`, error);
    unwritable.add(path);
  }
  return result;
}

function updateShared<T extends object, R>(
  path: string,
  empty: () => T,
  fn: (draft: T) => R,
): R {
  const handle = acquireLockSync(lockPath(path), syncLockWaitMs());
  return runLocked(handle, () => applyUpdate(path, empty, fn));
}

/** updateShared for callers that can wait off the event loop. The update
 *  itself still runs in one synchronous step once the lock is held. */
async function updateSharedAsync<T extends object, R>(
  path: string,
  empty: () => T,
  fn: (draft: T) => R,
): Promise<R> {
  const handle = await acquireLockAsync(lockPath(path), RUN_HOST_LOCK_WAIT_MS);
  return runLocked(handle, () => applyUpdate(path, empty, fn));
}

// ── Usage snapshots ──────────────────────────────────────────────────────────
// Written by whichever process fetched them (the gateway's poller, a run's
// post-limit refresh), read by every pick.

interface UsageFile {
  usage?: Record<string, AccountUsage>;
}

const emptyUsage = (): UsageFile => ({ usage: {} });

/**
 * Whether a freshly fetched snapshot should replace the stored one. A
 * snapshot fetched before the stored one never does: another process got
 * there later. An error never replaces a good snapshot unless the caller
 * says it must (the error itself is what a reader needs to see).
 */
function supersedes(
  next: AccountUsage,
  stored: AccountUsage,
  replaceGood: boolean,
): boolean {
  if (Date.parse(next.fetchedAt) < Date.parse(stored.fetchedAt)) return false;
  return !next.error || !!stored.error || replaceGood;
}

/** The usage snapshot map's interface, backed by the shared file. */
export const sharedUsageCache = {
  get(id: string): AccountUsage | undefined {
    const usage = readShared(usagePath(), emptyUsage).usage;
    return usage && Object.hasOwn(usage, id) ? usage[id] : undefined;
  },
  /** Store a snapshot as is (account setup, tests). */
  set(id: string, value: AccountUsage): void {
    updateShared(usagePath(), emptyUsage, (draft) => {
      (draft.usage ??= {})[id] = value;
    });
  },
  /**
   * Offer a snapshot this process just fetched. Under the lock, it is kept
   * only when it supersedes the stored one (see supersedes): a poll that
   * failed after another process stored a good snapshot, or one that
   * finished after a later one, leaves the stored snapshot alone. Resolves
   * to the snapshot stored now. Waits for the lock off the event loop, so
   * the gateway's poller never blocks it.
   */
  offer(
    id: string,
    value: AccountUsage,
    opts?: { replaceGood?: boolean },
  ): Promise<AccountUsage> {
    return updateSharedAsync(usagePath(), emptyUsage, (draft) => {
      const usage = (draft.usage ??= {});
      const stored = Object.hasOwn(usage, id) ? usage[id] : undefined;
      if (stored && !supersedes(value, stored, !!opts?.replaceGood))
        return stored;
      usage[id] = value;
      return value;
    });
  },
  delete(id: string): void {
    if (this.get(id) === undefined) return;
    updateShared(usagePath(), emptyUsage, (draft) => {
      if (draft.usage) delete draft.usage[id];
    });
  },
};

// ── Picks: round-robin turns and session memory ──────────────────────────────

interface SessionPick {
  id: string;
  at: number;
}

interface TurnsFile {
  /** When each account was last handed a turn, for the bucket tiebreak. */
  lastPickedAt?: Record<string, number>;
}

interface SessionsFile {
  /** Which account last served a session, keyed by sessionPickKey. */
  sessions?: Record<string, SessionPick>;
}

const emptyTurns = (): TurnsFile => ({ lastPickedAt: {} });
const emptySessions = (): SessionsFile => ({ sessions: {} });

/** When each account was last picked (0 when never). Read-only view. */
export function lastPickedTimes(): Readonly<Record<string, number>> {
  return readShared(turnsPath(), emptyTurns).lastPickedAt ?? {};
}

/**
 * Decide and record a pick in one critical section, so a concurrent pick in
 * another process sees this one. `choose` gets the current last-picked
 * times and returns the account to take, or undefined; the taken account's
 * time is stamped. Entries for accounts not in `knownIds` are dropped.
 */
export function recordPick<T extends { id: string }>(
  knownIds: readonly string[],
  choose: (lastPickedAt: Readonly<Record<string, number>>) => T | undefined,
): T | undefined {
  return updateShared(turnsPath(), emptyTurns, (draft) => {
    const times = (draft.lastPickedAt ??= {});
    const picked = choose(times);
    if (!picked) return undefined;
    times[picked.id] = Date.now();
    for (const id of Object.keys(times))
      if (!knownIds.includes(id)) delete times[id];
    return picked;
  });
}

/**
 * A session's remembered account. Bounded: entries older than
 * SESSION_PICK_TTL_MS are forgotten, and past SESSION_PICK_LIMIT the least
 * recently used go first.
 */
const SESSION_PICK_LIMIT = 4096;
const SESSION_PICK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Hashed so the file holds neither user names nor session ids. */
function sessionPickKey(user: string | undefined, sessionKey: string): string {
  return createHash("sha256")
    .update(`${user?.trim().toLowerCase() ?? ""}\0${sessionKey}`)
    .digest("hex")
    .slice(0, 32);
}

/** Re-stamping an unchanged entry more often than this buys nothing: it only
 *  keeps the entry ahead of the TTL and the size bound. */
const SESSION_PICK_RESTAMP_MS = 60_000;

function sessionEntry(key: string): SessionPick | undefined {
  const sessions = readShared(sessionsPath(), emptySessions).sessions;
  const entry =
    sessions && Object.hasOwn(sessions, key) ? sessions[key] : undefined;
  if (!entry || typeof entry.id !== "string") return undefined;
  return Date.now() - entry.at > SESSION_PICK_TTL_MS ? undefined : entry;
}

/** The account that last served this user's session, if remembered. */
export function rememberedSessionAccount(
  user: string | undefined,
  sessionKey: string,
): string | undefined {
  return sessionEntry(sessionPickKey(user, sessionKey))?.id;
}

/** Remember that `accountId` serves this user's session from now on. */
export function rememberSessionAccount(
  user: string | undefined,
  sessionKey: string,
  accountId: string,
): void {
  const key = sessionPickKey(user, sessionKey);
  const now = Date.now();
  const current = sessionEntry(key);
  if (current?.id === accountId && now - current.at < SESSION_PICK_RESTAMP_MS)
    return;
  updateShared(sessionsPath(), emptySessions, (draft) => {
    const sessions = (draft.sessions ??= {});
    sessions[key] = { id: accountId, at: now };
    const live = Object.entries(sessions).filter(
      ([, entry]) => now - entry.at <= SESSION_PICK_TTL_MS,
    );
    if (
      live.length === Object.keys(sessions).length &&
      live.length <= SESSION_PICK_LIMIT
    )
      return;
    live.sort(([, a], [, b]) => b.at - a.at);
    draft.sessions = Object.fromEntries(live.slice(0, SESSION_PICK_LIMIT));
  });
}

/** Test seam: forget every remembered session account. */
export function __forgetSessionAccountsForTest(): void {
  updateShared(sessionsPath(), emptySessions, (draft) => {
    draft.sessions = {};
  });
}

/** Test seam: forget round-robin turns and usage, as a fresh pool would. */
export function __resetSharedPickStateForTest(): void {
  fallback.clear();
  unwritable.clear();
  for (const path of [turnsPath(), sessionsPath(), usagePath()])
    rmSync(path, { force: true });
}

/** Test seam: the lock primitives, to drive their races step by step. */
export const __lockForTest = {
  path: lockPath,
  read: readLock,
  acquire: (lock: string) => acquireLockSync(lock, 0),
  release: releaseLock,
  breakStale: breakStaleLock,
  staleMs: LOCK_STALE_MS,
  syncWaitMs: syncLockWaitMs,
  usagePath: () => usagePath(),
  turnsPath: () => turnsPath(),
  sessionsPath: () => sessionsPath(),
};
