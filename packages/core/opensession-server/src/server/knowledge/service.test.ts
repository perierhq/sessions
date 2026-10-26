import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KnowledgeFrontMatter } from "../../shared/knowledge";
import { git } from "../memory-repo/git";
import { MemoryRepoService } from "../memory-repo/service";
import { renderArticle } from "./format";
import { MAX_ARTICLE_BYTES, MAX_ATTACHMENT_BYTES } from "./validate";
import { KnowledgeConflictError, KnowledgeService } from "./service";

const ADA = { name: "Ada", email: "ada@example.test" };
const TODAY = "2026-10-26";

function fm(over: Partial<KnowledgeFrontMatter> = {}): KnowledgeFrontMatter {
  return {
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: ["export", "csv"],
    sources: [],
    dependsOn: ["repo:docs/export.md"],
    validAsOf: "2026-10-20",
    ...over,
  };
}

let base: string;
let service: KnowledgeService;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "knowledge-service-"));
  service = new KnowledgeService({ base });
});

afterAll(async () => {
  service.index.close();
  await rm(base, { recursive: true, force: true });
});

let scratch = 0;

/** Commit files straight to the bare repository, as a broken file in
 *  history would be: no validator, no reindex. */
async function pushBehind(
  project: string,
  files: Record<string, string>,
  opts: { executable?: string[] } = {},
): Promise<void> {
  const work = join(base, `behind-${++scratch}`);
  await git([
    "clone",
    "--quiet",
    join(base, "repos", `knowledge-${project}.git`),
    work,
  ]);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), text);
    if (opts.executable?.includes(path)) await chmod(join(work, path), 0o755);
  }
  await git(["add", "-A"], { cwd: work });
  await git(
    [
      "-c",
      "user.name=Behind",
      "-c",
      "user.email=b@example.test",
      "commit",
      "--quiet",
      "-m",
      "Behind",
    ],
    { cwd: work },
  );
  await git(["push", "--quiet", "origin", "HEAD:main"], { cwd: work });
  await rm(work, { recursive: true, force: true });
}

async function commitCount(project: string): Promise<number> {
  const { stdout } = await git([
    "--git-dir",
    join(base, "repos", `knowledge-${project}.git`),
    "rev-list",
    "--count",
    "main",
  ]);
  return Number(stdout.trim());
}

