import { afterAll, beforeAll, expect, test } from "bun:test";
import {
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
import { repairForeignCheckoutPaths } from "./checkout-repair";
import { configuredRepos, getConfigAsync } from "./config";
import {
  foreignGithubHelper,
  githubCredentialHelperCommand,
} from "./github-git-credential";
import { __setSessionsDirForTest } from "./paths";
import { __setWorkloadScopingForTest } from "./workload-scope";
import { refreshWarmTemplate, warmTemplateStatus } from "./warm-template";
import { __setSetupOutcomePublisherForTest } from "./worktree";

/**
 * A checkout carried over from an earlier install (another user's home, a
 * different install prefix) keeps that install's paths: a credential helper
 * this process can't run, and a warm template whose `.git` names an admin
 * dir in the other install's checkout. Boot repairs both, once, with the
 * same helper registration writes.
 */

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "OPENSESSION_STATE_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

const HELPER_KEY = "credential.https://github.com.helper";
const OTHER_INSTALL = "/nonexistent-other-install";
let root = "";
let previousSessionsDir = "";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

async function helpers(dir: string): Promise<string[]> {
  const out = await $`git -C ${dir} config --get-all ${HELPER_KEY}`
    .quiet()
    .nothrow()
    .text();
  return out.replace(/\n$/, "").split("\n");
}

async function makeRepo(name: string): Promise<string> {
  const origin = join(root, `${name}.git`);
  const repo = join(root, "checkouts", name);
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
  return repo;
}

function captureLogs<T>(run: () => Promise<T>): Promise<{
  result: T;
  lines: string[];
}> {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  return run()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.log = log;
      console.warn = warn;
    });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "os-checkout-repair-"));
  const acme = await makeRepo("acme");
  const beta = await makeRepo("beta");
  const gamma = await makeRepo("gamma");
  // acme: carried over from another install.
  await git(acme, "config", "--replace-all", HELPER_KEY, "");
  await git(
    acme,
    "config",
    "--add",
    HELPER_KEY,
    `!${OTHER_INSTALL}/.opensession/bin/opensession github-credential`,
  );
  // beta: wired by this install.
  await git(beta, "config", "--replace-all", HELPER_KEY, "");
  await git(beta, "config", "--add", HELPER_KEY, "!/bin/sh github-credential");
  // gamma: a helper of the person's own, not ours to rewrite.
  await git(gamma, "config", "--add", HELPER_KEY, "!/nonexistent/own-helper");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: Object.fromEntries(
        [
          ["acme", acme],
          ["beta", beta],
          ["gamma", gamma],
        ].map(([id, repo]) => [
          id,
          {
            repo,
            wtPrefix: id,
            defaultBranch: "main",
            ghRepo: `acme/${id}`,
            depsInstall: "mkdir -p node_modules/dep",
          },
        ]),
      ),
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
  await getConfigAsync();
});

afterAll(() => {
  __setSessionsDirForTest(previousSessionsDir);
  __setWorkloadScopingForTest(null);
  __setSetupOutcomePublisherForTest(null);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

test("only our own helper, naming a program this process can't run, is foreign", () => {
  const canRun = (path: string) => path === "/usr/local/bin/opensession";
  expect(
    foreignGithubHelper(
      ["", "!/srv/old/.opensession/bin/opensession github-credential"],
      canRun,
    ),
  ).toBe("!/srv/old/.opensession/bin/opensession github-credential");
  expect(
    foreignGithubHelper(
      ["", "!/usr/local/bin/opensession github-credential"],
      canRun,
    ),
  ).toBeNull();
  expect(
    foreignGithubHelper(
      ["", "!bun /srv/old/scripts/gh-credential.ts"],
      () => false,
    ),
  ).toBe("!bun /srv/old/scripts/gh-credential.ts");
  // A source-tree helper that exists is fine: bun runs it, it needn't be +x.
  expect(
    foreignGithubHelper(["", `!bun ${import.meta.path}`], () => false),
  ).toBeNull();
  // Not ours: a person's own helper stays as it is.
  expect(foreignGithubHelper(["!/srv/old/my-helper"], () => false)).toBeNull();
  expect(foreignGithubHelper(["store"], () => false)).toBeNull();
  expect(foreignGithubHelper([""], () => false)).toBeNull();
});

test("boot repairs another install's paths once and leaves the rest", async () => {
  const repos = configuredRepos();
  // A warm template built, then carried over: its .git names the other
  // install's checkout.
  await refreshWarmTemplate("acme", { force: true });
  const template = join(root, "worktrees", "acme-warm-template");
  expect(existsSync(join(template, "node_modules"))).toBe(true);
  writeFileSync(
    join(template, ".git"),
    `gitdir: ${OTHER_INSTALL}/checkouts/acme/.git/worktrees/acme-warm-template\n`,
  );
  rmSync(join(repos.acme!.repo, ".git", "worktrees"), {
    recursive: true,
    force: true,
  });

  const first = await captureLogs(() => repairForeignCheckoutPaths());
  expect(await helpers(repos.acme!.repo)).toEqual([
    "",
    githubCredentialHelperCommand(),
  ]);
  expect(await helpers(repos.beta!.repo)).toEqual([
    "",
    "!/bin/sh github-credential",
  ]);
  expect(await helpers(repos.gamma!.repo)).toEqual([
    "!/nonexistent/own-helper",
  ]);
  expect(existsSync(template)).toBe(false);
  const repairLines = first.lines.filter((l) => l.includes(OTHER_INSTALL));
  expect(repairLines).toHaveLength(2);

  // Nothing left to repair: a second boot says nothing.
  const second = await captureLogs(() => repairForeignCheckoutPaths());
  expect(second.lines.filter((l) => l.includes("[checkout-repair]"))).toEqual(
    [],
  );

  // The next refresh builds the template again, linked to this checkout.
  await refreshWarmTemplate("acme");
  const link = readFileSync(join(template, ".git"), "utf-8");
  expect(link).toContain("/checkouts/acme/.git/worktrees/acme-warm-template");
  expect(link).not.toContain(OTHER_INSTALL);
  expect(warmTemplateStatus().find((e) => e.repoId === "acme")?.warm).toBe(
    true,
  );
}, 60_000);
