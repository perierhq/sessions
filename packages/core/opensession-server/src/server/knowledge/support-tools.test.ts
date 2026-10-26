import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeFrontMatter } from "../../shared/knowledge";
import type { SupportMessage } from "../../shared/support";
import {
  __resetSupportEvidenceForTest,
  sessionSawKnowledge,
} from "../support/evidence";
import {
  NOT_CURRENT,
  NOT_LINKED,
  __setSupportSessionLookupForTest,
} from "../support/mcp";
import { createConversation, updateConversation } from "../support/store";
import { useSupportTestKernel } from "../support/testing/kernel-fixture";
import { __setKnowledgeServiceForTest } from "./client";
import { KnowledgeService } from "./service";
import { knowledgeTools } from "./support-tools";

useSupportTestKernel();

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
let acmeHead: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "knowledge-tools-"));
  service = new KnowledgeService({ base });
  __setKnowledgeServiceForTest(service);
  await service.ensureRepo("acme");
  await service.ensureRepo("acme-api");
  await service.write(
    "acme-api",
    [
      {
        op: "put",
        path: "articles/export-api.md",
        fm: fm({ title: "Exporting through the API" }),
        body: "Call the export endpoint.\n",
      },
    ],
    { message: "Add API export", author: ADA },
  );
  acmeHead = (await service.write(
    "acme",
    [
      {
        op: "put",
        path: "articles/export.md",
        fm: fm(),
        body: "Open the project, choose Export, then CSV.\n",
      },
      {
        op: "put",
        path: "articles/export-limits.md",
        fm: fm({
          title: "Export limits",
          status: "needs-check",
          check: {
            reason: "docs/export.md changed in 9c1d2e0",
            since: "2026-10-26",
          },
        }),
        body: "An export holds at most 10 000 rows.\n",
      },
      {
        op: "put",
        path: "articles/export-internals.md",
        fm: fm({ title: "Export queue internals", kind: "internal" }),
        body: "Exports run on the worker queue; restart it when export hangs.\n",
      },
      {
        op: "put",
        path: "suggestions/export-pdf.md",
        fm: fm({
          title: "Exporting as PDF",
          trust: "reference",
          origin: "suggestion",
        }),
        body: "There is no PDF export yet.\n",
      },
    ],
    { message: "Add export articles", author: ADA },
  ))!;
});

afterAll(async () => {
  __setKnowledgeServiceForTest(null);
  service.close();
  await rm(base, { recursive: true, force: true });
});

let sessions: Record<
  string,
  { externalRefs?: Array<{ kind: string; id: string }> }
>;

function message(): SupportMessage {
  return {
    id: "sm_test-1",
    direction: "in",
    at: new Date().toISOString(),
    from: { name: "Carol", address: "carol@customer.example.test" },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Export",
    text: "How do I export my project?",
    keys: {
      messageId: "m1@customer.example.test",
      inReplyTo: null,
      references: [],
    },
    providerId: "imap:1:1",
    attachments: [],
  };
}

beforeEach(async () => {
  __resetSupportEvidenceForTest();
  sessions = {};
  __setSupportSessionLookupForTest(async (id) => sessions[id]);
  const first = message();
  const c = await createConversation({
    channel: "email",
    inboxId: "inbox-acme",
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: new Date().toISOString(),
  });
  await updateConversation(c.id, (x) => ({ ...x, sessionId: "s1" }));
  sessions.s1 = { externalRefs: [{ kind: "support", id: c.id }] };
  // Moved away: still carries the ref, no longer answers.
  sessions.s0 = { externalRefs: [{ kind: "support", id: c.id }] };
});

afterEach(() => {
  __setSupportSessionLookupForTest(undefined);
});

const textOf = (out: { content: unknown[] }) =>
  (out.content[0] as { text: string }).text;

function call(sessionId: string, name: string, args: Record<string, unknown>) {
  const tool = knowledgeTools({ sessionId }).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool.handler(args as never, {}).then(textOf);
}

test("the tools are search_knowledge and read_knowledge, scoped by the conversation", () => {
  const tools = knowledgeTools({ sessionId: "s1" });
  expect(tools.map((t) => t.name)).toEqual([
    "search_knowledge",
    "read_knowledge",
  ]);
  // The project is the conversation's, never an argument.
  expect(Object.keys(tools[0]!.inputSchema)).toEqual(["query", "limit"]);
  expect(Object.keys(tools[1]!.inputSchema)).toEqual(["path"]);
  for (const t of tools) {
    expect(t.description).toContain("trusted");
    expect(t.description).toContain("internal");
  }
});

