import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  type InboxConfig,
  type MailServerConfig,
  defaultInboxConfig,
} from "../../shared/support";
import { SendError } from "../../server/support/channel";
import {
  MAIL_PASSWORD,
  MAIL_USER,
  type MailFixture,
  startMailFixture,
} from "../../server/support/testing/mail-fixture";
import { ImapTransport } from "./imap-transport";
import type { OutgoingMail } from "./mime";
import {
  SmtpTransport,
  appendSentCopy,
  classifySmtpError,
  testSmtpLogin,
} from "./smtp-transport";

const NOW = "2026-10-25T10:00:00.000Z";

let fixtures: MailFixture[] = [];
let closers: Array<() => unknown> = [];

afterEach(async () => {
  for (const close of closers) await close();
  await Promise.all(fixtures.map((f) => f.close()));
  closers = [];
  fixtures = [];
});

async function fixture(): Promise<MailFixture> {
  const f = await startMailFixture();
  fixtures.push(f);
  return f;
}

function serverFor(port: number): MailServerConfig {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    user: MAIL_USER,
    passwordRef: "ref",
  };
}

function inboxFor(f: MailFixture, over: Partial<InboxConfig> = {}) {
  return {
    ...defaultInboxConfig({
      id: "inb_test",
      label: "Acme help",
      address: "help@acme.example.test",
      project: "acme",
      owner: "Ada",
      createdBy: "Ada",
      now: NOW,
      imap: serverFor(f.imapPort),
      smtp: serverFor(f.smtpPort),
    }),
    ...over,
  };
}

function transport(
  f: MailFixture,
  over: Partial<InboxConfig> = {},
  rateDeltaMs?: number,
): SmtpTransport {
  const t = new SmtpTransport({
    inbox: inboxFor(f, over),
    password: MAIL_PASSWORD,
    ...(rateDeltaMs !== undefined ? { rateDeltaMs } : {}),
  });
  closers.push(() => t.close());
  return t;
}

function mail(n = 1): OutgoingMail {
  return {
    from: { name: "Acme help", address: "help@acme.example.test" },
    to: [{ name: "Ada", address: "ada@example.test" }],
    subject: "Re: Help",
    text: `Thanks, fixed (${n}).`,
    messageId: `out${n}@acme.example.test`,
    inReplyTo: "m2@example.test",
    references: ["m1@example.test", "m2@example.test"],
    headers: { "Auto-Submitted": "auto-replied" },
  };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const decode = (raw: Uint8Array) => new TextDecoder().decode(raw);

describe("SmtpTransport.send", () => {
  test("sends with the threading headers to the customer", async () => {
    const f = await fixture();
    const result = await transport(f).send(mail());
    expect(f.sent).toHaveLength(1);
    const sent = f.sent[0]!;
    expect(sent.raw).toContain("Message-ID: <out1@acme.example.test>");
    expect(sent.raw).toContain("In-Reply-To: <m2@example.test>");
    expect(sent.raw).toContain(
      "References: <m1@example.test> <m2@example.test>",
    );
    expect(sent.raw).toContain("Auto-Submitted: auto-replied");
    expect(sent.envelope).toEqual({
      from: "help@acme.example.test",
      to: ["ada@example.test"],
    });
    expect(result.messageId).toBe("out1@acme.example.test");
    expect(result.accepted).toEqual(["ada@example.test"]);
    // The bytes for the Sent copy are the bytes that went out.
    expect(decode(result.raw).trimEnd()).toBe(sent.raw.trimEnd());
  });

  test("a 5xx answer is a permanent SendError", async () => {
    const f = await fixture();
    f.smtpReply = { code: 550, message: "No such user" };
    const error = await transport(f)
      .send(mail())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).permanent).toBe(true);
    expect((error as SendError).message).not.toContain("No such user");
  });

  test("a 4xx answer is a transient SendError", async () => {
    const f = await fixture();
    f.smtpReply = { code: 451, message: "Try later" };
    const error = await transport(f)
      .send(mail())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).permanent).toBe(false);
  });

  test("the send limit holds the third send until the window ends", async () => {
    const f = await fixture();
    const t = transport(f, { sendLimitPerMinute: 2 }, 500);
    const started = performance.now();
    await Promise.all([t.send(mail(1)), t.send(mail(2)), t.send(mail(3))]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(500);
    expect(f.sent).toHaveLength(3);
  });

  test("concurrent sends share one connection", async () => {
    const f = await fixture();
    const t = transport(f);
    await Promise.all([1, 2, 3, 4, 5].map((n) => t.send(mail(n))));
    expect(f.sent).toHaveLength(5);
    expect(f.smtpConnections.opened).toBe(1);
    expect(f.smtpConnections.maxLive).toBe(1);
  });

  test("a wrong password is a permanent SendError", async () => {
    const f = await fixture();
    const t = new SmtpTransport({ inbox: inboxFor(f), password: "wrong" });
    closers.push(() => t.close());
    const error = await t.send(mail()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).permanent).toBe(true);
  });

  test("a closed port is a transient SendError", async () => {
    const f = await fixture();
    const t = new SmtpTransport({
      inbox: inboxFor(f, { smtp: serverFor(await closedPort()) }),
      password: MAIL_PASSWORD,
    });
    closers.push(() => t.close());
    const error = await t.send(mail()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).permanent).toBe(false);
  });
});

