import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Repo } from "./config";
import {
  __pendingSetupsForTest,
  listSessionResources,
  ORPHANED_RESOURCE_GRACE_MS,
  reapSessionResources,
  stopArchivedSessionResources,
  stopSessionResourcesInDir,
} from "./session-resources";
import { __setWorkloadScopingForTest } from "./workload-scope";
import {
  __setSetupOutcomePublisherForTest,
  DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
  installWorktreeDeps,
  seedAndInstallWorktree,
  worktreeSetupTimeoutMs,
} from "./worktree";
import {
  recordWorktreeSetupFailure,
  sessionSetupFailure,
  worktreeSetupFailure,
} from "./worktree-setup-status";

const previousStateDir = process.env.OPENSESSION_STATE_DIR;
let state = "";
let worktree = "";
let published: string[] = [];

const repo = (overrides: Partial<Repo> = {}): Repo => ({
  id: "acme",
  label: "Acme",
  repo: "/nonexistent/acme",
  wtPrefix: "acme",
  defaultBranch: "main",
  ghRepo: "acme/widget",
  ...overrides,
});

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
    await Bun.sleep(50);
  }
  return check();
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "os-setup-state-"));
  worktree = mkdtempSync(join(tmpdir(), "os-setup-wt-"));
  process.env.OPENSESSION_STATE_DIR = state;
  __setWorkloadScopingForTest(false);
  published = [];
  __setSetupOutcomePublisherForTest((dir) => published.push(dir));
});

afterEach(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

afterAll(() => {
  __setWorkloadScopingForTest(null);
  __setSetupOutcomePublisherForTest(null);
  if (previousStateDir == null) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousStateDir;
});

test("the setup timeout defaults to 15 minutes and follows the repo", () => {
  expect(DEFAULT_WORKTREE_SETUP_TIMEOUT_MS).toBe(15 * 60_000);
  expect(worktreeSetupTimeoutMs(repo())).toBe(15 * 60_000);
  expect(
    worktreeSetupTimeoutMs(repo({ worktreeSetupTimeoutMinutes: 30 })),
  ).toBe(30 * 60_000);
  expect(worktreeSetupTimeoutMs(repo({ worktreeSetupTimeoutMinutes: 0 }))).toBe(
    15 * 60_000,
  );
  // Clamped to a day: past ~35,792 minutes the timer would fire at once.
  expect(
    worktreeSetupTimeoutMs(repo({ worktreeSetupTimeoutMinutes: 40_000 })),
  ).toBe(24 * 60 * 60_000);
  expect(
    worktreeSetupTimeoutMs(repo({ worktreeSetupTimeoutMinutes: 1e12 })),
  ).toBe(24 * 60 * 60_000);
});

test("an absurd timeout neither kills setup at once nor breaks its record", async () => {
  const result = await installWorktreeDeps(
    repo({ worktreeSetup: "sleep 0.3", worktreeSetupTimeoutMinutes: 1e12 }),
    worktree,
    "feat-absurd",
    { timeoutMs: 1e12 * 60_000 },
  );
  expect(result).toEqual({ ok: true });
});

test("setup for a session still being created is not reaped, and stops with that session", async () => {
  // createWorktreeForPrBranch awaits setup before its session records the
  // worktree: nothing lists the tree yet, and an archived session may still
  // name a recreated path.
  const setup = installWorktreeDeps(
    repo({ worktreeSetup: "sleep 30" }),
    worktree,
    "feat-new",
    { sessionId: "bks-new" },
  );
  expect(await waitFor(() => listSessionResources().length > 0)).toBe(true);
  const [record] = listSessionResources();
  expect(record?.sessionId).toBe("bks-new");
  const later = Date.parse(record!.startedAt) + ORPHANED_RESOURCE_GRACE_MS;
  const sweep = await reapSessionResources(
    [
      { id: "bks-new" },
      { id: "bks-old", worktreeDir: worktree, archived: true },
    ],
    { now: later },
  );
  expect(sweep.stopped).toEqual([]);
  expect(alive(record!.pid!)).toBe(true);

  const stopped = await stopArchivedSessionResources("bks-new", {
    listSessions: async () => [
      { id: "bks-new", worktreeDir: worktree, archived: true },
    ],
    isArchived: () => true,
  });
  expect(stopped.map((s) => s.reason)).toEqual(["archived"]);
  const result = await setup;
  expect(result).toMatchObject({ ok: false, reason: "stopped" });
  const failure = worktreeSetupFailure(worktree);
  expect(failure?.reason).toBe("stopped");
  expect(failure?.message).toBe(
    "Setup was stopped (worktreeSetup) because its session was archived.",
  );
  expect(failure?.message).not.toContain("SIGTERM");
});

test("a hung setup is stopped at its timeout, children included, and recorded", async () => {
  // The setup backgrounds a child and waits on it, like a package manager
  // waiting on its workers. Both must die at the timeout.
  const started = Date.now();
  const result = await installWorktreeDeps(
    repo({
      worktreeSetup:
        "sleep 30 & echo $! > child.pid; echo $$ > leader.pid; wait",
      // 300 ms.
      worktreeSetupTimeoutMinutes: 0.005,
    }),
    worktree,
    "feat-hang",
  );
  const elapsed = Date.now() - started;

  expect(result).toMatchObject({ ok: false, reason: "timed_out" });
  expect(elapsed).toBeLessThan(10_000);
  const leader = Number(readFileSync(join(worktree, "leader.pid"), "utf8"));
  const child = Number(readFileSync(join(worktree, "child.pid"), "utf8"));
  expect(await waitFor(() => !alive(leader) && !alive(child))).toBe(true);
  expect(listSessionResources()).toEqual([]);

  const failure = worktreeSetupFailure(worktree);
  expect(failure?.reason).toBe("timed_out");
  expect(failure?.message).toContain("did not finish");
  expect(failure?.message).toContain("worktreeSetup");
  expect(sessionSetupFailure({ worktreeDir: worktree })).toEqual(failure);
  expect(published).toContain(worktree);
});

test("the timeout covers the whole setup, not each step", async () => {
  const result = await installWorktreeDeps(
    repo({
      worktreeSetup: "sleep 0.2",
      depsInstall: "sleep 30",
      worktreeSetupTimeoutMinutes: 0.01,
    }),
    worktree,
    "feat-budget",
  );
  expect(result).toMatchObject({ ok: false, reason: "timed_out" });
  expect(worktreeSetupFailure(worktree)?.message).toContain("depsInstall");
});

test("a failing setup records why, and a later clean setup clears it", async () => {
  const failed = await installWorktreeDeps(
    repo({ worktreeSetup: "echo 'no lockfile' >&2; exit 3" }),
    worktree,
    "feat-fail",
  );
  expect(failed).toMatchObject({ ok: false, reason: "failed" });
  expect(worktreeSetupFailure(worktree)?.message).toContain("exit 3");
  expect(worktreeSetupFailure(worktree)?.message).toContain("no lockfile");

  const ok = await installWorktreeDeps(
    repo({ worktreeSetup: "true" }),
    worktree,
    "feat-fail",
  );
  expect(ok).toEqual({ ok: true });
  expect(worktreeSetupFailure(worktree)).toBeUndefined();
  expect(listSessionResources()).toEqual([]);
});

test("a session reads the setup failure of an attached repo too", () => {
  const attached = join(worktree, "attached");
  recordWorktreeSetupFailure(attached, {
    reason: "failed",
    message: "Setup failed.",
    at: "2026-01-01T00:00:00.000Z",
  });
  expect(
    sessionSetupFailure({
      worktreeDir: worktree,
      attachedRepos: [{ dir: attached }],
    })?.message,
  ).toBe("Setup failed.");
  expect(
    existsSync(join(state, ".opensession-worktree-setup-status.json")),
  ).toBe(true);
});

/** A warm-template seed that waits until released, like one queued on the
 * template's refresh lock. */
function heldSeed() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const seeding = new Promise<void>((resolve) => (started = resolve));
  return {
    seed: async () => {
      started();
      await released;
    },
    seeding,
    release,
  };
}

