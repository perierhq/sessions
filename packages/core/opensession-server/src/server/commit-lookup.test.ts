import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCommitSha,
  lookupCommit,
  lookupCommitIn,
  readCommitAt,
  readCommitChangesAt,
} from "./commit-lookup";
import { getConfigAsync } from "./config";

// Driven against a real repo rather than fixture strings: the format string
// and the shortstat line are git's to define, and a fixture would only assert
// that this file agrees with itself.
let root = "";
let dir = "";
let sha = "";
let blobSha = "";

// The identity rides in the environment rather than `git config`: an agent run
// exports GIT_AUTHOR_NAME/GIT_COMMITTER_NAME, and those outrank the repo's
// config, so a fixture that only writes config records whoever ran the test.
const identity = {
  GIT_AUTHOR_NAME: "Alex Example",
  GIT_AUTHOR_EMAIL: "alex@example.com",
  GIT_COMMITTER_NAME: "Alex Example",
  GIT_COMMITTER_EMAIL: "alex@example.com",
};

async function git(...args: string[]): Promise<string> {
  return (
    await $`git -C ${dir} ${args}`
      .env({ ...process.env, ...identity })
      .quiet()
      .text()
  ).trim();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "opensession-commit-lookup-"));
  dir = join(root, "repo");
  await $`git init -b main ${dir}`.quiet();
  writeFileSync(join(dir, "one.txt"), "a\nb\nc\n");
  writeFileSync(join(dir, "two.txt"), "x\n");
  await git("add", ".");
  await git("commit", "-m", "Add the files");
  writeFileSync(join(dir, "one.txt"), "a\nB\nc\nd\n");
  await git("add", ".");
  await git(
    "commit",
    "-m",
    "Info panel: colour marks what wants you\n\nThe body, which the card shows under the title.",
  );
  sha = await git("rev-parse", "HEAD");
  blobSha = await git("rev-parse", "HEAD:two.txt");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const repo = {
  id: "demo",
  get repo() {
    return dir;
  },
  ghRepo: "tellahq/demo",
};

describe("isCommitSha", () => {
  test("takes what git abbreviates to and nothing shorter", () => {
    expect(isCommitSha("4ed1ef09")).toBe(true);
    expect(isCommitSha("4ed1ef0")).toBe(true);
    expect(isCommitSha("f".repeat(40))).toBe(true);
    expect(isCommitSha("4ed1ef")).toBe(false);
    expect(isCommitSha("f".repeat(41))).toBe(false);
  });

  test("rejects anything that isn't an object name", () => {
    // A revision expression is not a lookup this answers: only object names
    // reach git, so `main`, `HEAD~3` and `..` cannot be smuggled through.
    expect(isCommitSha("HEAD~3")).toBe(false);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha("4ed1ef09..437cba77")).toBe(false);
    expect(isCommitSha("--output=x")).toBe(false);
  });
});

describe("readCommitAt", () => {
  test("reads the commit a full sha names", async () => {
    const commit = await readCommitAt(repo, sha);
    expect(commit).toBeTruthy();
    expect(commit!.sha).toBe(sha);
    expect(commit!.title).toBe("Info panel: colour marks what wants you");
    expect(commit!.body).toBe(
      "The body, which the card shows under the title.",
    );
    expect(commit!.author).toBe("Alex Example");
    expect(commit!.repo).toBe("demo");
    expect(commit!.url).toBe(`https://github.com/tellahq/demo/commit/${sha}`);
    expect(commit!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("counts what changed", async () => {
    const commit = await readCommitAt(repo, sha);
    expect(commit!.filesChanged).toBe(1);
    expect(commit!.additions).toBe(2);
    expect(commit!.deletions).toBe(1);
  });

  test("reads the unified code changes separately from commit metadata", async () => {
    const changes = await readCommitChangesAt(repo, sha);
    expect(changes.rawPatch).toContain("diff --git a/one.txt b/one.txt");
    expect(changes.rawPatch).toContain("-b");
    expect(changes.rawPatch).toContain("+B");
    expect(changes.patchTruncated).toBeUndefined();
  });

  test("takes an abbreviation and answers with the full sha", async () => {
    const commit = await readCommitAt(repo, sha.slice(0, 8));
    expect(commit!.sha).toBe(sha);
    expect(commit!.shortSha.length).toBeGreaterThanOrEqual(7);
    expect(sha.startsWith(commit!.shortSha)).toBe(true);
  });

  test("a sha that names something other than a commit is not one", async () => {
    // Agents paste blob and tree hashes too. Without the `^{commit}` peel
    // these would resolve and the card would describe a file as a commit.
    expect(await readCommitAt(repo, blobSha)).toBeNull();
  });

  test("an unknown sha is a miss, not a throw", async () => {
    expect(
      await readCommitAt(repo, "0123456789abcdef0123456789abcdef01234567"),
    ).toBeNull();
  });

  test("a repo with no ghRepo still resolves, without a link", async () => {
    const commit = await readCommitAt({ id: "demo", repo: dir }, sha);
    expect(commit!.title).toBe("Info panel: colour marks what wants you");
    expect(commit!.url).toBeUndefined();
  });
});

describe("lookupCommitIn", () => {
  // Two configured checkouts: `acme` (this file's repo, plus a commit on a
  // side branch) and `other`, which holds a commit acme doesn't have.
  let otherDir = "";
  let otherSha = "";
  let sideSha = "";
  const savedConfig = process.env.OPENSESSION_CONFIG;

  beforeAll(async () => {
    otherDir = join(root, "other");
    await $`git init -b main ${otherDir}`.quiet();
    writeFileSync(join(otherDir, "three.txt"), "z\n");
    const env = { ...process.env, ...identity };
    await $`git -C ${otherDir} add .`.env(env).quiet();
    await $`git -C ${otherDir} commit -m ${"Only in other"}`.env(env).quiet();
    otherSha = (
      await $`git -C ${otherDir} rev-parse HEAD`.quiet().text()
    ).trim();
    await git("checkout", "-b", "side");
    writeFileSync(join(dir, "side.txt"), "s\n");
    await git("add", ".");
    await git("commit", "-m", "Side work");
    sideSha = await git("rev-parse", "HEAD");
    await git("checkout", "main");
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: {
          acme: { repo: dir, defaultBranch: "main" },
          other: { repo: otherDir, defaultBranch: "main" },
        },
      }),
    );
    process.env.OPENSESSION_CONFIG = configPath;
    await getConfigAsync();
  });

  afterAll(() => {
    if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
    else process.env.OPENSESSION_CONFIG = savedConfig;
  });

  test("reads only the named checkout", async () => {
    const own = await lookupCommitIn(sha.slice(0, 8), "acme");
    expect(own?.sha).toBe(sha);
    expect(own?.repo).toBe("acme");
    expect(own?.onDefaultBranch).toBe(true);
    // The loose lookup crosses checkouts; the strict one never does.
    expect((await lookupCommit(otherSha, "acme"))?.repo).toBe("other");
    expect(await lookupCommitIn(otherSha, "acme")).toBeNull();
    expect((await lookupCommitIn(otherSha, "other"))?.sha).toBe(otherSha);
  });

  test("says whether the commit is on the default branch", async () => {
    const side = await lookupCommitIn(sideSha, "acme");
    expect(side?.sha).toBe(sideSha);
    expect(side?.onDefaultBranch).toBe(false);
  });

  test("an unknown repo or a non-sha is a miss", async () => {
    expect(await lookupCommitIn(sha, "nope")).toBeNull();
    expect(await lookupCommitIn("HEAD~1", "acme")).toBeNull();
  });
});
