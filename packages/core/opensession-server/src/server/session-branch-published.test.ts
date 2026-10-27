// A session's worktree can carry its work to another branch: a sub-task
// session made on `<x>-task-*` that resets to and pushes the integration
// branch. The record follows the branch the work is published on, so PR and
// CI lookups by branch find it.
import { getConfigAsync } from "./config";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedWorktreeWorkBranch } from "./session-branch-ownership";

const root = await mkdtemp(join(tmpdir(), "session-branch-published-"));
const priorConfig = process.env.OPENSESSION_CONFIG;
const priorWorktrees = process.env.OPENSESSION_WORKTREES_DIR;
const origin = join(root, "origin.git");
const main = join(root, "main");
const worktrees = join(root, "worktrees");
process.env.OPENSESSION_CONFIG = join(root, "config.json");
await getConfigAsync();
delete process.env.OPENSESSION_WORKTREES_DIR;
await writeFile(
  process.env.OPENSESSION_CONFIG,
  JSON.stringify({
    paths: { worktreesDir: worktrees },
    repos: { app: { repo: main, defaultBranch: "main" } },
  }),
);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Acme",
  GIT_AUTHOR_EMAIL: "dev@example.test",
  GIT_COMMITTER_NAME: "Acme",
  GIT_COMMITTER_EMAIL: "dev@example.test",
};
async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}
async function commit(cwd: string, file: string) {
  await writeFile(join(cwd, file), file);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", file);
}

await git(root, "init", "-q", "--bare", "-b", "main", origin);
await git(root, "clone", "-q", origin, main);
await git(main, "checkout", "-q", "-B", "main");
await commit(main, "readme");
await git(main, "push", "-q", "origin", "main");
await git(main, "checkout", "-q", "-b", "integration");
await commit(main, "contracts");
await git(main, "push", "-q", "origin", "integration");
await git(main, "checkout", "-q", "main");

afterAll(async () => {
  if (priorConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = priorConfig;
    await getConfigAsync();
  }
  if (priorWorktrees === undefined)
    delete process.env.OPENSESSION_WORKTREES_DIR;
  else process.env.OPENSESSION_WORKTREES_DIR = priorWorktrees;
  await rm(root, { recursive: true, force: true });
});

describe("the branch a session's work is on", () => {
  test("a sub-task branch reset to the integration branch and pushed there records the integration branch", async () => {
    const dir = join(worktrees, "app-integration-task-b1");
    await git(
      main,
      "worktree",
      "add",
      "-q",
      "-b",
      "integration-task-b1",
      dir,
      "origin/main",
    );
    // Fresh from the default branch: its own branch.
    expect(await ownedWorktreeWorkBranch(dir)).toBe("integration-task-b1");
    await git(dir, "fetch", "-q", "origin", "integration");
    await git(dir, "reset", "-q", "--hard", "origin/integration");
    expect(await ownedWorktreeWorkBranch(dir)).toBe("integration");
    await commit(dir, "task-b1");
    // Committed, not pushed yet: nothing says where it goes.
    expect(await ownedWorktreeWorkBranch(dir)).toBe("integration-task-b1");
    await git(dir, "push", "-q", "origin", "HEAD:integration");
    expect(await ownedWorktreeWorkBranch(dir)).toBe("integration");
  });

  test("a session that pushes its own branch keeps it", async () => {
    const dir = join(worktrees, "app-own-branch");
    await git(
      main,
      "worktree",
      "add",
      "-q",
      "-b",
      "own-branch",
      dir,
      "origin/integration",
    );
    await commit(dir, "own");
    await git(dir, "push", "-q", "origin", "HEAD:own-branch");
    await git(dir, "fetch", "-q", "origin");
    expect(await ownedWorktreeWorkBranch(dir)).toBe("own-branch");
  });

  test("a stacked session that has not started keeps its own branch", async () => {
    const dir = join(worktrees, "app-stacked");
    await git(
      main,
      "worktree",
      "add",
      "-q",
      "-b",
      "stacked",
      dir,
      "origin/integration",
    );
    expect(await ownedWorktreeWorkBranch(dir)).toBe("stacked");
  });

  test("the shared main checkout is no one's", async () => {
    expect(await ownedWorktreeWorkBranch(main)).toBeNull();
  });
});
