import { afterEach, describe, expect, test } from "bun:test";
import {
  BACKOFF_MAX_MS,
  type InboundMessage,
  type InboxConfig,
  type InboxHealth,
  defaultInboxConfig,
} from "../../shared/support";
import {
  DEFAULT_IMAP_PLUGINS,
  MAIL_PASSWORD,
  MAIL_USER,
  type MailFixture,
  rawMail,
  startMailFixture,
} from "../../server/support/testing/mail-fixture";
import {
  type ImapCursor,
  ImapTransport,
  type ImapTransportOptions,
  testImapLogin,
} from "./imap-transport";

const START = Date.parse("2026-10-25T10:00:00.000Z");

function fakeClock() {
  let now = START;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: ((fn: () => void, ms?: number) => {
      const id = ++seq;
      pending.set(id, { at: now + (ms ?? 0), fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => {
      pending.delete(id);
    }) as unknown as typeof clearTimeout,
    advance(ms: number) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
    },
    pending: () => pending.size,
    advanceTo(at: number) {
      this.advance(Math.max(0, at - now));
    },
  };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

/** Lets socket round trips settle without depending on wall-clock timing. */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function inboxFor(fixture: MailFixture): InboxConfig {
  const server = {
    host: "127.0.0.1",
    secure: false,
    user: MAIL_USER,
    passwordRef: "ref_imap",
  };
  return defaultInboxConfig({
    id: "inb_test",
    label: "Acme help",
    address: "help@acme.example.test",
    project: "acme",
    owner: "Ada",
    createdBy: "Ada",
    now: new Date(START).toISOString(),
    imap: { ...server, port: fixture.imapPort },
    smtp: { ...server, port: fixture.smtpPort },
  });
}

function mail(n: number, size = 0): string {
  return rawMail({
    from: `Customer ${n} <c${n}@example.test>`,
    subject: `Mail ${n}`,
    messageId: `m${n}@example.test`,
    text: size ? "y".repeat(size) : `Body ${n}`,
  });
}

interface Harness {
  transport: ImapTransport;
  received: InboundMessage[];
  cursor: { value: ImapCursor | null };
  healths: InboxHealth[];
}

let fixtures: MailFixture[] = [];
let transports: ImapTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.map((t) => t.stop()));
  await Promise.all(fixtures.map((f) => f.close()));
  transports = [];
  fixtures = [];
});

async function fixture(
  opts: Parameters<typeof startMailFixture>[0] = {},
): Promise<MailFixture> {
  const f = await startMailFixture(opts);
  fixtures.push(f);
  return f;
}

function harness(
  f: MailFixture,
  over: Partial<ImapTransportOptions> & {
    initialCursor?: ImapCursor | null;
    sink?: (m: InboundMessage) => Promise<"stored" | "duplicate" | "ignored">;
  } = {},
): Harness {
  const received: InboundMessage[] = [];
  const cursor = { value: over.initialCursor ?? null };
  const healths: InboxHealth[] = [];
  const { initialCursor: _ignored, sink, ...rest } = over;
  const transport = new ImapTransport({
    inbox: inboxFor(f),
    password: MAIL_PASSWORD,
    sink:
      sink ??
      (async (m) => {
        received.push(m);
        return "stored";
      }),
    loadCursor: async () => cursor.value,
    saveCursor: async (c) => {
      cursor.value = c;
    },
    onHealth: (h) => healths.push(h),
    autoIdleDelayMs: 50,
    ...rest,
  });
  transports.push(transport);
  return { transport, received, cursor, healths };
}

/** Counts LOGIN commands; `answer` returns a refusal or null to log in. */
function scriptLogin(
  f: MailFixture,
  answer: (n: number) => { code: string; text: string } | null,
): { count: () => number } {
  const original = f.imap.getCommandHandler("LOGIN");
  let n = 0;
  f.imap.setCommandHandler(
    "LOGIN",
    (conn: any, parsed: any, data: any, callback: () => void) => {
      n++;
      const refusal = answer(n);
      if (!refusal) return original(conn, parsed, data, callback);
      conn.sendStatus(parsed, data, "NO", refusal.text, refusal.code);
      callback();
    },
  );
  return { count: () => n };
}

