import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { getConfigAsync } from "./config";
import { getGitStatus } from "./git-status";
import { githubGitCredentialEnv } from "./github-git-credential";
import { __setWorkloadScopingForTest } from "./workload-scope";
import {
  __setGithubServiceCredentialForTest,
  __setSetupOutcomePublisherForTest,
  createWorktree,
  ensureAskCheckout,
  reviveWorktree,
} from "./worktree";

/**
 * Every fetch the server runs on its own against a GitHub checkout signs in
 * with the service credential (githubServiceGitEnv). The checkout's helper
 * answers only from the GH_TOKEN it is handed, so a fetch without it fails
 * on a private repository. A fetch for a session a person opens with their
 * own credential keeps theirs.
 */

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "PATH",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

let root = "";
let repo = "";
let worktrees = "";
const asked: (string | undefined)[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

/** The token each fetch that reached the remote carried. */
function tokens(): string[] {
  const log = join(root, "remote-env");
  return existsSync(log)
    ? readFileSync(log, "utf-8").split("\n").filter(Boolean)
    : [];
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "os-bg-fetch-env-"));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  worktrees = join(root, "worktrees");
  mkdirSync(worktrees);
  await $`git init --bare -b main ${origin}`.quiet();
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "test@example.test");
  await git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "acme\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");

  // A private GitHub repository: records the token git carried, then
  // refuses it (the flows below all tolerate a failed fetch).
  const bin = join(root, "bin");
  mkdirSync(bin);
  const helper = join(bin, "git-remote-private");
  writeFileSync(
    helper,
    [
      "#!/bin/sh",
      `echo "$GH_TOKEN" >> '${join(root, "remote-env")}'`,
      "echo \"fatal: could not read Username for 'https://github.com': No such device or address\" >&2",
      "exit 128",
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await git(repo, "remote", "set-url", "origin", "private::acme");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        acme: {
          repo,
          wtPrefix: "acme",
          defaultBranch: "main",
          ghRepo: "acme/app",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_WORKTREES_DIR = worktrees;
  __setWorkloadScopingForTest(false);
  __setSetupOutcomePublisherForTest(() => {});
  __setGithubServiceCredentialForTest(async (ghRepo) => {
    asked.push(ghRepo);
    return githubGitCredentialEnv("ghs_service");
  });
  await getConfigAsync();
});

beforeEach(() => {
  rmSync(join(root, "remote-env"), { force: true });
  asked.length = 0;
});

afterAll(() => {
  __setWorkloadScopingForTest(null);
  __setSetupOutcomePublisherForTest(null);
  __setGithubServiceCredentialForTest(undefined);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("the Ask checkout fetches with the service credential", async () => {
  await ensureAskCheckout("acme");
  expect(tokens()).toEqual(["ghs_service"]);
  expect(asked).toEqual(["acme/app"]);
});

test("a session worktree fetches with the person's credential, else the service's", async () => {
  await createWorktree("person-branch", "acme", {
    gitEnv: githubGitCredentialEnv("ghu_person"),
  });
  expect(tokens()).toEqual(["ghu_person"]);

  rmSync(join(root, "remote-env"), { force: true });
  await createWorktree("service-branch", "acme");
  expect(tokens()).toEqual(["ghs_service"]);
});

test("reviving a checkout fetches its branch with the service credential", async () => {
  await git(repo, "branch", "revived", "main");
  await reviveWorktree("revived", "acme");
  expect(tokens()).toEqual(["ghs_service"]);
});

// The reaper reads /proc for checkouts in use and skips the sweep without it.
test.skipIf(!existsSync("/proc"))(
  "the worktree reaper's fetch carries the service credential",
  async () => {
    const { sweepWorktreeReaper } = await import("./worktree-reaper");
    const dir = join(worktrees, "acme-reaped");
    await git(repo, "worktree", "add", "-q", "-b", "reaped", dir, "main");
    const old = new Date(Date.now() - 12 * 3_600_000);
    utimesSync(join(dir, ".git"), old, old);
    await sweepWorktreeReaper({ nowMs: Date.now(), sessions: [] });
    expect(tokens()).toEqual(["ghs_service"]);
  },
);

test("the git status poll's fetch on the host carries the service credential", async () => {
  const dir = join(worktrees, "acme-person-branch");
  await getGitStatus(dir, "main");
  await until(() => tokens().length > 0);
  expect(tokens()).toEqual(["ghs_service"]);
});
