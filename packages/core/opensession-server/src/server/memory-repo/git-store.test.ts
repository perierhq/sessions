import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, isolatedGitEnv } from "./git";
import { GitRepoStore, LITERAL_PATHSPECS, MemoryRepoError } from "./git-store";
import type { FileProblem } from "./validate";

let base: string;
let store: GitRepoStore;
let refuse: FileProblem[] = [];
const pushed: string[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "git-store-"));
  store = new GitRepoStore({
    base,
    isValidName: (name) => /^test-/.test(name),
    validate: () => refuse,
    onPushed: async (name) => {
      pushed.push(name);
    },
    label: "Knowledge",
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("GitRepoStore", () => {
  const name = "test-acme";
  let first = "";
  let second = "";

  test("withWork commits and returns the new HEAD", async () => {
    await store.initBare(name);
    expect(await store.repoExists(name)).toBe(true);
    expect(await store.head(name)).toBeNull();
    first = (await store.withWork(
      name,
      async (work) => {
        await work.write("a.md", "first\n");
      },
      { message: "Add a", author: { name: "Ada", email: "ada@example.test" } },
    ))!;
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await store.head(name)).toBe(first);
    expect(pushed).toEqual([name]);
    expect(await store.readFile(name, "a.md")).toBe("first\n");
    expect(await store.listFiles(name)).toEqual(["a.md"]);
  });

  test("an identical write returns null", async () => {
    const again = await store.withWork(
      name,
      async (work) => {
        await work.write("a.md", "first\n");
      },
      { message: "Add a again" },
    );
    expect(again).toBeNull();
    expect(await store.head(name)).toBe(first);
  });

  test("history lists commits with the author and trailers", async () => {
    second = (await store.withWork(
      name,
      async (work) => {
        await work.write("a.md", "second\n");
      },
      {
        message: "Edit a",
        author: { name: "Pat" },
        trailers: ["Suggested-by: Pat"],
      },
    ))!;
    expect(second).not.toBe(first);
    const log = await store.history(name, { path: "a.md" });
    expect(log.map((commit) => commit.sha)).toEqual([second, first]);
    expect(log[0]).toMatchObject({
      author: "Pat",
      subject: "Edit a",
      body: "Suggested-by: Pat",
      files: [{ status: "M", path: "a.md" }],
    });
    expect(log[1]).toMatchObject({ author: "Ada", subject: "Add a" });
    expect(await store.diff(name, second)).toContain("+second");
  });

  test("readAt and blobAt read a file at an older commit", async () => {
    const bytes = await store.readAt(name, first, "a.md");
    expect(new TextDecoder().decode(bytes!)).toBe("first\n");
    expect(await store.readAt(name, first, "missing.md")).toBeNull();
    const blobFirst = await store.blobAt(name, first, "a.md");
    const blobSecond = await store.blobAt(name, second, "a.md");
    expect(blobFirst).toMatch(/^[0-9a-f]{40}$/);
    expect(blobSecond).toMatch(/^[0-9a-f]{40}$/);
    expect(blobFirst).not.toBe(blobSecond);
    expect(await store.blobAt(name, first, "missing.md")).toBeNull();
  });

  test("isAncestor follows the commit graph", async () => {
    expect(await store.isAncestor(name, first, second)).toBe(true);
    expect(await store.isAncestor(name, second, first)).toBe(false);
  });

  test("commitOf resolves commits and refuses trees and unknown ids", async () => {
    expect(await store.commitOf(name, first)).toBe(first);
    expect(await store.commitOf(name, first.slice(0, 10))).toBe(first);
    expect(await store.commitOf(name, "main")).toBe(second);
    const tree = (
      await git([
        "--git-dir",
        store.bareDir(name),
        "rev-parse",
        `${first}^{tree}`,
      ])
    ).stdout.trim();
    expect(await store.commitOf(name, tree)).toBeNull();
    expect(await store.commitOf(name, "0".repeat(40))).toBeNull();
    expect(await store.commitOf(name, "nope")).toBeNull();
    await expect(store.commitOf(name, "-x")).rejects.toThrow(MemoryRepoError);
    await expect(store.commitOf(name, "a..b")).rejects.toThrow(MemoryRepoError);
    // A tree id is not a revision readAt, blobAt or isAncestor accept.
    expect(await store.readAt(name, tree, "a.md")).toBeNull();
    expect(await store.blobAt(name, tree, "a.md")).toBeNull();
    await expect(store.isAncestor(name, tree, second)).rejects.toThrow(
      "Unknown commit.",
    );
  });

  test("blobAt and readAt return null for a directory", async () => {
    const withDir = (await store.withWork(
      name,
      async (work) => {
        await work.write("docs/b.md", "b\n");
      },
      { message: "Add docs/b" },
    ))!;
    expect(await store.blobAt(name, withDir, "docs")).toBeNull();
    expect(await store.readAt(name, withDir, "docs")).toBeNull();
    expect(await store.blobAt(name, withDir, "docs/b.md")).toMatch(
      /^[0-9a-f]{40}$/,
    );
    await store.withWork(
      name,
      async (work) => {
        await work.remove("docs/b.md");
      },
      { message: "Remove docs/b" },
    );
  });

  test("reads refuse options, ranges and escaping paths", async () => {
    for (const rev of ["-x", "--output=/tmp/x", "a..b", "HEAD@{0}", ""]) {
      await expect(store.readAt(name, rev, "a.md")).rejects.toThrow(
        MemoryRepoError,
      );
      await expect(store.blobAt(name, rev, "a.md")).rejects.toThrow(
        MemoryRepoError,
      );
    }
    for (const path of [
      "../a.md",
      "x/../../a.md",
      ".git/config",
      "x/.GIT/y",
      "./a.md",
    ]) {
      await expect(store.readAt(name, first, path)).rejects.toThrow(
        MemoryRepoError,
      );
      await expect(store.blobAt(name, first, path)).rejects.toThrow(
        MemoryRepoError,
      );
    }
    // Unknown commits read as absent.
    expect(await store.readAt(name, "0".repeat(40), "a.md")).toBeNull();
    expect(await store.blobAt(name, "0".repeat(40), "a.md")).toBeNull();
  });

  test("isAncestor refuses non-hex and throws on unknown commits", async () => {
    await expect(store.isAncestor(name, "main", second)).rejects.toThrow(
      "Invalid commit.",
    );
    await expect(store.isAncestor(name, first, "zz")).rejects.toThrow(
      "Invalid commit.",
    );
    const unknown = "0".repeat(40);
    try {
      await store.isAncestor(name, unknown, second);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryRepoError);
      expect((error as MemoryRepoError).status).toBe(404);
    }
    await expect(store.isAncestor(name, first, unknown)).rejects.toThrow(
      "Unknown commit.",
    );
  });

  test("history reads its path literally", async () => {
    expect(LITERAL_PATHSPECS).toBe("--literal-pathspecs");
    expect(await store.history(name, { path: "*.md" })).toEqual([]);
    expect((await store.history(name, { path: "a.md" })).length).toBe(2);
  });

  test("withLockedWork hands a synced checkout to fn", async () => {
    const seen = await store.withLockedWork(
      name,
      isolatedGitEnv(),
      async (dir) => {
        const head = await git(["rev-parse", "HEAD"], { cwd: dir });
        return head.stdout.trim();
      },
    );
    expect(seen).toBe((await store.head(name))!);
  });

  test("revert of the last commit restores the file", async () => {
    const reverted = await store.revert(name, second, { name: "Ada" });
    expect(reverted).toMatch(/^[0-9a-f]{40}$/);
    expect(await store.readFile(name, "a.md")).toBe("first\n");
    const log = await store.history(name, { limit: 1 });
    expect(log[0]).toMatchObject({
      author: "Ada",
      subject: `Revert ${second.slice(0, 10)}`,
      body: `Reverts: ${second}`,
    });
  });

  test("listRepos ignores names isValidName refuses", async () => {
    await mkdir(join(base, "repos", "other.git"), { recursive: true });
    expect(await store.listRepos()).toEqual([name]);
  });

  test("a validation problem throws and leaves HEAD unchanged", async () => {
    const before = await store.head(name);
    refuse = [{ path: "b.md", line: 2, message: "Not allowed here." }];
    try {
      await expect(
        store.withWork(
          name,
          async (work) => {
            await work.write("b.md", "x\ny\n");
          },
          { message: "Add b" },
        ),
      ).rejects.toThrow(MemoryRepoError);
      await expect(
        store.withWork(
          name,
          async (work) => {
            await work.write("b.md", "x\ny\n");
          },
          { message: "Add b" },
        ),
      ).rejects.toThrow("b.md:2: Not allowed here.");
    } finally {
      refuse = [];
    }
    expect(await store.head(name)).toBe(before);
    expect(await store.readFile(name, "b.md")).toBeNull();
  });
});

