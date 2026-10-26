import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeFrontMatter } from "../../shared/knowledge";
import { git } from "../memory-repo/git";
import { MemoryRepoService } from "../memory-repo/service";
import { KnowledgeConflictError, KnowledgeService } from "./service";

const ADA = { name: "Ada", email: "ada@example.test" };

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
