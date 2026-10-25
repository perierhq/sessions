import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FOLDERS,
  type MailServerConfig,
  SUPPORT_TOPICS,
  defaultInboxConfig,
  normalizeAddress,
  normalizeMessageId,
  parseSupportItemId,
  smtpSavesSentItself,
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
  });
});

describe("defaultInboxConfig", () => {
  const server = (host: string): MailServerConfig => ({
    host,
    port: 993,
    secure: true,
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
    expect(config.autonomy).toBe("propose");
    expect(config.mailbox).toBe("untouched");
    expect(config.bugHandling).toBe("off");
    expect(config.moveLock).toBe("agent");
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
