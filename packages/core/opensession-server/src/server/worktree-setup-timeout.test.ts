import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Repo } from "./config";
import { listSessionResources } from "./session-resources";
import { __setWorkloadScopingForTest } from "./workload-scope";
import {
  __setSetupOutcomePublisherForTest,
  DEFAULT_WORKTREE_SETUP_TIMEOUT_MS,
  installWorktreeDeps,
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
