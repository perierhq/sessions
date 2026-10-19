/**
 * Processes and containers a session starts that must not outlive the
 * session.
 *
 * Two kinds of *session resource* share the stop paths below:
 *
 * - Recorded (`setup`): fresh-worktree setup commands the gateway starts. A
 *   durable record names the worktree, optionally the session that started
 *   it, and how to stop its whole process tree (the transient systemd scope
 *   when workloads are scoped, otherwise its process group). Records live in
 *   a small state file so a gateway restart does not orphan them.
 * - Labelled (`container`, `unit`): containers and systemd user units that
 *   carry the session's ownership label (session-ownership.ts). The label is
 *   the record; nothing without it is ever stopped.
 *
 * Four paths stop a resource:
 *
 * - its own deadline (`runSessionResource`'s timeout, and the reaper for a
 *   deadline set by a previous gateway process);
 * - archiving or deleting the session that owns its worktree, or whose id
 *   a label carries (`stopSessionOwnedResources`);
 * - the lifecycle reaper, for a worktree whose owners are all archived or
 *   gone, and for labels naming an archived or missing session
 *   (`reapSessionResources`), never while this process's own timer still
 *   bounds a setup;
 * - the startup sweep, for setup scopes older than any setup timeout that
 *   no record knows about (`sweepUntrackedSetupScopes`).
 *
 * The record and the stop path are deliberately generic: a later kind adds
 * a `kind` and, if needed, another stop handle, and inherits archive
 * teardown and the reaper sweep.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./audit";
import { statePath } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { withFileLock } from "./shared/file-lock";
import {
  listLabelledResources,
  resourceInstanceId,
  sessionOwnershipEnv,
  stopLabelledResource,
  type LabelledResource,
} from "./session-ownership";
import {
  stopUserScopeAndWait,
  systemdUserEnv,
  userScopeActive,
} from "./systemd-scopes";
import {
  workloadScopeArgv,
  workloadScopingActive,
  workloadUnitName,
} from "./workload-scope";

/** `setup` is recorded; `container` and `unit` are found by their label. */
export type SessionResourceKind = "setup" | "container" | "unit";

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
  /** Transient systemd user scope, without the `.scope` suffix. When set, the
   * scope is the only stop handle once this process stops watching the
   * leader: its process group is never signalled on a pid alone. */
  unit?: string;
  /** Process-group leader. */
  pid?: number;
  startedAt: string;
  /** Past this the resource is stopped, even by a later gateway process. */
  deadlineAt?: string;
  /** When the leader exited and left processes behind (a daemon the setup
   * meant to start). The owner checks count their grace from here. */
  leaderExitedAt?: string;
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

export type SessionResourceStopReason =
  | "timeout"
  | "expired"
  | "archived"
  | "orphaned"
  | "removed";

export type StoppedSessionResource = {
  id: string;
  kind: SessionResourceKind;
  /** The worktree of a recorded resource; labelled ones have none. */
  worktreeDir?: string;
  /** The owning session a label or record names. */
  sessionId?: string;
  reason: SessionResourceStopReason;
};

/** A resource whose owners are missing or archived may belong to a session
 * that is still being created (or a worktree recreated at a path an archived
 * session still names); give it this long before stopping it for that. */
export const ORPHANED_RESOURCE_GRACE_MS = 10 * 60_000;
/** Longest timer a resource gets: setTimeout fires at once past 2^31-1 ms. */
const MAX_RESOURCE_TIMEOUT_MS = 2 ** 31 - 1;
/** How long a process group gets between SIGTERM and SIGKILL. */
const GROUP_STOP_GRACE_MS = 2_000;
/** Tolerance when matching a recorded start time against `ps` after restart. */
const START_TIME_TOLERANCE_MS = 10_000;
/** Unit name prefix of setup scopes (workloadUnitName("setup")). */
export const SETUP_SCOPE_PREFIX = "opensession-setup-";

// ── Host seam ────────────────────────────────────────────────────────────────

export type SetupScopeInfo = {
  /** Unit name without the `.scope` suffix. */
  unit: string;
  /** Run time of the scope's oldest process, when it could be read. */
  ageMs?: number;
};

