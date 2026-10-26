import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoStore, MemoryRepoError } from "./git-store";
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