test("archiving while seeding waits keeps the setup from starting", async () => {
  const held = heldSeed();
  const setup = seedAndInstallWorktree(
    repo({ worktreeSetup: "touch started" }),
    worktree,
    "feat-seeding",
    { sessionId: "bks-seeding" },
    held.seed,
  );
  await held.seeding;
  // Nothing has spawned, so there is no record to stop; the pipeline is
  // still known.
  expect(listSessionResources()).toEqual([]);
  expect(__pendingSetupsForTest()).toHaveLength(1);
  await stopArchivedSessionResources("bks-seeding", {
    listSessions: async () => [
      { id: "bks-seeding", worktreeDir: worktree, archived: true },
    ],
    isArchived: () => true,
  });
  held.release();
  await setup;
  expect(existsSync(join(worktree, "started"))).toBe(false);
  expect(worktreeSetupFailure(worktree)?.message).toBe(
    "Setup was stopped (worktreeSetup) because its session was archived.",
  );
  expect(__pendingSetupsForTest()).toEqual([]);
});

test("a live sibling in the worktree keeps a waiting setup", async () => {
  const held = heldSeed();
  const setup = seedAndInstallWorktree(
    repo({ worktreeSetup: "touch started" }),
    worktree,
    "feat-shared",
    {},
    held.seed,
  );
  await held.seeding;
  await stopArchivedSessionResources("bks-owner", {
    listSessions: async () => [
      { id: "bks-owner", worktreeDir: worktree, archived: true },
      { id: "bks-sibling", worktreeDir: worktree },
    ],
    isArchived: (id) => id === "bks-owner",
  });
  held.release();
  await setup;
  expect(existsSync(join(worktree, "started"))).toBe(true);
});

test("the reaper cancels a waiting setup whose session is archived", async () => {
  const held = heldSeed();
  const setup = seedAndInstallWorktree(
    repo({ worktreeSetup: "touch started" }),
    worktree,
    "feat-reaped",
    { sessionId: "bks-gone" },
    held.seed,
  );
  await held.seeding;
  await reapSessionResources([{ id: "bks-gone", archived: true }]);
  held.release();
  await setup;
  expect(existsSync(join(worktree, "started"))).toBe(false);
  expect(worktreeSetupFailure(worktree)?.reason).toBe("stopped");
});

test("removing the worktree cancels a waiting setup", async () => {
  const held = heldSeed();
  const setup = seedAndInstallWorktree(
    repo({ worktreeSetup: "touch started" }),
    worktree,
    "feat-removed",
    {},
    held.seed,
  );
  await held.seeding;
  await stopSessionResourcesInDir(worktree);
  held.release();
  await setup;
  expect(existsSync(join(worktree, "started"))).toBe(false);
});