/** The system calls this module makes, replaceable in tests. */
export type SessionResourceHost = {
  spawn: (
    argv: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => ChildProcess;
  scopeActive: (unit: string) => Promise<boolean>;
  stopScope: (unit: string) => Promise<void>;
  /** Active `opensession-setup-*` user scopes. */
  listSetupScopes: () => Promise<SetupScopeInfo[]>;
};

async function commandOutput(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, ...systemdUserEnv() },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/** Age of a scope: the oldest process in its cgroup (ps `etimes`). */
async function scopeAgeMs(unit: string): Promise<number | undefined> {
  const cgroup = (
    await commandOutput([
      "systemctl",
      "--user",
      "show",
      "--property=ControlGroup",
      "--value",
      `${unit}.scope`,
    ])
  ).trim();
  if (!cgroup.startsWith("/")) return undefined;
  let pids: string[];
  try {
    pids = (await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8"))
      .split("\n")
      .filter((pid) => /^\d+$/.test(pid));
  } catch {
    return undefined;
  }
  if (!pids.length) return undefined;
  const seconds = (
    await commandOutput([
      "ps",
      "-o",
      "etimes=",
      "-p",
      pids.slice(0, 200).join(","),
    ])
  )
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return seconds.length ? Math.max(...seconds) * 1000 : undefined;
}

const defaultHost: SessionResourceHost = {
  spawn: (argv, options) =>
    spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      // A fresh process group, so a timeout or archive takes the children too.
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    }),
  scopeActive: userScopeActive,
  stopScope: stopUserScopeAndWait,
  listSetupScopes: async () => {
    const out = await commandOutput([
      "systemctl",
      "--user",
      "list-units",
      "--type=scope",
      "--state=active",
      "--plain",
      "--no-legend",
      "--no-pager",
      `${SETUP_SCOPE_PREFIX}*`,
    ]);
    const units = out
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((name) => name.startsWith(SETUP_SCOPE_PREFIX))
      .map((name) => name.replace(/\.scope$/, ""));
    const scopes: SetupScopeInfo[] = [];
    for (const unit of units.slice(0, 100)) {
      const ageMs = await scopeAgeMs(unit).catch(() => undefined);
      scopes.push(ageMs === undefined ? { unit } : { unit, ageMs });
    }
    return scopes;
  },
};

let host: SessionResourceHost = defaultHost;

/** Test seam: replace spawning and the systemd calls, or `null` to restore. */
export function __setSessionResourceHostForTest(
  next: Partial<SessionResourceHost> | null,
): void {
  host = next ? { ...defaultHost, ...next } : defaultHost;
}

// ── Registry ─────────────────────────────────────────────────────────────────

function registryPath(): string {
  return statePath(".opensession-session-resources.json");
}

type RegistryRead =
  | { ok: true; records: SessionResource[] }
  | { ok: false; error: string };

