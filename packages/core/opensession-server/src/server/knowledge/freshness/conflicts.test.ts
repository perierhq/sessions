import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeFrontMatter } from "../../../shared/knowledge";
import { __setKnowledgeServiceForTest, knowledgeRepo } from "../client";
import type { KnowledgeChange } from "../service";
import { KnowledgeService } from "../service";
import { checkConflicts, MAX_CONFLICT_CALLS } from "./conflicts";

const TODAY = "2026-10-26";
const ADA = { name: "Ada", email: "ada@example.test" };

let base: string;
let service: KnowledgeService;

function fm(over: Partial<KnowledgeFrontMatter>): KnowledgeFrontMatter {
  return {
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: ["export", "csv"],
    sources: [],
    dependsOn: [],
    validAsOf: "2026-10-20",
    ...over,
  };
}

async function seed(project: string, changes: KnowledgeChange[]) {
  await knowledgeRepo.call("ensureRepo", project);
  await knowledgeRepo.call("write", project, changes, {
    message: "Seed",
    author: ADA,
  });
}

async function item(project: string, path: string) {
  return (await knowledgeRepo.call("read", project, path, TODAY))!.item;
}

function stub(route: "agree" | "disagree" | "unrelated" | null) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    classify: async (a: string, b: string) => {
      calls.push([a, b]);
      return route;
    },
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "kn-conflicts-"));
  service = new KnowledgeService({ base: join(base, "memory") });
  __setKnowledgeServiceForTest(service);
  await seed("acme", [
    {
      op: "put",
      path: "articles/export.md",
      fm: fm({}),
      body: "Open the project, choose Export, then CSV.\n",
    },
    {
      op: "put",
      path: "articles/export-old.md",
      fm: fm({ title: "Export a project to CSV", validAsOf: "2026-01-10" }),
      body: "CSV export is only available on the Pro plan.\n",
    },
  ]);
});

afterAll(async () => {
  __setKnowledgeServiceForTest(null);
  service.close();
  await rm(base, { recursive: true, force: true });
});

describe("checkConflicts", () => {
  test("agree leaves both items as they are", async () => {
    const before = await knowledgeRepo.call("history", "acme");
    const model = stub("agree");
    const pairs = await checkConflicts("acme", ["articles/export.md"], {
      classify: model.classify,
      today: TODAY,
    });
    expect(pairs).toEqual([]);
    expect(model.calls.length).toBe(1);
    expect(model.calls[0]![0]).toContain("Open the project, choose Export");
    expect(model.calls[0]![1]).toContain("only available on the Pro plan");
    expect((await item("acme", "articles/export.md")).status).toBe("active");
    expect((await item("acme", "articles/export-old.md")).status).toBe(
      "active",
    );
    expect((await knowledgeRepo.call("history", "acme")).length).toBe(
      before.length,
    );
  });

  test("unrelated leaves both items as they are", async () => {
    const model = stub("unrelated");
    const pairs = await checkConflicts("acme", ["articles/export.md"], {
      classify: model.classify,
      today: TODAY,
    });
    expect(pairs).toEqual([]);
    expect(model.calls.length).toBe(1);
    expect((await item("acme", "articles/export.md")).status).toBe("active");
  });

  test("a failed model flips nothing and leaves the item for the next run", async () => {
    const unchecked: string[] = [];
    const pairs = await checkConflicts("acme", ["articles/export.md"], {
      classify: stub(null).classify,
      today: TODAY,
      onUnchecked: (path) => unchecked.push(path),
    });
    expect(pairs).toEqual([]);
    expect(unchecked).toEqual(["articles/export.md"]);
    expect((await item("acme", "articles/export.md")).status).toBe("active");
  });

  test("two trusted answers that disagree both need a check", async () => {
    const pairs = await checkConflicts("acme", ["articles/export.md"], {
      classify: stub("disagree").classify,
      today: TODAY,
    });
    expect(pairs).toEqual([
      { a: "articles/export.md", b: "articles/export-old.md" },
    ]);
    const a = await item("acme", "articles/export.md");
    const b = await item("acme", "articles/export-old.md");
    expect(a.status).toBe("needs-check");
    expect(a.check).toEqual({
      reason: "Disagrees with Export a project to CSV",
      since: TODAY,
      conflictWith: "articles/export-old.md",
    });
    expect(b.status).toBe("needs-check");
    expect(b.check).toEqual({
      reason: "Disagrees with Exporting a project as CSV",
      since: TODAY,
      conflictWith: "articles/export.md",
    });
    const [last] = await knowledgeRepo.call("history", "acme");
    expect(last!.author).toBe("Pat");
    expect(last!.body).toContain("Suggested-by: Pat");
  });

  test("an item that changed is not compared with reference items", async () => {
    await seed("acme-ref", [
      {
        op: "put",
        path: "articles/refunds.md",
        fm: fm({ title: "Refund timing", topics: ["refunds"] }),
        body: "Refunds take five days.\n",
      },
      {
        op: "put",
        path: "sources/mail/2026-10/m1@example.test.md",
        fm: fm({
          title: "Refund timing question",
          topics: ["refunds"],
          trust: "reference",
          origin: "mail",
          answeredAt: "2026-10-19T08:12:00Z",
        }),
        body: "Refunds take ten days.\n",
      },
    ]);
    const model = stub("disagree");
    const pairs = await checkConflicts("acme-ref", ["articles/refunds.md"], {
      classify: model.classify,
      today: TODAY,
    });
    expect(pairs).toEqual([]);
    expect(model.calls).toEqual([]);
    expect((await item("acme-ref", "articles/refunds.md")).status).toBe(
      "active",
    );
  });

  test(`at most ${MAX_CONFLICT_CALLS} pairs are classified per run`, async () => {
    const paths: string[] = [];
    const changes: KnowledgeChange[] = [];
    for (let n = 1; n <= 12; n++) {
      const path = `articles/invoice-${n}.md`;
      paths.push(path);
      changes.push({
        op: "put",
        path,
        fm: fm({ title: `Invoice question ${n}`, topics: ["invoice"] }),
        body: `Invoices are sent on day ${n}.\n`,
      });
    }
    await seed("acme-cap", changes);
    const model = stub("agree");
    const unchecked: string[] = [];
    await checkConflicts("acme-cap", paths, {
      classify: model.classify,
      today: TODAY,
      onUnchecked: (path) => unchecked.push(path),
    });
    expect(MAX_CONFLICT_CALLS).toBe(20);
    expect(model.calls.length).toBe(20);
    // The ones the budget didn't reach are retried next run.
    expect(unchecked.length).toBeGreaterThan(0);
  });
});
