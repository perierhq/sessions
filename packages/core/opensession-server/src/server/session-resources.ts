/**
 * Processes the gateway starts on a session's behalf that must not outlive
 * the session: today, fresh-worktree setup commands.
 *
 * Each one is a *session resource*: a durable record naming the worktree it
 * belongs to, optionally the session that started it, and how to stop its
 * whole process tree (the transient systemd scope when workloads are scoped,
 * and always its process group). Records live in a small state file so a
 * gateway restart does not orphan them.
 *
 * Three paths stop a resource:
 *
 * - its own deadline (`runSessionResource`'s timeout, and the reaper for a
 *   deadline set by a previous gateway process);
 * - archiving or deleting the session that owns its worktree
 *   (`stopSessionOwnedResources`);
 * - the lifecycle reaper, for a worktree whose owners are all archived or
 *   gone (`reapSessionResources`).
 *
 * The record and the stop path are deliberately generic: a later kind (a
 * container, a user unit) adds a `kind` and, if needed, another stop handle,
 * and inherits archive teardown and the reaper sweep.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./audit";
import { statePath } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stopUserScopeAndWait, userScopeActive } from "./systemd-scopes";
import {
  workloadArgv,
  workloadScopingActive,
  workloadUnitName,
} from "./workload-scope";

export type SessionResourceKind = "setup";

export interface SessionResource {
  id: string;
  kind: SessionResourceKind;
  /** Canonical directory the resource works in and belongs to. */
  worktreeDir: string;
  /** The session that started it, when the starter knows. Without one, every
   * session whose worktree (or attached repo) is this directory owns it. */
  sessionId?: string;
  /** False for directories no session owns outright (the shared Ask checkout,
   * warm templates): only the deadline stops those. */
  sessionOwned: boolean;
  /** Transient systemd user scope, without the `.scope` suffix. */
  unit?: string;
  /** Process-group leader. */
  pid?: number;
  startedAt: string;
  /** Past this the resource is stopped, even by a later gateway process. */
  deadlineAt?: string;
  /** Human-readable description for logs. */
  label?: string;
}

export type SessionResourceOwner = {
  id: string;
  worktreeDir?: string | null;
  attachedRepos?: ReadonlyArray<{ dir?: string | null }>;
  aliasIds?: readonly string[];
  archived?: boolean;
};

export type StoppedSessionResource = {
  id: string;
  kind: SessionResourceKind;
  worktreeDir: string;
  reason: "timeout" | "expired" | "archived" | "orphaned" | "removed";
};

/** A resource whose worktree has no owner yet may belong to a session that
 * is still being created; give it this long before treating it as orphaned. */
export const ORPHANED_RESOURCE_GRACE_MS = 10 * 60_000;
/** How long a process group gets between SIGTERM and SIGKILL. */
const GROUP_STOP_GRACE_MS = 2_000;
/** Tolerance when matching a recorded start time against `ps` after restart. */
const START_TIME_TOLERANCE_MS = 10_000;

function registryPath(): string {
  return statePath(".opensession-session-resources.json");
}

