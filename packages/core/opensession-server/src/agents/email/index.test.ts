import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { InboxConfig } from "../../shared/support";
import { __setOwnerRosterForTest } from "../../server/incidents/owner";
import { __setIdentitiesForTest } from "../../server/shared/user-mappings";
import { catalogDocuments } from "../../server/catalog-documents";
import { configuredIntegration } from "../../server/config";
import { isEnabled } from "../../server/integrations/load";
import { findIntegration } from "../../server/integrations/registry";
import { channelAdapterFor } from "../../server/support/channel";
import { __setSupportEventPublisherForTest } from "../../server/support/events";
import {
  __awaitInboundForTest,
  setSupportPipeline,
} from "../../server/support/ingest";
import {
  __setInboxProjectCheckForTest,
  createInbox,
  deleteInbox,
  getInbox,
  inboxCursorKey,
  updateInbox,
} from "../../server/support/inboxes";
import { listIndexRows } from "../../server/support/store";
import {
  TEST_PROJECTS,
  useSupportTestKernel,
} from "../../server/support/testing/kernel-fixture";
import {
  MAIL_PASSWORD,
  MAIL_USER,
  type MailFixture,
  rawMail,
  startMailFixture,
} from "../../server/support/testing/mail-fixture";
import { EmailAgent } from "./index";

const kernel = useSupportTestKernel();

const ADA = { name: "Ada", verified: true, isInstanceOwner: true };

let f: MailFixture;
let agent: EmailAgent | null = null;
let previousSecrets: string | undefined;
let restoreIdentities: (() => void) | undefined;
let opened = 0;
let maxLive = 0;
let sampler: ReturnType<typeof setInterval> | undefined;

beforeEach(async () => {
  f = await startMailFixture();
  opened = 0;
  maxLive = 0;
  f.imap.server.on("connection", () => {
    opened++;
  });
  sampler = setInterval(() => {
    maxLive = Math.max(maxLive, f.connections());
  }, 2);
  restoreIdentities = __setIdentitiesForTest([]);
  __setOwnerRosterForTest([]);
  __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  __setSupportEventPublisherForTest(async () => 0);
  setSupportPipeline({ async onInbound() {} });
  previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    kernel.root(),
    "workspace-secrets.json",
  );
});

