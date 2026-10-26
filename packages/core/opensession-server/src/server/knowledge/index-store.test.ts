import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KnowledgeFrontMatter,
  KnowledgeItem,
} from "../../shared/knowledge";
import { KnowledgeIndex } from "./index-store";

const COMMIT = "3f2a1b0c9d8e7f60514233445566778899aabbcc";
const TODAY = "2026-10-26";

function item(
  path: string,
  fm: Partial<KnowledgeFrontMatter>,
  project = "acme",
): KnowledgeItem {
  const full: KnowledgeFrontMatter = {
    title: "Untitled",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: path.startsWith("suggestions/")
      ? "suggestion"
      : path.startsWith("sources/mail/")
        ? "mail"
        : "article",
    topics: [],
    sources: [],
    dependsOn: [],
    validAsOf: "2026-10-01",
    ...fm,
  };
  return {
    ...full,
    project,
    path,
    blob: `blob-${path}`,
    commit: COMMIT,
    updatedAt: "2026-10-20T10:00:00.000Z",
    effective: full.status,
    excerpt: "",
  };
}

let dir: string;
let index: KnowledgeIndex;

const items: KnowledgeItem[] = [
  item("articles/export.md", {
    title: "Exporting a project",
    topics: ["export"],
    validAsOf: "2026-09-01",
  }),
  item("articles/export-new.md", {
    title: "Exporting a project, new flow",
    topics: ["export"],
    validAsOf: "2026-10-10",
  }),
  item("sources/mail/2026-09/ref.md", {
    title: "Export csv export csv export csv",
    trust: "reference",
    origin: "mail",
    topics: ["export", "csv"],
    answeredAt: "2026-09-02T10:00:00Z",
    validAsOf: "2026-10-20",
  }),
  item("articles/checking.md", {
    title: "Export csv answer that needs a check",
    topics: ["export", "csv"],
    status: "needs-check",
    check: { reason: "docs/export.md changed", since: "2026-10-25" },
    validAsOf: "2026-10-21",
  }),
  item("articles/old.md", {
    title: "Export csv retired",
    topics: ["export", "csv"],
    status: "retired",
    validAsOf: "2026-10-22",
  }),
  item("articles/overdue.md", {
    title: "Overdue export answer",
    reviewBy: "2026-10-01",
    dependsOn: ["repo:docs/"],
  }),
  item("articles/exact.md", {
    title: "Exact dependency",
    dependsOn: ["repo:docs/export.md", "issue:42"],
  }),
  item("articles/other.md", {
    title: "Other dependency",
    dependsOn: ["repo:docs/exports.md"],
  }),
  item("articles/note.md", {
    title: "Internal escalation note",
    kind: "internal",
  }),
  item("suggestions/proposal.md", {
    title: "Proposed answer",
    trust: "reference",
  }),
];

const bodies = new Map<string, string>([
  ["articles/export.md", "Open settings and choose export csv."],
  ["articles/export-new.md", "Use the new export button to get a csv."],
  ["sources/mail/2026-09/ref.md", "Export csv export csv export csv."],
  ["articles/checking.md", "Export csv from the old menu."],
  ["articles/old.md", "Export csv the retired way."],
  ["articles/overdue.md", "Some text."],
  ["articles/exact.md", "Some text."],
  ["articles/other.md", "Some text."],
  ["articles/note.md", "Escalate billing issues to the on-call engineer."],
  ["suggestions/proposal.md", "Maybe this."],
]);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "knowledge-index-"));
  index = new KnowledgeIndex(join(dir, "index.sqlite"));
  index.replaceProject("acme", COMMIT, items, bodies, null);
  index.replaceProject(
    "acme-api",
    COMMIT,
    [item("articles/api.md", { title: "API keys" }, "acme-api")],
    new Map([["articles/api.md", "Rotate api keys in settings."]]),
    null,
  );
});

