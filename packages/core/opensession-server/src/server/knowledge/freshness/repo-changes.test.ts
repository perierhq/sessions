import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, isolatedGitEnv } from "../../memory-repo/git";
import {
  commitAt,
  commitsSince,
  defaultHead,
  fetchDefaultBranch,
  latestChange,
  patchFor,
  type RepoChangeDeps,
  RepoUnavailableError,
  showAt,
} from "./repo-changes";

let base: string;
let work: string;
let checkout: string;
let deps: Partial<RepoChangeDeps>;
const sha: Record<string, string> = {};

async function run(dir: string, args: string[], date?: string) {
  return (
    await git(args, {
      cwd: dir,
      env: isolatedGitEnv(
        date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {},
      ),
    })
  ).stdout.trim();
}

async function commit(file: string, text: string, date: string) {
  await mkdir(join(work, file, ".."), { recursive: true });
  await writeFile(join(work, file), text);
  await run(work, ["add", "--", file]);
  await run(work, ["commit", "-q", "-m", `edit ${file}`], date);
  await run(work, ["push", "-q", "origin", "main"]);
  return run(work, ["rev-parse", "HEAD"]);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "kn-repo-changes-"));
  const origin = join(base, "origin.git");
  work = join(base, "work");
  checkout = join(base, "checkout");
  await run(base, ["init", "-q", "--bare", "-b", "main", origin]);
  await run(base, ["clone", "-q", origin, work]);
  await run(work, ["checkout", "-q", "-b", "main"]);
  sha.c1 = await commit("docs/export.md", "v1\n", "2026-08-01T10:00:00Z");
  sha.c2 = await commit("README.md", "hello\n", "2026-09-01T10:00:00Z");
  sha.c3 = await commit("docs/export.md", "v2\n", "2026-10-06T10:00:00Z");
  await run(base, ["clone", "-q", origin, checkout]);
  deps = {
    repo: (project) =>
      project === "acme" ? { dir: checkout, defaultBranch: "main" } : null,
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("repo change signals", () => {
  test("commitsSince lists newer commits touching a file", async () => {
    const commits = await commitsSince(
      "acme",
      sha.c1!,
      ["docs/export.md"],
      deps,
    );
    expect(commits.map((c) => c.sha)).toEqual([sha.c3!]);
    expect(commits[0]!.paths).toEqual(["docs/export.md"]);
    expect(commits[0]!.at).toStartWith("2026-10-06T10:00:00");
  });

  test("a trailing slash depends on the whole folder", async () => {
    const commits = await commitsSince("acme", sha.c1!, ["docs/"], deps);
    expect(commits.map((c) => c.sha)).toEqual([sha.c3!]);
  });

  test("paths are literal, not pathspec magic", async () => {
    expect(await commitsSince("acme", sha.c1!, ["docs/*"], deps)).toEqual([]);
    expect(await commitsSince("acme", sha.c1!, [":/"], deps)).toEqual([]);
  });

  test("latestChange finds the newest commit across paths", async () => {
    const latest = await latestChange("acme", ["docs/", "README.md"], deps);
    expect(latest?.sha).toBe(sha.c3!);
    const readme = await latestChange("acme", ["README.md"], deps);
    expect(readme?.sha).toBe(sha.c2!);
    expect(readme?.paths).toEqual(["README.md"]);
  });

  test("commitAt finds the default-branch commit at a moment", async () => {
    expect(await commitAt("acme", "2026-09-15T00:00:00Z", deps)).toBe(sha.c2!);
    expect(await commitAt("acme", "2026-01-01T00:00:00Z", deps)).toBeNull();
  });

  test("showAt and patchFor read a file at a commit", async () => {
    expect(await showAt("acme", sha.c1!, "docs/export.md", deps)).toBe("v1\n");
    expect(await showAt("acme", sha.c1!, "missing.md", deps)).toBeNull();
    const patch = await patchFor("acme", sha.c3!, "docs/export.md", deps);
    expect(patch).toContain("-v1");
    expect(patch).toContain("+v2");
  });

  test("fetchDefaultBranch picks up a commit pushed after the clone", async () => {
    expect(await defaultHead("acme", deps)).toBe(sha.c3!);
    const c4 = await commit("docs/export.md", "v3\n", "2026-10-20T10:00:00Z");
    expect(await defaultHead("acme", deps)).toBe(sha.c3!);
    expect(await fetchDefaultBranch("acme", deps)).toBe(true);
    expect(await defaultHead("acme", deps)).toBe(c4);
    const since = await commitsSince("acme", sha.c3!, ["docs/"], deps);
    expect(since.map((c) => c.sha)).toEqual([c4]);
  });

  test("an unresolvable project throws RepoUnavailableError, never reads as unchanged", async () => {
    const gone: Partial<RepoChangeDeps> = {
      repo: (project) =>
        project === "acme"
          ? { dir: checkout, defaultBranch: "main" }
          : project === "nocheckout"
            ? { dir: "", defaultBranch: "main" }
            : project === "missingdir"
              ? { dir: join(base, "missing"), defaultBranch: "main" }
              : project === "badbranch"
                ? { dir: checkout, defaultBranch: "main..x" }
                : project === "dashbranch"
                  ? { dir: checkout, defaultBranch: "-main" }
                  : null,
    };
    for (const p of [
      "nope",
      "nocheckout",
      "missingdir",
      "badbranch",
      "dashbranch",
    ]) {
      await expect(
        commitsSince(p, sha.c1!, ["docs/"], gone),
      ).rejects.toBeInstanceOf(RepoUnavailableError);
      await expect(latestChange(p, ["docs/"], gone)).rejects.toBeInstanceOf(
        RepoUnavailableError,
      );
      await expect(
        commitAt(p, "2026-09-15T00:00:00Z", gone),
      ).rejects.toBeInstanceOf(RepoUnavailableError);
      await expect(
        showAt(p, sha.c1!, "docs/export.md", gone),
      ).rejects.toBeInstanceOf(RepoUnavailableError);
      await expect(
        patchFor(p, sha.c1!, "docs/export.md", gone),
      ).rejects.toBeInstanceOf(RepoUnavailableError);
      // A fetch that couldn't run and a head that can't be read stay
      // false/null: neither reads as "unchanged".
      expect(await fetchDefaultBranch(p, gone)).toBe(false);
      expect(await defaultHead(p, gone)).toBeNull();
    }
  });

  test("branch names are checked by git, not a pattern", async () => {
    const odd: Partial<RepoChangeDeps> = {
      repo: () => ({ dir: checkout, defaultBranch: "release/v1.@{x" }),
    };
    await expect(latestChange("acme", [], odd)).rejects.toBeInstanceOf(
      RepoUnavailableError,
    );
    const lock: Partial<RepoChangeDeps> = {
      repo: () => ({ dir: checkout, defaultBranch: "main.lock" }),
    };
    await expect(latestChange("acme", [], lock)).rejects.toBeInstanceOf(
      RepoUnavailableError,
    );
  });

  test("an unknown commit for showAt throws, a missing path is null", async () => {
    await expect(
      showAt("acme", "0".repeat(40), "docs/export.md", deps),
    ).rejects.toThrow();
    expect(await showAt("acme", sha.c1!, "docs/", deps)).toBeNull();
  });

  test("an unknown or malformed since commit throws (callers fail closed)", async () => {
    await expect(
      commitsSince("acme", "0".repeat(40), ["docs/"], deps),
    ).rejects.toThrow();
    await expect(
      commitsSince("acme", "--all", ["docs/"], deps),
    ).rejects.toThrow();
  });
});
