import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FOLDERS,
  MAIL_TLS_MODES,
  defaultMailPort,
  type MailServerConfig,
  SUPPORT_TOPICS,
  defaultInboxConfig,
  type InboxConfig,
  migrateInboxRecord,
  normalizeAddress,
  normalizeMessageId,
  parseSupportItemId,
  noTlsHostAllowed,
  smtpSavesSentItself,
  SUPPORT_CHANNELS,
  supportItemId,
} from "./support";

describe("normalizeMessageId", () => {
  test("strips brackets and lowercases only the domain part", () => {
    expect(normalizeMessageId("<AbC@Example.TEST>")).toBe("AbC@example.test");
  });

  test("empty or without an at sign is null", () => {
    expect(normalizeMessageId("  ")).toBeNull();
    expect(normalizeMessageId("no-at-sign")).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });
});

describe("normalizeAddress", () => {
  test("trims the name and trims and lowercases the address", () => {
    expect(
      normalizeAddress({ name: " Ada ", address: " Ada@Example.Test " }),
    ).toEqual({ name: "Ada", address: "ada@example.test" });
  });

  test("missing address is null", () => {
    expect(normalizeAddress({ name: "Ada" })).toBeNull();
    expect(normalizeAddress({ name: "Ada", address: "  " })).toBeNull();
  });
});

describe("support item ids", () => {
  test("round-trip", () => {
    expect(parseSupportItemId(supportItemId("email", "sc_1"))).toEqual({
      channel: "email",
      id: "sc_1",
    });
  });

  test("an id without a colon is null", () => {
    expect(parseSupportItemId("nocolon")).toBeNull();
  });

  test("an unknown channel is null", () => {
    expect(SUPPORT_CHANNELS).toEqual(["email", "plain"]);
    expect(parseSupportItemId("sms:x1")).toBeNull();
  });

  test("colons after the first stay in the id", () => {
    expect(parseSupportItemId("plain:th_1:x")).toEqual({
      channel: "plain",
      id: "th_1:x",
    });
  });
});

describe("smtpSavesSentItself", () => {
  test("hosts that keep their own Sent copy", () => {
    expect(smtpSavesSentItself("SMTP.gmail.com")).toBe(true);
    expect(smtpSavesSentItself("smtp.office365.com")).toBe(true);
    expect(smtpSavesSentItself("smtp-mail.outlook.com")).toBe(true);
    expect(smtpSavesSentItself("mail.example.test")).toBe(false);
    expect(smtpSavesSentItself("smtp.googlemail.com")).toBe(true);
    // A fully qualified name with its trailing dot is the same host.
    expect(smtpSavesSentItself(" smtp.gmail.com. ")).toBe(true);
    expect(smtpSavesSentItself("smtp.office365.com..")).toBe(true);
  });
});

describe("mail TLS modes", () => {
  test("three modes, implicit TLS first", () => {
    expect([...MAIL_TLS_MODES]).toEqual(["implicit", "starttls", "none"]);
  });

  test("the usual port for each server and mode", () => {
    expect(defaultMailPort("imap", "implicit")).toBe(993);
    expect(defaultMailPort("imap", "starttls")).toBe(143);
    expect(defaultMailPort("smtp", "implicit")).toBe(465);
    expect(defaultMailPort("smtp", "starttls")).toBe(587);
  });
});

