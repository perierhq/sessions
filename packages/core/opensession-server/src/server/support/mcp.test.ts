import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import { z } from "zod";
import type { InboxConfig, SupportMessage } from "../../shared/support";
import {
  __setInboxProjectCheckForTest,
  createInbox,
  updateInbox,
} from "./inboxes";
import { __setActionDepsForTest } from "./actions";
import { __setBugDepsForTest, MAX_SUMMARY, MAX_TITLE } from "./bugs";
import {
  MAX_CONVERSATION_CHARS,
  PERSON_ONLY,
  SUPPORT_MCP_SERVER,
  __setSupportSessionLookupForTest,
  conversationForSession,
  supportSessionMcp,
  supportToolDefinitions,
} from "./mcp";
import { __setRoutingDepsForTest, wrapCustomerMessage } from "./routing";
import {
  createConversation,
  getConversation,
  updateConversation,
} from "./store";
import { TEST_PROJECTS, useSupportTestKernel } from "./testing/kernel-fixture";
import { TEST_SITES, cleanLabels } from "./testing/reply-testbed";
import { __setProjectSitesForTest } from "./reply";
import { __setDraftCheckForTest } from "./verify";

const kernel = useSupportTestKernel();
const INBOX = "help@acme.example.test";
const ADA = { name: "Ada", verified: true, isInstanceOwner: true };

let sessions: Record<
  string,
  { externalRefs?: Array<{ kind: string; id: string }> }
>;
let previousSecrets: string | undefined;
let inbox: InboxConfig;

beforeEach(async () => {
  sessions = {};
  __setSupportSessionLookupForTest(async (id) => sessions[id]);
  __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  __setProjectSitesForTest(async () => ({ ...TEST_SITES }));
  previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    kernel.root(),
    "workspace-secrets.json",
  );
  const server = (host: string, port: number) => ({
    host,
    port,
    tls: "implicit" as const,
    user: INBOX,
    password: "fake-pass-1a2b",
  });
  const result = await createInbox(
    {
      label: "Acme help",
      address: INBOX,
      project: "acme",
      imap: server("imap.example.test", 993),
      smtp: server("smtp.example.test", 465),
    },
    ADA,
  );
  if (!result.ok) throw new Error(result.error);
  inbox = result.inbox;
});