function readRegistryFile(): RegistryRead {
  const path = registryPath();
  try {
    if (!existsSync(path)) return { ok: true, records: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return { ok: false, error: "not a JSON array" };
    return {
      ok: true,
      records: parsed.filter(
        (entry): entry is SessionResource =>
          !!entry &&
          typeof entry.id === "string" &&
          typeof entry.worktreeDir === "string",
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let lastRegistryError: string | undefined;

function warnUnreadableRegistry(error: string): void {
  // Once per distinct error: every list and sweep reads the file.
  if (error === lastRegistryError) return;
  lastRegistryError = error;
  console.error(
    `[session-resources] ${registryPath()} is unreadable (${error}); leaving it untouched, and setup started now is tracked in this process only`,
  );
}

function readRegistry(): SessionResource[] {
  const read = readRegistryFile();
  if (read.ok) {
    lastRegistryError = undefined;
    return read.records;
  }
  warnUnreadableRegistry(read.error);
  return [];
}

/**
 * Read, change and write the registry under its cross-process lock, so a
 * gateway overlapping this one during a restart never loses an update. An
 * unreadable file is reported and left as it is rather than replaced with
 * what this process knows. `change` returns null to skip the write.
 */
async function mutateRegistry(
  change: (records: SessionResource[]) => SessionResource[] | null,
): Promise<void> {
  const path = registryPath();
  await withFileLock(
    path,
    () => {
      const read = readRegistryFile();
      if (!read.ok) {
        warnUnreadableRegistry(read.error);
        throw new Error(
          `session resource registry is unreadable: ${read.error}`,
        );
      }
      const next = change(read.records);
      if (next) writeJsonAtomic(path, next);
    },
    "Session resource registry",
  );
}

/** Registry writes never fail the caller: the record is best-effort state. */
async function mutateRegistryBestEffort(
  what: string,
  change: (records: SessionResource[]) => SessionResource[] | null,
): Promise<void> {
  try {
    await mutateRegistry(change);
  } catch (error) {
    console.warn(
      `[session-resources] could not ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function listSessionResources(): SessionResource[] {
  return readRegistry();
}

/** Whether anything archive or delete teardown could stop is recorded. */
export function hasSessionOwnedResources(): boolean {
  return readRegistry().some((record) => record.sessionOwned);
}

/** Whether archive or delete teardown could find anything to stop, recorded
 * or labelled; callers skip loading the session list when not. */
export async function mayHaveSessionOwnedResources(): Promise<boolean> {
  return (
    hasSessionOwnedResources() || (await listLabelledResources()).length > 0
  );
}

export async function registerSessionResource(
  record: SessionResource,
): Promise<void> {
  await mutateRegistry((records) => [
    ...records.filter((r) => r.id !== record.id),
    record,
  ]);
}

function updateSessionResource(
  id: string,
  patch: Partial<SessionResource>,
): Promise<void> {
  return mutateRegistryBestEffort("update a session resource", (records) => {
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return null;
    const next = [...records];
    // An undefined field in `patch` clears it: JSON drops undefined values.
    next[index] = { ...records[index]!, ...patch };
    return next;
  });
}

export function forgetSessionResource(id: string): Promise<void> {
  return mutateRegistryBestEffort("forget a session resource", (records) => {
    const next = records.filter((r) => r.id !== id);
    return next.length === records.length ? null : next;
  });
}

export async function canonicalResourceDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

// ── Process handles ──────────────────────────────────────────────────────────

/**
 * Resources whose leader this process started and is still waiting on. Their
 * pid cannot have been recycled, and their own timer bounds them. A record
 * leaves the set the moment its leader exits: any processes left behind are
 * then checked like a previous gateway's.
 */
const watchedHere = new Set<string>();
/** Resources a `runSessionResource` call in this process is still running,
 * from spawn until it returns. The reaper leaves them to that call. */
const runsHere = new Map<string, SessionResource>();
/** Stops in flight, so the run that owns a resource can wait for them. */
const stopsInFlight = new Map<string, Promise<void>>();
/** Why each resource run here stopped, for the run that owns it. */
const stopReasons = new Map<string, SessionResourceStopReason>();

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

export type ProcessRow = { pid: number; pgid: number; elapsedSec: number };

/** Rows of `ps -A -o pid=,pgid=,etime=`. */
export function parseProcessRows(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const [pid, pgid, etime] = line.trim().split(/\s+/);
    const elapsedSec = parseElapsedTime(etime ?? "");
    if (!pid || !pgid || elapsedSec === undefined) continue;
    rows.push({ pid: Number(pid), pgid: Number(pgid), elapsedSec });
  }
  return rows;
}

/**
 * Whether the processes in group `pgid` are the ones a record describes.
 * Pids are recycled, so a live group leader must have started when the
 * record says. A group whose leader is gone qualifies only if every member
 * started after the record did (the leftovers of that setup); a recycled pid
 * that leads a new group is always its leader, and is caught by the first
 * rule.
 */
export function groupMatchesRecord(
  rows: readonly ProcessRow[],
  pgid: number,
  startedAtMs: number,
  nowMs: number,
): boolean {
  if (!Number.isFinite(startedAtMs)) return false;
  const members = rows.filter((row) => row.pgid === pgid);
  if (!members.length) return false;
  const started = (row: ProcessRow) => nowMs - row.elapsedSec * 1000;
  const leader = members.find((row) => row.pid === pgid);
  if (leader)
    return Math.abs(started(leader) - startedAtMs) <= START_TIME_TOLERANCE_MS;
  return members.every(
    (row) => started(row) >= startedAtMs - START_TIME_TOLERANCE_MS,
  );
}

/**
 * Whether the record's process group may be signalled. Only an unscoped
 * record that `ps` confirms, or one whose leader this process still watches.
 */
async function recordedGroupStillOurs(
  record: SessionResource,
): Promise<boolean> {
  const pid = record.pid;
  if (!pid || pid < 2 || !groupAlive(pid)) return false;
  if (watchedHere.has(record.id)) return true;
  // Scoped: the scope holds every process the setup started, with no pid to
  // be confused about. Never signal a group on a pid alone.
  if (record.unit) return false;
  try {
    const out = await commandOutput(["ps", "-A", "-o", "pid=,pgid=,etime="]);
    return groupMatchesRecord(
      parseProcessRows(out),
      pid,
      Date.parse(record.startedAt),
      Date.now(),
    );
  } catch {
    return false;
  }
}

/** Whether any process of the resource is still running. */
export async function sessionResourceAlive(
  record: SessionResource,
): Promise<boolean> {
  if (record.unit && (await host.scopeActive(record.unit))) return true;
  return recordedGroupStillOurs(record);
}

/**
 * Stop a resource's whole process tree and forget it. The scope stop takes
 * every process in the cgroup, including ones that left the process group;
 * the group kill covers hosts without systemd scopes (macOS, dev instances)
 * and a scoped leader this process still watches. Never rejects.
 */
async function stopResource(
  record: SessionResource,
  reason: SessionResourceStopReason,
): Promise<StoppedSessionResource> {
  const running = stopsInFlight.get(record.id);
  if (running) {
    await running;
    return describeStop(record, reason);
  }
  if (runsHere.has(record.id)) stopReasons.set(record.id, reason);
  const stopping = (async () => {
    try {
      if (record.unit) await host.stopScope(record.unit);
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
      await forgetSessionResource(record.id);
    }
  })();
  stopsInFlight.set(record.id, stopping);
  try {
    await stopping;
  } finally {
    stopsInFlight.delete(record.id);
  }
  return logStopped(record, reason);
}

function describeStop(
  record: SessionResource,
  reason: SessionResourceStopReason,
): StoppedSessionResource {
  return {
    id: record.id,
    kind: record.kind,
    worktreeDir: record.worktreeDir,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    reason,
  };
}

function logStopped(
  record: SessionResource,
  reason: SessionResourceStopReason,
): StoppedSessionResource {
  audit({
    msg: "session_resource_stopped",
    session_id: record.sessionId,
    kind: record.kind,
    worktree: record.worktreeDir,
    reason,
  });
  return describeStop(record, reason);
}

// ── Running ──────────────────────────────────────────────────────────────────

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
  /** Set when archive, delete, worktree removal or the reaper stopped it. */
  stopped?: Exclude<SessionResourceStopReason, "timeout">;
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
  // Decide on scoping once: the argv and the record must agree.
  const unit = workloadScopingActive()
    ? workloadUnitName(input.kind)
    : undefined;
  const argv = unit ? workloadScopeArgv(input.argv, unit) : input.argv;
  const timeoutMs = Math.min(
    Math.max(0, input.timeoutMs),
    MAX_RESOURCE_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  // A session-tagged setup labels what it starts (a dev database) as the
  // session's, so archive stops that too.
  const ownership = sessionOwnershipEnv(input.sessionId, process.env.PATH);
  const child = host.spawn(argv, {
    cwd: input.cwd,
    ...(Object.keys(ownership).length
      ? { env: { ...process.env, ...ownership } }
      : {}),
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
    deadlineAt: new Date(startedAt + timeoutMs).toISOString(),
    ...(unit ? { unit } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  watchedHere.add(record.id);
  runsHere.set(record.id, record);
  let exitedYet = false;
  void exited.then(() => {
    exitedYet = true;
    // The leader is gone: from here its pid could be recycled.
    watchedHere.delete(record.id);
  });
  try {
    await registerSessionResource(record);
  } catch (error) {
    // Still bounded by the timer below; only a restart loses track of it.
    console.warn(
      `[session-resources] could not record ${record.label ?? record.kind}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let timedOut = false;
  const timer = setTimeout(
    () => {
      if (exitedYet) return;
      timedOut = true;
      void stopResource(record, "timeout");
    },
    Math.max(0, timeoutMs - (Date.now() - startedAt)),
  );
  const { code, signal } = await exited;
  clearTimeout(timer);
  watchedHere.delete(record.id);
  child.stderr?.destroy();
  const stopping = stopsInFlight.get(record.id);
  if (stopping) await stopping;
  const reason = stopReasons.get(record.id);
  stopReasons.delete(record.id);
  try {
    if (!reason) {
      // The leader finished. Processes it left behind (a daemon the setup
      // meant to start) stay tracked: the setup itself is done, so its
      // deadline no longer applies, but archive and the reaper still own them.
      const leftovers = unit
        ? await host.scopeActive(unit)
        : groupAlive(child.pid);
      if (leftovers)
        await updateSessionResource(record.id, {
          deadlineAt: undefined,
          leaderExitedAt: new Date().toISOString(),
        });
      else await forgetSessionResource(record.id);
    }
  } finally {
    runsHere.delete(record.id);
  }
  return {
    exitCode: code,
    signal,
    timedOut,
    ...(reason && reason !== "timeout" ? { stopped: reason } : {}),
    stderr,
  };
}

// ── Ownership ────────────────────────────────────────────────────────────────

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

function hasLiveOwner(owners: Map<string, boolean> | undefined): boolean {
  return !!owners && [...owners.values()].some((archived) => !archived);
}

// ── Labelled resources ───────────────────────────────────────────────────────

function labelledResourceId(resource: LabelledResource): string {
  return `${resource.kind}:${resource.handle}`;
}

/** Stop one labelled container or unit and log it; null when the stop
 * failed (the label stays, so the reaper tries again). */
async function stopLabelled(
  resource: LabelledResource,
  reason: SessionResourceStopReason,
): Promise<StoppedSessionResource | null> {
  if (!(await stopLabelledResource(resource))) {
    console.warn(
      `[session-resources] could not stop ${resource.kind} ${resource.handle} (${resource.label}) of ${resource.sessionId}; the reaper retries`,
    );
    return null;
  }
  audit({
    msg: "session_resource_stopped",
    session_id: resource.sessionId,
    kind: resource.kind,
    handle: resource.handle,
    ...(resource.runtime ? { runtime: resource.runtime } : {}),
    reason,
  });
  return {
    id: labelledResourceId(resource),
    kind: resource.kind,
    sessionId: resource.sessionId,
    reason,
  };
}

/** Labelled stops run this many at a time: a container gets up to ten
 * seconds to exit, and one session may hold several. */
const LABELLED_STOP_CONCURRENCY = 4;

/** Stop `resources` a few at a time; the ones that stopped. */
async function stopLabelledBatch(
  resources: ReadonlyArray<{
    resource: LabelledResource;
    reason: SessionResourceStopReason;
  }>,
): Promise<StoppedSessionResource[]> {
  const results: Array<StoppedSessionResource | null> = [];
  let next = 0;
  const worker = async () => {
    while (next < resources.length) {
      const index = next++;
      const { resource, reason } = resources[index]!;
      results[index] = await stopLabelled(resource, reason);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(LABELLED_STOP_CONCURRENCY, resources.length) },
      worker,
    ),
  );
  return results.filter(
    (result): result is StoppedSessionResource => result !== null,
  );
}

/** Stop every labelled container and unit whose label names one of `ids`. */
async function stopLabelledForSession(
  ids: ReadonlySet<string>,
  reason: SessionResourceStopReason,
): Promise<StoppedSessionResource[]> {
  const owned = (await listLabelledResources()).filter((resource) =>
    ids.has(resource.sessionId),
  );
  return stopLabelledBatch(owned.map((resource) => ({ resource, reason })));
}

/**
 * Why the reaper would stop a labelled container or unit, or null to keep
 * it. A label naming an archived session goes at once. One naming a session
 * the list does not have goes only when the label is this installation's
 * (another instance on the host keeps its own), the session list is not
 * empty (an unavailable list is not a list of no one), and the grace has
 * passed since it started, for a session still being created. A start time
 * that cannot be read keeps it.
 */
export function labelledReapReason(
  resource: Pick<LabelledResource, "sessionId" | "instance" | "startedAtMs">,
  input: {
    ownerArchived: boolean | undefined;
    sessionsKnown: boolean;
    instance: string;
    now: number;
  },
): "archived" | "orphaned" | null {
  if (input.ownerArchived === true) return "archived";
  if (input.ownerArchived === false) return null;
  if (!input.sessionsKnown || resource.instance !== input.instance) return null;
  if (resource.startedAtMs === undefined) return null;
  return input.now - resource.startedAtMs >= ORPHANED_RESOURCE_GRACE_MS
    ? "orphaned"
    : null;
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Stop the resources `session` owns, after it was archived or deleted:
 * recorded ones tagged with its id (or an alias) and untagged ones in its
 * worktrees, unless some other live session still uses that worktree; and
 * every container and unit whose label names it. `others` is the session
 * list; the session itself and archived rows in it are ignored.
 */
export async function stopSessionOwnedResources(
  session: SessionResourceOwner,
  others: readonly SessionResourceOwner[],
  options: { reason?: "archived" | "removed" } = {},
): Promise<StoppedSessionResource[]> {
  const reason = options.reason ?? "archived";
  const ids = new Set(ownerIds(session));
  const dirs = new Set(
    await Promise.all(ownerDirs(session).map(canonicalResourceDir)),
  );
  const stopped: StoppedSessionResource[] = [];
  if (dirs.size) {
    const live = await ownersByDir(
      others.filter(
        (other) =>
          !other.archived && !ownerIds(other).some((id) => ids.has(id)),
      ),
    );
    for (const record of readRegistry()) {
      if (!record.sessionOwned || !dirs.has(record.worktreeDir)) continue;
      if (record.sessionId && !ids.has(record.sessionId)) continue;
      if (live.get(record.worktreeDir)?.size) continue;
      stopped.push(await stopResource(record, reason));
    }
  }
  // A label names exactly one session, so a sibling in the same worktree
  // never keeps it.
  stopped.push(...(await stopLabelledForSession(ids, reason)));
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
    stopped.push(await stopResource(record, "removed"));
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
  if (!(await mayHaveSessionOwnedResources())) return [];
  const listSessions =
    options.listSessions ??
    (async () => (await import("./session-cache")).getCachedSessionsAsync());
  const isArchived =
    options.isArchived ?? (await import("./archive")).isArchivedId;
  const sessions = await listSessions();
  const session = sessions.find(
    (s) => s.id === sessionId || s.aliasIds?.includes(sessionId),
  );
  // Not listed yet or any more: its labels still name it.
  if (!session) return stopLabelledForSession(new Set([sessionId]), "archived");
  return stopSessionOwnedResources(
    session,
    sessions.map((s) => (isArchived(s.id) ? { ...s, archived: true } : s)),
  );
}

// ── Reaper ───────────────────────────────────────────────────────────────────

/**
 * Why the reaper would stop a session-owned record, or null to keep it.
 *
 * A worktree a live session uses always keeps its setup. Otherwise a record
 * tagged with an archived session goes at once, and the rest (owner missing,
 * or untagged in a worktree only archived sessions name) go once the grace
 * has passed since the setup started or its leader exited: a session still
 * being created does not list its worktree yet, and a worktree recreated at
 * a path an archived session still names belongs to someone new.
 */
function reapReason(
  record: SessionResource,
  dirOwners: Map<string, boolean> | undefined,
  taggedArchived: boolean | undefined,
  now: number,
): "archived" | "orphaned" | null {
  if (hasLiveOwner(dirOwners)) return null;
  if (record.sessionId) {
    if (taggedArchived === false) return null;
    if (taggedArchived === true) return "archived";
  }
  const since = Math.max(
    Date.parse(record.startedAt),
    record.leaderExitedAt ? Date.parse(record.leaderExitedAt) : -Infinity,
  );
  const settled =
    !Number.isFinite(since) || now - since >= ORPHANED_RESOURCE_GRACE_MS;
  if (!settled) return null;
  return dirOwners?.size ? "archived" : "orphaned";
}

/**
 * The lifecycle reaper's pass: stop recorded resources past a deadline a
 * previous gateway process set and ones whose owners are all archived or
 * gone, forget records whose processes already ended, and stop labelled
 * containers and units whose session is archived or gone
 * (labelledReapReason). A resource whose leader this process still watches
 * is left to its own timer.
 */
export async function reapSessionResources(
  sessions: readonly SessionResourceOwner[],
  options: {
    now?: number;
    /** Direct lookup of a labelled resource's session the list lacks;
     * undefined means the session no longer exists. */
    findOwner?: (
      id: string,
    ) => Promise<{ id: string; archived?: boolean } | undefined>;
  } = {},
): Promise<{ stopped: StoppedSessionResource[]; forgotten: number }> {
  const now = options.now ?? Date.now();
  const archivedById = new Map<string, boolean>();
  for (const session of sessions)
    for (const id of ownerIds(session))
      archivedById.set(id, session.archived === true);
  const stopped: StoppedSessionResource[] = [];
  let forgotten = 0;
  const records = readRegistry();
  const owners = records.length ? await ownersByDir(sessions) : new Map();
  for (const record of records) {
    // Started here and still running: its in-process timer bounds it, and
    // its session may not list the worktree yet.
    if (runsHere.has(record.id) || stopsInFlight.has(record.id)) continue;
    if (!(await sessionResourceAlive(record))) {
      await forgetSessionResource(record.id);
      forgotten++;
      continue;
    }
    const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : NaN;
    if (Number.isFinite(deadline) && now >= deadline) {
      stopped.push(await stopResource(record, "expired"));
      continue;
    }
    if (!record.sessionOwned) continue;
    const reason = reapReason(
      record,
      owners.get(record.worktreeDir),
      record.sessionId ? archivedById.get(record.sessionId) : undefined,
      now,
    );
    if (reason) stopped.push(await stopResource(record, reason));
  }
  const instance = resourceInstanceId();
  const reap: Array<{
    resource: LabelledResource;
    reason: SessionResourceStopReason;
  }> = [];
  for (const resource of await listLabelledResources()) {
    let reason = labelledReapReason(resource, {
      ownerArchived: archivedById.get(resource.sessionId),
      sessionsKnown: sessions.length > 0,
      instance,
      now,
    });
    // Missing from the list is not yet gone: a session the list has not
    // projected still answers a direct lookup.
    if (reason === "orphaned")
      reason = await confirmOrphaned(resource, options);
    if (reason) reap.push({ resource, reason });
  }
  stopped.push(...(await stopLabelledBatch(reap)));
  return { stopped, forgotten };
}

async function confirmOrphaned(
  resource: LabelledResource,
  options: {
    findOwner?: (
      id: string,
    ) => Promise<{ id: string; archived?: boolean } | undefined>;
  },
): Promise<"archived" | "orphaned" | null> {
  try {
    const findOwner =
      options.findOwner ??
      (async (id: string) => {
        const [{ findSessionAsync }, { isArchivedId }] = await Promise.all([
          import("./session-cache"),
          import("./archive"),
        ]);
        const found = await findSessionAsync(id);
        return found
          ? { id: found.id, archived: found.archived || isArchivedId(found.id) }
          : undefined;
      });
    const owner = await findOwner(resource.sessionId);
    if (!owner) return "orphaned";
    return owner.archived ? "archived" : null;
  } catch {
    // A lookup that failed proves nothing: keep it for the next pass.
    return null;
  }
}

// ── Startup sweep ────────────────────────────────────────────────────────────

/**
 * Setup scopes the startup sweep stops: older than `olderThanMs` (the longest
 * setup timeout) and unknown to the registry. A scope whose age cannot be
 * read is left alone.
 */
export function selectUntrackedSetupScopes(
  scopes: readonly SetupScopeInfo[],
  trackedUnits: ReadonlySet<string>,
  olderThanMs: number,
): SetupScopeInfo[] {
  return scopes.filter(
    (scope) =>
      scope.unit.startsWith(SETUP_SCOPE_PREFIX) &&
      !trackedUnits.has(scope.unit) &&
      scope.ageMs !== undefined &&
      scope.ageMs >= olderThanMs,
  );
}

/**
 * Stop setup scopes left running from before setups were tracked (or whose
 * record was lost), once they are older than any setup may run. Linux with
 * workload scoping only. Never rejects.
 */
export async function sweepUntrackedSetupScopes(options: {
  olderThanMs: number;
}): Promise<string[]> {
  try {
    if (!workloadScopingActive()) return [];
    const scopes = await host.listSetupScopes();
    if (!scopes.length) return [];
    const tracked = new Set(
      [...readRegistry(), ...runsHere.values()]
        .map((record) => record.unit)
        .filter((unit): unit is string => !!unit),
    );
    const stale = selectUntrackedSetupScopes(
      scopes,
      tracked,
      options.olderThanMs,
    );
    for (const scope of stale) {
      console.log(
        `[session-resources] stopping untracked setup scope ${scope.unit} (running ${Math.round((scope.ageMs ?? 0) / 60_000)} min)`,
      );
      await host.stopScope(scope.unit);
      audit({
        msg: "session_resource_stopped",
        kind: "setup",
        unit: scope.unit,
        reason: "untracked",
      });
    }
    return stale.map((scope) => scope.unit);
  } catch (error) {
    console.warn("[session-resources] setup scope sweep failed:", error);
    return [];
  }
}