afterAll(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

describe("KnowledgeIndex", () => {
  test("head, get and body", () => {
    expect(index.head("acme")).toBe(COMMIT);
    expect(index.head("nobody")).toBeNull();
    const got = index.get("acme", "articles/export.md");
    expect(got?.title).toBe("Exporting a project");
    expect(got?.blob).toBe("blob-articles/export.md");
    expect(got?.excerpt).toContain("Open settings");
    expect(index.body("acme", "articles/export.md")).toBe(
      "Open settings and choose export csv.",
    );
    expect(index.get("acme", "articles/missing.md")).toBeNull();
    expect(index.body("acme", "articles/missing.md")).toBeNull();
  });

  test("search puts trusted active before needs-check and reference", () => {
    const hits = index.search("acme", "export csv", { today: TODAY });
    const paths = hits.map((hit) => hit.item.path);
    expect(paths.slice(0, 2).sort()).toEqual([
      "articles/export-new.md",
      "articles/export.md",
    ]);
    expect(paths.indexOf("articles/checking.md")).toBe(2);
    expect(paths.indexOf("sources/mail/2026-09/ref.md")).toBeGreaterThan(
      paths.indexOf("articles/checking.md"),
    );
    expect(
      hits.find((h) => h.item.path === "articles/checking.md")?.item,
    ).toMatchObject({ effective: "needs-check" });
  });

  test("of two trusted answers the newer validAsOf ranks first", () => {
    const paths = index
      .search("acme", "exporting project", { today: TODAY })
      .map((hit) => hit.item.path);
    expect(paths.slice(0, 2)).toEqual([
      "articles/export-new.md",
      "articles/export.md",
    ]);
  });

  test("a sentence with words no item holds falls back to any term", () => {
    const paths = index
      .search("acme", "when should we escalate", { today: TODAY })
      .map((hit) => hit.item.path);
    expect(paths).toEqual(["articles/note.md"]);
  });

  test("retired items are not searched but are listed under retired", () => {
    const searched = index
      .search("acme", "retired", { today: TODAY })
      .map((hit) => hit.item.path);
    expect(searched).not.toContain("articles/old.md");
    const retired = index.list("acme", "retired");
    expect(retired.items.map((i) => i.path)).toEqual(["articles/old.md"]);
    expect(retired.total).toBe(1);
    expect(index.list("acme", "all").items.map((i) => i.path)).not.toContain(
      "articles/old.md",
    );
  });

  test("anyTerm skips the all-terms pass", () => {
    // Only the new-flow article holds both words; with anyTerm the items
    // holding one of them come back too.
    const all = index
      .search("acme", "flow csv", { today: TODAY })
      .map((hit) => hit.item.path);
    expect(all).toEqual(["articles/export-new.md"]);
    const any = index
      .search("acme", "flow csv", { today: TODAY, anyTerm: true })
      .map((hit) => hit.item.path);
    expect(any[0]).toBe("articles/export-new.md");
    expect(any).toContain("articles/export.md");
    expect(any).toContain("articles/checking.md");
  });

  test("exclude leaves one path out of both passes", () => {
    const all = index
      .search("acme", "exporting project", {
        today: TODAY,
        exclude: "articles/export-new.md",
      })
      .map((hit) => hit.item.path);
    expect(all).toEqual(["articles/export.md"]);
    const any = index
      .search("acme", "flow csv", {
        today: TODAY,
        anyTerm: true,
        exclude: "articles/export.md",
      })
      .map((hit) => hit.item.path);
    expect(any).not.toContain("articles/export.md");
    expect(any.length).toBeGreaterThan(0);
  });

  test("includeReference false leaves reference items out", () => {
    const paths = index
      .search("acme", "export csv", { today: TODAY, includeReference: false })
      .map((hit) => hit.item.path);
    expect(paths).not.toContain("sources/mail/2026-09/ref.md");
  });

  test("list filters, query and paging", () => {
    expect(index.list("acme", "suggestions").items.map((i) => i.path)).toEqual([
      "suggestions/proposal.md",
    ]);
    expect(index.list("acme", "internal").items.map((i) => i.path)).toEqual([
      "articles/note.md",
    ]);
    const queried = index.list("acme", "all", { query: "escalate" });
    expect(queried.items.map((i) => i.path)).toEqual(["articles/note.md"]);
    const page = index.list("acme", "all", { limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(9);
  });

  test("counts put an overdue reviewBy under needs-check, not answer", () => {
    const counts = index.counts("acme", TODAY);
    const answers = index.list("acme", "answer").items.map((i) => i.path);
    expect(answers).not.toContain("articles/overdue.md");
    expect(counts.answer).toBe(answers.length);
    expect(counts["needs-check"]).toBe(2);
    expect(counts.retired).toBe(1);
    expect(counts.internal).toBe(1);
    expect(counts.suggestions).toBe(1);
    expect(counts.reference).toBe(1);
    expect(counts.all).toBe(9);
    expect(
      index
        .search("acme", "overdue", { today: TODAY })
        .map((hit) => hit.item.effective),
    ).toEqual(["needs-check"]);
  });

  test("dependents follow repo prefixes and exact paths", () => {
    const paths = index
      .dependents("acme", {
        type: "repo",
        path: "docs/export.md",
        prefix: false,
      })
      .map((i) => i.path)
      .sort();
    expect(paths).toEqual(["articles/exact.md", "articles/overdue.md"]);
    expect(
      index
        .dependents("acme", { type: "issue", number: 42 })
        .map((i) => i.path),
    ).toEqual(["articles/exact.md"]);
    const folder = index
      .dependents("acme", { type: "repo", path: "docs/", prefix: true })
      .map((i) => i.path)
      .sort();
    expect(folder).toEqual([
      "articles/exact.md",
      "articles/other.md",
      "articles/overdue.md",
    ]);
  });

  test("internalBodies returns only internal items", () => {
    expect(index.internalBodies("acme")).toEqual([
      {
        path: "articles/note.md",
        title: "Internal escalation note",
        body: "Escalate billing issues to the on-call engineer.",
      },
    ]);
  });

  test("projects are isolated", () => {
    expect(index.search("acme-api", "export csv", { today: TODAY })).toEqual(
      [],
    );
    expect(
      index
        .search("acme", "api keys", { today: TODAY })
        .map((h) => h.item.path),
    ).toEqual([]);
    expect(
      index
        .search("acme-api", "api keys", { today: TODAY })
        .map((h) => h.item.path),
    ).toEqual(["articles/api.md"]);
  });

  test("replaceProject drops items that are gone", () => {
    expect(
      index.replaceProject("acme-api", "a".repeat(40), [], new Map(), COMMIT),
    ).toBe(true);
    expect(index.head("acme-api")).toBe("a".repeat(40));
    expect(index.list("acme-api", "all", { today: TODAY }).total).toBe(0);
    expect(index.list("acme", "all", { today: TODAY }).total).toBe(9);
  });

  test("replaceProject refuses when the head moved since the caller read it", () => {
    const head = index.head("acme-api");
    expect(
      index.replaceProject(
        "acme-api",
        "b".repeat(40),
        [item("articles/stale.md", { title: "Stale" }, "acme-api")],
        new Map(),
        COMMIT,
      ),
    ).toBe(false);
    expect(index.head("acme-api")).toBe(head);
    expect(index.get("acme-api", "articles/stale.md", TODAY)).toBeNull();
  });

  test("stamps give each path's blob and first-indexed time", () => {
    expect(index.stamps("acme").get("articles/export.md")).toEqual({
      blob: "blob-articles/export.md",
      updatedAt: "2026-10-20T10:00:00.000Z",
    });
    expect(index.stamps("nobody").size).toBe(0);
  });

  test("FTS5 operators in a query are plain text and never throw", () => {
    for (const query of [
      "export AND csv",
      "NOT export",
      "export OR",
      "title:export",
      "exp*",
      "NEAR(export csv)",
      '"export',
      "(export",
      "^export",
      "-",
      "export + csv",
      "{title}: csv",
    ]) {
      expect(() => index.search("acme", query, { today: TODAY })).not.toThrow();
      expect(() =>
        index.list("acme", "all", { query, today: TODAY }),
      ).not.toThrow();
    }
    expect(
      index.search("acme", "title:escalate", { today: TODAY }).length,
    ).toBe(0);
  });

  test("an overdue reviewBy ranks with needs-check in search", () => {
    const paths = index
      .search("acme", "export", { today: TODAY })
      .map((hit) => hit.item.path);
    const overdue = paths.indexOf("articles/overdue.md");
    expect(overdue).toBeGreaterThan(paths.indexOf("articles/export.md"));
    expect(overdue).toBeGreaterThan(paths.indexOf("articles/export-new.md"));
    expect(overdue).toBeLessThan(paths.indexOf("sources/mail/2026-09/ref.md"));
    // The day before it was due, it is a trusted answer again.
    const early = index
      .search("acme", "export", { today: "2026-09-30" })
      .map((hit) => hit.item.path);
    expect(early.indexOf("articles/overdue.md")).toBeLessThan(
      early.indexOf("articles/checking.md"),
    );
  });

  test("every day-dependent call refuses a day that isn't YYYY-MM-DD", () => {
    expect(() => index.get("acme", "articles/export.md", "today")).toThrow();
    expect(() => index.list("acme", "all", { today: "2026-1-1" })).toThrow();
    expect(() =>
      index.dependents("acme", { type: "issue", number: 42 }, "x"),
    ).toThrow();
  });
});
