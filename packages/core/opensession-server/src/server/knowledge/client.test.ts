import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setMemoryDirForTest } from "../../agents/slack/memory";
import type { KnowledgeFrontMatter } from "../../shared/knowledge";
import { MemoryRepoError } from "../memory-repo/git-store";
import { KNOWLEDGE_METHODS } from "../memory-repo/protocol";
import {
  NO_REPO_TTL_MS,
  __setKnowledgeServiceForTest,
  knowledgeRepo,
} from "./client";
import {
  __setKnowledgeBroadcastForTest,
  type KnowledgeBroadcast,
} from "./broadcast";
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
  test("a project's 'no repository' is reused for a minute, until ensureRepo", async () => {
    const now = Date.now();
    expect(await knowledgeRepo.hasRepo("acme-new", now)).toBe(false);
    // The repository appears behind the facade's back: still "no" within
    // the minute, asked again after it.
    await service.ensureRepo("acme-new");
    expect(await knowledgeRepo.hasRepo("acme-new", now + 1_000)).toBe(false);
    expect(await knowledgeRepo.hasRepo("acme-new", now + NO_REPO_TTL_MS)).toBe(
      true,
    );
    // ensureRepo through the facade forgets the answer at once.
    expect(await knowledgeRepo.hasRepo("acme-later", now)).toBe(false);
    await knowledgeRepo.call("ensureRepo", "acme-later");
    expect(await knowledgeRepo.hasRepo("acme-later", now + 1)).toBe(true);
    // A "yes" is never reused: an outage fails that project's checks.
    try {
      __setKnowledgeServiceForTest({
        hasRepo: async () => {
          throw new MemoryRepoError("The memory worker is unavailable.", 503);
        },
      } as unknown as KnowledgeService);
      await expect(
        knowledgeRepo.hasRepo("acme-later", now + 2),
      ).rejects.toThrow("unavailable");
    } finally {
      __setKnowledgeServiceForTest(service);
    }
  });

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

  test("a write, a revert or a new repository tells the project's clients; reads and refused writes don't", async () => {
    const sent: KnowledgeBroadcast[] = [];
    __setKnowledgeBroadcastForTest((m) => sent.push(m));
    try {
      await knowledgeRepo.call("ensureRepo", "acme-live");
      const sha = await knowledgeRepo.call(
        "write",
        "acme-live",
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
      expect(sent).toEqual([
        { type: "knowledge_changed", project: "acme-live", what: "items" },
        { type: "knowledge_changed", project: "acme-live", what: "items" },
      ]);
      await knowledgeRepo.call("read", "acme-live", "articles/export-csv.md");
      await knowledgeRepo.call("index.counts", "acme-live", TODAY);
      await knowledgeRepo
        .call(
          "write",
          "acme-live",
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
        .catch(() => undefined);
      expect(sent).toHaveLength(2);
      await knowledgeRepo.call("revert", "acme-live", sha!, ADA);
      expect(sent).toHaveLength(3);
      expect(sent[2]).toEqual({
        type: "knowledge_changed",
        project: "acme-live",
        what: "items",
      });
    } finally {
      __setKnowledgeBroadcastForTest(undefined);
    }
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