describe("classifySmtpError", () => {
  const err = (props: Record<string, unknown>) =>
    Object.assign(new Error("x"), props);

  test("4xx, connection and timeout errors are transient", () => {
    for (const e of [
      err({ responseCode: 421 }),
      err({ responseCode: 451 }),
      err({ code: "ECONNECTION" }),
      err({ code: "ETIMEDOUT" }),
      err({ code: "ESOCKET" }),
      new Error("anything else"),
    ])
      expect(classifySmtpError(e).permanent).toBe(false);
  });

  test("5xx, auth and envelope errors are permanent", () => {
    for (const e of [
      err({ responseCode: 550 }),
      err({ responseCode: 554, code: "EMESSAGE" }),
      err({ code: "EAUTH", responseCode: 535 }),
      err({ code: "EENVELOPE" }),
    ])
      expect(classifySmtpError(e).permanent).toBe(true);
  });

  test("passes a SendError through", () => {
    const e = new SendError("x", true);
    expect(classifySmtpError(e)).toBe(e);
  });
});

describe("appendSentCopy", () => {
  async function connectedImap(f: MailFixture): Promise<ImapTransport> {
    const imap = new ImapTransport({
      inbox: inboxFor(f),
      password: MAIL_PASSWORD,
      sink: async () => "stored",
      loadCursor: async () => null,
      saveCursor: async () => undefined,
      onHealth: () => undefined,
    });
    closers.push(() => imap.stop());
    await imap.start();
    const until = Date.now() + 3000;
    while (imap.health().state !== "live") {
      if (Date.now() > until) throw new Error("imap not live");
      await Bun.sleep(10);
    }
    return imap;
  }

  test("puts the sent bytes into the Sent folder", async () => {
    const f = await fixture();
    const imap = await connectedImap(f);
    const { raw } = await transport(f).send(mail());
    expect(await appendSentCopy(imap, raw, null)).toBe(true);
    const copies = f.imap.getMailbox("Sent").messages;
    expect(copies).toHaveLength(1);
    expect(String(copies[0].raw)).toContain(
      "Message-ID: <out1@acme.example.test>",
    );
  });

  test("returns false without a connection and does not throw", async () => {
    const f = await fixture();
    const imap = new ImapTransport({
      inbox: inboxFor(f),
      password: MAIL_PASSWORD,
      sink: async () => "stored",
      loadCursor: async () => null,
      saveCursor: async () => undefined,
      onHealth: () => undefined,
    });
    expect(
      await appendSentCopy(imap, new TextEncoder().encode("x"), "Sent"),
    ).toBe(false);
    expect(f.imap.getMailbox("Sent").messages).toHaveLength(0);
  });
});

describe("testSmtpLogin", () => {
  test("logs in to the fixture", async () => {
    const f = await fixture();
    expect(await testSmtpLogin(serverFor(f.smtpPort), MAIL_PASSWORD)).toEqual({
      ok: true,
    });
  });

  test("a wrong password is permanent", async () => {
    const f = await fixture();
    const result = await testSmtpLogin(serverFor(f.smtpPort), "wrong");
    expect(result).toMatchObject({ ok: false, permanent: true });
  });

  test("a closed port is not permanent", async () => {
    const result = await testSmtpLogin(
      serverFor(await closedPort()),
      MAIL_PASSWORD,
    );
    expect(result).toMatchObject({ ok: false, permanent: false });
  });
});
