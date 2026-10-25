import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  type InboxConfig,
  type InboxHealth,
  defaultInboxConfig,
} from "../../shared/support";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { resolveWorkspaceSecretAsync } from "../workspace-secrets";
import {
  type NewInbox,
  __setInboxProjectCheckForTest,
  createInbox,
  deleteInbox,
  getInbox,
  inboxPassword,
  inboxView,
  listInboxes,
  onInboxChange,
  updateInbox,
  validateInbox,
} from "./inboxes";
import { TEST_PROJECTS, useSupportTestKernel } from "./testing/kernel-fixture";

const kernel = useSupportTestKernel();

const IMAP_PASSWORD = "imap-pass-4f1c";
const SMTP_PASSWORD = "smtp-pass-9a2e";

let previousSecrets: string | undefined;
beforeEach(() => {
  __setOwnerRosterForTest([]);
  __setInboxProjectCheckForTest((id) => TEST_PROJECTS.includes(id));
  previousSecrets = process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = secretsPath();
});

let unsubscribe: (() => void) | undefined;
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  __setInboxProjectCheckForTest(undefined);
  __setOwnerRosterForTest(undefined);
  if (previousSecrets === undefined)
    delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  else process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = previousSecrets;
});

const secretsPath = () => join(kernel.root(), "workspace-secrets.json");

/** What the secrets file holds, read straight from disk. */
function storedSecrets(): Array<{
  id: string;
  purpose: string;
  value: string;
}> {
  if (!existsSync(secretsPath())) return [];
  return JSON.parse(readFileSync(secretsPath(), "utf-8")).secrets;
}

const inboxSecrets = () =>
  storedSecrets().filter((secret) =>
    secret.purpose.startsWith("support-inbox:"),
  );

/** Later reads and writes of the secrets store fail. */
const corruptSecrets = () => writeFileSync(secretsPath(), "{not json");

function recordChanges(): Array<[string | null, string | null]> {
  const calls: Array<[string | null, string | null]> = [];
  unsubscribe = onInboxChange((next, previous) => {
    calls.push([next?.label ?? null, previous?.label ?? null]);
  });
  return calls;
}

function newInbox(over: Partial<NewInbox> = {}): NewInbox {
  return {
    label: "Acme help",
    address: "help@acme.example.test",
    project: "acme",
    imap: {
      host: "imap.example.test",
      port: 993,
      secure: true,
      user: "help@acme.example.test",
      password: IMAP_PASSWORD,
    },
    smtp: {
      host: "smtp.example.test",
      port: 465,
      secure: true,
      user: "help@acme.example.test",
      password: SMTP_PASSWORD,
    },
    ...over,
  };
}

async function created(over: Partial<NewInbox> = {}): Promise<InboxConfig> {
  const result = await createInbox(newInbox(over), "Ada");
  if (!result.ok) throw new Error(result.error);
  return result.inbox;
}

const HEALTH: InboxHealth = {
  state: "live",
  since: "2026-10-25T10:00:00.000Z",
  reason: null,
  retryAt: null,
  lastMessageAt: null,
};

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((child) => hasKeyDeep(child, key));
}