function readRegistry(): SessionResource[] {
  const path = registryPath();
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is SessionResource =>
            !!entry &&
            typeof entry.id === "string" &&
            typeof entry.worktreeDir === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function writeRegistry(records: SessionResource[]): void {
  writeJsonAtomic(registryPath(), records);
}

export function listSessionResources(): SessionResource[] {
  return readRegistry();
}

/** Whether anything archive or delete teardown could stop is recorded. */
export function hasSessionOwnedResources(): boolean {
  return readRegistry().some((record) => record.sessionOwned);
}

export function registerSessionResource(record: SessionResource): void {
  writeRegistry([...readRegistry().filter((r) => r.id !== record.id), record]);
}

function updateSessionResource(
  id: string,
  patch: Partial<SessionResource>,
): void {
  const records = readRegistry();
  const index = records.findIndex((r) => r.id === id);
  if (index < 0) return;
  records[index] = { ...records[index]!, ...patch };
  writeRegistry(records);
}

export function forgetSessionResource(id: string): void {
  const records = readRegistry();
  const next = records.filter((r) => r.id !== id);
  if (next.length !== records.length) writeRegistry(next);
}

export async function canonicalResourceDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

/** Resources started by this gateway process: their pids are known-good. */
const startedHere = new Set<string>();

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** `ps` etime, `[[dd-]hh:]mm:ss`, in seconds. */
export function parseElapsedTime(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/**
 * Whether `pid` still leads the process group a previous gateway recorded.
 * Pids are recycled, so a record from before a restart is trusted only when
 * the process is still a group leader that started when the record says.
 */
async function recordedGroupStillOurs(
  record: SessionResource,
): Promise<boolean> {
  const pid = record.pid;
  if (!pid || pid < 2 || !groupAlive(pid)) return false;
  if (startedHere.has(record.id)) return true;
  try {
    const proc = Bun.spawn(["ps", "-o", "pgid=,etime=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const [pgid, etime] = out.split(/\s+/);
    if (Number(pgid) !== pid) return false;
    const elapsed = parseElapsedTime(etime ?? "");
    if (elapsed === undefined) return false;
    const startedAt = Date.parse(record.startedAt);
    return (
      Number.isFinite(startedAt) &&
      Math.abs(Date.now() - elapsed * 1000 - startedAt) <=
        START_TIME_TOLERANCE_MS
    );
  } catch {
    return false;
  }
}

/** Whether any process of the resource is still running. */
export async function sessionResourceAlive(
  record: SessionResource,
): Promise<boolean> {
  if (record.unit && (await userScopeActive(record.unit))) return true;
  return recordedGroupStillOurs(record);
}

/**
 * Stop a resource's whole process tree and forget it. The scope stop takes
 * every process in the cgroup, including ones that left the process group;
 * the group kill covers hosts without systemd scopes (macOS, dev instances).
 * Never rejects.
 */
export async function stopSessionResource(
  record: SessionResource,
): Promise<void> {
  try {
    if (record.unit) await stopUserScopeAndWait(record.unit);
    if (await recordedGroupStillOurs(record)) {
      const pid = record.pid!;
      signalGroup(pid, "SIGTERM");
      const deadline = Date.now() + GROUP_STOP_GRACE_MS;
      while (Date.now() < deadline && groupAlive(pid)) await Bun.sleep(100);
      if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    }
  } catch (error) {
    console.warn(
      `[session-resources] could not stop ${record.label ?? record.kind} in ${record.worktreeDir}:`,
      error,
    );
  } finally {
    forgetSessionResource(record.id);
    startedHere.delete(record.id);
  }
}

function logStopped(
  record: SessionResource,
  reason: StoppedSessionResource["reason"],
): StoppedSessionResource {
  audit({
    msg: "session_resource_stopped",
    session_id: record.sessionId,
    kind: record.kind,
    worktree: record.worktreeDir,
    reason,
  });
  return {
    id: record.id,
    kind: record.kind,
    worktreeDir: record.worktreeDir,
    reason,
  };
}

export type RunSessionResourceInput = {
  kind: SessionResourceKind;
  argv: string[];
  cwd: string;
  /** Directory the resource belongs to; defaults to `cwd`. */
  worktreeDir?: string;
  sessionId?: string;
  sessionOwned: boolean;
  timeoutMs: number;
  label?: string;
};

export type RunSessionResourceResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Last few KB of stderr. */
  stderr: string;
};

const STDERR_TAIL_BYTES = 4096;

/**
 * Run a command as a tracked session resource: its own process group, in a
 * workload scope when scoping is active, recorded until it exits, and killed
 * with its whole tree when `timeoutMs` passes. Resolves (never hangs) once
 * the command exits or has been stopped.
 */
export async function runSessionResource(
  input: RunSessionResourceInput,
): Promise<RunSessionResourceResult> {
  const unit = workloadScopingActive()
    ? workloadUnitName(input.kind)
    : undefined;
  const argv = workloadArgv(input.argv, input.kind, unit ? { unit } : {});
  const startedAt = Date.now();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: input.cwd,
    // A fresh process group, so a timeout or archive takes the children too.
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", () => resolveExit({ code: null, signal: null }));
  });
  if (!child.pid) {
    const { code, signal } = await exited;
    return { exitCode: code ?? 127, signal, timedOut: false, stderr };
  }

  const record: SessionResource = {
    id: randomUUID(),
    kind: input.kind,
    worktreeDir: await canonicalResourceDir(input.worktreeDir ?? input.cwd),
    sessionOwned: input.sessionOwned,
    pid: child.pid,
    startedAt: new Date(startedAt).toISOString(),
    deadlineAt: new Date(startedAt + input.timeoutMs).toISOString(),
    ...(unit ? { unit } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  startedHere.add(record.id);
  registerSessionResource(record);

  let timedOut = false;
  let stopping: Promise<void> | undefined;
  const timer = setTimeout(
    () => {
      timedOut = true;
      logStopped(record, "timeout");
      stopping = stopSessionResource(record);
    },
    Math.max(0, input.timeoutMs - (Date.now() - startedAt)),
  );
  const { code, signal } = await exited;
  clearTimeout(timer);
  child.stderr?.destroy();
  if (stopping) await stopping;
  else if (groupAlive(child.pid)) {
    // The leader finished but left processes behind (a daemon the setup
    // meant to start). The setup itself is done, so its deadline no longer
    // applies; archive and the reaper still own what is left.
    updateSessionResource(record.id, { deadlineAt: undefined });
  } else {
    forgetSessionResource(record.id);
    startedHere.delete(record.id);
  }
  return { exitCode: code, signal, timedOut, stderr };
}

function ownerIds(owner: SessionResourceOwner): string[] {
  return [owner.id, ...(owner.aliasIds ?? [])];
}

function ownerDirs(owner: SessionResourceOwner): string[] {
  const dirs = [
    owner.worktreeDir,
    ...(owner.attachedRepos ?? []).map((repo) => repo.dir),
  ];
  return dirs.filter((dir): dir is string => !!dir);
}

type DirOwners = Map<string, Map<string, boolean>>;

async function ownersByDir(
  sessions: readonly SessionResourceOwner[],
): Promise<DirOwners> {
  const owners: DirOwners = new Map();
  for (const session of sessions) {
    for (const dir of ownerDirs(session)) {
      const key = await canonicalResourceDir(dir);
      const set = owners.get(key) ?? new Map<string, boolean>();
      for (const id of ownerIds(session))
        set.set(id, session.archived === true);
      owners.set(key, set);
    }
  }
  return owners;
}

/**
 * Stop the resources `session` owns, after it was archived or deleted. A
 * resource tagged with another session's id is left alone, and so is an
 * untagged one in a worktree some other live session still uses. `others`
 * is the session list; the session itself and archived rows in it are
 * ignored.
 */
export async function stopSessionOwnedResources(
  session: SessionResourceOwner,
  others: readonly SessionResourceOwner[],
  options: { reason?: "archived" | "removed" } = {},
): Promise<StoppedSessionResource[]> {
  const ids = new Set(ownerIds(session));
  const dirs = new Set(
    await Promise.all(ownerDirs(session).map(canonicalResourceDir)),
  );
  if (!dirs.size) return [];
  const live = await ownersByDir(
    others.filter(
      (other) => !other.archived && !ownerIds(other).some((id) => ids.has(id)),
    ),
  );
  const stopped: StoppedSessionResource[] = [];
  for (const record of readRegistry()) {
    if (!record.sessionOwned || !dirs.has(record.worktreeDir)) continue;
    const owned = record.sessionId
      ? ids.has(record.sessionId)
      : !live.get(record.worktreeDir)?.size;
    if (!owned) continue;
    await stopSessionResource(record);
    stopped.push(logStopped(record, options.reason ?? "archived"));
  }
  return stopped;
}

/** Stop every resource in `dir`, whoever owns it (the worktree is going away). */
export async function stopSessionResourcesInDir(
  dir: string,
): Promise<StoppedSessionResource[]> {
  const key = await canonicalResourceDir(dir);
  const stopped: StoppedSessionResource[] = [];
  for (const record of readRegistry()) {
    if (record.worktreeDir !== key) continue;
    await stopSessionResource(record);
    stopped.push(logStopped(record, "removed"));
  }
  return stopped;
}

/**
 * Archive teardown by id. Resolves the session (and its aliases) from the
 * merged session list, then stops what it owns. Best-effort: the reaper
 * retries anything this misses.
 */
export async function stopArchivedSessionResources(
  sessionId: string,
  options: {
    listSessions?: () => Promise<readonly SessionResourceOwner[]>;
    isArchived?: (id: string) => boolean;
  } = {},
): Promise<StoppedSessionResource[]> {
  if (!hasSessionOwnedResources()) return [];
  const listSessions =
    options.listSessions ??
    (async () => (await import("./session-cache")).getCachedSessionsAsync());
  const isArchived =
    options.isArchived ?? (await import("./archive")).isArchivedId;
  const sessions = await listSessions();
  const session = sessions.find(
    (s) => s.id === sessionId || s.aliasIds?.includes(sessionId),
  );
  if (!session) return [];
  return stopSessionOwnedResources(
    session,
    sessions.map((s) => (isArchived(s.id) ? { ...s, archived: true } : s)),
  );
}

/**
 * The lifecycle reaper's pass: stop resources past their deadline and ones
 * whose worktree owners are all archived or gone, and forget records whose
 * processes already ended.
 */
export async function reapSessionResources(
  sessions: readonly SessionResourceOwner[],
  options: { now?: number } = {},
): Promise<{ stopped: StoppedSessionResource[]; forgotten: number }> {
  const now = options.now ?? Date.now();
  const records = readRegistry();
  if (!records.length) return { stopped: [], forgotten: 0 };
  const owners = await ownersByDir(sessions);
  const stopped: StoppedSessionResource[] = [];
  let forgotten = 0;
  for (const record of records) {
    if (!(await sessionResourceAlive(record))) {
      forgetSessionResource(record.id);
      startedHere.delete(record.id);
      forgotten++;
      continue;
    }
    const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : NaN;
    // A live timer in this process stops its own resource; the reaper only
    // takes over a deadline a previous gateway process set.
    if (
      Number.isFinite(deadline) &&
      now >= deadline &&
      !startedHere.has(record.id)
    ) {
      await stopSessionResource(record);
      stopped.push(logStopped(record, "expired"));
      continue;
    }
    if (!record.sessionOwned) continue;
    const liveOwners = owners.get(record.worktreeDir) ?? new Map();
    const orphaned = record.sessionId
      ? !liveOwners.has(record.sessionId)
      : liveOwners.size === 0;
    const archived = record.sessionId
      ? liveOwners.get(record.sessionId) === true
      : liveOwners.size > 0 && [...liveOwners.values()].every(Boolean);
    const startedAt = Date.parse(record.startedAt);
    const settled =
      !Number.isFinite(startedAt) ||
      now - startedAt >= ORPHANED_RESOURCE_GRACE_MS;
    const reason = archived
      ? "archived"
      : orphaned && settled
        ? "orphaned"
        : null;
    if (!reason) continue;
    await stopSessionResource(record);
    stopped.push(logStopped(record, reason));
  }
  return { stopped, forgotten };
}
