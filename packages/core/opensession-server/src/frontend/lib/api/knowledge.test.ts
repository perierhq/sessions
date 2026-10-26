import { afterEach, beforeEach, expect, test } from "bun:test";
import type { KnowledgeFrontMatter } from "../../../shared/knowledge";
import {
  approveSuggestions,
  attachKnowledgeFile,
  canAttachTo,
  fetchNeedsCheck,
  fetchNeedsCheckChange,
  saveKnowledgeItem,
  type KnowledgeNeedsCheckChange,
} from "./knowledge";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const calls: Array<{ url: string; body?: string }> = [];
/** What a stubbed route answers: the JSON the server would send. */
type Answer =
  | { items: Array<{ path: string }> }
  | { item: { path: string }; body: string; change: KnowledgeNeedsCheckChange }
  | { path: string; commit: string | null }
  | { commit: string | null; approved?: string[] }
  | Record<string, never>;

/** Answer every request with `body`, recording what was sent. */
function serve(body: Answer) {
  calls.length = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // SAFETY: the JSON calls send a string body; uploads send FormData,
      // which these tests never read back (String() of it is unused).
      const sent = init?.body == null ? undefined : String(init.body);
      calls.push({ url: String(input), body: sent });
      return Response.json(body);
    },
    { preconnect: originalFetch.preconnect },
  );
}

beforeEach(() => serve({}));

const fm: KnowledgeFrontMatter = {
  title: "Exporting a project as CSV",
  kind: "answer",
  trust: "trusted",
  status: "active",
  origin: "suggestion",
  topics: [],
  sources: [],
  dependsOn: [],
  validAsOf: "2026-10-26",
  approvedBy: "Ada",
};

const sent = (n = 0) => JSON.parse(calls[n]!.body ?? "null");

test("a save never sends origin or approvedBy", async () => {
  await saveKnowledgeItem("acme", {
    fm,
    body: "Text",
    path: "articles/export.md",
    expectedBlob: "b".repeat(40),
  });
  expect(calls[0]!.url).toEndWith("/api/knowledge/acme/item");
  const body = sent();
  expect(body.fm.origin).toBeUndefined();
  expect(body.fm.approvedBy).toBeUndefined();
  expect(body.fm.title).toBe(fm.title);
  expect(body.expectedBlob).toBe("b".repeat(40));
});

test("a new article sends no path or expected blob", async () => {
  await saveKnowledgeItem("acme", { fm, body: "Text" });
  expect(Object.keys(sent()).sort()).toEqual(["body", "fm"]);
});

test("approve edits drop origin and approvedBy", async () => {
  await approveSuggestions("acme", ["suggestions/a.md"], {
    "suggestions/a.md": { fm, body: "Edited" },
  });
  const body = sent();
  expect(body.paths).toEqual(["suggestions/a.md"]);
  expect(body.edits["suggestions/a.md"].fm.origin).toBeUndefined();
  expect(body.edits["suggestions/a.md"].fm.approvedBy).toBeUndefined();
  await approveSuggestions("acme", ["suggestions/a.md"]);
  expect(sent(1)).toEqual({ paths: ["suggestions/a.md"] });
});

test("needs-check: the list, then what changed per item", async () => {
  serve({ items: [{ path: "articles/a.md" }] });
  const items = await fetchNeedsCheck("acme");
  expect(items.map((i) => i.path)).toEqual(["articles/a.md"]);
  expect(calls[0]!.url).toEndWith("/api/knowledge/acme/needs-check");
  serve({
    item: { path: "articles/a b.md" },
    body: "Export it.\n",
    change: { kind: "repo", title: "docs changed", patch: "+x" },
  });
  const read = await fetchNeedsCheckChange("acme", "articles/a b.md");
  expect(read.item.path).toBe("articles/a b.md");
  expect(read.body).toBe("Export it.\n");
  expect(read.change.patch).toBe("+x");
  expect(calls[0]!.url).toEndWith(
    "/api/knowledge/acme/needs-check/item?path=articles%2Fa+b.md",
  );
});

test("attachments go only on articles and suggestions", async () => {
  expect(canAttachTo("articles/a.md")).toBe(true);
  expect(canAttachTo("suggestions/a.md")).toBe(true);
  expect(canAttachTo("sources/mail/2026-10/a.md")).toBe(false);
  expect(canAttachTo("articles/../KNOWLEDGE.md")).toBe(false);
  const file = new File(["x"], "a.png", { type: "image/png" });
  await expect(
    attachKnowledgeFile("acme", "sources/web/a.md", file),
  ).rejects.toThrow("Files can be attached to articles and suggestions");
  expect(calls).toHaveLength(0);
  serve({ path: "attachments/a/a.png", commit: null });
  await attachKnowledgeFile("acme", "articles/a.md", file);
  expect(calls[0]!.url).toEndWith("/api/knowledge/acme/attachments");
});
