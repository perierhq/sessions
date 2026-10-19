import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setSessionResourceHostForTest,
  groupMatchesRecord,
  listSessionResources,
  ORPHANED_RESOURCE_GRACE_MS,
  parseElapsedTime,
  parseProcessRows,
  reapSessionResources,
  registerSessionResource,
  runSessionResource,
  selectUntrackedSetupScopes,
  stopArchivedSessionResources,
  stopSessionOwnedResources,
  stopSessionResourcesInDir,
  sweepUntrackedSetupScopes,
  type SessionResource,
} from "./session-resources";
import { __setWorkloadScopingForTest } from "./workload-scope";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
let state = "";
let worktree = "";
const leftovers: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

/** A tracked setup that would sleep for a minute. */
async function startSetup(
  options: { sessionId?: string; sessionOwned?: boolean } = {},
) {
  const run = runSessionResource({
    kind: "setup",
    argv: ["sh", "-c", "sleep 60 & wait"],
    cwd: worktree,
    sessionOwned: options.sessionOwned ?? true,
    timeoutMs: 60_000,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });
  expect(await waitFor(() => listSessionResources().length > 0)).toBe(true);
  const record = listSessionResources()[0]!;
  leftovers.push(record.pid!);
  return { run, record };
}

/** A process group this gateway process did not start through the module,
 * standing in for a setup a previous gateway process left behind. */
async function foreignGroup(): Promise<number> {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  leftovers.push(child.pid!);
  return child.pid!;
}

function foreignRecord(
  pid: number,
  overrides: Partial<SessionResource> = {},
): SessionResource {
  return {
    id: `foreign-${pid}`,
    kind: "setup",
    worktreeDir: realpathSync(worktree),
    sessionOwned: true,
    pid,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "os-resources-state-"));
  worktree = mkdtempSync(join(tmpdir(), "os-resources-wt-"));
  process.env.OPENSESSION_STATE_DIR = state;
  __setWorkloadScopingForTest(false);
});

