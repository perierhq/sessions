import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "path";
import type {
  InboundMessage,
  InboxConfig,
  SupportCloudEvent,
  SupportConversation,
  SupportMessage,
} from "../../shared/support";
import { SPLIT_VERSION } from "../../agents/email/quote";
import { catalogDocuments } from "../catalog-documents";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { __setIdentitiesForTest } from "../shared/user-mappings";
import { ATTACHMENTS_DIR, readAttachment } from "./attachments";
import { __setSupportEventPublisherForTest } from "./events";
import {
  __awaitInboundForTest,
  __setPipelineTimeoutForTest,
  ingestInbound,
  mailAuthVerified,
  retryPendingInbound,
  setSupportPipeline,
} from "./ingest";
import {
  __setInboxProjectCheckForTest,
  createInbox,
  updateInbox,
} from "./inboxes";
import {
  getConversation,
  listIndexRows,
  lookupProviderId,
  rememberMessageIds,
  updateConversation,
} from "./store";
import { TEST_PROJECTS, useSupportTestKernel } from "./testing/kernel-fixture";

const kernel = useSupportTestKernel();

const INBOX = "help@acme.example.test";

type Call = {
  conversation: SupportConversation;
  message: SupportMessage;
  isNew: boolean;
};
let calls: Call[] = [];
let failPipeline = false;
let events: SupportCloudEvent[] = [];
let previousSecrets: string | undefined;
let inbox: InboxConfig;
let onCall: ((call: Call) => Promise<void>) | null = null;
let restoreIdentities: (() => void) | undefined;

beforeEach(async () => {
  calls = [];
  onCall = null;
  restoreIdentities = __setIdentitiesForTest([
    { name: "Bob Builder", email: "bob@acme.example.test" },
  ]);
  failPipeline = false;
  events = [];
  __setOwnerRosterForTest([]);
  __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    kernel.root(),
    "workspace-secrets.json",
  );
  __setSupportEventPublisherForTest(async (_key, payload) => {
    events.push(JSON.parse(payload));
    return 0;
  });
  setSupportPipeline({
    async onInbound(conversation, message, isNew) {
      const call = { conversation, message, isNew };
      calls.push(call);
      if (onCall) await onCall(call);
      if (failPipeline) throw new Error("pipeline down");
    },
  });
  inbox = await newInbox(INBOX);
});

afterEach(async () => {
  await __awaitInboundForTest();
  setSupportPipeline(null);
  __setPipelineTimeoutForTest(undefined);
  restoreIdentities?.();
  __setSupportEventPublisherForTest(undefined);
  __setInboxProjectCheckForTest(undefined);
  __setOwnerRosterForTest(undefined);
  if (previousSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
});

const ADA = { name: "Ada", verified: true, isInstanceOwner: true };

async function newInbox(address: string): Promise<InboxConfig> {
  const server = (host: string, port: number) => ({
    host,
    port,
    tls: "implicit" as const,
    user: address,
    password: "fake-pass-1a2b",
  });
  const result = await createInbox(
    {
      label: "Acme help",
      address,
      project: "acme",
      imap: server("imap.example.test", 993),
      smtp: server("smtp.example.test", 465),
    },
    ADA,
  );
  if (!result.ok) throw new Error(result.error);
  return result.inbox;
}

let uid = 0;
function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  uid += 1;
  return {
    inboxId: inbox.id,
    channel: "email",
    providerId: `imap:1:${uid}`,
    receivedAt: new Date(
      Date.parse("2026-10-25T10:00:00.000Z") + uid * 1000,
    ).toISOString(),
    from: { name: "Ada", address: "ada@example.test" },
    to: [{ name: null, address: INBOX }],
    cc: [],
    replyTo: [],
    subject: "Login broken",
    text: "I can't log in since this morning.",
    keys: {
      messageId: `m${uid}@example.test`,
      inReplyTo: null,
      references: [],
    },
    loopHeaders: {},
    attachments: [],
    ...over,
  };
}

