import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWLEDGE_METHODS } from "../memory-repo/protocol";
import { dispatchKnowledge } from "./dispatch";
import { KnowledgeService } from "./service";

const TODAY = "2026-10-26";

/** Arguments that make each index call succeed on an empty project. */
const ARGS: Record<string, unknown[]> = {
  "index.search": ["acme", "export", { today: TODAY }],
  "index.list": ["acme", "all", { today: TODAY }],
  "index.counts": ["acme", TODAY],
  "index.get": ["acme", "articles/export.md", TODAY],
  "index.internalBodies": ["acme"],
  "index.dependents": ["acme", { type: "issue", number: 1 }, TODAY],
};

let base: string;
let service: KnowledgeService;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "knowledge-dispatch-"));
  service = new KnowledgeService({ base });
  await service.ensureRepo("acme");
});

afterAll(async () => {
  service.close();
  await rm(base, { recursive: true, force: true });
});

describe("dispatchKnowledge", () => {
  test("every index call runs fresh before it reads", async () => {
    const indexCalls = KNOWLEDGE_METHODS.filter((m) =>
      m.startsWith("index."),
    ).map(String);
    expect(indexCalls.sort()).toEqual(Object.keys(ARGS).sort());
    const original = service.fresh.bind(service);
    for (const method of indexCalls) {
      let fresh = 0;
      service.fresh = async (project) => {
        fresh++;
        return original(project);
      };
      try {
        await dispatchKnowledge(service, method, ARGS[method]);
      } finally {
        service.fresh = original;
      }
      expect({ method, fresh }).toEqual({ method, fresh: 1 });
    }
  });

  test("an index call fails closed when the index can't catch up", async () => {
    const original = service.fresh.bind(service);
    service.fresh = async () => {
      throw new Error("disk full");
    };
    try {
      for (const method of Object.keys(ARGS))
        await expect(
          dispatchKnowledge(service, method, ARGS[method]),
        ).rejects.toThrow("disk full");
    } finally {
      service.fresh = original;
    }
  });
});
