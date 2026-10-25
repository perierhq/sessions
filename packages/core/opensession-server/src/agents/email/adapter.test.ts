import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  type InboundMessage,
  type InboxConfig,
  type MailServerConfig,
  type SupportConversation,
  type SupportDraft,
  type SupportMessage,
  defaultInboxConfig,
} from "../../shared/support";
import { catalogDocuments } from "../../server/catalog-documents";
import { type OutboundDraft, SendError } from "../../server/support/channel";
import { useSupportTestKernel } from "../../server/support/testing/kernel-fixture";
import {
  MAIL_PASSWORD,
  MAIL_USER,
  type MailFixture,
  rawMail,
  startMailFixture,
} from "../../server/support/testing/mail-fixture";
import { EmailChannelAdapter, ensureFolder } from "./adapter";

useSupportTestKernel();

const NOW = "2026-10-25T10:00:00.000Z";
const INBOX = "help@acme.example.test";

let f: MailFixture;
let adapters: EmailChannelAdapter[] = [];

beforeEach(async () => {
  // No Sessions/Done or Sessions/Spam: the move tests see them created.
  f = await startMailFixture();
});

afterEach(async () => {
  for (const adapter of adapters) await adapter.disconnect();
  adapters = [];
  await f.close();
});

function server(port: number): MailServerConfig {
  return {
    host: "127.0.0.1",
    port,
    tls: "none",
    user: MAIL_USER,
    passwordRef: "ref",
  };
}

function inboxFor(over: Partial<InboxConfig> = {}): InboxConfig {
  return {
    ...defaultInboxConfig({
      id: "inb_0190a1b2-0000-7000-8000-000000000001",
      label: "Acme help",
      address: INBOX,
      project: "acme",
      owner: "Ada",
      createdBy: "Ada",
      now: NOW,
      imap: server(f.imapPort),
      smtp: server(f.smtpPort),
    }),
    allowInternalHost: true,
    ...over,
  };
}