describe("GitRepoStore extras", () => {
  test("validateStagedPaths checks files moved with git", async () => {
    const name = "test-move";
    await store.initBare(name);
    await store.withWork(
      name,
      async (work) => {
        await work.write("a.md", "a\n");
      },
      { message: "Add a" },
    );
    const seen: string[] = [];
    const strict = new GitRepoStore({
      ...store.opts,
      validate: (path) => {
        seen.push(path);
        return path.startsWith("bad/")
          ? [{ path, line: 1, message: "Not allowed here." }]
          : [];
      },
    });
    const before = await store.head(name);
    await expect(
      strict.withWork(
        name,
        async (work) => {
          await mkdir(join(work.dir, "bad"));
          await work.git(["mv", "a.md", "bad/a.md"]);
          await strict.validateStagedPaths(work);
        },
        { message: "Move a" },
      ),
    ).rejects.toThrow("bad/a.md:1: Not allowed here.");
    expect(await store.head(name)).toBe(before);
    seen.length = 0;
    const moved = await strict.withWork(
      name,
      async (work) => {
        await mkdir(join(work.dir, "good"));
        await work.git(["mv", "a.md", "good/a.md"]);
        expect(await strict.validateStagedPaths(work)).toEqual(["good/a.md"]);
      },
      { message: "Move a" },
    );
    expect(moved).toMatch(/^[0-9a-f]{40}$/);
    expect(seen).toEqual(["good/a.md"]);
    expect(await store.listFiles(name)).toEqual(["good/a.md"]);
  });

  test("an onPushed failure throws unless logOnPushedErrors is set", async () => {
    const name = "test-pushed";
    const failing = (log: boolean) =>
      new GitRepoStore({
        ...store.opts,
        onPushed: async () => {
          throw new Error("refresh broke");
        },
        logOnPushedErrors: log,
      });
    await store.initBare(name);
    await expect(
      failing(false).withWork(
        name,
        async (work) => {
          await work.write("a.md", "a\n");
        },
        { message: "Add a" },
      ),
    ).rejects.toThrow("refresh broke");
    const warn = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warned.push(args);
    };
    try {
      const head = await failing(true).withWork(
        name,
        async (work) => {
          await work.write("a.md", "b\n");
        },
        { message: "Edit a" },
      );
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(await store.head(name)).toBe(head);
    } finally {
      console.warn = warn;
    }
    expect(warned.length).toBe(1);
  });
});
