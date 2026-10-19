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
 * are atomic renames with mode 0600, and reads go through the stat-keyed
 * JSON cache, so an unchanged file costs one stat. Read-modify-write updates
 * hold a short exclusive lock, so two processes picking at once see each
 * other's turn instead of both taking the same account.
 *
 * Nothing here holds a credential: usage windows, account ids, timestamps,
 * and session keys hashed together with their user.
 */
import { createHash } from "crypto";
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "fs";
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
const picksPath = () => siblingPath("picks");

// ── Locked read-modify-write ─────────────────────────────────────────────────
// A lock is held for one read, one small decision and one write: well under
// a millisecond. A holder that died leaves its lock file behind, so a lock
// older than LOCK_STALE_MS is broken. A pick never waits long for one: past
// LOCK_WAIT_MS it goes ahead unlocked, because this is load spreading, never
// an access decision (the pin, owner gate and sidelines do not read it).
const LOCK_WAIT_MS = 250;
const LOCK_STALE_MS = 2_000;

function withFileLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      held = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        try {
          mkdirSync(dirname(lock), { recursive: true });
        } catch {}
      } else if (code === "EEXIST") {
        try {
          if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS)
            rmSync(lock, { force: true });
        } catch {}
      } else {
        break;
      }
    }
    if (Date.now() >= deadline) break;
    Bun.sleepSync(1);
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { force: true });
  }
}

// When a write fails (a read-only or full disk), this process keeps its own
// copy so its picks still rotate and stick, as they did before the files.
const fallback = new Map<string, unknown>();
const unwritable = new Set<string>();

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

function updateShared<T extends object, R>(
  path: string,
  empty: () => T,
  fn: (draft: T) => R,
): R {
  return withFileLock(path, () => {
    const draft = structuredClone(readShared(path, empty));
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
  });
}

// ── Usage snapshots ──────────────────────────────────────────────────────────
// Written by whichever process fetched them (the gateway's poller, a run's
// post-limit refresh), read by every pick.

interface UsageFile {
  usage?: Record<string, AccountUsage>;
}

const emptyUsage = (): UsageFile => ({ usage: {} });

/** The usage snapshot map's interface, backed by the shared file. */
export const sharedUsageCache = {
  get(id: string): AccountUsage | undefined {
    const usage = readShared(usagePath(), emptyUsage).usage;
    return usage && Object.hasOwn(usage, id) ? usage[id] : undefined;
  },
  set(id: string, value: AccountUsage): void {
    updateShared(usagePath(), emptyUsage, (draft) => {
      (draft.usage ??= {})[id] = value;
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

interface PicksFile {
  /** When each account was last handed a turn, for the bucket tiebreak. */
  lastPickedAt?: Record<string, number>;
  /** Which account last served a session, keyed by sessionPickKey. */
  sessions?: Record<string, SessionPick>;
}

const emptyPicks = (): PicksFile => ({ lastPickedAt: {}, sessions: {} });

/** When each account was last picked (0 when never). Read-only view. */
export function lastPickedTimes(): Readonly<Record<string, number>> {
  return readShared(picksPath(), emptyPicks).lastPickedAt ?? {};
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
  return updateShared(picksPath(), emptyPicks, (draft) => {
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
  const sessions = readShared(picksPath(), emptyPicks).sessions;
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
  updateShared(picksPath(), emptyPicks, (draft) => {
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
  updateShared(picksPath(), emptyPicks, (draft) => {
    draft.sessions = {};
  });
}

/** Test seam: forget round-robin turns and usage, as a fresh pool would. */
export function __resetSharedPickStateForTest(): void {
  fallback.clear();
  unwritable.clear();
  rmSync(picksPath(), { force: true });
  rmSync(usagePath(), { force: true });
}