function adapterFor(over: Partial<InboxConfig> = {}): EmailChannelAdapter {
  const adapter = new EmailChannelAdapter(inboxFor(over), {
    password: async () => MAIL_PASSWORD,
    otherInboxAddresses: async () => [],
    imap: { autoIdleDelayMs: 50 },
  });
  adapters.push(adapter);
  return adapter;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

/** Connects with a recording sink and waits until the inbox is live. */
async function connected(adapter: EmailChannelAdapter) {
  const received: InboundMessage[] = [];
  await adapter.connect(async (m) => {
    received.push(m);
    return "stored";
  });
  await until(() => adapter.health().state === "live");
  return received;
}

/** Delivers `count` messages and waits until the sink has them all. */
async function receive(
  received: InboundMessage[],
  count: number,
): Promise<InboundMessage[]> {
  const before = received.length;
  for (let i = 0; i < count; i++)
    f.deliver(
      rawMail({
        from: "Ada <ada@example.test>",
        to: INBOX,
        messageId: `m${before + i}@example.test`,
        text: `Message ${before + i}`,
      }),
    );
  await until(() => received.length >= before + count);
  return received.slice(before);
}

function stored(m: InboundMessage, id: string): SupportMessage {
  return {
    id,
    direction: "in",
    at: m.receivedAt,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    text: m.text,
    keys: m.keys,
    providerId: m.providerId,
    attachments: [],
  };
}

function conversationOf(messages: SupportMessage[]): SupportConversation {
  return {
    id: "sc_0190a1b2-0000-7000-8000-000000000001",
    channel: "email",
    inboxId: inboxFor().id,
    project: "acme",
    subject: "Help",
    customer: { name: "Ada", address: "ada@example.test" },
    status: "open",
    owner: null,
    createdAt: NOW,
    lastMessageAt: NOW,
    closedAt: null,
    triage: null,
    sessionId: null,
    fixSessionId: null,
    messages,
    draft: null,
    autoSends: [],
    moves: [],
    issue: null,
    pendingIssue: null,
    events: [],
    revision: 1,
  };
}

function outbound(inbox: InboxConfig, messageId: string): OutboundDraft {
  const draft: SupportDraft = {
    id: "sd_1",
    text: "Thanks, it's fixed now.",
    author: { kind: "person", name: "Ada" },
    createdAt: NOW,
    state: "sending",
    rule: "",
    vetoDeadline: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    messageId,
    decidedBy: { kind: "person", name: "Ada" },
  };
  const message: SupportMessage = {
    id: "sm_1",
    direction: "in",
    at: NOW,
    from: { name: "Ada", address: "ada@example.test" },
    to: [{ name: null, address: INBOX }],
    cc: [],
    subject: "Help",
    text: "It broke",
    keys: { messageId: "m1@example.test", inReplyTo: null, references: [] },
    providerId: "imap:1:1",
    attachments: [],
  };
  return { conversation: conversationOf([message]), draft, inbox };
}

type Snapshot = Record<
  string,
  Array<{ uid: number; flags: string[]; raw: string }>
>;

/** Every folder with its messages' UIDs, flags and bytes. */
function snapshot(): Snapshot {
  const out: Snapshot = {};
  for (const [path, mailbox] of Object.entries<any>(f.imap.folderCache))
    out[path] = (mailbox.messages ?? []).map((m: any) => ({
      uid: m.uid,
      flags: [...m.flags].sort(),
      raw: m.raw,
    }));
  return out;
}

const messagesIn = (path: string): any[] =>
  f.imap.getMailbox(path)?.messages ?? [];

/** Counts LOGIN commands; `refuse(n)` answers NO for the nth one. */
function scriptLogin(
  refuse: (n: number) => boolean,
): { count: () => number } {
  const original = f.imap.getCommandHandler("LOGIN");
  let n = 0;
  f.imap.setCommandHandler(
    "LOGIN",
    (conn: any, parsed: any, data: any, callback: () => void) => {
      n++;
      if (!refuse(n)) return original(conn, parsed, data, callback);
      conn.sendStatus(
        parsed,
        data,
        "NO",
        "Invalid credentials",
        "AUTHENTICATIONFAILED",
      );
      callback();
    },
  );
  return { count: () => n };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("EmailChannelAdapter.send", () => {
  test("sends the draft and returns its Message-ID", async () => {
    const inbox = inboxFor({ copyToSent: false });
    const adapter = adapterFor({ copyToSent: false });
    await connected(adapter);
    const receipt = await adapter.send(
      outbound(inbox, "out1@acme.example.test"),
    );
    expect(receipt.messageId).toBe("out1@acme.example.test");
    expect(receipt.providerId).toBeNull();
    expect(Number.isNaN(Date.parse(receipt.sentAt))).toBe(false);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.envelope.to).toEqual(["ada@example.test"]);
    expect(f.sent[0]!.raw).toContain("In-Reply-To: <m1@example.test>");
  });

  test("with copyToSent the Sent folder gains one message", async () => {
    const inbox = inboxFor({ copyToSent: true });
    const adapter = adapterFor({ copyToSent: true });
    await connected(adapter);
    await adapter.send(outbound(inbox, "out2@acme.example.test"));
    await until(() => messagesIn("Sent").length === 1);
    expect(messagesIn("Sent")[0].raw).toContain(
      "Message-ID: <out2@acme.example.test>",
    );
    // Nothing else lands there.
    await Bun.sleep(200);
    expect(messagesIn("Sent")).toHaveLength(1);
  });

  test("without copyToSent the Sent folder stays empty", async () => {
    const inbox = inboxFor({ copyToSent: false });
    const adapter = adapterFor({ copyToSent: false });
    await connected(adapter);
    await adapter.send(outbound(inbox, "out3@acme.example.test"));
    await Bun.sleep(300);
    expect(messagesIn("Sent")).toHaveLength(0);
  });

  test("a disconnect during a send's first await opens no SMTP session", async () => {
    const inbox = inboxFor({ copyToSent: false });
    const others = deferred<string[]>();
    const adapter = new EmailChannelAdapter(inbox, {
      password: async () => MAIL_PASSWORD,
      otherInboxAddresses: () => others.promise,
    });
    adapters.push(adapter);
    const sending = adapter
      .send(outbound(inbox, "race@acme.example.test"))
      .catch((e: unknown) => e);
    await Bun.sleep(10);
    const closing = adapter.disconnect();
    others.resolve([]);
    await closing;
    const error = await sending;
    expect(error).toBeInstanceOf(SendError);
    expect(error).toMatchObject({ permanent: false });
    await Bun.sleep(100);
    expect(f.smtpConnections.opened).toBe(0);
    expect(f.sent).toHaveLength(0);
  });

  test("disconnect lets a send in flight finish before closing SMTP", async () => {
    const inbox = inboxFor({ copyToSent: false });
    const adapter = adapterFor({ copyToSent: false });
    await connected(adapter);
    const sending = adapter.send(outbound(inbox, "late@acme.example.test"));
    await until(() => f.smtpConnections.opened === 1);
    await adapter.disconnect();
    await expect(sending).resolves.toMatchObject({
      messageId: "late@acme.example.test",
    });
    expect(f.sent).toHaveLength(1);
  });

  test("a permanent SMTP error shows on the inbox's health until a send works", async () => {
    const inbox = inboxFor({ copyToSent: false });
    const adapter = adapterFor({ copyToSent: false });
    await connected(adapter);
    f.smtpReply = { code: 550, message: "No such user" };
    const error = await adapter
      .send(outbound(inbox, "bad@acme.example.test"))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "SendError", permanent: true });
    const health = adapter.health();
    expect(health.state).toBe("live");
    expect(health.reason).toContain("The mail server refused the message");
    expect(health.reason).not.toContain("No such user");
    await adapter.send(outbound(inbox, "good@acme.example.test"));
    expect(adapter.health().reason).toBeNull();
  });

  test("a new address rebuilds the SMTP pool but keeps the IMAP connection", async () => {
    const inbox = inboxFor({ copyToSent: false });
    const adapter = adapterFor({ copyToSent: false });
    await connected(adapter);
    await adapter.send(outbound(inbox, "one@acme.example.test"));
    expect(f.smtpConnections.opened).toBe(1);
    const moved = { ...inbox, address: "support@acme.example.test" };
    adapter.update(moved);
    await adapter.send(outbound(moved, "two@acme.example.test"));
    expect(f.smtpConnections.opened).toBe(2);
    expect(f.sent[1]!.envelope.from).toBe("support@acme.example.test");
    expect(f.connections()).toBe(1);
    expect(adapter.health().state).toBe("live");
  });

  test("a missing SMTP password is a permanent send error", async () => {
    const inbox = inboxFor();
    const adapter = new EmailChannelAdapter(inbox, {
      password: async (which) => (which === "imap" ? MAIL_PASSWORD : undefined),
      otherInboxAddresses: async () => [],
    });
    adapters.push(adapter);
    const error = await adapter
      .send(outbound(inbox, "out4@acme.example.test"))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "SendError", permanent: true });
    expect(f.sent).toHaveLength(0);
  });
});

