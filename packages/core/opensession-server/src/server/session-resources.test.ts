import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listSessionResources,
  ORPHANED_RESOURCE_GRACE_MS,
  parseElapsedTime,
  reapSessionResources,
  registerSessionResource,
  runSessionResource,
  stopArchivedSessionResources,
  stopSessionOwnedResources,
  stopSessionResourcesInDir,
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
  test("stops setup whose worktree owners are all archived", async () => {
    const { run, record } = await startSetup();
    const { stopped } = await reapSessionResources([
      { id: "a", worktreeDir: worktree, archived: true },
      { id: "b", worktreeDir: worktree, archived: true },
    ]);
    expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
    await run;
    expect(await waitFor(() => !alive(record.pid!))).toBe(true);
    expect(listSessionResources()).toEqual([]);
  });

  test("keeps setup a live owner still uses", async () => {
    const { run, record } = await startSetup();
    const { stopped } = await reapSessionResources([
      { id: "a", worktreeDir: worktree, archived: true },
      { id: "b", worktreeDir: worktree },
    ]);
    expect(stopped).toEqual([]);
    expect(alive(record.pid!)).toBe(true);
    await stopSessionResourcesInDir(worktree);
    await run;
  });

  test("orphaned setup gets a grace period for a session still being created", async () => {
    const { run, record } = await startSetup();
    expect((await reapSessionResources([])).stopped).toEqual([]);
    expect(alive(record.pid!)).toBe(true);
    const later = Date.parse(record.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
    const { stopped } = await reapSessionResources([], { now: later });
    expect(stopped.map((s) => s.reason)).toEqual(["orphaned"]);
    await run;
  });

  test("takes over a deadline a previous gateway process set", async () => {
    const pid = await foreignGroup();
    registerSessionResource(
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

  test("stops a previous process's setup whose owner is archived", async () => {
    const pid = await foreignGroup();
    registerSessionResource(foreignRecord(pid, { sessionId: "owner" }));
    const { stopped } = await reapSessionResources([
      { id: "owner", worktreeDir: worktree, archived: true },
    ]);
    expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  test("never signals a recycled pid: the start time must match", async () => {
    const pid = await foreignGroup();
    // Same pid, but recorded as starting an hour earlier than this process.
    registerSessionResource(
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
    registerSessionResource(foreignRecord(child.pid!));
    const result = await reapSessionResources([]);
    expect(result).toEqual({ stopped: [], forgotten: 1 });
    expect(listSessionResources()).toEqual([]);
  });
});