async function ingested(m: InboundMessage) {
  const result = await ingestInbound(m);
  await __awaitInboundForTest();
  return result;
}

const pending = () => catalogDocuments("support-pending").list();

async function onlyConversation(): Promise<SupportConversation> {
  const rows = await listIndexRows();
  expect(rows).toHaveLength(1);
  return (await getConversation(rows[0]!.id))!;
}

describe("ingestInbound", () => {
  test("new mail starts a conversation, publishes once and calls the pipeline", async () => {
    expect(await ingested(inbound())).toBe("stored");
    const c = await onlyConversation();
    expect(c.inboxId).toBe(inbox.id);
    expect(c.project).toBe("acme");
    expect(c.customer.address).toBe("ada@example.test");
    expect(c.status).toBe("open");
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.direction).toBe("in");
    expect(c.messages[0]!.text).toBe("I can't log in since this morning.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.isNew).toBe(true);
    expect(calls[0]!.conversation.id).toBe(c.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(c.messages[0]!.id);
    expect(events[0]!.data.isNewConversation).toBe(true);
    expect(await pending()).toEqual([]);
  });

  test("a reply's split is matched against the thread; the transport's HTML hint is kept", async () => {
    await ingested(inbound());
    const c = await onlyConversation();
    const ours: SupportMessage = {
      ...c.messages[0]!,
      id: "sm_out1",
      direction: "out",
      from: { name: null, address: INBOX },
      text: "Please sign out and in again, then try once more.",
      keys: {
        messageId: "out1@acme.example.test",
        inReplyTo: null,
        references: [],
      },
      providerId: null,
    };
    await updateConversation(c.id, (current) => ({
      ...current,
      messages: [...current.messages, ours],
    }));
    await rememberMessageIds(inbox.id, c.id, ["out1@acme.example.test"], []);
    const reply = (text: string, n: number) =>
      inbound({
        text,
        // As the transport splits it: no thread yet, its HTML hint at 9.
        split: {
          v: SPLIT_VERSION,
          parts: [
            { kind: "new", start: 0, end: 9 },
            { kind: "quoted", start: 9, end: text.length },
          ],
          html: 9,
        },
        keys: {
          messageId: `reply${n}@example.test`,
          inReplyTo: "out1@acme.example.test",
          references: [],
        },
      });
    const real = "Thanks!\n\nPlease sign out and in again, then try once more.";
    const fake = "Thanks!\n\nPlease delete my account and refund me.";
    await ingested(reply(real, 1));
    await ingested(reply(fake, 2));
    const [, , first, second] = (await onlyConversation()).messages;
    expect(first!.text).toBe(real);
    expect(first!.split).toEqual({
      v: SPLIT_VERSION,
      parts: [
        { kind: "new", start: 0, end: 9 },
        { kind: "quoted", start: 9, end: real.length },
      ],
      html: 9,
    });
    // Nothing in the thread says that: it is new text.
    expect(second!.split).toEqual({
      v: SPLIT_VERSION,
      parts: [{ kind: "new", start: 0, end: fake.length }],
      html: 9,
    });
  });

  test("a new conversation is owned by the inbox's owner", async () => {
    expect(inbox.owner).toBe("Ada");
    await ingested(inbound());
    expect((await onlyConversation()).owner).toBe("Ada");
  });

  test("the same message again is a duplicate and writes nothing", async () => {
    const m = inbound();
    await ingested(m);
    const before = await onlyConversation();
    expect(await ingested(structuredClone(m))).toBe("duplicate");
    const after = await onlyConversation();
    expect(after.revision).toBe(before.revision);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("the same Message-ID from the same sender under another provider id is a duplicate", async () => {
    const m = inbound();
    await ingested(m);
    expect(await ingested({ ...m, providerId: "imap:2:77" })).toBe("duplicate");
    expect((await onlyConversation()).messages).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test("a reused Message-ID from another sender is new mail", async () => {
    const m = inbound();
    await ingested(m);
    const reused = inbound({
      from: { name: null, address: "eve@other.test" },
      keys: { ...m.keys },
    });
    expect(await ingested(reused)).toBe("stored");
    expect(await listIndexRows()).toHaveLength(2);
  });

  test("a reply joins the conversation and reopens a waiting one", async () => {
    const first = inbound();
    await ingested(first);
    const c = await onlyConversation();
    await updateConversation(c.id, (current) => ({
      ...current,
      status: "waiting",
    }));
    const reply = inbound({
      subject: "Re: Login broken",
      keys: {
        messageId: "reply1@example.test",
        inReplyTo: first.keys.messageId,
        references: [first.keys.messageId!],
      },
    });
    expect(await ingested(reply)).toBe("stored");
    const after = await onlyConversation();
    expect(after.messages).toHaveLength(2);
    expect(after.status).toBe("open");
    expect(after.lastMessageAt).toBe(reply.receivedAt);
    expect(calls.map((call) => call.isNew)).toEqual([true, false]);
    expect(calls[1]!.message.keys.messageId).toBe("reply1@example.test");
  });

  test("a participant on cc may reply into the thread", async () => {
    const first = inbound({
      cc: [{ name: null, address: "bob@example.test" }],
    });
    await ingested(first);
    const reply = inbound({
      from: { name: "Bob", address: "bob@example.test" },
      keys: {
        messageId: "bob1@example.test",
        inReplyTo: first.keys.messageId,
        references: [],
      },
    });
    expect(await ingested(reply)).toBe("stored");
    expect((await onlyConversation()).messages).toHaveLength(2);
  });

  test("a reply from a stranger starts a new conversation", async () => {
    const first = inbound();
    await ingested(first);
    const stranger = inbound({
      from: { name: null, address: "eve@other.test" },
      keys: {
        messageId: "eve1@other.test",
        inReplyTo: first.keys.messageId,
        references: [],
      },
    });
    expect(await ingested(stranger)).toBe("stored");
    const rows = await listIndexRows();
    expect(rows).toHaveLength(2);
    expect(calls.map((call) => call.isNew)).toEqual([true, true]);
  });

  test("a message to a closed conversation reopens it with an event", async () => {
    const first = inbound();
    await ingested(first);
    const c = await onlyConversation();
    await updateConversation(c.id, (current) => ({
      ...current,
      status: "closed",
      closedAt: "2026-10-25T11:00:00.000Z",
    }));
    await ingested(
      inbound({
        keys: {
          messageId: "late@example.test",
          inReplyTo: first.keys.messageId,
          references: [],
        },
      }),
    );
    const after = await onlyConversation();
    expect(after.status).toBe("open");
    expect(after.closedAt).toBeNull();
    expect(after.events.map((e) => e.detail)).toContain(
      "Customer wrote after close",
    );
  });

  test("an auto-reply is stored as automated without an event or the pipeline", async () => {
    expect(
      await ingested(
        inbound({ loopHeaders: { "auto-submitted": "auto-replied" } }),
      ),
    ).toBe("stored");
    const c = await onlyConversation();
    expect(c.messages[0]!.automated).toBe(true);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(await pending()).toEqual([]);
  });

  test("an auto-reply to a closed conversation does not reopen it", async () => {
    const first = inbound();
    await ingested(first);
    const c = await onlyConversation();
    await updateConversation(c.id, (current) => ({
      ...current,
      status: "closed",
      closedAt: "2026-10-25T11:00:00.000Z",
    }));
    await ingested(
      inbound({
        loopHeaders: { "auto-submitted": "auto-replied" },
        keys: {
          messageId: "ooo@example.test",
          inReplyTo: first.keys.messageId,
          references: [],
        },
      }),
    );
    const after = await onlyConversation();
    expect(after.messages).toHaveLength(2);
    expect(after.status).toBe("closed");
    expect(calls).toHaveLength(1);
  });

  test("mail to a disabled inbox is ignored", async () => {
    const updated = await updateInbox(
      inbox.id,
      { expectedRevision: inbox.revision, enabled: false },
      ADA,
    );
    expect(updated.ok).toBe(true);
    expect(await ingested(inbound())).toBe("ignored");
    expect(await listIndexRows()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("mail to an unknown inbox is ignored", async () => {
    expect(await ingested(inbound({ inboxId: "inb_missing" }))).toBe("ignored");
    expect(await listIndexRows()).toEqual([]);
  });

  test("a failed pipeline leaves the pending key; a retry runs it again and clears it", async () => {
    failPipeline = true;
    await ingested(inbound());
    const c = await onlyConversation();
    expect((await pending()).map((p) => p.key)).toEqual([`triage:${c.id}`]);
    failPipeline = false;
    expect(await retryPendingInbound(Date.now() + 86_400_000)).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.isNew).toBe(true);
    expect(calls[1]!.conversation.id).toBe(c.id);
    expect(await pending()).toEqual([]);
  });

  test("a retry before the key is due does nothing", async () => {
    failPipeline = true;
    await ingested(inbound());
    expect(await retryPendingInbound(Date.now())).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("a pending key for a deleted conversation is dropped", async () => {
    await catalogDocuments("support-pending").set("triage:sc_0000-gone", {
      conversationId: "sc_0000-gone",
      messageId: "sm_x",
      isNew: true,
      attempts: 1,
      nextAttemptAt: 0,
    });
    expect(await retryPendingInbound(Date.now())).toBe(0);
    expect(await pending()).toEqual([]);
  });

  test("our own Message-ID arriving in INBOX is a duplicate", async () => {
    await ingested(inbound());
    const c = await onlyConversation();
    await rememberMessageIds(inbox.id, c.id, ["ours1@acme.example.test"], []);
    const copy = inbound({
      from: { name: "Acme help", address: INBOX },
      to: [{ name: null, address: "ada@example.test" }],
      keys: {
        messageId: "ours1@acme.example.test",
        inReplyTo: null,
        references: [],
      },
    });
    expect(await ingested(copy)).toBe("duplicate");
    expect((await onlyConversation()).messages).toHaveLength(1);
  });

  test("a forward of our sent reply is a duplicate", async () => {
    await ingested(inbound());
    const c = await onlyConversation();
    const ours: SupportMessage = {
      ...c.messages[0]!,
      id: "sm_out",
      direction: "out",
      from: { name: null, address: INBOX },
      keys: {
        messageId: "ours2@acme.example.test",
        inReplyTo: null,
        references: [],
      },
      providerId: null,
    };
    await updateConversation(c.id, (current) => ({
      ...current,
      messages: [...current.messages, ours],
    }));
    await rememberMessageIds(inbox.id, c.id, ["ours2@acme.example.test"], []);
    expect(
      await ingested(
        inbound({
          from: { name: null, address: INBOX },
          keys: {
            messageId: "ours2@acme.example.test",
            inReplyTo: null,
            references: [],
          },
        }),
      ),
    ).toBe("duplicate");
  });

  test("mail without a Message-ID is stored and deduped by provider id", async () => {
    const m = inbound({
      keys: { messageId: null, inReplyTo: null, references: [] },
    });
    expect(await ingested(m)).toBe("stored");
    expect(await ingested(structuredClone(m))).toBe("duplicate");
    expect(await listIndexRows()).toHaveLength(1);
  });

  test("trust flags come from Reply-To and Authentication-Results", async () => {
    await ingested(
      inbound({ replyTo: [{ name: null, address: "x@other.test" }] }),
    );
    await ingested(
      inbound({
        from: { name: null, address: "bob@example.test" },
        loopHeaders: {
          "authentication-results": "mx.example.test; dmarc=fail",
        },
      }),
    );
    await ingested(
      inbound({
        from: { name: null, address: "cy@example.test" },
        replyTo: [{ name: null, address: "cy+help@example.test" }],
        loopHeaders: {
          "authentication-results":
            "mx.example.test; spf=pass; dkim=pass; dmarc=pass",
        },
      }),
    );
    await ingested(
      inbound({
        from: { name: null, address: "dan@example.test" },
        replyTo: [{ name: "Dan", address: "Dan@Example.test" }],
      }),
    );
    await ingested(
      inbound({
        from: { name: null, address: "eve@example.test" },
        replyTo: [
          { name: null, address: "eve@example.test" },
          { name: null, address: "boss@example.test" },
        ],
      }),
    );
    const trustBy = new Map<string, unknown>();
    for (const row of await listIndexRows()) {
      const c = (await getConversation(row.id))!;
      trustBy.set(c.customer.address, c.messages[0]!.trust);
    }
    expect(trustBy.get("ada@example.test")).toEqual({
      replyToDiffers: true,
      authFailed: false,
      authVerified: false,
    });
    expect(trustBy.get("bob@example.test")).toEqual({
      replyToDiffers: false,
      authFailed: true,
      authVerified: false,
    });
    // Another address at the same domain still differs.
    expect(trustBy.get("cy@example.test")).toEqual({
      replyToDiffers: true,
      authFailed: false,
      authVerified: true,
    });
    expect(trustBy.get("dan@example.test")).toEqual({
      replyToDiffers: false,
      authFailed: false,
      authVerified: false,
    });
    // More than one Reply-To differs, even when one is the sender.
    expect(trustBy.get("eve@example.test")).toEqual({
      replyToDiffers: true,
      authFailed: false,
      authVerified: false,
    });
  });

  test("Reply-To is kept on the stored message for the reply, and left out when empty", async () => {
    await ingested(
      inbound({
        replyTo: [{ name: "Ada Desk", address: " Desk@Example.test " }],
      }),
    );
    await ingested(
      inbound({ from: { name: null, address: "bob@example.test" } }),
    );
    const byCustomer = new Map<string, unknown>();
    for (const row of await listIndexRows()) {
      const c = (await getConversation(row.id))!;
      byCustomer.set(c.customer.address, c.messages[0]!);
    }
    expect(byCustomer.get("ada@example.test")).toMatchObject({
      replyTo: [{ name: "Ada Desk", address: "desk@example.test" }],
    });
    expect(byCustomer.get("bob@example.test")).not.toHaveProperty("replyTo");
  });

  test("spf and dkim both failing count as an auth failure, one alone does not", async () => {
    await ingested(
      inbound({
        loopHeaders: {
          "authentication-results": "mx.example.test; spf=fail; dkim=fail",
        },
      }),
    );
    await ingested(
      inbound({
        from: { name: null, address: "bob@example.test" },
        loopHeaders: {
          "authentication-results": "mx.example.test; spf=fail; dkim=pass",
        },
      }),
    );
    const trust = new Map<string, boolean>();
    for (const row of await listIndexRows())
      trust.set(
        row.customer.address,
        (await getConversation(row.id))!.messages[0]!.trust!.authFailed,
      );
    expect(trust.get("ada@example.test")).toBe(true);
    expect(trust.get("bob@example.test")).toBe(false);
  });

  test("attachments are saved with fresh ids and their bytes are not in the document", async () => {
    const bytes = new TextEncoder().encode("log line 1\n");
    const m = inbound({
      attachments: [
        {
          id: "att_1",
          fileName: "log.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.byteLength,
          stored: false,
          expiresAt: null,
          content: bytes,
        },
      ],
    });
    await ingested(m);
    const c = await onlyConversation();
    const meta = c.messages[0]!.attachments[0]!;
    expect(meta.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(meta.id).not.toBe("att_1");
    expect(meta.stored).toBe(true);
    expect(meta.expiresAt).not.toBeNull();
    expect("content" in meta).toBe(false);
    expect(await readAttachment(c.id, meta.id)).toEqual(bytes);
  });

  test("an oversize message is stored with a note", async () => {
    await ingested(inbound({ text: "", oversize: true }));
    const c = await onlyConversation();
    expect(c.messages[0]!.text).toStartWith("[Message too large to import:");
  });

  test("an unreadable message gets the stub text", async () => {
    await ingested(inbound({ text: "", unreadable: true }));
    const c = await onlyConversation();
    expect(c.messages[0]!.text).toBe("(This message couldn't be read)");
  });

  test("a publisher that throws does not fail ingest", async () => {
    __setSupportEventPublisherForTest(async () => {
      throw new Error("bus down");
    });
    expect(await ingested(inbound())).toBe("stored");
    expect(calls).toHaveLength(1);
  });
});

const replyTo = (first: InboundMessage, over: Partial<InboundMessage> = {}) =>
  inbound({
    subject: `Re: ${first.subject}`,
    keys: {
      messageId: `r${uid + 1}@example.test`,
      inReplyTo: first.keys.messageId,
      references: [first.keys.messageId!],
    },
    ...over,
  });

const pendingEntry = async (conversationId: string) =>
  (await pending()).find((p) => p.key === `triage:${conversationId}`)?.value as
    | { isNew: boolean; attempts: number; messageId: string }
    | undefined;

describe("ingest crash windows", () => {
  test("a reply stored before its ids were remembered is not stored twice", async () => {
    const first = inbound();
    await ingested(first);
    const c = await onlyConversation();
    const bytes = new TextEncoder().encode("trace\n");
    const reply = replyTo(first, {
      attachments: [
        {
          id: "att_1",
          fileName: "trace.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.byteLength,
          stored: false,
          expiresAt: null,
          content: bytes,
        },
      ],
    });
    // The crash: the reply is in the document, its ids and pending key are not.
    await updateConversation(c.id, (current) => ({
      ...current,
      messages: [
        ...current.messages,
        {
          ...current.messages[0]!,
          id: "sm_crashed",
          at: reply.receivedAt,
          keys: reply.keys,
          providerId: reply.providerId,
          attachments: [],
        },
      ],
    }));
    expect(await ingested(reply)).toBe("duplicate");
    const after = await onlyConversation();
    expect(after.messages).toHaveLength(2);
    expect(await lookupProviderId(inbox.id, reply.providerId)).toBe(c.id);
    // The hand-off the crash skipped runs now, for the stored message.
    expect(calls.map((call) => call.message.id)).toEqual([
      c.messages[0]!.id,
      "sm_crashed",
    ]);
    // The attachment saved for the duplicate is gone again.
    const files = await readdir(join(ATTACHMENTS_DIR(), c.id)).catch(() => []);
    expect(files).toEqual([]);
  });

  test("a new conversation whose ids were remembered before a crash is created under that id", async () => {
    const m = inbound();
    const id = "sc_0193a1b2-0000-7000-8000-00000000c0de";
    await rememberMessageIds(
      inbox.id,
      id,
      [m.keys.messageId!, `${m.keys.messageId!}\0ada@example.test`],
      [m.providerId],
    );
    expect(await ingested(m)).toBe("stored");
    const c = await onlyConversation();
    expect(c.id).toBe(id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.isNew).toBe(true);
    // And once it exists, the same mail is a duplicate.
    expect(await ingested(structuredClone(m))).toBe("duplicate");
  });

  test("a reply after a failed first hand-off still reaches the pipeline as new", async () => {
    failPipeline = true;
    const first = inbound();
    await ingested(first);
    failPipeline = false;
    await ingested(replyTo(first));
    expect(calls.map((call) => call.isNew)).toEqual([true, true]);
    expect(await pending()).toEqual([]);
  });
});

describe("pipeline hand-off", () => {
  test("gives up after eight attempts with an event on the conversation", async () => {
    failPipeline = true;
    await ingested(inbound());
    const c = await onlyConversation();
    for (let i = 0; i < 7; i++)
      await retryPendingInbound(Date.now() + 86_400_000 * (i + 1));
    expect(calls).toHaveLength(8);
    expect(await pending()).toEqual([]);
    const after = (await getConversation(c.id))!;
    expect(after.events.map((e) => e.detail)).toContain(
      "Couldn't hand this to the agent",
    );
    expect(await retryPendingInbound(Date.now() + 86_400_000 * 30)).toBe(0);
  });

  test("a pipeline that never settles times out and stays pending", async () => {
    __setPipelineTimeoutForTest(20);
    onCall = () => new Promise(() => {});
    await ingested(inbound());
    const c = await onlyConversation();
    expect((await pendingEntry(c.id))?.attempts).toBe(1);
  });

  test("retries run concurrently across conversations", async () => {
    failPipeline = true;
    await ingested(inbound());
    await ingested(
      inbound({ from: { name: null, address: "cy@example.test" } }),
    );
    failPipeline = false;
    let active = 0;
    let most = 0;
    onCall = async () => {
      active += 1;
      most = Math.max(most, active);
      await Bun.sleep(20);
      active -= 1;
    };
    expect(await retryPendingInbound(Date.now() + 86_400_000)).toBe(2);
    expect(most).toBe(2);
    expect(await pending()).toEqual([]);
  });
});

describe("dedupe keys", () => {
  test("a reused Message-ID's second copy is a duplicate of its own conversation", async () => {
    const m = inbound();
    await ingested(m);
    const reused = inbound({
      from: { name: null, address: "eve@other.test" },
      keys: { ...m.keys },
    });
    await ingested(reused);
    expect(await ingested({ ...reused, providerId: "imap:2:99" })).toBe(
      "duplicate",
    );
    expect(await listIndexRows()).toHaveLength(2);
  });

  test("mail without a Message-ID copied to another folder is a duplicate", async () => {
    const m = inbound({
      keys: { messageId: null, inReplyTo: null, references: [] },
    });
    await ingested(m);
    expect(await ingested({ ...m, providerId: "imap:2:98" })).toBe("duplicate");
    expect(await listIndexRows()).toHaveLength(1);
  });
});

describe("own and staff mail", () => {
  test("mail from the inbox address that does not thread is ignored", async () => {
    expect(
      await ingested(inbound({ from: { name: "Acme help", address: INBOX } })),
    ).toBe("ignored");
    expect(await listIndexRows()).toEqual([]);
  });

  test("mail from the inbox address in a thread is recorded as replied outside Sessions", async () => {
    const first = inbound();
    await ingested(first);
    expect(
      await ingested(
        replyTo(first, {
          from: { name: "Acme help", address: INBOX },
          to: [{ name: null, address: "ada@example.test" }],
        }),
      ),
    ).toBe("stored");
    const c = await onlyConversation();
    expect(c.messages.map((x) => x.direction)).toEqual(["in", "out"]);
    expect(c.events.map((e) => e.detail)).toContain("Replied outside Sessions");
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("a team member's reply in a thread is staff, not a customer", async () => {
    const first = inbound();
    await ingested(first);
    await ingested(
      replyTo(first, {
        from: { name: "Bob", address: "bob@acme.example.test" },
      }),
    );
    const c = await onlyConversation();
    expect(c.messages[1]!.direction).toBe("out");
    expect(c.messages[1]!.sentBy).toEqual({ kind: "person", name: "Bob" });
    expect(calls).toHaveLength(1);
  });

  test("a team member's mail that does not thread never starts a customer conversation", async () => {
    expect(
      await ingested(
        inbound({ from: { name: "Bob", address: "bob@acme.example.test" } }),
      ),
    ).toBe("ignored");
    expect(await listIndexRows()).toEqual([]);
  });
});

describe("routing after triage", () => {
  test("the event is published after the pipeline, with the message time", async () => {
    let seenAtCall = -1;
    onCall = async () => {
      seenAtCall = events.length;
    };
    const m = inbound();
    await ingested(m);
    expect(seenAtCall).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.time).toBe(m.receivedAt);
  });

  test("mail triaged as spam publishes nothing, and replies to it are not handed off", async () => {
    onCall = async ({ conversation }) => {
      await updateConversation(conversation.id, (c) => ({
        ...c,
        status: "spam",
      }));
    };
    const first = inbound();
    await ingested(first);
    expect(events).toHaveLength(0);
    onCall = null;
    expect(await ingested(replyTo(first))).toBe("stored");
    expect((await onlyConversation()).messages).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(0);
    expect(await pending()).toEqual([]);
  });

  test("with no pipeline nothing is published yet", async () => {
    setSupportPipeline(null);
    await ingested(inbound());
    expect(events).toHaveLength(0);
    expect(await pending()).toHaveLength(1);
  });

  test("an unreadable message goes to a person instead of triage", async () => {
    await ingested(inbound({ text: "", unreadable: true }));
    const c = await onlyConversation();
    expect(calls).toHaveLength(0);
    expect(c.status).toBe("open");
    expect(c.events.map((e) => e.kind)).toContain("needs-person");
  });

  test("a bounce of our reply threads into the conversation", async () => {
    await ingested(inbound());
    const c = await onlyConversation();
    const ours: SupportMessage = {
      ...c.messages[0]!,
      id: "sm_out1",
      direction: "out",
      from: { name: null, address: INBOX },
      keys: {
        messageId: "out1@acme.example.test",
        inReplyTo: null,
        references: [],
      },
      providerId: null,
    };
    await updateConversation(c.id, (current) => ({
      ...current,
      messages: [...current.messages, ours],
    }));
    await rememberMessageIds(inbox.id, c.id, ["out1@acme.example.test"], []);
    await ingested(
      inbound({
        from: { name: null, address: "mailer-daemon@mx.example.test" },
        loopHeaders: { "auto-submitted": "auto-replied" },
        keys: {
          messageId: "bounce1@mx.example.test",
          inReplyTo: "out1@acme.example.test",
          references: [],
        },
      }),
    );
    const after = await onlyConversation();
    expect(after.messages).toHaveLength(3);
    expect(after.messages[2]!.automated).toBe(true);
  });

  test("automated mail that does not thread is filed closed", async () => {
    await ingested(
      inbound({ loopHeaders: { "auto-submitted": "auto-generated" } }),
    );
    const c = await onlyConversation();
    expect(c.status).toBe("closed");
    expect(c.closedAt).not.toBeNull();
  });
});

describe("positive mail authentication", () => {
  const from = "carol@customer.example.test";
  test.each<[string, string, boolean]>([
    [
      "dmarc pass",
      "mx.example.test; dmarc=pass header.from=customer.example.test",
      true,
    ],
    [
      "dmarc pass for another domain",
      "mx.example.test; dmarc=pass header.from=evil.example.test",
      false,
    ],
    [
      "aligned dkim",
      "mx.example.test; dkim=pass header.d=customer.example.test",
      true,
    ],
    [
      "dkim of a parent domain",
      "mx.example.test; dkim=pass header.i=@example.test",
      true,
    ],
    [
      "dkim of another domain",
      "mx.example.test; dkim=pass header.d=mailer.example.org",
      false,
    ],
    [
      "aligned spf",
      "mx.example.test; spf=pass smtp.mailfrom=bounce@customer.example.test",
      true,
    ],
    [
      "unaligned spf",
      "mx.example.test; spf=pass smtp.mailfrom=bounce@sender.example.org",
      false,
    ],
    [
      "comments are ignored",
      "mx.example.test; dkim=fail (dkim=pass header.d=customer.example.test)",
      false,
    ],
    [
      "nothing passed",
      "mx.example.test; spf=none; dkim=none; dmarc=none",
      false,
    ],
    ["no header", "", false],
    // Only the receiving server's (topmost) header counts.
    [
      "a lower header a sender added",
      "mx.example.test; dkim=none\nforged; dmarc=pass header.from=customer.example.test",
      false,
    ],
  ])("%s", (_name, results, verified) => {
    expect(mailAuthVerified(results, from)).toBe(verified);
  });
});