describe("createInbox", () => {
  test("stores both passwords as workspace secrets, never in the config", async () => {
    const inbox = await created();
    expect(inbox.id).toMatch(/^inb_/);
    expect(inbox.imap.passwordRef).toMatch(/^wssec-/);
    expect(inbox.smtp.passwordRef).toMatch(/^wssec-/);
    expect(inbox.imap.passwordRef).not.toBe(inbox.smtp.passwordRef);
    expect(await resolveWorkspaceSecretAsync(inbox.imap.passwordRef!)).toBe(
      IMAP_PASSWORD,
    );
    expect(await inboxPassword(inbox, "smtp")).toBe(SMTP_PASSWORD);

    const listed = JSON.stringify(await listInboxes());
    expect(listed).not.toContain(IMAP_PASSWORD);
    expect(listed).not.toContain(SMTP_PASSWORD);
    expect(await getInbox(inbox.id)).toEqual(inbox);
  });

  test("defaults match defaultInboxConfig for everything not given", async () => {
    const inbox = await created();
    const expected = defaultInboxConfig({
      id: inbox.id,
      label: "Acme help",
      address: "help@acme.example.test",
      project: "acme",
      owner: "Ada",
      createdBy: "Ada",
      now: inbox.createdAt,
      imap: {
        host: "imap.example.test",
        port: 993,
        secure: true,
        user: "help@acme.example.test",
        passwordRef: inbox.imap.passwordRef,
      },
      smtp: {
        host: "smtp.example.test",
        port: 465,
        secure: true,
        user: "help@acme.example.test",
        passwordRef: inbox.smtp.passwordRef,
      },
    });
    expect(inbox).toEqual(expected);
  });

  test("an explicit owner wins; a machine principal falls back to the instance owner", async () => {
    expect((await created({ owner: "Grace" })).owner).toBe("Grace");
    __setOwnerRosterForTest([{ name: "Grace Hopper" }], "");
    const result = await createInbox(newInbox(), "automation");
    expect(result.ok && result.inbox.owner).toBe("Grace");
  });

  test("an invalid inbox stores no secret", async () => {
    const result = await createInbox(newInbox({ project: "nope" }), "Ada");
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Project"),
    });
    expect(await listInboxes()).toEqual([]);
    expect(inboxSecrets()).toEqual([]);
  });

  test("a failed create deletes the secrets it wrote", async () => {
    await created();
    expect(inboxSecrets()).toHaveLength(2);
    // The catalog write fails after both passwords are stored.
    kernel.store().close();
    await expect(createInbox(newInbox(), "Ada")).rejects.toThrow();
    expect(inboxSecrets()).toHaveLength(2);
  });

  test("malformed server settings are a validation error, not a crash", async () => {
    const bad = (over: Partial<NewInbox>) =>
      createInbox({ ...newInbox(), ...over } as NewInbox, "Ada");
    expect(await bad({ smtp: {} as never })).toEqual({
      ok: false,
      error: expect.stringContaining("SMTP host"),
    });
    expect(await bad({ smtp: undefined as never })).toEqual({
      ok: false,
      error: "SMTP settings are missing",
    });
    expect(
      await bad({ imap: { ...newInbox().imap, host: 42 as never } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("IMAP host") });
    expect(inboxSecrets()).toEqual([]);
  });

  test("a project name from Object.prototype is not a project", async () => {
    __setInboxProjectCheckForTest(undefined);
    for (const project of ["toString", "constructor", "__proto__"])
      expect(await createInbox(newInbox({ project }), "Ada")).toEqual({
        ok: false,
        error: expect.stringContaining("Project"),
      });
  });

  test("passwords are capped and can't contain line breaks", async () => {
    for (const password of ["a\r\nb", "a\nb", "a\u0000b", "x".repeat(1025)]) {
      const result = await createInbox(
        newInbox({ imap: { ...newInbox().imap, password } }),
        "Ada",
      );
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining("IMAP password"),
      });
    }
    expect(inboxSecrets()).toEqual([]);
    expect(
      (
        await createInbox(
          newInbox({
            smtp: { ...newInbox().smtp, password: "x".repeat(1024) },
          }),
          "Ada",
        )
      ).ok,
    ).toBe(true);
  });
});

