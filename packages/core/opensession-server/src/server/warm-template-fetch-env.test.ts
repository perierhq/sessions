import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { getConfigAsync } from "./config";
import { __setGitAccessSeamsForTest, gitAccessIssue } from "./git-access-health";
import { githubGitCredentialEnv } from "./github-git-credential";
import type { NotificationEvent } from "./notification-threads";
import { __setSessionsDirForTest } from "./paths";
import { __setWorkloadScopingForTest } from "./workload-scope";
import { refreshWarmTemplate, warmTemplateStatus } from "./warm-template";
import {
  __setGithubServiceCredentialForTest,
  __setSetupOutcomePublisherForTest,
} from "./worktree";

/**
 * The checkout's credential helper answers only from GH_TOKEN in the git
 * process's environment. The warm-template sweep ran git with the server's
 * plain environment, so every fetch of a private repository failed with
 * "could not read Username" while session worktrees, which pass the service
 * credential, fetched fine. The sweep's fetches must carry the same
 * credential, and a project the server has no token for must say so.
 */

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "OPENSESSION_STATE_DIR",
  "PATH",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

let root = "";
let repo = "";
let now = Date.parse("2026-10-26T21:24:53.000Z");
const told: NotificationEvent[] = [];
const asked: (string | undefined)[] = [];
let serviceToken = "";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

/** One line per fetch that reached the remote: the token git carried. */
function fetches(): string[] {
  const log = join(root, "remote-env");
  return existsSync(log)
    ? readFileSync(log, "utf-8").split("\n").filter(Boolean)
    : [];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "os-warm-env-"));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  await $`git init --bare -b main ${origin}`.quiet();
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "test@example.test");
  await git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "package.json"), "{}\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");

  // A private GitHub repository: it records the token git was handed and
  // refuses it, or, with none, fails the way git does when nothing answers.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const helper = join(bin, "git-remote-private");
  writeFileSync(
    helper,
    [
      "#!/bin/sh",
      `echo "token=$GH_TOKEN prompt=$GIT_TERMINAL_PROMPT" >> '${join(root, "remote-env")}'`,
      'if [ -n "$GH_TOKEN" ]; then',
      '  echo "remote: Invalid username or token." >&2',
      "  echo \"fatal: Authentication failed for 'https://github.com/acme/app.git/'\" >&2",
      "else",
      "  echo \"fatal: could not read Username for 'https://github.com': No such device or address\" >&2",
      "fi",
      "exit 128",
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  // Shared by the checkout and its template worktree.
  await git(repo, "remote", "set-url", "origin", "private::acme");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        acme: {
          label: "Acme",
          repo,
          wtPrefix: "acme",
          defaultBranch: "main",
          ghRepo: "acme/app",
          depsInstall: "mkdir -p node_modules/dep",
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");
  process.env.OPENSESSION_STATE_DIR = join(root, "state");
  __setSessionsDirForTest(join(root, "sessions"));
  mkdirSync(join(root, "sessions", "warm-templates"), { recursive: true });
  writeFileSync(
    join(root, "sessions", "warm-templates", "config.json"),
    JSON.stringify({ repos: { acme: { enabled: true } } }),
  );
  __setWorkloadScopingForTest(false);
  __setSetupOutcomePublisherForTest(() => {});
  __setGitAccessSeamsForTest({
    now: () => now,
    notify: async (event) => {
      told.push(event);
    },
  });
  __setGithubServiceCredentialForTest(async (ghRepo) => {
    asked.push(ghRepo);
    return githubGitCredentialEnv(serviceToken);
  });
  await getConfigAsync();
});

beforeEach(() => {
  rmSync(join(root, "remote-env"), { force: true });
  asked.length = 0;
  told.length = 0;
});

afterAll(() => {
  __setWorkloadScopingForTest(null);
  __setSetupOutcomePublisherForTest(null);
  __setGitAccessSeamsForTest(undefined);
  __setGithubServiceCredentialForTest(undefined);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("the template's first build and its refreshes fetch with the service credential", async () => {
  serviceToken = "ghs_service_acme";
  await refreshWarmTemplate("acme", { force: true });
  // Building the template fetches the checkout, then the template.
  expect(fetches()).toEqual([
    "token=ghs_service_acme prompt=0",
    "token=ghs_service_acme prompt=0",
  ]);
  expect(asked.every((r) => r === "acme/app")).toBe(true);
  // The remote refused that token: an ordinary sign-in issue.
  expect(gitAccessIssue("acme")).toMatchObject({ kind: "auth", failures: 1 });
  expect(told[0]).toMatchObject({ reason: "Git can't sign in to GitHub" });
  // The template still built from the last fetched origin/main.
  expect(warmTemplateStatus().find((e) => e.repoId === "acme")?.warm).toBe(
    true,
  );

  rmSync(join(root, "remote-env"), { force: true });
  await refreshWarmTemplate("acme", { force: true });
  expect(fetches()).toEqual(["token=ghs_service_acme prompt=0"]);
});

test("no token for the repository says the GitHub App isn't installed for it", async () => {
  serviceToken = "";
  now += 60_000;
  await refreshWarmTemplate("acme", { force: true });
  expect(fetches()).toEqual(["token= prompt=0"]);
  const issue = gitAccessIssue("acme");
  expect(issue).toMatchObject({ kind: "not-installed", ghRepo: "acme/app" });
  // A new kind of issue is a new issue: the owner hears about it.
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({
    kind: "access_failing",
    reason: "The GitHub App isn't installed for acme/app",
  });
});
