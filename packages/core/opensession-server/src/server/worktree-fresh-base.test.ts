import { getConfigAsync } from "./config";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import {
  __setAskCheckoutTimingForTest,
  ensureAskCheckout,
  fastForwardBranchFromOrigin,
  invalidateAskCheckoutRefresh,
  reviveWorktree,
  withGitLock,
} from "./worktree";

/**
 * New sessions start from origin's current state: the shared Ask checkout
 * catches up before a session reads it, and a reused local branch is
 * fast-forwarded when origin is strictly ahead. Real temporary repositories,
 * no network.
 */

const ENV_KEYS = ["OPENSESSION_CONFIG", "OPENSESSION_WORKTREES_DIR"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

let root: string;
let repoDir: string;
let publisherDir: string;
const REPO_ID = "fresh";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await $`git -C ${cwd} ${args}`.quiet().text()).trim();
}

async function commit(cwd: string, file: string, message: string) {
  writeFileSync(join(cwd, file), `${message}\n`);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", message);
}

/** Land a commit on origin's main from another clone. */
async function landOnMain(message: string): Promise<string> {
  await git(publisherDir, "pull", "-q", "--ff-only", "origin", "main");
  await commit(publisherDir, `${message.replace(/\W+/g, "-")}.txt`, message);
  await git(publisherDir, "push", "-q", "origin", "HEAD:main");
  return git(publisherDir, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bks-wt-fresh-"));
  const originDir = join(root, "origin.git");
  repoDir = join(root, "repo");
  publisherDir = join(root, "publisher");
  await $`git init --bare -b main ${originDir}`.quiet();
  for (const dir of [repoDir, publisherDir]) {
    await $`git init -b main ${dir}`.quiet();
    await git(dir, "config", "user.email", "test@test");
    await git(dir, "config", "user.name", "test");
    await git(dir, "remote", "add", "origin", originDir);
  }
  await commit(repoDir, "a.txt", "init");
  await git(repoDir, "push", "-q", "-u", "origin", "main");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        [REPO_ID]: {
          repo: repoDir,
          wtPrefix: REPO_ID,
          defaultBranch: "main",
          ghRepo: "acme/fresh",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  await getConfigAsync();
  process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Ask checkout freshness", () => {
  test("a new Ask session waits for a push that invalidated the checkout", async () => {
    const askDir = await ensureAskCheckout(REPO_ID);
    const pushed = await landOnMain("pushed after the checkout was made");
    // Inside the fresh window nothing is fetched...
    expect(await ensureAskCheckout(REPO_ID)).toBe(askDir);
    expect(await git(askDir, "rev-parse", "HEAD")).not.toBe(pushed);
    // ...until the push webhook invalidates it; then the session waits.
    invalidateAskCheckoutRefresh(REPO_ID);
    expect(await ensureAskCheckout(REPO_ID)).toBe(askDir);
    expect(await git(askDir, "rev-parse", "HEAD")).toBe(pushed);
  });

  test("a checkout older than the fresh window is refreshed before the session starts", async () => {
    const askDir = await ensureAskCheckout(REPO_ID);
    const pushed = await landOnMain("pushed during a quiet period");
    const restore = __setAskCheckoutTimingForTest({ freshMs: 0 });
    try {
      await Bun.sleep(2);
      expect(await ensureAskCheckout(REPO_ID)).toBe(askDir);
    } finally {
      restore();
    }
    expect(await git(askDir, "rev-parse", "HEAD")).toBe(pushed);
  });

  test("a refresh with nothing new leaves the tree alone", async () => {
    const askDir = await ensureAskCheckout(REPO_ID);
    // Only a reset would revert this tracked edit.
    writeFileSync(join(askDir, "a.txt"), "edited\n");
    invalidateAskCheckoutRefresh(REPO_ID);
    await ensureAskCheckout(REPO_ID);
    expect(readFileSync(join(askDir, "a.txt"), "utf8")).toBe("edited\n");
    await git(askDir, "checkout", "--", "a.txt");
  });

  test("a slow refresh is waited for only so long, then finishes in the background", async () => {
    const askDir = await ensureAskCheckout(REPO_ID);
    const before = await git(askDir, "rev-parse", "HEAD");
    const pushed = await landOnMain("pushed while git is busy");
    const restore = __setAskCheckoutTimingForTest({ waitMs: 50 });
    let release!: () => void;
    let entered!: () => void;
    const inLock = new Promise<void>((resolve) => (entered = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    // Another git operation holds the lock, so the refresh cannot start.
    const blocker = withGitLock(async () => {
      entered();
      await held;
    });
    try {
      await inLock;
      invalidateAskCheckoutRefresh(REPO_ID);
      const started = Date.now();
      expect(await ensureAskCheckout(REPO_ID)).toBe(askDir);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await git(askDir, "rev-parse", "HEAD")).toBe(before);
    } finally {
      restore();
      release();
      await blocker;
    }
    // The next session joins the refresh still in flight instead of
    // starting another one, and sees the pushed head.
    expect(await ensureAskCheckout(REPO_ID)).toBe(askDir);
    expect(await git(askDir, "rev-parse", "HEAD")).toBe(pushed);
  });
});

describe("reused local branches catch up with origin", () => {
  async function branchPushedFromHere(name: string): Promise<string> {
    await git(repoDir, "branch", name, "origin/main");
    await git(repoDir, "push", "-q", "origin", name);
    return git(repoDir, "rev-parse", name);
  }

  async function landOnBranch(name: string, message: string): Promise<string> {
    await git(publisherDir, "fetch", "-q", "origin", name);
    await git(publisherDir, "checkout", "-q", "-B", name, `origin/${name}`);
    await commit(
      publisherDir,
      `${name}-${message.replace(/\W+/g, "-")}.txt`,
      message,
    );
    await git(publisherDir, "push", "-q", "origin", `HEAD:${name}`);
    const head = await git(publisherDir, "rev-parse", "HEAD");
    await git(publisherDir, "checkout", "-q", "main");
    return head;
  }

  test("a branch strictly behind origin is fast-forwarded before revival", async () => {
    await branchPushedFromHere("behind");
    const pushed = await landOnBranch("behind", "pushed from another machine");
    const dir = await reviveWorktree("behind", REPO_ID);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(pushed);
    expect(await git(repoDir, "rev-parse", "behind")).toBe(pushed);
  });

  test("a diverged branch keeps its local commits", async () => {
    await branchPushedFromHere("diverged");
    const pushed = await landOnBranch("diverged", "remote work");
    await git(repoDir, "checkout", "-q", "diverged");
    await commit(repoDir, "local-only.txt", "local work never pushed");
    const local = await git(repoDir, "rev-parse", "HEAD");
    await git(repoDir, "checkout", "-q", "main");
    expect(await fastForwardBranchFromOrigin(repoDir, "diverged")).toBe(
      "diverged",
    );
    expect(await git(repoDir, "rev-parse", "diverged")).toBe(local);
    expect(await git(repoDir, "rev-parse", "origin/diverged")).toBe(pushed);
    const dir = await reviveWorktree("diverged", REPO_ID);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(local);
  });

  test("a branch ahead of origin, or unknown to origin, is left alone", async () => {
    await branchPushedFromHere("ahead");
    await git(repoDir, "checkout", "-q", "ahead");
    await commit(repoDir, "ahead.txt", "unpushed");
    const ahead = await git(repoDir, "rev-parse", "HEAD");
    await git(repoDir, "branch", "local-only", "HEAD");
    await git(repoDir, "checkout", "-q", "main");
    expect(await fastForwardBranchFromOrigin(repoDir, "ahead")).toBe("ahead");
    expect(await git(repoDir, "rev-parse", "ahead")).toBe(ahead);
    expect(await fastForwardBranchFromOrigin(repoDir, "local-only")).toBe(
      "no-remote",
    );
    expect(await git(repoDir, "rev-parse", "local-only")).toBe(ahead);
  });
});