describe("KnowledgeService", () => {
  let first = "";
  let second = "";

  test("ensureRepo creates one commit with KNOWLEDGE.md, idempotently", async () => {
    expect(await service.hasRepo("acme")).toBe(false);
    await service.ensureRepo("acme");
    await service.ensureRepo("acme");
    expect(await service.hasRepo("acme")).toBe(true);
    expect(await commitCount("acme")).toBe(1);
    const history = await service.history("acme");
    expect(history[0].files.map((f) => f.path)).toEqual(["KNOWLEDGE.md"]);
  });

  test("the knowledge repository has no remote", async () => {
    const result = await git(
      [
        "--git-dir",
        join(base, "repos", "knowledge-acme.git"),
        "config",
        "--get",
        "remote.origin.url",
      ],
      { check: false },
    );
    expect(result.stdout.trim()).toBe("");
  });

  test("put then read returns the item at HEAD with its blob", async () => {
    first = (await service.write(
      "acme",
      [
        {
          op: "put",
          path: "articles/export.md",
          fm: fm(),
          body: "Open settings and choose Export.",
        },
      ],
      { message: "Add Exporting a project as CSV", author: ADA },
    ))!;
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await service.head("acme")).toBe(first);
    const read = await service.read("acme", "articles/export.md");
    expect(read?.body).toBe("Open settings and choose Export.");
    expect(read?.item.commit).toBe(first);
    expect(read?.item.title).toBe("Exporting a project as CSV");
    expect(read?.item.blob).toBe(
      (await service.blobAt("acme", "articles/export.md", first))!,
    );
    const history = await service.history("acme");
    expect(history[0].author).toBe("Ada");
  });

  test("a stale expected blob is a conflict and changes nothing", async () => {
    const before = await service.head("acme");
    const error = await service
      .write(
        "acme",
        [
          {
            op: "put",
            path: "articles/export.md",
            fm: fm(),
            body: "Changed.",
          },
        ],
        {
          message: "Edit",
          author: ADA,
          expected: { "articles/export.md": "0".repeat(40) },
        },
      )
      .catch((e) => e);
    expect(error).toBeInstanceOf(KnowledgeConflictError);
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "Someone changed this article. Reload and try again.",
    );
    expect(await service.head("acme")).toBe(before);

    const exists = await service
      .write(
        "acme",
        [{ op: "put", path: "articles/export.md", fm: fm(), body: "New." }],
        {
          message: "Add",
          author: ADA,
          expected: { "articles/export.md": null },
        },
      )
      .catch((e) => e);
    expect(exists).toBeInstanceOf(KnowledgeConflictError);
  });

  test("an edit with the right expected blob commits; old content stays readable", async () => {
    const read = await service.read("acme", "articles/export.md");
    second = (await service.write(
      "acme",
      [
        {
          op: "put",
          path: "articles/export.md",
          fm: fm({ validAsOf: "2026-10-25" }),
          body: "Use the Export button.",
        },
      ],
      {
        message: "Edit Exporting a project as CSV",
        author: ADA,
        expected: { "articles/export.md": read!.item.blob },
      },
    ))!;
    expect(second).not.toBe(first);
    const old = await service.readAt("acme", "articles/export.md", first);
    expect(old?.body).toBe("Open settings and choose Export.");
    expect(old?.fm.validAsOf).toBe("2026-10-20");
    const oldBlob = await service.blobAt("acme", "articles/export.md", first);
    const newBlob = await service.blobAt("acme", "articles/export.md", second);
    expect(old?.blob).toBe(oldBlob!);
    expect(oldBlob).not.toBe(newBlob);
    expect(await service.isAncestor("acme", first, second)).toBe(true);
    expect(await service.isAncestor("acme", second, first)).toBe(false);
    expect((await service.read("acme", "articles/export.md"))?.body).toBe(
      "Use the Export button.",
    );
  });

  test("move from suggestions to articles leaves one item", async () => {
    await service.write(
      "acme",
      [
        {
          op: "put",
          path: "suggestions/x.md",
          fm: fm({
            title: "Resetting a password",
            trust: "reference",
            origin: "suggestion",
            suggestedBy: "Pat",
          }),
          body: "Use the reset link.",
        },
      ],
      {
        message: "Suggest Resetting a password",
        author: { name: "Pat" },
        trailers: ["Suggested-by: Pat"],
      },
    );
    expect(await service.read("acme", "suggestions/x.md")).not.toBeNull();
    await service.write(
      "acme",
      [
        {
          op: "move",
          from: "suggestions/x.md",
          to: "articles/x.md",
          fm: fm({
            title: "Resetting a password",
            approvedBy: "Ada",
            suggestedBy: "Pat",
          }),
          body: "Use the reset link.",
        },
      ],
      {
        message: "Approve Resetting a password",
        author: ADA,
        trailers: ["Suggested-by: Pat"],
      },
    );
    expect(await service.read("acme", "suggestions/x.md")).toBeNull();
    const moved = await service.read("acme", "articles/x.md");
    expect(moved?.item.approvedBy).toBe("Ada");
    const titled = service.index
      .list("acme", "all")
      .items.filter((i) => i.title === "Resetting a password");
    expect(titled.map((i) => i.path)).toEqual(["articles/x.md"]);
    const history = await service.history("acme", "articles/x.md");
    expect(history.map((c) => c.subject)).toEqual([
      "Approve Resetting a password",
    ]);
    expect(history[0].body).toContain("Suggested-by: Pat");
  });

  test("history for a path lists only commits that touch it", async () => {
    const history = await service.history("acme", "articles/export.md");
    expect(history.map((c) => c.sha)).toEqual([second, first]);
  });

  test("a body with a credential is refused with no commit", async () => {
    const before = await service.head("acme");
    await expect(
      service.write(
        "acme",
        [
          {
            op: "put",
            path: "articles/key.md",
            fm: fm({ title: "Key" }),
            body: `Use ghp_${"a".repeat(36)} as the key.`,
          },
        ],
        { message: "Add key", author: ADA },
      ),
    ).rejects.toThrow(/credentials/);
    expect(await service.head("acme")).toBe(before);
    expect(await service.read("acme", "articles/key.md")).toBeNull();
  });

  test("attachments are stored and read back as bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255]);
    await service.write(
      "acme",
      [{ op: "attach", path: "attachments/handbook/handbook.pdf", bytes }],
      { message: "Attach handbook", author: ADA },
    );
    expect(
      await service.readAttachment("acme", "attachments/handbook/handbook.pdf"),
    ).toEqual(bytes);
    expect(
      await service.readAttachment("acme", "attachments/handbook/none.pdf"),
    ).toBeNull();
  });

  test("delete removes the item from the index", async () => {
    await service.write("acme", [{ op: "delete", path: "articles/x.md" }], {
      message: "Delete Resetting a password",
      author: ADA,
    });
    expect(await service.read("acme", "articles/x.md")).toBeNull();
  });

  test("revert restores the previous content", async () => {
    const sha = await service.revert("acme", second, ADA);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await service.read("acme", "articles/export.md"))?.body).toBe(
      "Open settings and choose Export.",
    );
    expect(await service.diff("acme", second)).toContain(
      "Use the Export button.",
    );
  });

  test("an unreadable item is indexed as needs-check and never backs", async () => {
    // Written behind the service's back, as a broken file in history would be.
    const work = join(base, "scratch");
    await git([
      "clone",
      "--quiet",
      join(base, "repos", "knowledge-acme.git"),
      work,
    ]);
    await Bun.write(
      join(work, "articles/broken.md"),
      "---\ntitle: Broken item\nkind: answer\n---\n\nText.\n",
    );
    await git(["add", "-A"], { cwd: work });
    await git(["commit", "--quiet", "-m", "Broken"], { cwd: work });
    await git(["push", "--quiet", "origin", "HEAD:main"], { cwd: work });
    await service.fresh("acme");
    const broken = await service.read("acme", "articles/broken.md");
    expect(broken?.item.status).toBe("needs-check");
    expect(broken?.item.trust).toBe("reference");
    expect(broken?.item.title).toBe("Broken item");
    expect(broken?.item.check?.reason).toStartWith("The file can't be read: ");
  });

  test("a failed reindex keeps the saved edit and reads fail until it works", async () => {
    const index = service.index;
    const original = index.replaceProject.bind(index);
    index.replaceProject = () => {
      throw new Error("disk full");
    };
    try {
      const sha = await service.write(
        "acme",
        [
          {
            op: "put",
            path: "articles/late.md",
            fm: fm({ title: "Late" }),
            body: "Indexed later.",
          },
        ],
        { message: "Add Late", author: ADA },
      );
      expect(sha).toBe((await service.head("acme"))!);
      expect(index.head("acme")).not.toBe(sha);
      await expect(service.read("acme", "articles/late.md")).rejects.toThrow(
        "disk full",
      );
    } finally {
      index.replaceProject = original;
    }
    expect((await service.read("acme", "articles/late.md"))?.body).toBe(
      "Indexed later.",
    );
  });

  test("listProjects ignores memory repositories in the same base", async () => {
    const memory = new MemoryRepoService({
      base,
      indexPath: join(base, "memory-index.sqlite"),
    });
    await memory.ensureRepo("team");
    memory.close();
    expect(await service.listProjects()).toEqual(["acme"]);
  });

  test("an invalid project name is refused", async () => {
    await expect(service.ensureRepo("../etc")).rejects.toThrow();
  });
});

