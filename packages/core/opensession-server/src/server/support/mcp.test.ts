import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import type { InboxConfig, SupportMessage } from "../../shared/support";
import { __setInboxProjectCheckForTest, createInbox } from "./inboxes";
import {
  SUPPORT_MCP_SERVER,
  __setSupportSessionLookupForTest,
  conversationForSession,
  supportSessionMcp,
  supportToolDefinitions,
} from "./mcp";
import { wrapCustomerMessage } from "./routing";
import { createConversation } from "./store";
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