test("search_knowledge lists the conversation project's items only", async () => {
  const out = await call("s1", "search_knowledge", { query: "export" });
  expect(out).toContain(
    `- knowledge:articles/export.md@${acmeHead.slice(0, 7)} · answer · trusted · active · valid as of 2026-10-20 — Exporting a project as CSV`,
  );
  expect(out).not.toContain("Exporting through the API");
  expect(out).not.toContain("export-api");
});

test("search_knowledge says why an item needs a check and marks internal items", async () => {
  const out = await call("s1", "search_knowledge", { query: "export" });
  const lines = out.split("\n");
  const limits = lines.findIndex((l) =>
    l.includes("articles/export-limits.md"),
  );
  expect(lines[limits]).toContain("· needs-check ·");
  expect(lines[limits + 1]).toBe(
    "  needs check: docs/export.md changed in 9c1d2e0",
  );
  const internal = lines.findIndex((l) =>
    l.includes("articles/export-internals.md"),
  );
  expect(lines[internal]).toContain("· internal ·");
  expect(lines[internal + 1]).toBe("  internal: steer by it, never quote it");
  const reference = lines.find((l) => l.includes("suggestions/export-pdf.md"));
  expect(reference).toContain("· reference ·");
});

test("search_knowledge records every item it printed, at the printed commit", async () => {
  await call("s1", "search_knowledge", { query: "export" });
  expect(
    sessionSawKnowledge("s1", "articles/export.md", acmeHead.slice(0, 7)),
  ).toBe(true);
  expect(sessionSawKnowledge("s1", "articles/export.md", acmeHead)).toBe(true);
  expect(sessionSawKnowledge("s0", "articles/export.md", acmeHead)).toBe(false);
});

test("search_knowledge says when nothing matches", async () => {
  expect(await call("s1", "search_knowledge", { query: "zebra" })).toBe(
    'No knowledge matches "zebra".',
  );
});

test("only the session that answers the conversation may search or read", async () => {
  expect(await call("s0", "search_knowledge", { query: "export" })).toBe(
    NOT_CURRENT,
  );
  expect(
    await call("s0", "read_knowledge", { path: "articles/export.md" }),
  ).toBe(NOT_CURRENT);
  expect(await call("s9", "search_knowledge", { query: "export" })).toBe(
    NOT_LINKED,
  );
});

test("read_knowledge shows the item and how to cite it", async () => {
  const out = await call("s1", "read_knowledge", {
    path: "articles/export.md",
  });
  expect(out).toContain("title: Exporting a project as CSV\n");
  expect(out).toContain("trust: trusted\n");
  expect(out).toContain("dependsOn: repo:docs/export.md\n");
  expect(out).toContain("\n\nOpen the project, choose Export, then CSV.\n");
  expect(out.endsWith(`Cite as knowledge:articles/export.md@${acmeHead}`)).toBe(
    true,
  );
  expect(acmeHead).toMatch(/^[0-9a-f]{40}$/);
  expect(sessionSawKnowledge("s1", "articles/export.md", acmeHead)).toBe(true);
});

test("read_knowledge marks an internal item", async () => {
  const out = await call("s1", "read_knowledge", {
    path: "articles/export-internals.md",
  });
  expect(out).toContain("internal: steer by it, never quote it");
});

test("read_knowledge refuses attachments and paths outside the items", async () => {
  for (const path of [
    "attachments/x/a.pdf",
    "../x",
    "KNOWLEDGE.md",
    "articles/../KNOWLEDGE.md",
  ]) {
    const out = await call("s1", "read_knowledge", { path });
    expect(out).toStartWith("Not a knowledge item");
    expect(sessionSawKnowledge("s1", path, acmeHead)).toBe(false);
  }
});

test("read_knowledge says when there is no such item", async () => {
  expect(
    await call("s1", "read_knowledge", { path: "articles/missing.md" }),
  ).toBe("No knowledge item at articles/missing.md.");
  // Another project's item is not this conversation's.
  expect(
    await call("s1", "read_knowledge", { path: "articles/export-api.md" }),
  ).toBe("No knowledge item at articles/export-api.md.");
});