describe("ImapTransport", () => {
  test("first start imports nothing and starts at the newest UID", async () => {
    const f = await fixture();
    for (const n of [1, 2, 3]) f.deliver(mail(n));
    const h = harness(f);
    await h.transport.start();
    expect(h.received).toEqual([]);
    expect(h.cursor.value).toEqual({ uidValidity: "1", lastUid: 3 });
    expect(h.transport.health().state).toBe("live");
  });

  test("a new mail reaches the sink and moves the cursor", async () => {
    const f = await fixture();
    for (const n of [1, 2, 3]) f.deliver(mail(n));
    const h = harness(f);
    await h.transport.start();
    f.deliver(mail(4));
    await waitFor(() => h.received.length === 1, 2000);
    await waitFor(() => h.cursor.value?.lastUid === 4, 2000);
    const [m] = h.received;
    expect(m!.inboxId).toBe("inb_test");
    expect(m!.providerId).toBe("imap:1:4");
    expect(m!.subject).toBe("Mail 4");
    expect(m!.keys.messageId).toBe("m4@example.test");
    expect(h.transport.health().lastMessageAt).not.toBeNull();
  });

  test("a restart catches up from the stored cursor, in order", async () => {
    const f = await fixture();
    for (const n of [1, 2, 3]) f.deliver(mail(n));
    const h = harness(f, { initialCursor: { uidValidity: "1", lastUid: 1 } });
    await h.transport.start();
    await waitFor(() => h.received.length === 2);
    expect(h.received.map((m) => m.subject)).toEqual(["Mail 2", "Mail 3"]);
    expect(h.cursor.value).toEqual({ uidValidity: "1", lastUid: 3 });
  });

  test("the cursor advances only after the sink resolves", async () => {
    const f = await fixture();
    for (const n of [1, 2]) f.deliver(mail(n));
    const clock = fakeClock();
    const offered: string[] = [];
    let fail = true;
    const h = harness(f, {
      initialCursor: { uidValidity: "1", lastUid: 1 },
      timers: clock,
      random: () => 1,
      sink: async (m) => {
        offered.push(m.subject);
        if (fail) {
          fail = false;
          throw new Error("store unavailable");
        }
        return "stored";
      },
    });
    await h.transport.start();
    await waitFor(() => h.transport.health().state === "backing-off");
    expect(offered).toEqual(["Mail 2"]);
    expect(h.cursor.value).toEqual({ uidValidity: "1", lastUid: 1 });
    const retryAt = Date.parse(h.transport.health().retryAt!);
    expect(retryAt - clock.now()).toBeGreaterThanOrEqual(30_000);
    clock.advanceTo(retryAt);
    await waitFor(() => h.cursor.value?.lastUid === 2);
    expect(offered).toEqual(["Mail 2", "Mail 2"]);
  });

  test("without IDLE the transport polls", async () => {
    const f = await fixture({
      plugins: DEFAULT_IMAP_PLUGINS.filter((p) => p !== "IDLE"),
    });
    const h = harness(f, { pollMs: 200 });
    await h.transport.start();
    expect(h.transport.health().state).toBe("polling");
    f.deliver(mail(1));
    await waitFor(() => h.received.length === 1, 3000);
    expect(h.received[0]!.subject).toBe("Mail 1");
  });

  test("an auth failure pauses without retrying", async () => {
    const f = await fixture();
    const login = scriptLogin(f, () => ({
      code: "AUTHENTICATIONFAILED",
      text: "Invalid credentials",
    }));
    const clock = fakeClock();
    const h = harness(f, { timers: clock });
    await h.transport.start();
    const health = h.transport.health();
    expect(health.state).toBe("paused");
    expect(health.retryAt).toBeNull();
    expect(health.reason).toContain("password");
    expect(clock.pending()).toBe(0);
    expect(login.count()).toBe(1);
    clock.advance(3_600_000);
    await flush();
    expect(login.count()).toBe(1);
    expect(f.connections()).toBe(0);
  });

  test("a refused login with an ALERT pauses without retrying", async () => {
    const f = await fixture();
    const login = scriptLogin(f, () => ({
      code: "ALERT",
      text: "Application-specific password required\x07",
    }));
    const clock = fakeClock();
    const h = harness(f, { timers: clock });
    await h.transport.start();
    const health = h.transport.health();
    expect(health.state).toBe("paused");
    expect(health.retryAt).toBeNull();
    expect(health.reason).toContain("Application-specific password required");
    expect(health.reason).not.toContain("\x07");
    expect(clock.pending()).toBe(0);
    expect(login.count()).toBe(1);
    clock.advance(3_600_000);
    await flush();
    expect(login.count()).toBe(1);
    expect(f.connections()).toBe(0);
  });

  test("an informational ALERT keeps the connection live", async () => {
    const f = await fixture();
    const h = harness(f);
    await h.transport.start();
    expect(h.transport.health().state).toBe("live");
    for (const conn of f.imap.connections)
      conn.send(
        {
          tag: "*",
          command: "OK",
          attributes: [
            { type: "SECTION", section: [{ type: "ATOM", value: "ALERT" }] },
            { type: "TEXT", value: "Mailbox almost full" },
          ],
        },
        "ALERT",
      );
    await waitFor(
      () => h.transport.health().reason?.includes("Mailbox almost full") ?? false,
    );
    expect(h.transport.health().state).toBe("live");
    f.deliver(mail(1));
    await waitFor(() => h.received.length === 1);
    expect(h.transport.health().state).toBe("live");
    expect(f.connections()).toBe(1);
  });

  test("a throttled login backs off and reconnects once", async () => {
    const f = await fixture();
    const login = scriptLogin(f, (n) =>
      n === 1 ? { code: "THROTTLED", text: "Too many requests" } : null,
    );
    const clock = fakeClock();
    const h = harness(f, { timers: clock, random: () => 1 });
    await h.transport.start();
    const health = h.transport.health();
    expect(health.state).toBe("backing-off");
    const retryAt = Date.parse(health.retryAt!);
    expect(retryAt - clock.now()).toBeGreaterThanOrEqual(30_000);
    clock.advanceTo(retryAt - 1);
    await Bun.sleep(100);
    expect(login.count()).toBe(1);
    clock.advanceTo(retryAt);
    await waitFor(() => h.transport.health().state === "live");
    expect(login.count()).toBe(2);
  });

  test("repeated failures do not storm the server", async () => {
    const f = await fixture();
    const login = scriptLogin(f, () => ({
      code: "THROTTLED",
      text: "Too many requests",
    }));
    const clock = fakeClock();
    const h = harness(f, { timers: clock, random: () => 1 });
    await h.transport.start();
    for (;;) {
      const health = h.transport.health();
      expect(health.state).toBe("backing-off");
      const at = Date.parse(health.retryAt!);
      if (at - START > BACKOFF_MAX_MS) break;
      clock.advanceTo(at);
      await waitFor(() => {
        const next = h.transport.health();
        return next.state === "backing-off" && next.retryAt !== health.retryAt;
      });
    }
    expect(login.count()).toBeGreaterThanOrEqual(5);
    expect(login.count()).toBeLessThanOrEqual(6);
  });

  test("an oversize message is stored as headers only", async () => {
    const f = await fixture();
    const h = harness(f, { maxSourceBytes: 1024 });
    await h.transport.start();
    f.deliver(mail(1, 4096));
    await waitFor(() => h.received.length === 1);
    const [m] = h.received;
    expect(m!.oversize).toBe(true);
    expect(m!.text).toBe("");
    expect(m!.subject).toBe("Mail 1");
  });

  test("a UIDVALIDITY change resets the cursor and imports nothing", async () => {
    const f = await fixture();
    f.imap.getMailbox("INBOX").uidvalidity = 7;
    for (const n of [1, 2]) f.deliver(mail(n));
    const h = harness(f, { initialCursor: { uidValidity: "1", lastUid: 5 } });
    await h.transport.start();
    expect(h.received).toEqual([]);
    expect(h.cursor.value).toEqual({ uidValidity: "7", lastUid: 2 });
  });

  test("withClient rejects when not connected", async () => {
    const f = await fixture();
    const h = harness(f);
    await expect(h.transport.withClient(async () => 1)).rejects.toThrow();
    await h.transport.start();
    expect(await h.transport.withClient(async (c) => c.usable)).toBe(true);
    await h.transport.stop();
    expect(h.transport.health().state).toBe("off");
    await expect(h.transport.withClient(async () => 1)).rejects.toThrow();
  });
});

describe("testImapLogin", () => {
  test("reports capabilities and the Sent folder", async () => {
    const f = await fixture();
    const server = {
      host: "127.0.0.1",
      port: f.imapPort,
      secure: false,
      user: MAIL_USER,
    };
    expect(await testImapLogin(server, MAIL_PASSWORD)).toEqual({
      ok: true,
      idle: true,
      condstore: true,
      sentFolder: "Sent",
    });
  });

  test("a wrong password is an auth failure", async () => {
    const f = await fixture();
    const server = {
      host: "127.0.0.1",
      port: f.imapPort,
      secure: false,
      user: MAIL_USER,
    };
    const result = await testImapLogin(server, "wrong");
    expect(result).toMatchObject({ ok: false, kind: "auth" });
    expect(JSON.stringify(result)).not.toContain("wrong");
  });
});