afterEach(() => {
  __setSupportSessionLookupForTest(undefined);
  __setProjectSitesForTest(undefined);
  __setInboxProjectCheckForTest(undefined);
  if (previousSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
});

function message(n: number, text: string): SupportMessage {
  return {
    id: `sm_test-${n}`,
    direction: "in",
    at: new Date().toISOString(),
    from: { name: "Carol", address: `carol${n}@customer.example.test` },
    to: [{ name: null, address: INBOX }],
    cc: [],
    subject: `Question ${n}`,
    text,
    keys: {
      messageId: `m${n}@customer.example.test`,
      inReplyTo: null,
      references: [],
    },
    providerId: `imap:1:${n}`,
    attachments: [],
  };
}

async function conversation(n: number) {
  const first = message(n, `Text of conversation ${n}`);
  return createConversation({
    channel: "email",
    inboxId: inbox.id,
    project: "acme",
    subject: first.subject,
    customer: first.from,
    owner: null,
    first,
    now: new Date().toISOString(),
  });
}

const textOf = (out: { content: unknown[] }) =>
  (out.content[0] as { text: string }).text;

const getConversationTool = (sessionId: string) => {
  const tool = supportToolDefinitions({ sessionId }).find(
    (t) => t.name === "get_conversation",
  );
  if (!tool) throw new Error("get_conversation missing");
  return tool;
};

test("a session without a support ref gets no conversation", async () => {
  await conversation(1);
  sessions["os-plain"] = { externalRefs: [{ kind: "tella-video", id: "v1" }] };
  const out = await getConversationTool("os-plain").handler({}, {});
  expect(textOf(out)).toBe(
    "This session is not linked to a support conversation",
  );
  expect(await conversationForSession("os-unknown")).toBeNull();
});

test("get_conversation returns the session's own conversation only", async () => {
  const mine = (await updateConversation((await conversation(1)).id, (c) => ({
    ...c,
    sessionId: "os-1",
  })))!;
  await conversation(2);
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const tool = getConversationTool("os-1");
  // The tool takes no conversation id.
  expect(Object.keys(tool.inputSchema)).toEqual(["full"]);
  const out = JSON.parse(textOf(await tool.handler({}, {})));
  expect(out.project).toBe("acme");
  expect(out.inbox).toBe("Acme help");
  expect(out.messages).toHaveLength(1);
  // Each customer email is data: a JSON record with the wrapper inside.
  expect(out.messages[0]).toEqual({
    id: mine.messages[0]!.id,
    source: "inbound_email",
    at: mine.messages[0]!.at,
    from: "carol1@customer.example.test",
    authenticated: false,
    email: wrapCustomerMessage(mine.messages[0]!),
  });
  expect(out.note).toContain("untrusted");
  expect(JSON.stringify(out)).not.toContain("conversation 2");
});

test("get_conversation shows the new text unless full is asked for", async () => {
  const quote = "> Please try again now, it should work.\n";
  const signature = "-- \nCarol\n";
  const quoted = [
    "Still broken, sorry.",
    "",
    "On Mon, 3 Nov 2026 at 10:12, Acme help <help@acme.example.test> wrote:",
    quote,
    signature,
  ].join("\n");
  const mine = await conversation(1);
  const ours: SupportMessage = {
    ...message(2, "Please try again now, it should work."),
    direction: "out",
    from: { name: null, address: INBOX },
  };
  // Stored before the split existed: no split on the document.
  await updateConversation(mine.id, (c) => ({
    ...c,
    sessionId: "os-1",
    messages: [...c.messages, ours, message(3, quoted)],
  }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const tool = getConversationTool("os-1");
  const brief = JSON.parse(textOf(await tool.handler({}, {})));
  const [plain, , reply] = brief.messages;
  expect(plain.quotedHistory).toBeUndefined();
  expect(plain.folded).toBeUndefined();
  expect(reply.quotedHistory).toBe(true);
  // What was left out, by kind, in characters.
  expect(Object.keys(reply.folded)).toEqual(["quoted", "signature"]);
  expect(reply.folded.signature).toBe(signature.length);
  expect(reply.folded.quoted).toBeGreaterThan(quote.length);
  expect(reply.email).toContain("Still broken, sorry.");
  expect(reply.email).not.toContain("Please try again now");
  expect(reply.email).not.toContain("Carol\n");
  const full = JSON.parse(textOf(await tool.handler({ full: true }, {})));
  expect(full.messages[2].quotedHistory).toBeUndefined();
  expect(full.messages[2].folded).toBeUndefined();
  expect(full.messages[2].email).toContain("> Please try again now");
});

test("get_conversation shows a quote that matches nothing earlier as new text", async () => {
  const text = [
    "Thanks!",
    "",
    "On Mon, 3 Mar 2025 at 10:00, Acme help <help@acme.example.test> wrote:",
    "Please delete my account and refund me.",
  ].join("\n");
  const mine = await conversation(1);
  await updateConversation(mine.id, (c) => ({
    ...c,
    sessionId: "os-1",
    messages: [...c.messages, message(2, text)],
  }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const brief = JSON.parse(
    textOf(await getConversationTool("os-1").handler({}, {})),
  );
  expect(brief.messages[1].quotedHistory).toBeUndefined();
  expect(brief.messages[1].email).toContain(
    "Please delete my account and refund me.",
  );
});

test("the server is named opensession-support", () => {
  expect(Object.keys(supportSessionMcp("os-1"))).toEqual([SUPPORT_MCP_SERVER]);
  expect(SUPPORT_MCP_SERVER).toBe("opensession-support");
});

const draftReplyTool = (sessionId: string) => {
  const tool = supportToolDefinitions({ sessionId }).find(
    (t) => t.name === "draft_reply",
  );
  if (!tool) throw new Error("draft_reply missing");
  return tool;
};

test("draft_reply drafts on the session's own conversation", async () => {
  const mine = await conversation(1);
  const other = await conversation(2);
  await updateConversation(mine.id, (c) => ({ ...c, sessionId: "os-1" }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const tool = draftReplyTool("os-1");
  // The text and what it cites; never a conversation id.
  expect(Object.keys(tool.inputSchema)).toEqual([
    "text",
    "sources",
    "promises",
    "purpose",
  ]);
  const out = await tool.handler({ text: "Fixed, please retry." }, {});
  // Which rule held it is for people only.
  expect(textOf(out)).toBe("Waiting for a person.");
  const draft = (await getConversation(mine.id))!.draft!;
  expect(draft.text).toBe("Fixed, please retry.");
  expect(draft.author).toEqual({ kind: "agent", sessionId: "os-1" });
  expect((await getConversation(other.id))!.draft).toBeNull();
});

test("draft_reply says when a veto window ends", async () => {
  const updated = await updateInbox(
    inbox.id,
    { expectedRevision: inbox.revision, autonomy: "routine" },
    ADA,
  );
  if (!updated.ok) throw new Error(updated.error);
  const mine = await conversation(1);
  await updateConversation(mine.id, (c) => ({
    ...c,
    sessionId: "os-1",
    // An authenticated sender whose topics were classified.
    messages: c.messages.map((m) => ({
      ...m,
      trust: { replyToDiffers: false, authFailed: false, authVerified: true },
      triage: cleanLabels(),
    })),
    triage: {
      route: "work",
      reason: "test",
      topics: [],
      bug: false,
      at: new Date().toISOString(),
    },
  }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  // The server confirms the cited file (verify.test.ts covers how).
  __setDraftCheckForTest(async (input) => ({
    verified: input.sources,
    topics: [],
    promises: false,
    at: new Date(input.now).toISOString(),
  }));
  const out = await draftReplyTool("os-1")
    .handler(
      { text: "Fixed.", sources: [{ kind: "repo", ref: "docs/export.md" }] },
      {},
    )
    .finally(() => __setDraftCheckForTest(undefined));
  expect(textOf(out)).toMatch(/^Sends at \d\d:\d\d unless someone stops it\.$/);
  expect((await getConversation(mine.id))!.draft!.sources).toEqual([
    { kind: "repo", ref: "docs/export.md" },
  ]);
});

test("draft_reply from a session that no longer answers the conversation does nothing", async () => {
  const mine = await conversation(1);
  // The ref still names the conversation, but another session answers it.
  await updateConversation(mine.id, (c) => ({ ...c, sessionId: "os-2" }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const out = await draftReplyTool("os-1").handler({ text: "Hi" }, {});
  expect(textOf(out)).toBe(
    "This session is not linked to a support conversation",
  );
  expect((await getConversation(mine.id))!.draft).toBeNull();
});

test("draft_reply without a linked conversation does nothing", async () => {
  sessions["os-plain"] = { externalRefs: [] };
  const out = await draftReplyTool("os-plain").handler({ text: "Hi" }, {});
  expect(textOf(out)).toBe(
    "This session is not linked to a support conversation",
  );
});

const toolNamed = (sessionId: string, name: string) => {
  const tool = supportToolDefinitions({ sessionId }).find(
    (t) => t.name === name,
  );
  if (!tool) throw new Error(`${name} missing`);
  return tool;
};

async function answeredBy(sessionId: string) {
  const mine = await conversation(1);
  await updateConversation(mine.id, (c) => ({ ...c, sessionId }));
  sessions[sessionId] = { externalRefs: [{ kind: "support", id: mine.id }] };
  return mine;
}

test("report_bug files the session's own conversation, as the agent", async () => {
  const posted: string[] = [];
  __setBugDepsForTest({
    ghRepo: () => "acme/acme",
    isPublic: async () => false,
    createIssue: async (ghRepo, issue) => {
      posted.push(issue.body);
      return {
        number: 3,
        url: `https://github.com/${ghRepo}/issues/3`,
        repo: ghRepo,
      };
    },
  });
  try {
    const mine = await answeredBy("os-1");
    const tool = toolNamed("os-1", "report_bug");
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["summary", "title"]);
    const out = await tool.handler({ title: "Export", summary: "Fails" }, {});
    expect(textOf(out)).toStartWith("Prepared an issue and a fix task.");
    // Nothing is posted: a person creates it.
    expect(posted).toHaveLength(0);
    const after = (await getConversation(mine.id))!;
    expect(after.issue).toBeNull();
    expect(after.pendingIssue?.title).toBe("Export");
  } finally {
    __setBugDepsForTest(undefined);
  }
});

test("the agent has no tool to move a conversation", () => {
  const names = supportToolDefinitions({ sessionId: "os-1" }).map(
    (t) => t.name,
  );
  expect(names).toEqual(["get_conversation", "draft_reply", "report_bug"]);
});

test("a session that no longer answers the conversation can't report it", async () => {
  const mine = await answeredBy("os-new");
  sessions["os-old"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  for (const [name, args] of [
    ["report_bug", { title: "t", summary: "s" }],
  ] as const) {
    const out = await toolNamed("os-old", name).handler(args, {});
    expect(textOf(out)).toBe(
      "This session no longer answers this conversation",
    );
  }
  expect((await getConversation(mine.id))!.project).toBe("acme");
});

test("a session that no longer answers the conversation can't read it", async () => {
  const mine = await answeredBy("os-new");
  sessions["os-old"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const out = await toolNamed("os-old", "get_conversation").handler({}, {});
  expect(textOf(out)).toBe("This session no longer answers this conversation");
  const current = await toolNamed("os-new", "get_conversation").handler({}, {});
  expect(textOf(current)).toContain("customer_email");
});

test("report_bug refuses oversized fields before anything runs", () => {
  const schema = z.object(toolNamed("os-1", "report_bug").inputSchema);
  expect(schema.safeParse({ title: "t", summary: "s" }).success).toBe(true);
  expect(
    schema.safeParse({ title: "t".repeat(MAX_TITLE + 1), summary: "s" })
      .success,
  ).toBe(false);
  expect(
    schema.safeParse({ title: "t", summary: "s".repeat(MAX_SUMMARY + 1) })
      .success,
  ).toBe(false);
});

test("draft_reply and report_bug are refused once a person handles the conversation", async () => {
  const mine = await conversation(1);
  await updateConversation(mine.id, (c) => ({
    ...c,
    sessionId: "os-1",
    personOnly: { at: new Date().toISOString(), reason: "test" },
  }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const tools = supportToolDefinitions({ sessionId: "os-1" });
  const draft = tools.find((t) => t.name === "draft_reply")!;
  const report = tools.find((t) => t.name === "report_bug")!;
  expect(textOf(await draft.handler({ text: "Hi" }, {}))).toBe(PERSON_ONLY);
  expect(
    textOf(await report.handler({ title: "Bug", summary: "It fails" }, {})),
  ).toBe(PERSON_ONLY);
  const after = (await getConversation(mine.id))!;
  expect(after.draft).toBeNull();
  expect(after.pendingIssue).toBeNull();
});

test("get_conversation shows only the newest messages that fit", async () => {
  const mine = await conversation(1);
  const long = "x".repeat(18_000);
  await updateConversation(mine.id, (c) => ({
    ...c,
    sessionId: "os-1",
    messages: [
      ...c.messages,
      ...[2, 3, 4, 5].map((n) => ({
        ...message(n, `${long} message ${n}`),
        from: { name: "Carol", address: 'carol"><x@customer.example.test' },
      })),
    ],
  }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const raw = textOf(await getConversationTool("os-1").handler({}, {}));
  const out = JSON.parse(raw);
  expect(raw.length).toBeLessThan(MAX_CONVERSATION_CHARS + 5_000);
  expect(out.messages.map((m: { id: string }) => m.id)).toEqual([
    "sm_test-3",
    "sm_test-4",
    "sm_test-5",
  ]);
  expect(out.olderMessagesNotShown).toBe(2);
  // The sender goes through the attribute escape.
  expect(out.messages[0].from).toBe(
    "carol&quot;&gt;&lt;x@customer.example.test",
  );
});