describe("KnowledgeService review fixes", () => {
  const put = (
    path: string,
    over: Partial<KnowledgeFrontMatter> = {},
    body = "Text.",
  ) => ({
    op: "put" as const,
    path,
    fm: fm({ title: path, ...over }),
    body,
  });

  test("fresh runs one at a time; a call after a push waits and sees it", async () => {
    await service.ensureRepo("race");
    const writer = new KnowledgeService({
      base,
      indexPath: join(base, "race-writer.sqlite"),
    });
    // A commit this service hasn't indexed yet.
    const before = await writer.write("race", [put("articles/early.md")], {
      message: "Add early",
      author: ADA,
    });
    const store = service.store;
    const original = store.head.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    store.head = async (name: string) => {
      const head = await original(name);
      if (!held) {
        held = true;
        await gate;
      }
      return head;
    };
    try {
      // The first reindex reads the old head, then stalls.
      const first = service.fresh("race");
      await Bun.sleep(20);
      const pushed = await writer.write("race", [put("articles/late.md")], {
        message: "Add late",
        author: ADA,
      });
      expect(pushed).not.toBe(before);
      const second = service.fresh("race");
      release();
      await Promise.all([first, second]);
      expect(service.index.head("race")).toBe(pushed!);
      expect(service.index.get("race", "articles/late.md")).not.toBeNull();
    } finally {
      store.head = original;
      writer.close();
    }
  });

  test("search, list, counts, internalBodies and dependents bring the index up to date", async () => {
    const writer = new KnowledgeService({
      base,
      indexPath: join(base, "fresh-writer.sqlite"),
    });
    try {
      await writer.write(
        "race",
        [
          put("articles/zebra.md", {
            title: "Zebra crossings",
            dependsOn: ["issue:7"],
          }),
          put(
            "articles/inside.md",
            { title: "Inside note", kind: "internal" },
            "Only staff see this.",
          ),
        ],
        { message: "Add zebra", author: ADA },
      );
    } finally {
      writer.close();
    }
    expect(
      (await service.search("race", "zebra", { today: TODAY })).map(
        (hit) => hit.item.path,
      ),
    ).toEqual(["articles/zebra.md"]);
    const listed = await service.list("race", "all", { today: TODAY });
    expect(listed.items.map((item) => item.path)).toContain(
      "articles/zebra.md",
    );
    expect((await service.counts("race", TODAY)).all).toBe(listed.total);
    expect(
      (await service.internalBodies("race")).map((note) => note.body),
    ).toEqual(["Only staff see this."]);
    expect(
      (
        await service.dependents("race", { type: "issue", number: 7 }, TODAY)
      ).map((item) => item.path),
    ).toEqual(["articles/zebra.md"]);
  });

  test("an unreadable item keeps its raw text for the quote check, capped", async () => {
    await service.ensureRepo("raw");
    const big = "staff only words ".repeat(20_000);
    await pushBehind("raw", {
      "articles/unclosed.md":
        "---\ntitle: Unclosed\nCall Bob on the private line for refunds.\n",
      "sources/files/big.md": big,
    });
    const bodies = await service.internalBodies("raw");
    const unclosed = bodies.find(
      (note) => note.path === "articles/unclosed.md",
    );
    expect(unclosed?.body).toContain("Call Bob on the private line");
    const capped = bodies.find((note) => note.path === "sources/files/big.md");
    expect(capped?.body.length).toBe(MAX_ARTICLE_BYTES);
    expect(big.startsWith(capped!.body)).toBe(true);
  });

  test("paths with a .git segment are refused", async () => {
    for (const path of [
      "attachments/.git/config.pdf",
      "attachments/x/.GIT",
      "attachments/x/.gitmodules",
      "articles/.git/x.md",
      "sources/repo/.Github/readme.md",
    ]) {
      const change = path.startsWith("attachments/")
        ? { op: "attach" as const, path, bytes: new Uint8Array([1]) }
        : put(path);
      await expect(
        service.write("acme", [change], { message: "Bad", author: ADA }),
      ).rejects.toThrow(/Invalid knowledge path/);
    }
  });

  test("every change is checked before any git work", async () => {
    // "nosetup" has no repository: a 404 would mean git ran first.
    const refused = async (
      change: Parameters<KnowledgeService["write"]>[1][number],
      message = "Add",
      trailers?: string[],
    ) =>
      service
        .write("nosetup", [change], { message, author: ADA, trailers })
        .catch((error) => error);
    const origin = await refused(
      put("articles/a.md", { origin: "suggestion" }),
    );
    expect(origin.status).toBe(400);
    expect(origin.message).toMatch(/origin/);
    const secret = await refused(
      put("articles/a.md"),
      `Add ghp_${"a".repeat(36)}`,
    );
    expect(secret.status).toBe(400);
    expect(secret.message).toMatch(/credentials/);
    const trailer = await refused(put("articles/a.md"), "Add", [
      `Token: ghp_${"b".repeat(36)}`,
    ]);
    expect(trailer.message).toMatch(/credentials/);
    const huge = await refused({
      op: "attach",
      path: "attachments/big/big.pdf",
      bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
    });
    expect(huge.status).toBe(400);
    expect(huge.message).toMatch(/limit/);
    const outside = await refused({
      op: "attach",
      path: "articles/handbook.pdf",
      bytes: new Uint8Array([1, 2]),
    });
    expect(outside.message).toMatch(/Invalid knowledge path/);
    expect(await service.hasRepo("nosetup")).toBe(false);
  });

  test("a move needs its source and an empty target", async () => {
    await service.ensureRepo("moves");
    await service.write(
      "moves",
      [
        put("suggestions/a.md", { origin: "suggestion", trust: "reference" }),
        put("articles/b.md"),
      ],
      { message: "Seed", author: ADA },
    );
    const head = await service.head("moves");
    const move = (from: string, to: string) => ({
      op: "move" as const,
      from,
      to,
      fm: fm({ title: "Moved" }),
      body: "Moved.",
    });
    for (const [from, to] of [
      ["suggestions/none.md", "articles/c.md"],
      ["suggestions/a.md", "articles/b.md"],
    ]) {
      const error = await service
        .write("moves", [move(from, to)], { message: "Move", author: ADA })
        .catch((e) => e);
      expect(error).toBeInstanceOf(KnowledgeConflictError);
    }
    expect(await service.head("moves")).toBe(head);
    const same = await service
      .write("moves", [move("articles/b.md", "articles/b.md")], {
        message: "Move",
        author: ADA,
      })
      .catch((e) => e);
    expect(same.status).toBe(400);
    // Replacing the target is fine when the caller says what it replaces.
    const b = await service.read("moves", "articles/b.md");
    await service.write("moves", [move("suggestions/a.md", "articles/b.md")], {
      message: "Move",
      author: ADA,
      expected: { "articles/b.md": b!.item.blob },
    });
    expect((await service.read("moves", "articles/b.md"))?.body).toBe("Moved.");
    expect(await service.read("moves", "suggestions/a.md")).toBeNull();
  });

  test("two writes with the same expected blob: one lands, one is a 409", async () => {
    const read = await service.read("moves", "articles/b.md");
    const edit = (body: string) =>
      service.write("moves", [put("articles/b.md", {}, body)], {
        message: `Edit ${body}`,
        author: ADA,
        expected: { "articles/b.md": read!.item.blob },
      });
    const results = await Promise.allSettled([edit("One."), edit("Two.")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(KnowledgeConflictError);
  });

  test("revert validates what it restores, file modes included", async () => {
    await service.ensureRepo("revert");
    await pushBehind(
      "revert",
      { "articles/run.md": renderArticle(fm({ title: "Run" }), "Body.") },
      { executable: ["articles/run.md"] },
    );
    const removed = await service.write(
      "revert",
      [{ op: "delete", path: "articles/run.md" }],
      { message: "Remove run", author: ADA },
    );
    await expect(service.revert("revert", removed!, ADA)).rejects.toThrow(
      /Executable/,
    );
    expect(await service.head("revert")).toBe(removed);
  });

  test("the knowledge repository is never served for pushes", async () => {
    const result = await git(
      [
        "--git-dir",
        join(base, "repos", "knowledge-acme.git"),
        "config",
        "--get",
        "http.receivepack",
      ],
      { check: false },
    );
    expect(result.stdout.trim()).toBe("");
  });

  test("a project name with capitals is refused", async () => {
    await expect(service.ensureRepo("Acme")).rejects.toThrow(
      /Invalid knowledge project/,
    );
  });
});
