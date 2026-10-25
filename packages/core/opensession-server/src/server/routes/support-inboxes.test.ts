import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { InboxHealth, InboxView } from "../../shared/support";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { registerChannelAdapter } from "../support/channel";
import { __setMailHostResolverForTest } from "../support/mail-host";
import {
  type NewInbox,
  __setInboxProjectCheckForTest,
} from "../support/inboxes";
import {
  MAIL_PASSWORD,
  type MailFixture,
  startMailFixture,
} from "../support/testing/mail-fixture";
import {
  TEST_PROJECTS,
  useSupportTestKernel,
} from "../support/testing/kernel-fixture";
import type { RouteContext } from "./context";
import { routeHandlers } from "./index";
import {
  __resetInboxTestLimitsForTest,
  __setEmailSupportEnabledForTest,
  handleSupportInboxRoutes,
} from "./support-inboxes";

const kernel = useSupportTestKernel();

/** The instance owner (the roster's notify user). */
const ADA = { login: "ada", name: "Ada Lovelace" };
/** A signed-in teammate. */
const BEA = { login: "bea", name: "Bea Smith" };

const IMAP_PASSWORD = "imap-pass-4f1c";
const SMTP_PASSWORD = "smtp-pass-9a2e";

let previousSecrets: string | undefined;
beforeEach(() => {
  __setOwnerRosterForTest(
    [
      { name: "Ada Lovelace", github: "ada" },
      { name: "Bea Smith", github: "bea" },
    ] as never,
    "Ada",
  );
  __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  __setEmailSupportEnabledForTest(true);
  __resetInboxTestLimitsForTest();
  previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    kernel.root(),
    "workspace-secrets.json",
  );
});

let fixture: MailFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  __setOwnerRosterForTest(undefined);
  __setInboxProjectCheckForTest(undefined);
  __setEmailSupportEnabledForTest(undefined);
  if (previousSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  auth: RouteContext["authUser"] = ADA,
): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  const res = await handleSupportInboxRoutes({
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
          }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: auth,
  });
  if (!res) throw new Error(`${method} ${path} was not handled`);
  return res;
}

function newInbox(over: Partial<NewInbox> = {}): NewInbox {
  return {
    label: "Acme help",
    address: "help@acme.example.test",
    project: "acme",
    imap: {
      host: "imap.example.test",
      port: 993,
      tls: "implicit",
      user: "help@acme.example.test",
      password: IMAP_PASSWORD,
    },
    smtp: {
      host: "smtp.example.test",
      port: 465,
      tls: "implicit",
      user: "help@acme.example.test",
      password: SMTP_PASSWORD,
    },
    ...over,
  };
}

async function created(over: Partial<NewInbox> = {}): Promise<InboxView> {
  const res = await call("POST", "/api/support/inboxes", newInbox(over));
  expect(res.status).toBe(200);
  return ((await res.json()) as { inbox: InboxView }).inbox;
}