describe("defaultInboxConfig", () => {
  const server = (host: string): MailServerConfig => ({
    host,
    port: 993,
    tls: "implicit",
    user: "support@example.test",
    passwordRef: null,
  });
  const input = (smtpHost: string) => ({
    id: "inb_1",
    label: "Acme support",
    address: "support@example.test",
    project: "acme",
    owner: "user:ada",
    createdBy: "ada",
    now: "2026-10-25T10:00:00.000Z",
    imap: server("imap.example.test"),
    smtp: server(smtpHost),
  });

  test("starts at Draft with safe defaults", () => {
    const config = defaultInboxConfig(input("mail.example.test"));
    expect(config.autonomy).toBe("draft");
    expect(config.mailbox).toBe("untouched");
    expect("bugHandling" in config).toBe(false);
    expect("moveLock" in config).toBe(false);
    expect(config.vetoMs).toBe(600_000);
    expect(config.retention).toEqual({
      conversationDays: 180,
      attachmentDays: 30,
    });
    expect(config.sendLimitPerMinute).toBe(30);
    expect(config.neverWithoutAPerson).toEqual([...SUPPORT_TOPICS]);
    expect(config.folders.done).toBe("Sessions/Done");
    expect(config.folders).toEqual({ ...DEFAULT_FOLDERS });
    expect(config.revision).toBe(0);
    expect(config.enabled).toBe(true);
    expect(config.channel).toBe("email");
    expect(config.createdAt).toBe("2026-10-25T10:00:00.000Z");
    expect(config.updatedBy).toBe("ada");
  });

  test("copies to Sent only when the SMTP host does not already", () => {
    expect(defaultInboxConfig(input("mail.example.test")).copyToSent).toBe(
      !smtpSavesSentItself("mail.example.test"),
    );
    expect(defaultInboxConfig(input("smtp.gmail.com")).copyToSent).toBe(false);
  });

  test("never shares the default lists between inboxes", () => {
    const a = defaultInboxConfig(input("mail.example.test"));
    a.neverWithoutAPerson.pop();
    a.folders.done = "Other";
    const b = defaultInboxConfig(input("mail.example.test"));
    expect(b.neverWithoutAPerson).toEqual([...SUPPORT_TOPICS]);
    expect(b.folders.done).toBe("Sessions/Done");
  });
});

describe("noTlsHostAllowed", () => {
  test("localhost and loopback literals only", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
    ])
      expect(noTlsHostAllowed(host)).toBe(true);
    for (const host of [
      "",
      "imap.example.test",
      "localhost.example.test",
      "10.0.0.5",
      "127.0.0.1.example.test",
      "127.0.0",
      "::2",
      "::ffff:10.0.0.1",
      "fe80::1",
    ])
      expect(noTlsHostAllowed(host)).toBe(false);
  });
});

describe("migrateInboxRecord", () => {
  const server: MailServerConfig = {
    host: "mail.example.test",
    port: 993,
    tls: "implicit",
    user: "help@example.test",
    passwordRef: null,
  };
  const current = defaultInboxConfig({
    id: "inb_1",
    label: "Help",
    address: "help@example.test",
    project: "acme",
    owner: "Ada",
    createdBy: "Ada",
    now: "2026-01-01T00:00:00.000Z",
    imap: server,
    smtp: { ...server, port: 465 },
  });
  const legacy = (autonomy: string, extra: object = {}) =>
    ({
      ...current,
      autonomy,
      vetoMs: 600_000,
      moveLock: "people",
      bugHandling: "issue",
      neverWithoutAPerson: ["refund", "angry-customer"],
      ...extra,
    }) as unknown as InboxConfig;

  test("a current record comes back as is", () => {
    expect(migrateInboxRecord(current)).toBe(current);
    expect(current.autonomy).toBe("draft");
    expect(current.neverWithoutAPerson).toEqual([...SUPPORT_TOPICS]);
  });

  test("propose becomes draft and the removed settings go", () => {
    const next = migrateInboxRecord(legacy("propose"));
    expect(next.autonomy).toBe("draft");
    expect("moveLock" in next).toBe(false);
    expect("bugHandling" in next).toBe(false);
    expect(next.vetoMs).toBe(600_000);
  });

  test("deploy-after-veto becomes routine with its veto window", () => {
    const next = migrateInboxRecord(legacy("deploy-after-veto"));
    expect(next.autonomy).toBe("routine");
    expect(next.vetoMs).toBe(600_000);
  });

  test("deploy-right-away becomes routine without a veto window", () => {
    const next = migrateInboxRecord(legacy("deploy-right-away"));
    expect(next.autonomy).toBe("routine");
    expect(next.vetoMs).toBeNull();
  });

  test("watch stays watch", () => {
    expect(migrateInboxRecord(legacy("watch")).autonomy).toBe("watch");
  });

  test("old topics keep their choice, angry goes, new topics are added", () => {
    const next = migrateInboxRecord(legacy("propose"));
    expect(next.neverWithoutAPerson).toEqual([
      "refund",
      "security",
      "data-export",
      "data-deletion",
    ]);
  });
});
