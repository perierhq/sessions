import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { getConfigAsync } from "./config";
import { __setSessionsDirForTest } from "./paths";
import { __setWorkloadScopingForTest } from "./workload-scope";
import { refreshWarmTemplate, warmTemplateStatus } from "./warm-template";
import { __setSetupOutcomePublisherForTest } from "./worktree";

/**
 * A warm-template refresh whose dependency install fails or times out must
 * not publish the template: installWorktreeDeps reports the failure in its
 * result rather than throwing, and the partial node_modules it leaves would
 * otherwise be captured and seeded into new worktrees.
 */

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "OPENSESSION_WORKTREES_DIR",
  "OPENSESSION_STATE_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

let root = "";
let previousSessionsDir = "";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await $`git -C ${cwd} ${args}`.quiet();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "os-warm-refresh-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await $`git init --bare -b main ${origin}`.quiet();
  await $`git init -b main ${repo}`.quiet();
  await git(repo, "config", "user.email", "test@test");
  await git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "package.json"), "{}\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-u", "origin", "main");

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      repos: {
        scratch: {
          repo,
          wtPrefix: "scratch",
          defaultBranch: "main",
          ghRepo: "test/scratch",
          // Leaves a partial node_modules, then hangs past the limit.
          depsInstall: "mkdir -p node_modules/left-behind && sleep 30",
          // 300 ms.
          worktreeSetupTimeoutMinutes: 0.005,
        },
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = join(root, "config.json");
  process.env.OPENSESSION_WORKTREES_DIR = join(root, "worktrees");
  process.env.OPENSESSION_STATE_DIR = join(root, "state");
  previousSessionsDir = __setSessionsDirForTest(join(root, "sessions"));
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

test("a timed-out dependency install never publishes the template", async () => {
  await refreshWarmTemplate("scratch", { force: true });
  const [entry] = warmTemplateStatus().filter((e) => e.repoId === "scratch");
  expect(
    existsSync(
      join(root, "worktrees", "scratch-warm-template", "node_modules"),
    ),
  ).toBe(true);
  expect(entry?.warm).toBe(false);
  expect(entry?.state?.ok).toBe(false);
  expect(entry?.state?.lastError).toContain("did not finish");
  expect(
    existsSync(join(root, "sessions", "warm-templates", "scratch.manifest")),
  ).toBe(false);
}, 30_000);
