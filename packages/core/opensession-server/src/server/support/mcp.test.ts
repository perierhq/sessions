import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import type { InboxConfig, SupportMessage } from "../../shared/support";
import {
  __setInboxProjectCheckForTest,
  createInbox,
  updateInbox,
} from "./inboxes";
import { __setActionDepsForTest } from "./actions";
import { __setBugDepsForTest } from "./bugs";
import {
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
  const mine = await conversation(1);
  await conversation(2);
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const tool = getConversationTool("os-1");
  // The tool takes no conversation id.
  expect(Object.keys(tool.inputSchema)).toEqual([]);
  const out = JSON.parse(textOf(await tool.handler({}, {})));
  expect(out.project).toBe("acme");
  expect(out.inbox).toBe("Acme help");
  expect(out.messages).toHaveLength(1);
  expect(out.messages[0]).toBe(wrapCustomerMessage(mine.messages[0]));
  expect(JSON.stringify(out)).not.toContain("conversation 2");
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
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const tool = draftReplyTool("os-1");
  // Only the text; never a conversation id.
  expect(Object.keys(tool.inputSchema)).toEqual(["text"]);
  const out = await tool.handler({ text: "Fixed, please retry." }, {});
  expect(textOf(out)).toBe("Waiting for a person: Drafts wait for a person");
  const draft = (await getConversation(mine.id))!.draft!;
  expect(draft.text).toBe("Fixed, please retry.");
  expect(draft.author).toEqual({ kind: "agent", sessionId: "os-1" });
  expect((await getConversation(other.id))!.draft).toBeNull();
});

test("draft_reply says when a veto window ends", async () => {
  const updated = await updateInbox(
    inbox.id,
    { expectedRevision: inbox.revision, autonomy: "deploy-after-veto" },
    ADA,
  );
  if (!updated.ok) throw new Error(updated.error);
  const mine = await conversation(1);
  await updateConversation(mine.id, (c) => ({
    ...c,
    triage: {
      route: "work",
      reason: "test",
      topics: [],
      bug: false,
      at: new Date().toISOString(),
    },
  }));
  sessions["os-1"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  const out = await draftReplyTool("os-1").handler({ text: "Fixed." }, {});
  expect(textOf(out)).toMatch(/^Sends at \d\d:\d\d unless someone stops it\.$/);
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
      return { number: 3, url: `https://github.com/${ghRepo}/issues/3`, repo: ghRepo };
    },
  });
  try {
    const mine = await answeredBy("os-1");
    const tool = toolNamed("os-1", "report_bug");
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["summary", "title"]);
    const off = await tool.handler({ title: "Export", summary: "Fails" }, {});
    expect(textOf(off)).toBe(
      "Bug handling is off for this inbox, so no issue was created.",
    );
    const updated = await updateInbox(
      inbox.id,
      { expectedRevision: inbox.revision, bugHandling: "issue" },
      ADA,
    );
    if (!updated.ok) throw new Error(updated.error);
    const out = await tool.handler({ title: "Export", summary: "Fails" }, {});
    expect(textOf(out)).toBe("Created https://github.com/acme/acme/issues/3.");
    expect(posted).toHaveLength(1);
    expect((await getConversation(mine.id))!.issue?.number).toBe(3);
  } finally {
    __setBugDepsForTest(undefined);
  }
});

test("move_conversation moves the session's own conversation", async () => {
  const cancelled: string[] = [];
  __setActionDepsForTest({
    cancelSession: async (id) => {
      cancelled.push(id);
      return true;
    },
  });
  __setRoutingDepsForTest({
    runSpec: async () => ({
      model: "m",
      mcpServers: [],
      mode: "ask",
      sandbox: { ok: false, reason: "no place to run" },
    }),
  });
  try {
    const mine = await answeredBy("os-1");
    const tool = toolNamed("os-1", "move_conversation");
    expect(Object.keys(tool.inputSchema).sort()).toEqual(["project", "reason"]);
    const refused = await tool.handler({ project: "acme", reason: "x" }, {});
    expect(textOf(refused)).toStartWith("Not moved: ");
    const out = await tool.handler(
      { project: "acme-api", reason: "It's about the API" },
      {},
    );
    expect(textOf(out)).toBe("Moved to acme-api. This session stops here.");
    expect(cancelled).toEqual(["os-1"]);
    const moved = (await getConversation(mine.id))!;
    expect(moved.project).toBe("acme-api");
    expect(moved.moves[0]?.by).toEqual({ kind: "agent", sessionId: "os-1" });
  } finally {
    __setActionDepsForTest(undefined);
    __setRoutingDepsForTest(undefined);
  }
});

test("a session that no longer answers the conversation can't move or report it", async () => {
  const mine = await answeredBy("os-new");
  sessions["os-old"] = { externalRefs: [{ kind: "support", id: mine.id }] };
  for (const [name, args] of [
    ["move_conversation", { project: "acme-api", reason: "x" }],
    ["report_bug", { title: "t", summary: "s" }],
  ] as const) {
    const out = await toolNamed("os-old", name).handler(args, {});
    expect(textOf(out)).toBe(
      "This session no longer answers this conversation",
    );
  }
  expect((await getConversation(mine.id))!.project).toBe("acme");
});
