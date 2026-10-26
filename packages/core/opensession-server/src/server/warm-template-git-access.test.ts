import { afterAll, beforeAll, expect, test } from "bun:test";
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
import {
  GIT_ACCESS_BASE_BACKOFF_MS,
  __setGitAccessSeamsForTest,
  gitAccessIssue,
} from "./git-access-health";
import type { NotificationEvent } from "./notification-threads";
import { __setSessionsDirForTest } from "./paths";
import { __setWorkloadScopingForTest } from "./workload-scope";
import { refreshWarmTemplate, warmTemplateStatus } from "./warm-template";
import { __setSetupOutcomePublisherForTest } from "./worktree";

/**
 * The warm-template sweep fetches every enabled project every five minutes.
 * With a broken credential that was one failed sign-in per project per
 * sweep, silently, for hours. A sign-in failure must back the fetch off,
 * tell the owner once, and clear when a fetch works again.
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
let origin = "";
let previousSessionsDir = "";
let now = Date.parse("2026-10-25T21:39:00.000Z");
const told: NotificationEvent[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

function attempts(): number {
  const log = join(root, "remote-attempts");
  return existsSync(log)
    ? readFileSync(log, "utf-8").split("\n").filter(Boolean).length
    : 0;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "os-warm-access-"));
  origin = join(root, "origin.git");
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

  // A remote that refuses the credential, as GitHub does for a bad token.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const helper = join(bin, "git-remote-refuse");
  writeFileSync(
    helper,
    [
      "#!/bin/sh",
      `echo x >> '${join(root, "remote-attempts")}'`,
      'echo "remote: Invalid username or token. Password authentication is not supported for Git operations." >&2',
      "echo \"fatal: Authentication failed for 'https://github.com/acme/app.git/'\" >&2",
      "exit 128",
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  // A remote whose credential helper is another install's until the
  // checkout is repaired; then it refuses the credential like GitHub.
  const helperCheck = join(bin, "git-remote-helpercheck");
  writeFileSync(
    helperCheck,
    [
      "#!/bin/sh",
      `echo x >> '${join(root, "remote-attempts")}'`,
      "if git config --get-all credential.https://github.com.helper | grep -q /nonexistent-other-install/; then",
      '  echo "/nonexistent-other-install/bin/opensession github-credential get: Permission denied" >&2',
      "  echo \"fatal: could not read Username for 'https://github.com': terminal prompts disabled\" >&2",
      "else",
      '  echo "remote: Invalid username or token." >&2',
      "  echo \"fatal: Authentication failed for 'https://github.com/acme/app.git/'\" >&2",
      "fi",
      "exit 128",
      "",
    ].join("\n"),
  );
  chmodSync(helperCheck, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;

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
  previousSessionsDir = __setSessionsDirForTest(join(root, "sessions"));
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
  await getConfigAsync();
  // A healthy first build.
  await refreshWarmTemplate("acme", { force: true });
});

afterAll(() => {
  __setSessionsDirForTest(previousSessionsDir);
  __setWorkloadScopingForTest(null);
  __setSetupOutcomePublisherForTest(null);
  __setGitAccessSeamsForTest(undefined);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("a refused sign-in backs the sweep off and tells the owner once", async () => {
  expect(warmTemplateStatus().find((e) => e.repoId === "acme")?.warm).toBe(
    true,
  );
  const template = join(root, "worktrees", "acme-warm-template");
  await git(template, "remote", "set-url", "origin", "refuse::acme");

  await refreshWarmTemplate("acme");
  expect(attempts()).toBe(1);
  expect(gitAccessIssue("acme")).toMatchObject({ kind: "auth", failures: 1 });
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({
    kind: "access_failing",
    subject: { type: "repo", id: "acme", title: "Acme" },
  });

  // The next sweeps inside the backoff do not touch the remote.
  now += GIT_ACCESS_BASE_BACKOFF_MS - 1;
  await refreshWarmTemplate("acme");
  expect(attempts()).toBe(1);

  // Once it runs out, one more try, and the wait doubles.
  now += 1;
  await refreshWarmTemplate("acme");
  expect(attempts()).toBe(2);
  expect(gitAccessIssue("acme")?.failures).toBe(2);
  now += GIT_ACCESS_BASE_BACKOFF_MS;
  await refreshWarmTemplate("acme");
  expect(attempts()).toBe(2);
  expect(told).toHaveLength(1);

  // The template keeps serving its last good build meanwhile.
  expect(warmTemplateStatus().find((e) => e.repoId === "acme")?.warm).toBe(
    true,
  );
});

test("Refresh now tries at once, and a fetch that works clears the issue", async () => {
  const template = join(root, "worktrees", "acme-warm-template");
  await git(template, "remote", "set-url", "origin", origin);
  await refreshWarmTemplate("acme", { force: true });
  expect(gitAccessIssue("acme")).toBeNull();
  expect(told.at(-1)).toMatchObject({
    kind: "access_failing",
    delivery: "quiet",
  });
});

test("a helper from another install is repaired at fetch time and tried again", async () => {
  await git(
    repo,
    "config",
    "--replace-all",
    "credential.https://github.com.helper",
    "!/nonexistent-other-install/bin/opensession github-credential",
  );
  const template = join(root, "worktrees", "acme-warm-template");
  await git(template, "remote", "set-url", "origin", "helpercheck::acme");
  const before = attempts();
  told.length = 0;
  await refreshWarmTemplate("acme");
  // One try with the foreign helper, one after the repair.
  expect(attempts()).toBe(before + 2);
  const helpers = (
    await $`git -C ${repo} config --get-all credential.https://github.com.helper`.text()
  ).trim();
  expect(helpers).not.toContain("/nonexistent-other-install/");
  // The token itself is still refused: that is an ordinary sign-in issue.
  expect(gitAccessIssue("acme")).toMatchObject({ kind: "auth", failures: 1 });
  expect(told).toHaveLength(1);
});
