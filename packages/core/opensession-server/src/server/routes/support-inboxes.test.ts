import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { InboxHealth, InboxView } from "../../shared/support";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { registerChannelAdapter } from "../support/channel";
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
      autonomy: "deploy-after-veto",
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