afterEach(async () => {
  await agent?.shutdown();
  agent = null;
  clearInterval(sampler);
  await __awaitInboundForTest();
  setSupportPipeline(null);
  __setSupportEventPublisherForTest(undefined);
  __setInboxProjectCheckForTest(undefined);
  __setOwnerRosterForTest(undefined);
  restoreIdentities?.();
  if (previousSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
  await f.close();
});

/** Counts LOGIN commands; `refusal(n)` answers NO with that code and text
 *  for the nth one, or null to log in. */
function scriptLogin(
  refusal: (n: number) => { code: string; text: string } | null,
): { count: () => number } {
  const original = f.imap.getCommandHandler("LOGIN");
  let n = 0;
  f.imap.setCommandHandler(
    "LOGIN",
    (conn: any, parsed: any, data: any, callback: () => void) => {
      n++;
      const refuse = refusal(n);
      if (!refuse) return original(conn, parsed, data, callback);
      conn.sendStatus(parsed, data, "NO", refuse.text, refuse.code);
      callback();
    },
  );
  return { count: () => n };
}

const cursorOf = (id: string) =>
  catalogDocuments("support-cursors").get(inboxCursorKey(id));

async function newInbox(
  address: string,
  over: Record<string, unknown> = {},
): Promise<InboxConfig> {
  const server = (port: number) => ({
    host: "127.0.0.1",
    port,
    tls: "none" as const,
    user: MAIL_USER,
    password: MAIL_PASSWORD,
  });
  const result = await createInbox(
    {
      label: "Acme help",
      address,
      project: "acme",
      allowInternalHost: true,
      imap: server(f.imapPort),
      smtp: server(f.smtpPort),
      ...over,
    },
    ADA,
  );
  if (!result.ok) throw new Error(result.error);
  return result.inbox;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

async function started(): Promise<EmailAgent> {
  agent = new EmailAgent({ coalesceMs: 100, imap: { autoIdleDelayMs: 50 } });
  await agent.startup();
  return agent;
}

async function update(
  inbox: InboxConfig,
  patch: Record<string, unknown>,
): Promise<InboxConfig> {
  const result = await updateInbox(
    inbox.id,
    { expectedRevision: inbox.revision, ...patch },
    ADA,
  );
  if (!result.ok) throw new Error(result.error);
  return result.inbox;
}

describe("EmailAgent", () => {
  test("one enabled inbox gets one connection, and its mail is stored", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    expect(f.connections()).toBe(1);
    f.deliver(
      rawMail({
        from: "Ada <ada@example.test>",
        to: "help@acme.example.test",
        messageId: "first@example.test",
        subject: "Login broken",
      }),
    );
    let rows: Awaited<ReturnType<typeof listIndexRows>> = [];
    const end = Date.now() + 3000;
    while (rows.length === 0 && Date.now() < end) {
      await Bun.sleep(20);
      rows = await listIndexRows();
    }
    expect(rows).toHaveLength(1);
    expect(f.connections()).toBe(1);
  });

  test("a disabled inbox has no connection, and enabling it connects again", async () => {
    let inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => f.connections() === 1);
    inbox = await update(inbox, { enabled: false });
    await until(() => f.connections() === 0, 2000);
    expect(channelAdapterFor(inbox.id)).toBeUndefined();
    inbox = await update(inbox, { enabled: true });
    await until(() => f.connections() === 1, 2000);
    expect(channelAdapterFor(inbox.id)).toBeDefined();
    expect(maxLive).toBe(1);
  });

  test("a new IMAP password reconnects exactly once", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => f.connections() === 1);
    const before = channelAdapterFor(inbox.id);
    expect(opened).toBe(1);
    f.imap.users.testuser.password = "newpass-2b";
    await update(inbox, { imap: { password: "newpass-2b" } });
    await until(() => opened === 2, 2000);
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    await Bun.sleep(300);
    expect(opened).toBe(2);
    expect(maxLive).toBe(1);
    expect(f.connections()).toBe(1);
    expect(channelAdapterFor(inbox.id)).not.toBe(before);
  });

  test("changes close together coalesce into one reconnect", async () => {
    let inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => f.connections() === 1);
    f.imap.users.testuser.password = "newpass-3c";
    inbox = await update(inbox, { imap: { password: "newpass-3c" } });
    inbox = await update(inbox, { smtp: { password: "newpass-3c" } });
    inbox = await update(inbox, { label: "Acme support" });
    await until(() => opened === 2, 2000);
    await Bun.sleep(400);
    expect(opened).toBe(2);
    expect(maxLive).toBe(1);
  });

  test("other fields update the adapter in place without reconnecting", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => f.connections() === 1);
    const before = channelAdapterFor(inbox.id);
    await update(inbox, { label: "Acme support", copyToSent: false });
    await Bun.sleep(400);
    expect(opened).toBe(1);
    expect(channelAdapterFor(inbox.id)).toBe(before);
    expect((before as any).inbox.label).toBe("Acme support");
  });

  test("two inboxes get two connections; deleting one leaves one", async () => {
    await newInbox("help@acme.example.test");
    const second = await newInbox("billing@acme.example.test");
    await started();
    await until(() => f.connections() === 2);
    const removed = await deleteInbox(second.id, ADA);
    expect(removed.ok).toBe(true);
    await until(() => f.connections() === 1, 2000);
    expect(channelAdapterFor(second.id)).toBeUndefined();
  });

  test("an inbox created after startup connects", async () => {
    await started();
    expect(f.connections()).toBe(0);
    await newInbox("help@acme.example.test");
    await until(() => f.connections() === 1, 2000);
  });

  test("health lists inboxes without any address", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => f.connections() === 1);
    const health = agent!.health();
    expect(health).toMatchObject({
      inboxes: [{ id: inbox.id, state: "live", reason: null }],
    });
    expect(JSON.stringify(health)).not.toContain("@");
  });

  test("a paused inbox saved with nothing changed logs in once and goes live", async () => {
    let refuse = true;
    const login = scriptLogin(() =>
      refuse ? { code: "AUTHENTICATIONFAILED", text: "Invalid" } : null,
    );
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "paused");
    expect(login.count()).toBe(1);
    const before = channelAdapterFor(inbox.id);
    refuse = false;
    await update(inbox, { label: "Acme support" });
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    await Bun.sleep(300);
    expect(login.count()).toBe(2);
    expect(channelAdapterFor(inbox.id)).toBe(before);
    expect(f.connections()).toBe(1);
  });

  test("a disabled inbox at startup gets no connection", async () => {
    const inbox = await newInbox("help@acme.example.test", { enabled: false });
    await started();
    await Bun.sleep(300);
    expect(f.connections()).toBe(0);
    expect(opened).toBe(0);
    expect(channelAdapterFor(inbox.id)).toBeUndefined();
  });

  test("mail read while the inbox is disabled keeps the cursor where it was", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    const cursor = (await cursorOf(inbox.id)) as { lastUid: number };
    // Disabled behind the agent's back: the connection is still up.
    await catalogDocuments("support-inboxes").update(inbox.id, (value) => ({
      ...(value as object),
      enabled: false,
    }));
    expect((await getInbox(inbox.id))?.enabled).toBe(false);
    f.deliver(
      rawMail({
        from: "Ada <ada@example.test>",
        to: "help@acme.example.test",
        messageId: "while-off@example.test",
      }),
    );
    await until(
      () => channelAdapterFor(inbox.id)?.health().state === "backing-off",
    );
    expect(await cursorOf(inbox.id)).toMatchObject({
      lastUid: cursor.lastUid,
    });
    expect(await listIndexRows()).toHaveLength(0);
  });

  test("deleting an inbox removes its cursor", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    expect(await cursorOf(inbox.id)).not.toBeNull();
    expect((await deleteInbox(inbox.id, ADA)).ok).toBe(true);
    await until(() => f.connections() === 0, 2000);
    expect(await cursorOf(inbox.id)).toBeNull();
  });

  test("deleting an inbox removes its cursor without the agent running", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await catalogDocuments("support-cursors").set(inboxCursorKey(inbox.id), {
      uidValidity: "1",
      lastUid: 3,
    });
    expect((await deleteInbox(inbox.id, ADA)).ok).toBe(true);
    expect(await cursorOf(inbox.id)).toBeNull();
  });

  test("health cuts addresses out of server ALERT text", async () => {
    scriptLogin(() => ({
      code: "ALERT",
      text: "Log in at the web site first, help@acme.example.test",
    }));
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "paused");
    const health = agent!.health() as { inboxes: Array<{ reason: string }> };
    expect(health.inboxes[0]!.reason).toContain("Log in at the web site");
    expect(health.inboxes[0]!.reason).toContain("[address]");
    expect(JSON.stringify(health)).not.toContain("@");
  });

  test("a new address or send limit keeps the IMAP connection", async () => {
    let inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    const before = channelAdapterFor(inbox.id);
    inbox = await update(inbox, { address: "support@acme.example.test" });
    inbox = await update(inbox, { sendLimitPerMinute: 10 });
    await Bun.sleep(400);
    expect(opened).toBe(1);
    expect(channelAdapterFor(inbox.id)).toBe(before);
    expect((before as any).inbox.address).toBe("support@acme.example.test");
  });

  test("the agent keeps no password in its own state", async () => {
    const inbox = await newInbox("help@acme.example.test");
    await started();
    await until(() => channelAdapterFor(inbox.id)?.health().state === "live");
    const live = (agent as any).live.get(inbox.id);
    expect(JSON.stringify(live.passwords)).not.toContain(MAIL_PASSWORD);
  });

  test("shutdown closes every connection", async () => {
    await newInbox("help@acme.example.test");
    const a = await started();
    await until(() => f.connections() === 1);
    await a.shutdown();
    agent = null;
    await until(() => f.connections() === 0, 2000);
  });
});

describe("ENABLE_EMAIL_SUPPORT", () => {
  const spec = findIntegration("email")!;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ENABLE_EMAIL_SUPPORT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ENABLE_EMAIL_SUPPORT;
    else process.env.ENABLE_EMAIL_SUPPORT = saved;
  });

  test("only the literal 'true' turns it on", () => {
    process.env.ENABLE_EMAIL_SUPPORT = "true";
    expect(isEnabled(spec)).toBe(true);
    process.env.ENABLE_EMAIL_SUPPORT = "1";
    expect(isEnabled(spec)).toBe(false);
    process.env.ENABLE_EMAIL_SUPPORT = "TRUE";
    expect(isEnabled(spec)).toBe(false);
  });

  test("unset, the config decides", () => {
    delete process.env.ENABLE_EMAIL_SUPPORT;
    expect(isEnabled(spec)).toBe(
      configuredIntegration("email").enabled === true,
    );
  });
});