afterEach(async () => {
  __setSessionResourceHostForTest(null);
  __setWorkloadScopingForTest(false);
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  rmSync(state, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

afterAll(() => {
  __setWorkloadScopingForTest(null);
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

test("parseElapsedTime reads ps etime", () => {
  expect(parseElapsedTime("00:07")).toBe(7);
  expect(parseElapsedTime("12:34")).toBe(754);
  expect(parseElapsedTime("01:02:03")).toBe(3723);
  expect(parseElapsedTime("2-01:02:03")).toBe(2 * 86_400 + 3723);
  expect(parseElapsedTime("garbage")).toBeUndefined();
});

describe("archive teardown", () => {
  test("archiving the owner stops its setup and the whole group", async () => {
    const { run, record } = await startSetup();
    const stopped = await stopArchivedSessionResources("owner", {
      listSessions: async () => [
        { id: "owner", worktreeDir: worktree, archived: true },
      ],
      isArchived: (id) => id === "owner",
    });
    expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
    const result = await run;
    expect(result.timedOut).toBe(false);
    expect(await waitFor(() => !alive(record.pid!))).toBe(true);
    expect(listSessionResources()).toEqual([]);
  });

  test("an alias of the owner archives it too", async () => {
    const { run } = await startSetup({ sessionId: "slack-alias" });
    const stopped = await stopArchivedSessionResources("slack-alias", {
      listSessions: async () => [
        {
          id: "owner",
          aliasIds: ["slack-alias"],
          worktreeDir: worktree,
          archived: true,
        },
      ],
      isArchived: () => true,
    });
    expect(stopped).toHaveLength(1);
    await run;
  });

  test("a live sibling in the same worktree keeps the setup running", async () => {
    const { run, record } = await startSetup();
    const stopped = await stopArchivedSessionResources("owner", {
      listSessions: async () => [
        { id: "owner", worktreeDir: worktree, archived: true },
        { id: "sibling", worktreeDir: worktree },
      ],
      isArchived: (id) => id === "owner",
    });
    expect(stopped).toEqual([]);
    expect(alive(record.pid!)).toBe(true);
    // Removing the worktree stops it regardless of owners.
    expect(await stopSessionResourcesInDir(worktree)).toHaveLength(1);
    await run;
    expect(alive(record.pid!)).toBe(false);
  });

  test("a setup tagged with another session is not the archived one's", async () => {
    const { run, record } = await startSetup({ sessionId: "other" });
    const stopped = await stopSessionOwnedResources(
      { id: "owner", worktreeDir: worktree, archived: true },
      [],
    );
    expect(stopped).toEqual([]);
    expect(alive(record.pid!)).toBe(true);
    await stopSessionResourcesInDir(worktree);
    await run;
  });

  test("deleting the owner stops its setup", async () => {
    const { run } = await startSetup();
    const session = { id: "owner", worktreeDir: worktree };
    // The list still carries the deleted session; it must not protect itself.
    const stopped = await stopSessionOwnedResources(session, [session], {
      reason: "removed",
    });
    expect(stopped.map((s) => s.reason)).toEqual(["removed"]);
    await run;
  });

  test("setup in a tree no session owns outright is left to its timeout", async () => {
    const { run, record } = await startSetup({ sessionOwned: false });
    expect(
      await stopSessionOwnedResources(
        { id: "owner", worktreeDir: worktree, archived: true },
        [],
      ),
    ).toEqual([]);
    expect(alive(record.pid!)).toBe(true);
    await stopSessionResourcesInDir(worktree);
    await run;
  });
});

describe("lifecycle reaper sweep", () => {
  test("never reaps a setup this process is still timing", async () => {
    // createWorktreeForPrBranch awaits setup before any session lists the
    // worktree, and a recreated path may still be named by an archived
    // session. The in-process timer bounds both.
    const { run, record } = await startSetup();
    const later = Date.parse(record.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
    expect((await reapSessionResources([], { now: later })).stopped).toEqual(
      [],
    );
    expect(
      (
        await reapSessionResources(
          [{ id: "old", worktreeDir: worktree, archived: true }],
          { now: later },
        )
      ).stopped,
    ).toEqual([]);
    expect(alive(record.pid!)).toBe(true);
    expect(listSessionResources()).toHaveLength(1);
    await stopSessionResourcesInDir(worktree);
    await run;
  });

  test("stops a previous process's setup whose worktree owners are all archived, after the grace", async () => {
    const pid = await foreignGroup();
    const record = foreignRecord(pid);
    await registerSessionResource(record);
    const sessions = [
      { id: "a", worktreeDir: worktree, archived: true },
      { id: "b", worktreeDir: worktree, archived: true },
    ];
    // A path recreated for a new session may still be named by archived ones.
    expect((await reapSessionResources(sessions)).stopped).toEqual([]);
    expect(alive(pid)).toBe(true);
    const later = Date.parse(record.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
    const { stopped } = await reapSessionResources(sessions, { now: later });
    expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(listSessionResources()).toEqual([]);
  });

  test("keeps a previous process's setup a live owner still uses", async () => {
    const pid = await foreignGroup();
    const record = foreignRecord(pid);
    await registerSessionResource(record);
    const later = Date.parse(record.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
    const { stopped } = await reapSessionResources(
      [
        { id: "a", worktreeDir: worktree, archived: true },
        { id: "b", worktreeDir: worktree },
      ],
      { now: later },
    );
    expect(stopped).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  test("an orphaned setup gets a grace period for a session still being created", async () => {
    const pid = await foreignGroup();
    const record = foreignRecord(pid);
    await registerSessionResource(record);
    expect((await reapSessionResources([])).stopped).toEqual([]);
    expect(alive(pid)).toBe(true);
    const later = Date.parse(record.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
    const { stopped } = await reapSessionResources([], { now: later });
    expect(stopped.map((s) => s.reason)).toEqual(["orphaned"]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  test("a tagged setup belongs to its live session before that session lists the worktree", async () => {
    const pid = await foreignGroup();
    const record = foreignRecord(pid, { sessionId: "new" });
    await registerSessionResource(record);
    const later = Date.parse(record.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
    const { stopped } = await reapSessionResources(
      [{ id: "new" }, { id: "old", worktreeDir: worktree, archived: true }],
      { now: later },
    );
    expect(stopped).toEqual([]);
    expect(alive(pid)).toBe(true);
    // Its session gone entirely, it is an orphan once the grace has passed.
    expect(
      (await reapSessionResources([], { now: later })).stopped.map(
        (s) => s.reason,
      ),
    ).toEqual(["orphaned"]);
  });

  test("takes over a deadline a previous gateway process set", async () => {
    const pid = await foreignGroup();
    await registerSessionResource(
      foreignRecord(pid, {
        sessionOwned: false,
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    const { stopped } = await reapSessionResources([]);
    expect(stopped.map((s) => s.reason)).toEqual(["expired"]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(listSessionResources()).toEqual([]);
  });

  test("stops a previous process's setup whose tagged owner is archived", async () => {
    const pid = await foreignGroup();
    await registerSessionResource(foreignRecord(pid, { sessionId: "owner" }));
    const { stopped } = await reapSessionResources([
      { id: "owner", worktreeDir: worktree, archived: true },
    ]);
    expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  test("never signals a recycled pid: the start time must match", async () => {
    const pid = await foreignGroup();
    // Same pid, but recorded as starting an hour earlier than this process.
    await registerSessionResource(
      foreignRecord(pid, {
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );
    const { stopped, forgotten } = await reapSessionResources([
      { id: "owner", worktreeDir: worktree, archived: true },
    ]);
    expect(stopped).toEqual([]);
    expect(forgotten).toBe(1);
    expect(alive(pid)).toBe(true);
  });

  test("forgets records whose processes already ended", async () => {
    const child = spawn("true", [], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => child.once("exit", resolve));
    await registerSessionResource(foreignRecord(child.pid!));
    const result = await reapSessionResources([]);
    expect(result).toEqual({ stopped: [], forgotten: 1 });
    expect(listSessionResources()).toEqual([]);
  });
});

describe("processes a setup leaves behind", () => {
  test("stay tracked without a deadline, are verified by ps, and archive stops them", async () => {
    // The leader backgrounds a daemon in its group and exits at once.
    const result = await runSessionResource({
      kind: "setup",
      argv: ["sh", "-c", "sleep 60 & echo $! > daemon.pid"],
      cwd: worktree,
      sessionOwned: true,
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const daemon = Number(readFileSync(join(worktree, "daemon.pid"), "utf8"));
    expect(alive(daemon)).toBe(true);
    const [record] = listSessionResources();
    leftovers.push(record!.pid!);
    expect(record?.deadlineAt).toBeUndefined();
    expect(record?.leaderExitedAt).toBeString();

    // The grace counts from the leader's exit, not the setup's start.
    const exitedAt = Date.parse(record!.leaderExitedAt!);
    expect(
      (
        await reapSessionResources([], {
          now: exitedAt + ORPHANED_RESOURCE_GRACE_MS - 1_000,
        })
      ).stopped,
    ).toEqual([]);

    // No longer trusted on its pid alone: the leaderless group still
    // matches the record by start time, so archive stops it.
    const stopped = await stopSessionOwnedResources(
      { id: "owner", worktreeDir: worktree, archived: true },
      [],
    );
    expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
    expect(await waitFor(() => !alive(daemon))).toBe(true);
  });

  test("groupMatchesRecord accepts only the recorded group", () => {
    const now = 1_000_000_000;
    const startedAt = now - 60_000;
    // ps reports etime in whole seconds.
    const leader = { pid: 500, pgid: 500, elapsedSec: 60 };
    expect(groupMatchesRecord([leader], 500, startedAt, now)).toBe(true);
    // A recycled pid leads a group that started later.
    expect(
      groupMatchesRecord(
        [{ pid: 500, pgid: 500, elapsedSec: 5 }],
        500,
        startedAt,
        now,
      ),
    ).toBe(false);
    // Leaderless leftovers, all started after the setup.
    expect(
      groupMatchesRecord(
        [
          { pid: 501, pgid: 500, elapsedSec: 50 },
          { pid: 502, pgid: 500, elapsedSec: 10 },
        ],
        500,
        startedAt,
        now,
      ),
    ).toBe(true);
    // A member older than the setup is not its child.
    expect(
      groupMatchesRecord(
        [{ pid: 501, pgid: 500, elapsedSec: 3_600 }],
        500,
        startedAt,
        now,
      ),
    ).toBe(false);
    expect(groupMatchesRecord([], 500, startedAt, now)).toBe(false);
    expect(
      parseProcessRows("  500   500       01:00\n  501   500    00:50\njunk\n"),
    ).toEqual([
      { pid: 500, pgid: 500, elapsedSec: 60 },
      { pid: 501, pgid: 500, elapsedSec: 50 },
    ]);
  });
});

describe("stop reasons", () => {
  test("a run stopped by archive reports why", async () => {
    const { run } = await startSetup();
    await stopSessionOwnedResources(
      { id: "owner", worktreeDir: worktree, archived: true },
      [],
    );
    expect(await run).toMatchObject({ timedOut: false, stopped: "archived" });
  });

  test("a run stopped at its timeout is timed out, not stopped", async () => {
    const result = await runSessionResource({
      kind: "setup",
      argv: ["sh", "-c", "sleep 60 & wait"],
      cwd: worktree,
      sessionOwned: true,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBeUndefined();
  });
});

describe("registry file", () => {
  const registry = () => join(state, ".opensession-session-resources.json");

  test("an unreadable registry is reported and never overwritten", async () => {
    writeFileSync(registry(), "{not json");
    const result = await runSessionResource({
      kind: "setup",
      argv: ["true"],
      cwd: worktree,
      sessionOwned: true,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(registry(), "utf8")).toBe("{not json");
    expect(listSessionResources()).toEqual([]);
    await expect(
      registerSessionResource(foreignRecord(123_456)),
    ).rejects.toThrow("unreadable");
    expect(readFileSync(registry(), "utf8")).toBe("{not json");
  });

  test("two gateway processes writing at once lose no record", async () => {
    const script = `
      const { registerSessionResource } = await import(${JSON.stringify(
        join(import.meta.dir, "session-resources.ts"),
      )});
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          registerSessionResource({
            id: "other-" + i,
            kind: "setup",
            worktreeDir: "/tmp/x",
            sessionOwned: true,
            startedAt: new Date().toISOString(),
          }),
        ),
      );
    `;
    const other = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, OPENSESSION_STATE_DIR: state },
      stdout: "ignore",
      stderr: "pipe",
    });
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        registerSessionResource({
          id: `here-${i}`,
          kind: "setup",
          worktreeDir: "/tmp/x",
          sessionOwned: true,
          startedAt: new Date().toISOString(),
        }),
      ),
    );
    expect(await other.exited).toBe(0);
    expect(listSessionResources()).toHaveLength(30);
  }, 30_000);
});

describe("with workload scoping", () => {
  /** A stand-in for systemd-run: records the argv, runs the command after
   * `--` in its own group, and treats that group (plus a `daemon.pid` the
   * command may write, standing in for a process that left the group but
   * not the cgroup) as the scope. */
  function fakeSystemd() {
    const calls = { argv: [] as string[][], stopped: [] as string[] };
    const scopes = new Map<string, { pgid: number; cwd: string }>();
    const daemonOf = (cwd: string): number | undefined => {
      try {
        return (
          Number(readFileSync(join(cwd, "daemon.pid"), "utf8")) || undefined
        );
      } catch {
        return undefined;
      }
    };
    __setWorkloadScopingForTest(true);
    __setSessionResourceHostForTest({
      spawn: (argv, options): ChildProcess => {
        calls.argv.push(argv);
        const unit = argv
          .find((arg) => arg.startsWith("--unit="))
          ?.slice("--unit=".length);
        const inner = argv.slice(argv.indexOf("--") + 1);
        const child = spawn(inner[0]!, inner.slice(1), {
          cwd: options.cwd,
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        if (unit && child.pid)
          scopes.set(unit, { pgid: child.pid, cwd: options.cwd });
        return child;
      },
      scopeActive: async (unit) => {
        const scope = scopes.get(unit);
        if (!scope) return false;
        const daemon = daemonOf(scope.cwd);
        return alive(-scope.pgid) || (daemon !== undefined && alive(daemon));
      },
      stopScope: async (unit) => {
        calls.stopped.push(unit);
        const scope = scopes.get(unit);
        if (!scope) return;
        const daemon = daemonOf(scope.cwd);
        for (const target of [-scope.pgid, ...(daemon ? [daemon] : [])])
          try {
            process.kill(target, "SIGKILL");
          } catch {}
      },
    });
    return { calls, scopes };
  }

  test("runs setup in a named systemd scope and stops it through the scope", async () => {
    const { calls } = fakeSystemd();
    const result = await runSessionResource({
      kind: "setup",
      argv: ["sh", "-c", "echo $$ > leader.pid; sleep 60 & wait"],
      cwd: worktree,
      sessionOwned: true,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    const argv = calls.argv[0]!;
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/env", argv[1]!]);
    expect(argv[1]).toStartWith("XDG_RUNTIME_DIR=");
    expect(argv.slice(2, 7)).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
    ]);
    const unit = argv.find((a) => a.startsWith("--unit="))!.slice(7);
    expect(unit).toMatch(/^opensession-setup-[0-9a-f]{16}$/);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([
      "sh",
      "-c",
      "echo $$ > leader.pid; sleep 60 & wait",
    ]);
    expect(calls.stopped).toEqual([unit]);
    const leader = Number(readFileSync(join(worktree, "leader.pid"), "utf8"));
    expect(await waitFor(() => !alive(leader))).toBe(true);
    expect(listSessionResources()).toEqual([]);
  });

  test("a daemon that left the process group but not the scope keeps the record", async () => {
    const { calls } = fakeSystemd();
    // `set -m` puts the background job in a process group of its own.
    const result = await runSessionResource({
      kind: "setup",
      argv: ["sh", "-c", "set -m; sleep 60 & echo $! > daemon.pid"],
      cwd: worktree,
      sessionOwned: true,
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    const daemon = Number(readFileSync(join(worktree, "daemon.pid"), "utf8"));
    leftovers.push(daemon);
    expect(alive(daemon)).toBe(true);
    const [record] = listSessionResources();
    expect(record?.unit).toMatch(/^opensession-setup-/);
    expect(record?.leaderExitedAt).toBeString();
    await stopSessionResourcesInDir(worktree);
    expect(calls.stopped).toEqual([record!.unit!]);
    expect(await waitFor(() => !alive(daemon))).toBe(true);
  });

  test("a scoped record from a previous process is stopped through its scope only", async () => {
    const { calls } = fakeSystemd();
    const pid = await foreignGroup();
    // The scope is already gone but the pid is a live group: with a scope
    // recorded, the group is never signalled on its pid alone.
    await registerSessionResource(
      foreignRecord(pid, { unit: "opensession-setup-0123456789abcdef" }),
    );
    expect(await stopSessionResourcesInDir(worktree)).toHaveLength(1);
    expect(calls.stopped).toEqual(["opensession-setup-0123456789abcdef"]);
    await Bun.sleep(100);
    expect(alive(pid)).toBe(true);
  });
});

describe("startup sweep of untracked setup scopes", () => {
  test("selects only old setup scopes no record tracks", () => {
    const hour = 3_600_000;
    expect(
      selectUntrackedSetupScopes(
        [
          { unit: "opensession-setup-aaaa", ageMs: 2 * hour },
          { unit: "opensession-setup-bbbb", ageMs: 2 * hour },
          { unit: "opensession-setup-cccc", ageMs: 60_000 },
          { unit: "opensession-setup-dddd" },
          { unit: "opensession-preview-eeee", ageMs: 2 * hour },
        ],
        new Set(["opensession-setup-bbbb"]),
        hour,
      ).map((scope) => scope.unit),
    ).toEqual(["opensession-setup-aaaa"]);
  });

  test("stops them when scoping is active, and does nothing otherwise", async () => {
    const stoppedUnits: string[] = [];
    __setSessionResourceHostForTest({
      listSetupScopes: async () => [
        { unit: "opensession-setup-old", ageMs: 3_600_000 },
        { unit: "opensession-setup-new", ageMs: 1_000 },
      ],
      stopScope: async (unit) => void stoppedUnits.push(unit),
    });
    __setWorkloadScopingForTest(false);
    expect(await sweepUntrackedSetupScopes({ olderThanMs: 900_000 })).toEqual(
      [],
    );
    __setWorkloadScopingForTest(true);
    expect(await sweepUntrackedSetupScopes({ olderThanMs: 900_000 })).toEqual([
      "opensession-setup-old",
    ]);
    expect(stoppedUnits).toEqual(["opensession-setup-old"]);
  });
});