describe("EmailChannelAdapter.mark", () => {
  test("mark-read sets \\Seen on the conversation's UIDs only", async () => {
    const adapter = adapterFor({ mailbox: "mark-read" });
    const received = await connected(adapter);
    const [a, b, other] = await receive(received, 3);
    // An id from an older UIDVALIDITY with the same UID is not this mail.
    const stale = stored(other!, "sm_stale");
    stale.providerId = `imap:999:${other!.providerId.split(":")[2]}`;
    const c = conversationOf([stored(a!, "sm_a"), stored(b!, "sm_b"), stale]);
    await adapter.mark(c, "handled");
    const seen = messagesIn("INBOX").map((m) => m.flags.includes("\\Seen"));
    expect(seen).toEqual([true, true, false]);
  });

  test("move puts the conversation's messages in Sessions/Done, creating it", async () => {
    const adapter = adapterFor({ mailbox: "move" });
    const received = await connected(adapter);
    const [a, b] = await receive(received, 3);
    expect(f.imap.getMailbox("Sessions/Done")).toBeUndefined();
    await adapter.mark(
      conversationOf([stored(a!, "sm_a"), stored(b!, "sm_b")]),
      "handled",
    );
    expect(messagesIn("Sessions/Done")).toHaveLength(2);
    expect(messagesIn("INBOX")).toHaveLength(1);
    expect(messagesIn("INBOX")[0].raw).toContain("Message 2");
  });

  test("move files spam in Sessions/Spam", async () => {
    const adapter = adapterFor({ mailbox: "move" });
    const received = await connected(adapter);
    const [a] = await receive(received, 1);
    await adapter.mark(conversationOf([stored(a!, "sm_a")]), "spam");
    expect(messagesIn("Sessions/Spam")).toHaveLength(1);
    expect(messagesIn("INBOX")).toHaveLength(0);
  });

  test("untouched leaves the mailbox byte-for-byte unchanged", async () => {
    const adapter = adapterFor({ mailbox: "untouched" });
    const received = await connected(adapter);
    const [a, b] = await receive(received, 2);
    const before = snapshot();
    const c = conversationOf([stored(a!, "sm_a"), stored(b!, "sm_b")]);
    await adapter.mark(c, "handled");
    await adapter.mark(c, "spam");
    expect(snapshot()).toEqual(before);
    expect(Object.keys(f.imap.folderCache).sort()).toEqual(
      Object.keys(before).sort(),
    );
  });

  test("mark-read also flags our own mail filed from this mailbox", async () => {
    const adapter = adapterFor({ mailbox: "mark-read" });
    const received = await connected(adapter);
    const [a] = await receive(received, 1);
    // "Replied outside Sessions": our own mail, read from INBOX.
    const ours = { ...stored(a!, "sm_ours"), direction: "out" as const };
    await adapter.mark(conversationOf([ours]), "handled");
    expect(messagesIn("INBOX")[0].flags).toContain("\\Seen");
  });

  test("mark-read on a mailbox opened read-only changes nothing and logs the inbox", async () => {
    const adapter = adapterFor({ mailbox: "untouched" });
    const received = await connected(adapter);
    const [a] = await receive(received, 1);
    // Changed in place, so the connection is still the read-only one.
    adapter.update(inboxFor({ mailbox: "mark-read" }));
    const before = snapshot();
    const warn = spyOn(console, "warn");
    try {
      await adapter.mark(conversationOf([stored(a!, "sm_a")]), "handled");
      expect(snapshot()).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("mailbox action skipped"),
        expect.objectContaining({ inboxId: inboxFor().id }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("a mailbox action on a disconnected inbox is swallowed", async () => {
    const adapter = adapterFor({ mailbox: "move" });
    const c = conversationOf([]);
    await expect(adapter.mark(c, "handled")).resolves.toBeUndefined();
  });
});

describe("EmailChannelAdapter.connect", () => {
  test("health is off until connected and after disconnect", async () => {
    const adapter = adapterFor();
    expect(adapter.health().state).toBe("off");
    await connected(adapter);
    expect(f.connections()).toBe(1);
    await adapter.disconnect();
    expect(adapter.health().state).toBe("off");
    await until(() => f.connections() === 0);
  });

  test("the cursor lives in support-cursors and carries over a reconnect", async () => {
    const first = adapterFor();
    await connected(first);
    await first.disconnect();
    const cursor = await catalogDocuments("support-cursors").get(
      `${inboxFor().id}:INBOX`,
    );
    expect(cursor).toMatchObject({ uidValidity: expect.any(String) });

    // Mail that arrives while disconnected is offered on the next connect.
    f.deliver(rawMail({ from: "ada@example.test", messageId: "late@x.test" }));
    const second = adapterFor();
    const received = await connected(second);
    await until(() => received.length === 1);
    expect(received[0]!.keys.messageId).toBe("late@x.test");
  });

  test("the stored cursor records when the last message arrived", async () => {
    const adapter = adapterFor();
    const received = await connected(adapter);
    const [m] = await receive(received, 1);
    const key = `${inboxFor().id}:INBOX`;
    const docs = catalogDocuments("support-cursors");
    let cursor: any = null;
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      cursor = await docs.get(key);
      if (cursor?.lastUid === 1) break;
      await Bun.sleep(20);
    }
    expect(cursor).toMatchObject({
      uidValidity: expect.any(String),
      lastUid: 1,
      lastReceivedAt: m!.receivedAt,
    });
  });

  test("a refused login pauses; resume() logs in once and goes live", async () => {
    const login = scriptLogin((n) => n === 1);
    const adapter = adapterFor();
    await adapter.connect(async () => "stored");
    expect(adapter.health().state).toBe("paused");
    expect(login.count()).toBe(1);
    await adapter.resume();
    expect(adapter.health().state).toBe("live");
    expect(login.count()).toBe(2);
    await adapter.resume();
    await Bun.sleep(100);
    expect(login.count()).toBe(2);
    expect(f.connections()).toBe(1);
  });

  test("resume() after disconnect does nothing", async () => {
    const adapter = adapterFor();
    await connected(adapter);
    await adapter.disconnect();
    await adapter.resume();
    expect(adapter.health().state).toBe("off");
    await until(() => f.connections() === 0);
  });

  test("a missing IMAP password pauses the inbox without connecting", async () => {
    const adapter = new EmailChannelAdapter(inboxFor(), {
      password: async () => undefined,
      otherInboxAddresses: async () => [],
    });
    adapters.push(adapter);
    await adapter.connect(async () => "stored");
    expect(adapter.health().state).toBe("paused");
    expect(f.connections()).toBe(0);
  });
});

describe("ensureFolder", () => {
  function fakeClient(
    listed: Array<Array<{ path: string; delimiter: string }>>,
    over: Record<string, unknown> = {},
  ) {
    let lists = 0;
    const created: unknown[] = [];
    const client = {
      namespace: { prefix: "INBOX.", delimiter: "." },
      list: async () => listed[Math.min(lists++, listed.length - 1)]!,
      mailboxCreate: async (path: unknown) => {
        created.push(path);
        throw Object.assign(new Error("exists"), {
          serverResponseCode: "ALREADYEXISTS",
        });
      },
      ...over,
    };
    return { client: client as any, created, lists: () => lists };
  }

  test("finds a folder under the server's namespace prefix", async () => {
    const fake = fakeClient([
      [
        { path: "INBOX", delimiter: "." },
        { path: "INBOX.Sessions.Done", delimiter: "." },
      ],
    ]);
    expect(await ensureFolder(fake.client, "Sessions/Done")).toBe(
      "INBOX.Sessions.Done",
    );
    expect(fake.created).toEqual([]);
  });

  test("lists again when the create says the folder exists", async () => {
    const fake = fakeClient(
      [
        [{ path: "INBOX", delimiter: "." }],
        [
          { path: "INBOX", delimiter: "." },
          { path: "INBOX.Sessions.Done", delimiter: "." },
        ],
      ],
    );
    expect(await ensureFolder(fake.client, "Sessions/Done")).toBe(
      "INBOX.Sessions.Done",
    );
    expect(fake.lists()).toBe(2);
  });

  test("a create that fails for another reason still fails", async () => {
    const fake = fakeClient([[{ path: "INBOX", delimiter: "." }]]);
    await expect(ensureFolder(fake.client, "Sessions/Done")).rejects.toThrow();
  });
});