describe("updateInbox", () => {
  test("a stale revision is a conflict", async () => {
    const inbox = await created();
    const first = await updateInbox(
      inbox.id,
      { expectedRevision: inbox.revision, label: "Acme support" },
      "Ada",
    );
    expect(first.ok && first.inbox.revision).toBe(1);
    const stale = await updateInbox(
      inbox.id,
      { expectedRevision: inbox.revision, label: "Other" },
      "Ada",
    );
    expect(stale).toMatchObject({ ok: false, status: 409 });
    expect((await getInbox(inbox.id))?.label).toBe("Acme support");
  });

  test("unknown inbox is a 404, an invalid patch a 400", async () => {
    expect(
      await updateInbox("inb_missing", { expectedRevision: 0 }, "Ada"),
    ).toMatchObject({ ok: false, status: 404 });
    const inbox = await created();
    expect(
      await updateInbox(
        inbox.id,
        { expectedRevision: 0, imap: { port: 0 } },
        "Ada",
      ),
    ).toMatchObject({ ok: false, status: 400 });
  });

  test("a new password replaces the secret under the same ref; none keeps it", async () => {
    const inbox = await created();
    const changed = await updateInbox(
      inbox.id,
      { expectedRevision: 0, imap: { password: "rotated" } },
      "Grace",
    );
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.inbox.imap.passwordRef).toBe(inbox.imap.passwordRef);
    expect(await inboxPassword(changed.inbox, "imap")).toBe("rotated");
    expect(changed.inbox.updatedBy).toBe("Grace");

    const kept = await updateInbox(
      inbox.id,
      {
        expectedRevision: 1,
        label: "Acme support",
        // The same server settings again are no change.
        imap: { host: "imap.example.test", port: 993 },
      },
      "Grace",
    );
    if (!kept.ok) throw new Error(kept.error);
    expect(kept.inbox.label).toBe("Acme support");
    expect(kept.inbox.imap.port).toBe(993);
    expect(await inboxPassword(kept.inbox, "imap")).toBe("rotated");
    expect(await inboxPassword(kept.inbox, "smtp")).toBe(SMTP_PASSWORD);
  });

  test("changing a server without its password again is refused", async () => {
    const inbox = await created();
    const changes = [
      { imap: { host: "attacker.example.test" } },
      { imap: { port: 143 } },
      { imap: { secure: false } },
      { smtp: { user: "someone@example.test" } },
      // A password for the other server doesn't count.
      { imap: { host: "attacker.example.test" }, smtp: { password: "s" } },
    ];
    for (const change of changes)
      expect(
        await updateInbox(inbox.id, { expectedRevision: 0, ...change }, "Ada"),
      ).toEqual({
        ok: false,
        status: 400,
        error: "Enter the password again when the server changes",
      });
    expect(await getInbox(inbox.id)).toEqual(inbox);
    expect(await inboxPassword(inbox, "imap")).toBe(IMAP_PASSWORD);
    expect(await inboxPassword(inbox, "smtp")).toBe(SMTP_PASSWORD);
  });

  test("a new server with its password never pairs with the old password", async () => {
    const inbox = await created();
    const seen: Array<string | undefined> = [];
    unsubscribe = onInboxChange((next) => {
      if (next) void inboxPassword(next, "imap").then((p) => seen.push(p));
    });
    const changed = await updateInbox(
      inbox.id,
      {
        expectedRevision: 0,
        imap: { host: "mail.example.test", password: "new-host-pass" },
      },
      "Ada",
    );
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.inbox.imap.host).toBe("mail.example.test");
    // A new ref, written before the commit; the old secret is gone.
    expect(changed.inbox.imap.passwordRef).not.toBe(inbox.imap.passwordRef);
    expect(await inboxPassword(changed.inbox, "imap")).toBe("new-host-pass");
    expect(
      await resolveWorkspaceSecretAsync(inbox.imap.passwordRef!),
    ).toBeUndefined();
    expect(changed.inbox.smtp.passwordRef).toBe(inbox.smtp.passwordRef);
    expect(inboxSecrets()).toHaveLength(2);
    await Bun.sleep(5);
    expect(seen).toEqual(["new-host-pass"]);
  });

  test("of two updates racing on one revision, the loser writes no secret", async () => {
    const inbox = await created();
    const results = await Promise.all([
      updateInbox(
        inbox.id,
        {
          expectedRevision: 0,
          imap: { host: "a.example.test", password: "pa" },
        },
        "Ada",
      ),
      updateInbox(
        inbox.id,
        {
          expectedRevision: 0,
          smtp: { host: "b.example.test", password: "pb" },
        },
        "Grace",
      ),
    ]);
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false, status: 409 });
    const values = inboxSecrets().map((secret) => secret.value);
    expect(values).toHaveLength(2);
    const winner = results.find((r) => r.ok);
    if (!winner?.ok) throw new Error("no winner");
    expect(await inboxPassword(winner.inbox, "imap")).toBe(
      winner.inbox.imap.host === "a.example.test" ? "pa" : IMAP_PASSWORD,
    );
    expect(values).not.toContain(
      winner.inbox.imap.host === "a.example.test" ? "pb" : "pa",
    );
  });

  test("password limits apply to updates too", async () => {
    const inbox = await created();
    expect(
      await updateInbox(
        inbox.id,
        { expectedRevision: 0, smtp: { password: "a\r\nAUTH" } },
        "Ada",
      ),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("SMTP password"),
    });
    expect(await inboxPassword(inbox, "smtp")).toBe(SMTP_PASSWORD);
  });
});

