import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setMemoryDirForTest } from "../../agents/slack/memory";
import type { KnowledgeFrontMatter } from "../../shared/knowledge";
import { MemoryRepoError } from "../memory-repo/git-store";
import { KNOWLEDGE_METHODS } from "../memory-repo/protocol";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "./client";
import { dispatchKnowledge } from "./dispatch";
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
  base = await mkdtemp(join(tmpdir(), "knowledge-client-"));
  service = new KnowledgeService({ base });
  __setKnowledgeServiceForTest(service);
});

afterAll(async () => {
  __setKnowledgeServiceForTest(null);
  service.close();
  await rm(base, { recursive: true, force: true });
});

describe("knowledgeRepo client", () => {
  test("write then search finds the item without an explicit fresh", async () => {
    await knowledgeRepo.call("ensureRepo", "acme");
    expect(await knowledgeRepo.call("hasRepo", "acme")).toBe(true);
    const sha = await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: "articles/export-csv.md",
          fm: fm(),
          body: "Open the project, choose Export, then CSV.\n",
        },
      ],
      { message: "Add export article", author: ADA },
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const hits = await knowledgeRepo.call("index.search", "acme", "export", {
      today: TODAY,
    });
    expect(hits.map((hit) => hit.item.path)).toEqual([
      "articles/export-csv.md",
    ]);
    expect(hits[0].item.commit).toBe(sha!);
  });

  test("index calls bring the index up to date first", async () => {
    // A commit this index hasn't seen: written by a second service over
    // the same repositories with its own index.
    const writer = new KnowledgeService({
      base,
      indexPath: join(base, "writer-index.sqlite"),
    });
    try {
      await writer.write(
        "acme",
        [
          {
            op: "put",
            path: "articles/import-csv.md",
            fm: fm({ title: "Importing a CSV", topics: ["import"] }),
            body: "Choose Import, then pick the file.\n",
          },
        ],
        { message: "Add import article", author: ADA },
      );
    } finally {
      writer.close();
    }
    expect(service.index.get("acme", "articles/import-csv.md")).toBeNull();
    const item = await knowledgeRepo.call(
      "index.get",
      "acme",
      "articles/import-csv.md",
    );
    expect(item?.title).toBe("Importing a CSV");
    const counts = await knowledgeRepo.call("index.counts", "acme", TODAY);
    expect(counts.all).toBe(2);
  });

  test("a conflicting write rejects with KnowledgeConflictError (409)", async () => {
    const error = await knowledgeRepo
      .call(
        "write",
        "acme",
        [
          {
            op: "put",
            path: "articles/export-csv.md",
            fm: fm(),
            body: "Changed.\n",
          },
        ],
        {
          message: "Edit",
          author: ADA,
          expected: { "articles/export-csv.md": null },
        },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KnowledgeConflictError);
    expect((error as MemoryRepoError).status).toBe(409);
  });
});

describe("dispatchKnowledge", () => {
  test("refuses a method that isn't on the list", async () => {
    await expect(dispatchKnowledge(service, "store", ["acme"])).rejects.toThrow(
      "Unknown knowledge method store",
    );
    await expect(
      dispatchKnowledge(service, "index.replaceProject", ["acme"]),
    ).rejects.toThrow("Unknown knowledge method index.replaceProject");
    await expect(dispatchKnowledge(service, "constructor", [])).rejects.toThrow(
      "Unknown knowledge method constructor",
    );
  });

  test("an index call prefers the service's own fail-closed method", async () => {
    const target = service as unknown as Record<string, unknown>;
    target.search = async (...args: unknown[]) => ({ wrapped: args });
    try {
      expect(
        await dispatchKnowledge(service, "index.search", ["acme", "csv", {}]),
      ).toEqual({ wrapped: ["acme", "csv", {}] });
    } finally {
      delete target.search;
    }
  });

  test("index calls need a project", async () => {
    await expect(
      dispatchKnowledge(service, "index.search", [42, "export", {}]),
    ).rejects.toThrow(MemoryRepoError);
  });

  test("every listed method exists on the service or its index", () => {
    for (const method of KNOWLEDGE_METHODS) {
      const owner: object = method.startsWith("index.")
        ? service.index
        : service;
      const name = method.replace(/^index\./, "");
      expect(typeof (owner as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

describe("knowledgeRepo on the memory worker", () => {
  let dir: string;
  let previous: string | null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "knowledge-worker-"));
    previous = __setMemoryDirForTest(dir);
    __setKnowledgeServiceForTest(null);
  });

  afterAll(async () => {
    __setMemoryDirForTest(previous);
    __setKnowledgeServiceForTest(service);
    await rm(dir, { recursive: true, force: true });
  });

  test("calls cross the thread and a conflict comes back as itself", async () => {
    await knowledgeRepo.call("ensureRepo", "acme");
    const sha = await knowledgeRepo.call(
      "write",
      "acme",
      [
        {
          op: "put",
          path: "articles/export-csv.md",
          fm: fm(),
          body: "Open the project, choose Export, then CSV.\n",
        },
      ],
      { message: "Add export article", author: ADA },
    );
    const hits = await knowledgeRepo.call("index.search", "acme", "csv", {
      today: TODAY,
    });
    expect(hits[0]?.item.commit).toBe(sha!);
    const conflict = await knowledgeRepo
      .call(
        "write",
        "acme",
        [
          {
            op: "put",
            path: "articles/export-csv.md",
            fm: fm(),
            body: "Changed.\n",
          },
        ],
        {
          message: "Edit",
          author: ADA,
          expected: { "articles/export-csv.md": null },
        },
      )
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(KnowledgeConflictError);
    expect((conflict as MemoryRepoError).status).toBe(409);
    const unknown = await knowledgeRepo
      .call("read", "not a project", "articles/x.md")
      .catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(MemoryRepoError);
    expect((unknown as MemoryRepoError).status).toBe(400);
  });
});
