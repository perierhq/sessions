import { describe, expect, test } from "bun:test";
import type { InboxView } from "../../shared/support";
import {
  emptyInboxForm,
  formFromInbox,
  healthLine,
  inboxFormError,
  newInboxFromForm,
  patchFromForm,
  showsConnectorWarning,
  testBodyFromForm,
} from "./inbox-form";

const VIEW: InboxView = {
  id: "inb_0001",
  label: "Acme help",
  address: "help@acme.example.test",
  channel: "email",
  enabled: true,
  project: "acme",
  moveLock: "agent",
  autonomy: "propose",
  vetoMs: 900_000,
  neverWithoutAPerson: ["refund", "legal"],
  bugHandling: "off",
  mailbox: "untouched",
  folders: { done: "Sessions/Done", spam: "Sessions/Spam" },
  copyToSent: true,
  retention: { conversationDays: 180, attachmentDays: 30 },
  owner: "Ada",
  sendLimitPerMinute: 30,
  allowInternalHost: false,
  imap: {
    host: "imap.example.test",
    port: 993,
    tls: "implicit",
    user: "help@acme.example.test",
    hasPassword: true,
  },
  smtp: {
    host: "smtp.example.test",
    port: 465,
    tls: "implicit",
    user: "help@acme.example.test",
    hasPassword: true,
  },
  createdAt: "2026-10-25T10:00:00.000Z",
  createdBy: "Ada",
  updatedAt: "2026-10-25T10:00:00.000Z",
  updatedBy: "Ada",
  revision: 3,
  health: {
    state: "live",
    since: "2026-10-25T10:00:00.000Z",
    reason: null,
    retryAt: null,
    lastMessageAt: null,
  },
};

describe("patchFromForm", () => {
  test("an untouched form changes nothing", () => {
    expect(patchFromForm(VIEW, formFromInbox(VIEW))).toEqual({
      expectedRevision: 3,
    });
  });

  test("an untouched password field sends no password", () => {
    const form = formFromInbox(VIEW);
    form.imap.host = "mail.example.test";
    const patch = patchFromForm(VIEW, form);
    expect(patch).toEqual({
      expectedRevision: 3,
      imap: { host: "mail.example.test" },
    });
    expect(JSON.stringify(patch)).not.toContain("password");
  });

  test("a typed password is sent for that server only", () => {
    const form = formFromInbox(VIEW);
    form.smtp.password = "new-secret";
    expect(patchFromForm(VIEW, form)).toEqual({
      expectedRevision: 3,
      smtp: { password: "new-secret" },
    });
  });

  test("changing only the autonomy sends only the autonomy", () => {
    const form = formFromInbox(VIEW);
    form.autonomy = "watch";
    expect(patchFromForm(VIEW, form)).toEqual({
      expectedRevision: 3,
      autonomy: "watch",
    });
  });

  test("veto minutes become vetoMs", () => {
    const form = formFromInbox(VIEW);
    form.autonomy = "deploy-after-veto";
    form.vetoMinutes = "5";
    expect(patchFromForm(VIEW, form)).toEqual({
      expectedRevision: 3,
      autonomy: "deploy-after-veto",
      vetoMs: 300_000,
    });
  });

  test("retention and topics are sent whole when they change", () => {
    const form = formFromInbox(VIEW);
    form.attachmentDays = "14";
    form.neverWithoutAPerson = ["refund"];
    expect(patchFromForm(VIEW, form)).toEqual({
      expectedRevision: 3,
      neverWithoutAPerson: ["refund"],
      retention: { conversationDays: 180, attachmentDays: 14 },
    });
  });
});

describe("newInboxFromForm", () => {
  test("carries both passwords and the handling fields", () => {
    const form = emptyInboxForm("acme", "Ada");
    form.label = "Acme help";
    form.address = "help@acme.example.test";
    form.imap = {
      host: "imap.example.test",
      port: "993",
      tls: "implicit",
      user: "help@acme.example.test",
      password: "imap-secret",
    };
    form.smtp = {
      host: "smtp.example.test",
      port: "465",
      tls: "implicit",
      user: "help@acme.example.test",
      password: "smtp-secret",
    };
    form.vetoMinutes = "10";
    const input = newInboxFromForm(form);
    expect(input.imap).toEqual({
      host: "imap.example.test",
      port: 993,
      tls: "implicit",
      user: "help@acme.example.test",
      password: "imap-secret",
    });
    expect(input.smtp.password).toBe("smtp-secret");
    expect(input.vetoMs).toBe(600_000);
    expect(input.autonomy).toBe("propose");
    expect(input.project).toBe("acme");
  });
});

describe("inboxFormError", () => {
  test("a port that isn't a number is named", () => {
    const form = formFromInbox(VIEW);
    form.imap.port = "99a";
    expect(inboxFormError(form, true)).toBe(
      "IMAP port must be a whole number from 1 to 65535",
    );
  });

  test("a new inbox needs both passwords", () => {
    const form = emptyInboxForm("acme", "Ada");
    form.label = "Acme help";
    form.address = "help@acme.example.test";
    form.imap.host = "imap.example.test";
    form.imap.user = "help";
    form.smtp.host = "smtp.example.test";
    form.smtp.user = "help";
    expect(inboxFormError(form, false)).toBe("IMAP password is required");
  });
});

describe("testBodyFromForm", () => {
  test("a saved inbox with nothing changed tests by id", () => {
    expect(testBodyFromForm(formFromInbox(VIEW), VIEW)).toEqual({
      inboxId: "inb_0001",
    });
  });

  test("a changed server is sent with what was typed", () => {
    const form = formFromInbox(VIEW);
    form.imap.password = "typed";
    expect(testBodyFromForm(form, VIEW)).toEqual({
      inboxId: "inb_0001",
      imap: {
        host: "imap.example.test",
        port: 993,
        tls: "implicit",
        user: "help@acme.example.test",
        password: "typed",
      },
    });
  });
});

describe("healthLine", () => {
  const at = (health: Partial<InboxView["health"]>) =>
    healthLine({ ...VIEW.health, ...health }, "en-GB");

  test("reads each state", () => {
    expect(at({ state: "live" })).toBe("Connected");
    expect(at({ state: "polling" })).toBe("Checking mail every 5 minutes");
    expect(
      at({ state: "backing-off", retryAt: "2026-10-25T14:05:00.000Z" }),
    ).toMatch(/^Reconnecting at \d{2}:\d{2}$/);
    expect(at({ state: "paused", reason: "The server said no" })).toBe(
      "Paused: The server said no",
    );
    expect(at({ state: "off" })).toBe("Off");
    expect(at({ state: "connecting" })).toBe("Connecting");
  });
});

describe("showsConnectorWarning", () => {
  test("only for the two send levels on a project with connectors", () => {
    expect(showsConnectorWarning("deploy-after-veto", true)).toBe(true);
    expect(showsConnectorWarning("deploy-right-away", true)).toBe(true);
    expect(showsConnectorWarning("propose", true)).toBe(false);
    expect(showsConnectorWarning("deploy-right-away", false)).toBe(false);
  });
});