describe("validateInbox", () => {
  const exists = (id: string) => TEST_PROJECTS.includes(id);
  const base = defaultInboxConfig({
    id: "inb_1",
    label: "Acme help",
    address: "help@acme.example.test",
    project: "acme",
    owner: "Ada",
    createdBy: "Ada",
    now: "2026-10-25T10:00:00.000Z",
    imap: {
      host: "imap.example.test",
      port: 993,
      secure: true,
      user: "u",
      passwordRef: null,
    },
    smtp: {
      host: "smtp.example.test",
      port: 465,
      secure: true,
      user: "u",
      passwordRef: null,
    },
  });

  test("accepts the defaults", () => {
    expect(validateInbox(base, exists)).toBeNull();
  });

  test("accepts host names and IP literals", () => {
    for (const host of [
      "localhost",
      "mail.example.test",
      "xn--bcher-kva.example",
      "93.184.216.34",
      "2001:db8::25",
    ])
      expect(
        validateInbox({ ...base, imap: { ...base.imap, host } }, exists),
      ).toBeNull();
  });

  test("new inboxes don't allow internal hosts", () => {
    expect(base.allowInternalHost).toBe(false);
  });

  test("an internal IP literal needs allowInternalHost", () => {
    for (const host of ["127.0.0.1", "::1", "10.0.0.5", "100.64.1.2"]) {
      const config = { ...base, imap: { ...base.imap, host } };
      expect(validateInbox(config, exists)).toBe(
        "This IMAP server address isn't allowed",
      );
      expect(
        validateInbox({ ...config, allowInternalHost: true }, exists),
      ).toBeNull();
    }
  });

  test("a link-local or metadata literal is refused even with allowInternalHost", () => {
    for (const host of ["169.254.169.254", "fe80::1", "fd00:ec2::254"])
      expect(
        validateInbox(
          {
            ...base,
            allowInternalHost: true,
            smtp: { ...base.smtp, host },
          },
          exists,
        ),
      ).toBe("This SMTP server address isn't allowed");
  });

  test("allowInternalHost must be on or off", () => {
    expect(
      validateInbox({ ...base, allowInternalHost: "yes" as never }, exists),
    ).toMatch(/Internal/);
  });

  const cases: Array<[string, Partial<InboxConfig>, RegExp]> = [
    ["port 0", { imap: { ...base.imap, port: 0 } }, /IMAP port/],
    ["port 70000", { smtp: { ...base.smtp, port: 70000 } }, /SMTP port/],
    [
      "host with a space",
      { imap: { ...base.imap, host: "imap example" } },
      /IMAP host/,
    ],
    ["address without @", { address: "help.example.test" }, /Address/],
    ["two addresses", { address: "a,b@example.test" }, /Address/],
    ["address with ;", { address: "a;b@example.test" }, /Address/],
    ["address with quotes", { address: '"a"@example.test' }, /Address/],
    ["address with ()", { address: "a(b)@example.test" }, /Address/],
    ["address list in the domain", { address: "a@x.test,b" }, /Address/],
    ["label with a line break", { label: "Acme\nhelp" }, /Label/],
    ["label with a control character", { label: "Acme\u0007" }, /Label/],
    [
      "user with a control character",
      { imap: { ...base.imap, user: "u\r\nx" } },
      /IMAP user/,
    ],
    ["host of dots", { imap: { ...base.imap, host: "..." } }, /IMAP host/],
    ["host with a colon", { smtp: { ...base.smtp, host: "a:b" } }, /SMTP host/],
    ["host -", { imap: { ...base.imap, host: "-" } }, /IMAP host/],
    ["host [", { imap: { ...base.imap, host: "[" } }, /IMAP host/],
    ["host a..b", { imap: { ...base.imap, host: "a..b" } }, /IMAP host/],
    [
      "host label starting -",
      { imap: { ...base.imap, host: "-a.test" } },
      /IMAP host/,
    ],
    ["bad IPv4", { imap: { ...base.imap, host: "999.1.1.1" } }, /IMAP host/],
    [
      "host with a port",
      { imap: { ...base.imap, host: "imap.example.test:993" } },
      /IMAP host.*port/,
    ],
    ["unknown project", { project: "nope" }, /Project/],
    ["veto under a minute", { vetoMs: 59_999 }, /Veto window/],
    ["veto over a day", { vetoMs: 86_400_001 }, /Veto window/],
    [
      "attachments kept longer than conversations",
      { retention: { conversationDays: 30, attachmentDays: 31 } },
      /Attachment/,
    ],
    ["send limit 0", { sendLimitPerMinute: 0 }, /Send limit/],
    ["send limit 121", { sendLimitPerMinute: 121 }, /Send limit/],
    [
      "folder with *",
      { folders: { done: "Done*", spam: "Spam" } },
      /Done folder/,
    ],
    [
      "folder with %",
      { folders: { done: "Done", spam: "Sp%am" } },
      /Spam folder/,
    ],
    [
      "unknown topic",
      { neverWithoutAPerson: ["refund", "weather" as never] },
      /Never without a person/,
    ],
  ];
  for (const [name, patch, message] of cases)
    test(`rejects ${name}`, () => {
      const error = validateInbox({ ...base, ...patch }, exists);
      expect(error).toMatch(message);
      // Sentence case: a capital first letter.
      expect(error![0]).toBe(error![0]!.toUpperCase());
    });
});

