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
  RepoTooLargeError,
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
    expect(await commitsSince("acme", sha.c1!, ["docs/*"], deps)).toHaveLength(
      0,
    );
    expect(await commitsSince("acme", sha.c1!, [":/"], deps)).toHaveLength(0);
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

describe("first-parent dates, caps, fetch flags and odd paths", () => {
  let root: string;
  let w: string;
  let co: string;
  let d: Partial<RepoChangeDeps>;
  const s: Record<string, string> = {};

  async function edit(file: string, text: string, date: string) {
    await mkdir(join(w, file, ".."), { recursive: true });
    await writeFile(join(w, file), text);
    await run(w, ["add", "--", file]);
    await run(w, ["commit", "-q", "-m", `edit ${file}`], date);
    return run(w, ["rev-parse", "HEAD"]);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "kn-repo-changes-merge-"));
    const origin = join(root, "origin.git");
    w = join(root, "work");
    co = join(root, "checkout");
    await run(root, ["init", "-q", "--bare", "-b", "main", origin]);
    await run(root, ["clone", "-q", origin, w]);
    await run(w, ["checkout", "-q", "-b", "main"]);
    s.m0 = await edit("README.md", "hi\n", "2026-08-01T10:00:00Z");
    await run(w, ["checkout", "-q", "-b", "feature"]);
    // Written long ago on a branch, landed on main much later.
    s.b1 = await edit("docs/guide.md", "old\n", "2026-07-01T10:00:00Z");
    await run(w, ["checkout", "-q", "main"]);
    s.m1 = await edit("README.md", "hello\n", "2026-09-01T10:00:00Z");
    await run(
      w,
      ["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"],
      "2026-10-01T10:00:00Z",
    );
    s.merge = await run(w, ["rev-parse", "HEAD"]);
    s.u = await edit("docs/ünï cöde.md", "x\n", "2026-10-02T10:00:00Z");
    s.big = await edit(
      "docs/big.md",
      "x".repeat(1024 * 1024 + 10),
      "2026-10-03T10:00:00Z",
    );
    await run(w, ["push", "-q", "origin", "main"]);
    await run(root, ["clone", "-q", origin, co]);
    d = {
      repo: () => ({ dir: co, defaultBranch: "main" }),
      serialize: (fn) => fn(),
    };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("latestChange reports the merge that landed a change, at its landing date", async () => {
    const latest = await latestChange("acme", ["docs/guide.md"], d);
    expect(latest?.sha).toBe(s.merge!);
    expect(latest?.at).toStartWith("2026-10-01T10:00:00");
    expect(latest?.paths).toEqual(["docs/guide.md"]);
  });

  test("commitAt walks the default branch only, not merged-in branch dates", async () => {
    expect(await commitAt("acme", "2026-07-15T00:00:00Z", d)).toBeNull();
    expect(await commitAt("acme", "2026-09-15T00:00:00Z", d)).toBe(s.m1!);
    expect(await commitAt("acme", "2026-10-01T12:00:00Z", d)).toBe(s.merge!);
  });

  test("commitsSince keeps the full topology", async () => {
    const since = await commitsSince("acme", s.m0!, ["docs/guide.md"], d);
    expect(since.map((c) => c.sha)).toContain(s.b1!);
    expect(since.truncated).toBe(false);
  });

  test("non-ASCII paths come back as written", async () => {
    const since = await commitsSince("acme", s.merge!, ["docs/"], d);
    expect(since.map((c) => c.paths)).toEqual([
      ["docs/big.md"],
      ["docs/ünï cöde.md"],
    ]);
    const latest = await latestChange("acme", ["docs/ünï cöde.md"], d);
    expect(latest?.sha).toBe(s.u!);
    expect(await showAt("acme", s.u!, "docs/ünï cöde.md", d)).toBe("x\n");
  });

  test("commitsSince caps the entries and says so", async () => {
    const capped = await commitsSince("acme", s.m0!, [], {
      ...d,
      limits: { commits: 2 },
    });
    expect(capped).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped[0]!.sha).toBe(s.big!);
  });

  test("showAt refuses a file over 1 MB", async () => {
    await expect(showAt("acme", s.big!, "docs/big.md", d)).rejects.toThrow(
      RepoTooLargeError,
    );
  });

  test("output past the cap kills git and throws", async () => {
    await expect(
      patchFor("acme", s.big!, "docs/big.md", {
        ...d,
        limits: { outputBytes: 4096 },
      }),
    ).rejects.toThrow(RepoTooLargeError);
    await expect(
      commitsSince("acme", s.m0!, [], { ...d, limits: { outputBytes: 64 } }),
    ).rejects.toThrow(RepoTooLargeError);
  });

  test("patchFor never runs textconv", async () => {
    const calls: string[][] = [];
    await patchFor("acme", s.u!, "docs/ünï cöde.md", {
      ...d,
      git: async (_dir, args) => {
        calls.push(args);
        return "";
      },
    });
    const show = calls.find((a) => a.includes("show"))!;
    expect(show).toContain("--no-textconv");
  });

  test("the fetch skips gc, submodules and FETCH_HEAD", async () => {
    const calls: string[][] = [];
    expect(
      await fetchDefaultBranch("acme", {
        repo: d.repo,
        git: async (_dir, args) => {
          calls.push(args);
          return "";
        },
      }),
    ).toBe(true);
    const fetch = calls.find((a) => a.includes("fetch"))!;
    expect(fetch).toContain("--no-auto-gc");
    expect(fetch).toContain("--no-recurse-submodules");
    expect(fetch).toContain("--no-write-fetch-head");
  });

  test("the fetch authenticates the way worktree.ts fetches do", async () => {
    // A checkout registered by an earlier install keeps that install's
    // helper in .git/config. Git runs every helper in the list, so the
    // fetch has to replace the list, not only add to it.
    const stale = "!/nonexistent/opensession github-credential";
    const key = "credential.https://github.com.helper";
    await run(co, ["config", "--replace-all", key, ""]);
    await run(co, ["config", "--add", key, stale]);
    const envs: Record<string, string | undefined>[] = [];
    expect(
      await fetchDefaultBranch("acme", {
        repo: () => ({
          dir: co,
          defaultBranch: "main",
          ghRepo: "acme/widgets",
        }),
        git: async (_dir, args, opts) => {
          if (args.includes("fetch")) envs.push(opts?.env ?? {});
          return "";
        },
      }),
    ).toBe(true);
    expect(envs).toHaveLength(1);
    const { githubServiceGitEnv } = await import("../../worktree");
    const worktreeEnv = await githubServiceGitEnv("acme/widgets");
    const credential = Object.fromEntries(
      Object.entries(worktreeEnv).filter(
        ([k]) => k.startsWith("GIT_CONFIG_") || k.endsWith("_TOKEN"),
      ),
    );
    expect(Object.keys(credential)).toContain("GIT_CONFIG_COUNT");
    expect(envs[0]).toMatchObject(credential);
    // With that env git's helper list ends in the server's own helper; the
    // stale one is cleared before it.
    const helpers = (
      await git(["config", "--get-all", key], {
        cwd: co,
        env: { ...isolatedGitEnv(), ...credential },
      })
    ).stdout
      .replace(/\n$/, "")
      .split("\n");
    const last = helpers.lastIndexOf("");
    expect(helpers.slice(0, last)).toContain(stale);
    expect(helpers.slice(last + 1).filter(Boolean)).toEqual([
      worktreeEnv.GIT_CONFIG_VALUE_1!,
    ]);
  });

  test("a real fetch waits for the server's git lock", async () => {
    const { withGitLock } = await import("../../worktree");
    let release!: () => void;
    const held = withGitLock(
      () => new Promise<void>((done) => (release = done)),
    );
    let finished = false;
    const fetching = fetchDefaultBranch("acme", { repo: d.repo }).then((ok) => {
      finished = true;
      return ok;
    });
    await Bun.sleep(300);
    expect(finished).toBe(false);
    release();
    await held;
    expect(await fetching).toBe(true);
  });
});