describe("support inbox routes", () => {
  test("are registered in the route chain", () => {
    expect(routeHandlers).toContain(handleSupportInboxRoutes);
  });

  test("a request that isn't signed in is refused", async () => {
    const res = await call("GET", "/api/support/inboxes", undefined, null);
    expect(res.status).toBe(401);
    const post = await call("POST", "/api/support/inboxes", newInbox(), null);
    expect(post.status).toBe(401);
  });

  test("a bad port answers 400 with the store's message", async () => {
    const res = await call(
      "POST",
      "/api/support/inboxes",
      newInbox({
        imap: { ...newInbox().imap, port: 70_000 },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "IMAP port must be a whole number from 1 to 65535",
    });
  });

  test("a created inbox lists without its passwords", async () => {
    const inbox = await created();
    expect(inbox.imap.hasPassword).toBe(true);
    const res = await call("GET", "/api/support/inboxes");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(IMAP_PASSWORD);
    expect(raw).not.toContain(SMTP_PASSWORD);
    expect(raw).not.toContain("passwordRef");
    const body = JSON.parse(raw) as {
      enabled: boolean;
      isInstanceOwner: boolean;
      inboxes: InboxView[];
    };
    expect(body.enabled).toBe(true);
    expect(body.isInstanceOwner).toBe(true);
    expect(body.inboxes).toHaveLength(1);
    expect(body.inboxes[0]!.imap.hasPassword).toBe(true);
    expect(body.inboxes[0]!.smtp.hasPassword).toBe(true);
    expect(body.inboxes[0]!.health.state).toBe("off");
  });

  test("a create may set the handling fields in the same call", async () => {
    const inbox = await created({
      autonomy: "routine",
      vetoMs: 600_000,
      bugHandling: "issue",
    } as Partial<NewInbox>);
    expect(inbox.autonomy).toBe("deploy-after-veto");
    expect(inbox.vetoMs).toBe(600_000);
    expect(inbox.bugHandling).toBe("issue");
  });

  test("health comes from the inbox's channel adapter", async () => {
    const inbox = await created();
    const health: InboxHealth = {
      state: "paused",
      since: "2026-10-25T10:00:00.000Z",
      reason: "The mail server refused the password",
      retryAt: null,
      lastMessageAt: null,
    };
    registerChannelAdapter({
      channel: "email",
      inboxId: inbox.id,
      connect: async () => {},
      disconnect: async () => {},
      health: () => health,
      send: async () => {
        throw new Error("unused");
      },
    });
    const body = (await (await call("GET", "/api/support/inboxes")).json()) as {
      inboxes: InboxView[];
    };
    expect(body.inboxes[0]!.health).toEqual(health);
  });

  test("the page knows when the email integration is off", async () => {
    __setEmailSupportEnabledForTest(false);
    const body = (await (await call("GET", "/api/support/inboxes")).json()) as {
      enabled: boolean;
    };
    expect(body.enabled).toBe(false);
  });

  test("a teammate isn't the instance owner", async () => {
    const body = (await (
      await call("GET", "/api/support/inboxes", undefined, BEA)
    ).json()) as { isInstanceOwner: boolean };
    expect(body.isInstanceOwner).toBe(false);
  });

  test("PATCH with a stale revision answers 409", async () => {
    const inbox = await created();
    const first = await call("PATCH", `/api/support/inboxes/${inbox.id}`, {
      expectedRevision: inbox.revision,
      label: "Acme support",
    });
    expect(first.status).toBe(200);
    const stale = await call("PATCH", `/api/support/inboxes/${inbox.id}`, {
      expectedRevision: inbox.revision,
      label: "Acme again",
    });
    expect(stale.status).toBe(409);
  });

  test("PATCH of a missing inbox answers 404", async () => {
    const res = await call("PATCH", "/api/support/inboxes/inb_0000", {
      expectedRevision: 0,
      label: "Nope",
    });
    expect(res.status).toBe(404);
  });

  test("only the instance owner may remove an inbox", async () => {
    const inbox = await created();
    const refused = await call(
      "DELETE",
      `/api/support/inboxes/${inbox.id}`,
      undefined,
      BEA,
    );
    expect(refused.status).toBe(403);
    const removed = await call("DELETE", `/api/support/inboxes/${inbox.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    const body = (await (await call("GET", "/api/support/inboxes")).json()) as {
      inboxes: InboxView[];
    };
    expect(body.inboxes).toEqual([]);
  });

  test("only the instance owner may forget a customer", async () => {
    const res = await call(
      "POST",
      "/api/support/customers/forget",
      { email: "someone@example.test" },
      BEA,
    );
    expect(res.status).toBe(403);
    const ok = await call("POST", "/api/support/customers/forget", {
      email: "someone@example.test",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ conversations: 0 });
  });

  test("the seventh connection test within a minute answers 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push(
        (
          await call("POST", "/api/support/inboxes/test", {
            inboxId: "inb_0000",
          })
        ).status,
      );
    expect(statuses.slice(0, 6)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(statuses[6]).toBe(429);
  });

  test("testing a saved inbox uses its stored passwords", async () => {
    fixture = await startMailFixture();
    const inbox = await created({
      allowInternalHost: true,
      imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
      smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
    });
    const res = await call("POST", "/api/support/inboxes/test", {
      inboxId: inbox.id,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imap: { ok: boolean; idle?: boolean };
      smtp: { ok: boolean };
    };
    expect(body.imap).toMatchObject({ ok: true, idle: true });
    expect(body.smtp).toEqual({ ok: true });
    expect(fixture.smtpAuthCalls).toBe(1);
  });

  test("a test never sends a stored password to a changed server", async () => {
    fixture = await startMailFixture();
    const inbox = await created({
      allowInternalHost: true,
      imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
      smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
    });
    const res = await call("POST", "/api/support/inboxes/test", {
      inboxId: inbox.id,
      imap: { ...fixture.imapServer, user: "someone-else" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Enter the IMAP password to test a changed server",
    });
  });
});

describe("support inbox routes: who may do what", () => {
  const AUTOMATION = {
    login: "automation",
    name: "Automation",
    automation: true,
  } as RouteContext["authUser"];

  test("the automation principal is refused", async () => {
    const res = await call(
      "GET",
      "/api/support/inboxes",
      undefined,
      AUTOMATION,
    );
    expect(res.status).toBe(401);
    const post = await call(
      "POST",
      "/api/support/inboxes",
      newInbox(),
      AUTOMATION,
    );
    expect(post.status).toBe(401);
  });

  test("a teammate can't allow internal mail servers on a new inbox", async () => {
    const res = await call(
      "POST",
      "/api/support/inboxes",
      newInbox({ allowInternalHost: true }),
      BEA,
    );
    expect(res.status).toBe(403);
  });

  test("a teammate can't let an inbox send right away", async () => {
    const post = await call(
      "POST",
      "/api/support/inboxes",
      newInbox({ autonomy: "routine", vetoMs: null }),
      BEA,
    );
    expect(post.status).toBe(403);
    const inbox = await created();
    const patch = await call(
      "PATCH",
      `/api/support/inboxes/${inbox.id}`,
      { expectedRevision: inbox.revision, autonomy: "routine", vetoMs: null },
      BEA,
    );
    expect(patch.status).toBe(403);
  });

  test("the owner is matched by GitHub login, not by first name", async () => {
    __setOwnerRosterForTest(
      [
        { name: "Ada Lovelace", github: "ada" },
        { name: "Ada Byron", github: "ada-b" },
      ] as never,
      "Ada",
    );
    const other = (await (
      await call("GET", "/api/support/inboxes", undefined, {
        login: "ada-b",
        name: "Ada Byron",
      })
    ).json()) as { isInstanceOwner: boolean };
    expect(other.isInstanceOwner).toBe(false);
    const owner = (await (
      await call("GET", "/api/support/inboxes")
    ).json()) as { isInstanceOwner: boolean };
    expect(owner.isInstanceOwner).toBe(true);
  });

  test("an empty owner on a new inbox means the person connecting it", async () => {
    const res = await call(
      "POST",
      "/api/support/inboxes",
      newInbox({ owner: "" }),
      BEA,
    );
    expect(res.status).toBe(200);
    const { inbox } = (await res.json()) as { inbox: InboxView };
    expect(inbox.owner).toBe("Bea");
  });

  test("an owner that isn't text is refused", async () => {
    const res = await call(
      "POST",
      "/api/support/inboxes",
      newInbox({ owner: 42 as never }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Owner must be a person" });
  });
});

describe("support inbox routes: audit and failures", () => {
  test("creates, updates and removals are audited with field names only", async () => {
    const inbox = await created();
    await call("PATCH", `/api/support/inboxes/${inbox.id}`, {
      expectedRevision: inbox.revision,
      label: "Acme support",
      imap: { password: "new-imap-pass" },
    });
    await call("DELETE", `/api/support/inboxes/${inbox.id}`);
    const rows = kernel.audits.filter((a) =>
      String(a.type).startsWith("support_inbox_"),
    );
    expect(rows).toEqual([
      { type: "support_inbox_created", inboxId: inbox.id, by: "Ada" },
      {
        type: "support_inbox_updated",
        inboxId: inbox.id,
        by: "Ada",
        fields: ["label", "imap.password"],
      },
      { type: "support_inbox_removed", inboxId: inbox.id, by: "Ada" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("new-imap-pass");
    expect(JSON.stringify(rows)).not.toContain("Acme support");
  });

  test("a store failure answers 500 without its message", async () => {
    await Bun.write(
      process.env.OPENSESSION_WORKSPACE_SECRETS_STORE!,
      "{not json /secret/path",
    );
    const warn = console.warn;
    const logged: unknown[][] = [];
    console.warn = (...args: unknown[]) => void logged.push(args);
    try {
      const res = await call("POST", "/api/support/inboxes", newInbox());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "Couldn't save the inbox. Try again",
      });
    } finally {
      console.warn = warn;
    }
    expect(JSON.stringify(logged)).not.toContain("/secret/path");
  });
});

describe("support inbox routes: connection tests", () => {
  test("a teammate can't point an internal-host inbox's test somewhere else", async () => {
    fixture = await startMailFixture();
    const inbox = await created({
      allowInternalHost: true,
      imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
      smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
    });
    const res = await call(
      "POST",
      "/api/support/inboxes/test",
      {
        inboxId: inbox.id,
        smtp: {
          ...fixture.smtpServer,
          port: fixture.imapPort,
          password: MAIL_PASSWORD,
        },
      },
      BEA,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        "Only the instance owner can change the mail servers of an inbox that allows internal servers",
    });
    expect(fixture.smtpConnections.opened).toBe(0);
  });

  test("a teammate's test is limited to the usual mail ports", async () => {
    const res = await call(
      "POST",
      "/api/support/inboxes/test",
      {
        address: "help@acme.example.test",
        imap: { ...newInbox().imap, port: 22 },
        smtp: newInbox().smtp,
      },
      BEA,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "IMAP port must be a usual mail port: 143, 993, 25, 465, 587 or 2525",
    });
  });

  test("a teammate sees one message for any failure before the server answers", async () => {
    __setMailHostResolverForTest(async () => ["127.0.0.1"]);
    try {
      const body = {
        address: "help@acme.example.test",
        imap: newInbox().imap,
        smtp: newInbox().smtp,
      };
      const res = await call("POST", "/api/support/inboxes/test", body, BEA);
      expect(res.status).toBe(200);
      const result = (await res.json()) as {
        imap: { ok: boolean; error?: string };
        smtp: { ok: boolean; error?: string };
      };
      expect(result.imap.error).toBe("Couldn't connect to this mail server");
      expect(result.smtp.error).toBe("Couldn't connect to this mail server");
      const own = (await (
        await call("POST", "/api/support/inboxes/test", body)
      ).json()) as { imap: { error?: string } };
      expect(own.imap.error).toBe("This mail server address isn't allowed");
    } finally {
      __setMailHostResolverForTest(undefined);
    }
  });

  test("test input is checked like a saved inbox", async () => {
    const base = {
      address: "help@acme.example.test",
      imap: newInbox().imap,
      smtp: newInbox().smtp,
    };
    const host = await call("POST", "/api/support/inboxes/test", {
      ...base,
      imap: { ...base.imap, host: "imap.example.test:993" },
    });
    expect(host.status).toBe(400);
    expect(await host.json()).toEqual({
      error: "IMAP host can't include a port. Put it in the port field",
    });
    const address = await call("POST", "/api/support/inboxes/test", {
      ...base,
      address: "two@a.test, three@b.test",
    });
    expect(address.status).toBe(400);
    expect(await address.json()).toEqual({
      error: "Address must be an email address like help@example.test",
    });
    const password = await call("POST", "/api/support/inboxes/test", {
      ...base,
      smtp: { ...base.smtp, password: "a\r\nb" },
    });
    expect(password.status).toBe(400);
  });

  test("one test at a time per person and server", async () => {
    fixture = await startMailFixture();
    const servers = {
      allowInternalHost: true,
      imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
      smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
    };
    const one = await created(servers);
    const two = await created({
      ...servers,
      address: "sales@acme.example.test",
    });
    const [a, b] = await Promise.all([
      call("POST", "/api/support/inboxes/test", { inboxId: one.id }),
      call("POST", "/api/support/inboxes/test", { inboxId: two.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });

  test("a passing test of a saved inbox resumes it when it was paused", async () => {
    fixture = await startMailFixture();
    const inbox = await created({
      allowInternalHost: true,
      imap: { ...fixture.imapServer, password: MAIL_PASSWORD },
      smtp: { ...fixture.smtpServer, password: MAIL_PASSWORD },
    });
    let resumed = 0;
    registerChannelAdapter({
      channel: "email",
      inboxId: inbox.id,
      connect: async () => {},
      disconnect: async () => {},
      health: () => ({
        state: "paused",
        since: "2026-10-25T10:00:00.000Z",
        reason: "The mail server refused the password",
        retryAt: null,
        lastMessageAt: null,
      }),
      send: async () => {
        throw new Error("unused");
      },
      resume: async () => {
        resumed++;
      },
    } as never);
    const res = await call("POST", "/api/support/inboxes/test", {
      inboxId: inbox.id,
    });
    expect(res.status).toBe(200);
    expect(resumed).toBe(1);
  });
});