describe("deleteInbox and listeners", () => {
  test("deleteInbox removes the config and both secrets", async () => {
    const inbox = await created();
    expect(await deleteInbox(inbox.id, "Ada")).toBe(true);
    expect(await getInbox(inbox.id)).toBeNull();
    expect(await resolveWorkspaceSecretAsync(inbox.imap.passwordRef!)).toBe(
      undefined,
    );
    expect(await resolveWorkspaceSecretAsync(inbox.smtp.passwordRef!)).toBe(
      undefined,
    );
    expect(await deleteInbox(inbox.id, "Ada")).toBe(false);
  });

  test("listeners hear a committed update even when the password write after it fails", async () => {
    const inbox = await created();
    const calls = recordChanges();
    corruptSecrets();
    await expect(
      updateInbox(
        inbox.id,
        { expectedRevision: 0, label: "B", imap: { password: "rotated" } },
        "Ada",
      ),
    ).rejects.toThrow();
    await Bun.sleep(0);
    expect(calls).toEqual([["B", "Acme help"]]);
  });

  test("a delete whose secrets can't be removed still deletes and notifies", async () => {
    const inbox = await created();
    const calls = recordChanges();
    corruptSecrets();
    expect(await deleteInbox(inbox.id, "Ada")).toBe(true);
    expect(await getInbox(inbox.id)).toBeNull();
    await Bun.sleep(0);
    expect(calls).toEqual([[null, "Acme help"]]);
  });

  test("onInboxChange hears create, update and delete once each", async () => {
    const calls: Array<[string | null, string | null]> = [];
    unsubscribe = onInboxChange((next, previous) => {
      calls.push([next?.label ?? null, previous?.label ?? null]);
    });
    const inbox = await created();
    await updateInbox(inbox.id, { expectedRevision: 0, label: "B" }, "Ada");
    await deleteInbox(inbox.id, "Ada");
    await Bun.sleep(0);
    expect(calls).toEqual([
      ["Acme help", null],
      ["B", "Acme help"],
      [null, "B"],
    ]);
  });
});

describe("inboxView", () => {
  test("shows whether a password is set and drops every ref", async () => {
    const inbox = await created();
    const view = inboxView(inbox, HEALTH);
    expect(view.imap.hasPassword).toBe(true);
    expect(view.smtp.hasPassword).toBe(true);
    expect(view.health).toEqual(HEALTH);
    expect(hasKeyDeep(view, "passwordRef")).toBe(false);
    const empty = inboxView(
      { ...inbox, smtp: { ...inbox.smtp, passwordRef: null } },
      HEALTH,
    );
    expect(empty.smtp.hasPassword).toBe(false);
    const missing = inboxView(
      { ...inbox, imap: { ...inbox.imap, passwordRef: undefined as never } },
      HEALTH,
    );
    expect(missing.imap.hasPassword).toBe(false);
  });
});
