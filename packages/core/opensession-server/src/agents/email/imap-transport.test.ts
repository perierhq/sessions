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

/** Counts one command (`UID SEARCH` is its own name); `refuse` answers
 *  NO instead of running it. */
function countCommands(
  f: MailFixture,
  name: string,
  refuse?: (data: string) => boolean,
): { count: () => number } {
  const original = f.imap.getCommandHandler(name);
  let n = 0;
  f.imap.setCommandHandler(
    name,
    (conn: any, parsed: any, data: any, callback: () => void) => {
      n++;
      if (refuse?.(String(data))) {
        conn.sendStatus(parsed, data, "NO", "Refused for the test");
        callback();
        return;
      }
      return original(conn, parsed, data, callback);
    },
  );
  return { count: () => n };
}

/** Drops every server-side connection, as a server restart would. */
function dropConnections(f: MailFixture): void {
  for (const conn of f.imap.connections) conn.socket?.destroy();
}

describe("ImapTransport", () => {
  test("first start imports nothing and starts at the newest UID", async () => {
    const f = await fixture();
    for (const n of [1, 2, 3]) f.deliver(mail(n));
    const h = harness(f);
    await h.transport.start();
    expect(h.received).toEqual([]);
    expect(h.cursor.value).toMatchObject({ uidValidity: "1", lastUid: 3 });
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
    expect(h.cursor.value).toMatchObject({ uidValidity: "1", lastUid: 3 });
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
    expect(h.cursor.value).toMatchObject({ uidValidity: "1", lastUid: 1 });
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
      () =>
        h.transport.health().reason?.includes("Mailbox almost full") ?? false,
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
    // The retry timer starts the connect synchronously, so the state tells.
    expect(h.transport.health().state).toBe("backing-off");
    expect(clock.pending()).toBe(1);
    expect(login.count()).toBe(1);
    clock.advanceTo(retryAt);
    await waitFor(() => h.transport.health().state === "live");
    expect(login.count()).toBe(2);
  });

  test("too many connections backs off", async () => {
    const f = await fixture();
    const login = scriptLogin(f, () => ({
      code: "",
      text: "Too many simultaneous connections",
    }));
    const clock = fakeClock();
    const h = harness(f, { timers: clock, random: () => 1 });
    await h.transport.start();
    const health = h.transport.health();
    expect(health.state).toBe("backing-off");
    expect(health.reason).toContain("too many open connections");
    expect(Date.parse(health.retryAt!) - clock.now()).toBe(30_000);
    expect(login.count()).toBe(1);
  });

  test("five minutes live resets the backoff", async () => {
    const f = await fixture();
    scriptLogin(f, (n) =>
      n <= 2 ? { code: "THROTTLED", text: "Too many requests" } : null,
    );
    const clock = fakeClock();
    const h = harness(f, { timers: clock, random: () => 1 });
    await h.transport.start();
    for (const delay of [30_000, 60_000]) {
      const at = Date.parse(h.transport.health().retryAt!);
      expect(at - clock.now()).toBe(delay);
      clock.advanceTo(at);
      await waitFor(() => h.transport.health().state !== "connecting");
    }
    expect(h.transport.health().state).toBe("live");

    // Dropped before five minutes: the backoff keeps growing.
    clock.advance(299_000);
    dropConnections(f);
    await waitFor(() => h.transport.health().state === "backing-off");
    let at = Date.parse(h.transport.health().retryAt!);
    expect(at - clock.now()).toBe(120_000);
    clock.advanceTo(at);
    await waitFor(() => h.transport.health().state === "live");

    // Live five minutes: the next drop starts over.
    clock.advance(300_000);
    dropConnections(f);
    await waitFor(() => h.transport.health().state === "backing-off");
    at = Date.parse(h.transport.health().retryAt!);
    expect(at - clock.now()).toBe(30_000);
  });

  test("retries are at least 30 s apart even with zero jitter", async () => {
    const f = await fixture();
    const clock = fakeClock();
    const times: number[] = [];
    scriptLogin(f, () => {
      times.push(clock.now());
      return { code: "THROTTLED", text: "Too many requests" };
    });
    const h = harness(f, { timers: clock, random: () => 0 });
    await h.transport.start();
    for (let i = 0; i < 6; i++) {
      const before = h.transport.health().retryAt;
      clock.advanceTo(Date.parse(before!));
      await waitFor(() => {
        const next = h.transport.health();
        return next.state === "backing-off" && next.retryAt !== before;
      });
    }
    expect(times.length).toBe(7);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(30_000);
  });

  test("stop() during a backoff leaves no timer and no connection", async () => {
    const f = await fixture();
    const login = scriptLogin(f, () => ({
      code: "THROTTLED",
      text: "Too many requests",
    }));
    const clock = fakeClock();
    const h = harness(f, { timers: clock });
    await h.transport.start();
    expect(h.transport.health().state).toBe("backing-off");
    await h.transport.stop();
    expect(clock.pending()).toBe(0);
    expect(h.transport.health().state).toBe("off");
    clock.advance(3_600_000);
    await flush();
    expect(login.count()).toBe(1);
    await waitFor(() => f.connections() === 0);
  });

  test("stop() during connect leaves no timer and no connection", async () => {
    const f = await fixture();
    const clock = fakeClock();
    const h = harness(f, { timers: clock });
    const started = h.transport.start();
    await h.transport.stop();
    await started;
    expect(clock.pending()).toBe(0);
    expect(h.transport.health().state).toBe("off");
    await waitFor(() => f.connections() === 0);
  });

  test("stop() gives up on a hung sink and a hung LOGOUT", async () => {
    const f = await fixture();
    f.imap.setCommandHandler("LOGOUT", () => undefined);
    const clock = fakeClock();
    const offered: string[] = [];
    const h = harness(f, {
      timers: clock,
      sink: async (m) => {
        offered.push(m.subject);
        return new Promise(() => undefined);
      },
    });
    await h.transport.start();
    f.deliver(mail(1));
    await waitFor(() => offered.length === 1);
    let stopped = false;
    const stopping = h.transport.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    clock.advance(5_000);
    await flush();
    clock.advance(5_000);
    await stopping;
    expect(clock.pending()).toBe(0);
    expect(h.cursor.value).toMatchObject({ lastUid: 0 });
    await waitFor(() => f.connections() === 0);
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

  test("a UIDVALIDITY change offers recent mail again, then resets the cursor", async () => {
    const f = await fixture();
    f.imap.getMailbox("INBOX").uidvalidity = 7;
    const day = 86_400_000;
    const at = (ms: number) => new Date(Date.now() - ms);
    f.imap.appendMessage("INBOX", [], at(10 * day), mail(1));
    f.imap.appendMessage("INBOX", [], at(3.5 * day), mail(2));
    f.deliver(mail(3));
    const h = harness(f, {
      initialCursor: {
        uidValidity: "1",
        lastUid: 5,
        lastReceivedAt: at(3 * day).toISOString(),
      },
    });
    await h.transport.start();
    expect(h.received.map((m) => m.subject)).toEqual(["Mail 2", "Mail 3"]);
    expect(h.received[0]!.providerId).toBe("imap:7:2");
    expect(h.cursor.value).toMatchObject({ uidValidity: "7", lastUid: 3 });
  });

  test("a UIDVALIDITY change never looks back more than 7 days", async () => {
    const f = await fixture();
    f.imap.getMailbox("INBOX").uidvalidity = 7;
    const day = 86_400_000;
    f.imap.appendMessage("INBOX", [], new Date(Date.now() - 9 * day), mail(1));
    f.deliver(mail(2));
    const h = harness(f, {
      initialCursor: {
        uidValidity: "1",
        lastUid: 5,
        lastReceivedAt: new Date(Date.now() - 30 * day).toISOString(),
      },
    });
    await h.transport.start();
    expect(h.received.map((m) => m.subject)).toEqual(["Mail 2"]);
    expect(h.cursor.value).toMatchObject({ uidValidity: "7", lastUid: 2 });
  });

  test("a UIDVALIDITY recovery that the sink refuses keeps the old cursor", async () => {
    const f = await fixture();
    f.imap.getMailbox("INBOX").uidvalidity = 7;
    f.deliver(mail(1));
    const old = {
      uidValidity: "1",
      lastUid: 5,
      lastReceivedAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const h = harness(f, {
      initialCursor: old,
      sink: async () => {
        throw new Error("store unavailable");
      },
    });
    await h.transport.start();
    expect(h.transport.health().state).toBe("backing-off");
    expect(h.cursor.value).toEqual(old);
  });

  test("a new cursor records when it was set", async () => {
    const f = await fixture();
    const clock = fakeClock();
    const h = harness(f, { timers: clock });
    await h.transport.start();
    expect(h.cursor.value).toEqual({
      uidValidity: "1",
      lastUid: 0,
      lastReceivedAt: new Date(START).toISOString(),
    });
  });

  test("nothing new since the cursor: no search on connect", async () => {
    const f = await fixture();
    for (const n of [1, 2, 3]) f.deliver(mail(n));
    const search = countCommands(f, "UID SEARCH");
    const h = harness(f, { initialCursor: { uidValidity: "1", lastUid: 3 } });
    await h.transport.start();
    expect(h.transport.health().state).toBe("live");
    expect(search.count()).toBe(0);
    f.deliver(mail(4));
    await waitFor(() => h.received.length === 1);
    expect(h.received[0]!.subject).toBe("Mail 4");
  });

  test("poll mode keeps the socket open longer than the poll interval", async () => {
    const f = await fixture({
      plugins: DEFAULT_IMAP_PLUGINS.filter((p) => p !== "IDLE"),
    });
    const clock = fakeClock();
    const h = harness(f, { timers: clock, pollMs: 300_000 });
    await h.transport.start();
    expect(h.transport.health().state).toBe("polling");
    const socketTimeout = await h.transport.withClient(
      async (c) => (c as unknown as { socketTimeout: number }).socketTimeout,
    );
    expect(socketTimeout).toBeGreaterThan(300_000);
  });

  test("a hung sink times out and the message is offered again", async () => {
    const f = await fixture();
    const clock = fakeClock();
    const offered: string[] = [];
    let hang = true;
    const h = harness(f, {
      timers: clock,
      random: () => 1,
      sink: async (m) => {
        offered.push(m.subject);
        if (hang) {
          hang = false;
          return new Promise(() => undefined);
        }
        return "stored";
      },
    });
    await h.transport.start();
    f.deliver(mail(1));
    await waitFor(() => offered.length === 1);
    expect(h.transport.health().state).toBe("live");
    clock.advance(119_999);
    await flush();
    expect(h.transport.health().state).toBe("live");
    clock.advance(1);
    await waitFor(() => h.transport.health().state === "backing-off");
    expect(h.transport.health().reason).toContain("Couldn't store");
    expect(h.cursor.value).toMatchObject({ lastUid: 0 });
    clock.advanceTo(Date.parse(h.transport.health().retryAt!));
    await waitFor(() => h.cursor.value?.lastUid === 1);
    expect(offered).toEqual(["Mail 1", "Mail 1"]);
  });

  test("a cursor that can't be saved backs off and re-offers", async () => {
    const f = await fixture();
    const clock = fakeClock();
    const h = harness(f, { timers: clock, random: () => 1 });
    await h.transport.start();
    let failSave = true;
    const saved: ImapCursor[] = [];
    (h.transport as unknown as { opts: ImapTransportOptions }).opts.saveCursor =
      async (c) => {
        if (failSave) {
          failSave = false;
          throw new Error("disk full");
        }
        saved.push(c);
      };
    f.deliver(mail(1));
    await waitFor(() => h.transport.health().state === "backing-off");
    expect(h.transport.health().reason).toContain("position");
    clock.advanceTo(Date.parse(h.transport.health().retryAt!));
    await waitFor(() => saved.some((c) => c.lastUid === 1));
    expect(h.received.map((m) => m.subject)).toEqual(["Mail 1", "Mail 1"]);
  });

  test("a message that can't be parsed is offered as unreadable and passed", async () => {
    const f = await fixture();
    const h = harness(f);
    await h.transport.start();
    // mailparser refuses a header block over 1 MB.
    const refs = Array.from({ length: 100_000 }, (_, i) => `r${i}@x.test`);
    f.deliver(
      rawMail({
        from: "Ada <ada@example.test>",
        subject: "Huge headers",
        references: refs,
      }),
    );
    f.deliver(mail(2));
    await waitFor(() => h.received.length === 2);
    const [broken, next] = h.received;
    expect(broken!.unreadable).toBe(true);
    expect(broken!.oversize).toBeUndefined();
    expect(broken!.text).toBe("(This message couldn't be read)");
    expect(broken!.subject).toBe("Huge headers");
    expect(next!.subject).toBe("Mail 2");
    await waitFor(() => h.cursor.value?.lastUid === 2);
  });

  test("an IMAP error while fetching a message is not skipped", async () => {
    const f = await fixture();
    const clock = fakeClock();
    let refuse = true;
    countCommands(f, "UID FETCH", (data) => {
      if (refuse && /BODY\.PEEK\[\]/i.test(data)) {
        refuse = false;
        return true;
      }
      return false;
    });
    const h = harness(f, { timers: clock, random: () => 1 });
    await h.transport.start();
    f.deliver(mail(1));
    await waitFor(() => h.transport.health().state === "backing-off");
    expect(h.received).toEqual([]);
    expect(h.cursor.value).toMatchObject({ lastUid: 0 });
    clock.advanceTo(Date.parse(h.transport.health().retryAt!));
    await waitFor(() => h.received.length === 1);
    expect(h.received[0]!.subject).toBe("Mail 1");
  });

  test("a message bigger than its reported size takes the oversize path", async () => {
    const handlers = require("hoodiecrow-imap/lib/commands/handlers/fetch");
    const size = handlers["RFC822.SIZE"];
    handlers["RFC822.SIZE"] = () => 10;
    try {
      const f = await fixture();
      const h = harness(f, { maxSourceBytes: 1024 });
      await h.transport.start();
      f.deliver(mail(1, 4096));
      await waitFor(() => h.received.length === 1);
      expect(h.received[0]!.oversize).toBe(true);
      expect(h.received[0]!.text).toBe("");
      expect(h.received[0]!.subject).toBe("Mail 1");
    } finally {
      handlers["RFC822.SIZE"] = size;
    }
  });

  test("an untouched mailbox is opened read-only and flags stay unchanged", async () => {
    const f = await fixture();
    const examine = countCommands(f, "EXAMINE");
    const select = countCommands(f, "SELECT");
    const h = harness(f);
    await h.transport.start();
    f.deliver(mail(1));
    await waitFor(() => h.cursor.value?.lastUid === 1);
    expect(examine.count()).toBe(1);
    expect(select.count()).toBe(0);
    const [stored] = f.imap.getMailbox("INBOX").messages;
    expect(stored.flags).not.toContain("\\Seen");
    expect(stored.flags).toEqual([]);
  });

  test("a mailbox the inbox changes is selected", async () => {
    const f = await fixture();
    const examine = countCommands(f, "EXAMINE");
    const select = countCommands(f, "SELECT");
    const h = harness(f, { inbox: { ...inboxFor(f), mailbox: "mark-read" } });
    await h.transport.start();
    expect(select.count()).toBe(1);
    expect(examine.count()).toBe(0);
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

  test("opens INBOX read-only", async () => {
    const f = await fixture();
    const examine = countCommands(f, "EXAMINE");
    const server = {
      host: "127.0.0.1",
      port: f.imapPort,
      secure: false,
      user: MAIL_USER,
    };
    expect((await testImapLogin(server, MAIL_PASSWORD)).ok).toBe(true);
    expect(examine.count()).toBe(1);
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
