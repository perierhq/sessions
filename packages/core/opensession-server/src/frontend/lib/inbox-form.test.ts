import { describe, expect, test } from "bun:test";
import type { InboxView } from "../../shared/support";
import {
  emptyInboxForm,
  formChanged,
  formFromInbox,
  healthLine,
  inboxFormError,
  inboxStatusLine,
  setServerField,
  tlsChoices,
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
    form.autonomy = "deploy-after-veto";
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
    expect(input.autonomy).toBe("deploy-after-veto");
    expect(input.project).toBe("acme");
  });
});

describe("inboxFormError", () => {
  test("a port that isn't a number is named", () => {
    const form = formFromInbox(VIEW);
    form.imap.port = "99a";
    expect(inboxFormError(form, VIEW)).toBe(
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
    expect(inboxFormError(form, null)).toBe("IMAP password is required");
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

describe("review fixes", () => {
  const filled = () => {
    const form = emptyInboxForm("acme", "");
    form.label = "Acme help";
    form.address = "help@acme.example.test";
    form.imap = {
      host: "imap.example.test",
      port: "993",
      tls: "implicit",
      user: "help",
      password: "imap-secret",
    };
    form.smtp = {
      host: "smtp.example.test",
      port: "465",
      tls: "implicit",
      user: "help",
      password: "smtp-secret",
    };
    return form;
  };

  test("a new inbox's owner starts empty and is left to the server", () => {
    expect(emptyInboxForm("acme", "").owner).toBe("");
    expect(newInboxFromForm(filled())).not.toHaveProperty("owner");
  });

  test("vetoMs is sent only for the veto level", () => {
    const form = filled();
    expect(newInboxFromForm(form)).not.toHaveProperty("vetoMs");
    form.autonomy = "deploy-after-veto";
    expect(newInboxFromForm(form).vetoMs).toBe(600_000);
  });

  test("a changed server needs its password again", () => {
    const form = formFromInbox(VIEW);
    form.smtp.port = "587";
    form.smtp.tls = "starttls";
    expect(inboxFormError(form, VIEW)).toBe(
      "Enter the SMTP password again for the changed server",
    );
    form.smtp.password = "again";
    expect(inboxFormError(form, VIEW)).toBeNull();
  });

  test("the name shown to customers is named in its error", () => {
    const form = filled();
    form.label = " ";
    expect(inboxFormError(form, null)).toBe(
      "Name shown to customers is required",
    );
  });

  test("no project means a repository has to be added first", () => {
    const form = filled();
    form.project = "";
    expect(inboxFormError(form, null)).toBe("Add a repository first");
  });

  test("no TLS is refused off this machine, as the store does", () => {
    const form = filled();
    form.imap.tls = "none";
    expect(inboxFormError(form, null)).toBe(
      "IMAP security can be none only for a server on this machine",
    );
    form.imap.host = "127.0.0.1";
    expect(inboxFormError(form, null)).toBeNull();
  });

  test("a new SMTP host resets the Sent copy unless the switch was touched", () => {
    const form = formFromInbox(VIEW);
    expect(form.copyToSent).toBe(true);
    const moved = setServerField(form, "smtp", { host: "smtp.gmail.com" });
    expect(moved.copyToSent).toBeNull();
    const touched = { ...form, copyToSent: false, copyToSentTouched: true };
    expect(
      setServerField(touched, "smtp", { host: "smtp.gmail.com" }).copyToSent,
    ).toBe(false);
    expect(setServerField(form, "imap", { host: "x.test" }).copyToSent).toBe(
      true,
    );
  });

  test("no TLS is offered only on this machine or when it is saved", () => {
    expect(tlsChoices("imap.example.test", null)).toEqual([
      "implicit",
      "starttls",
    ]);
    expect(tlsChoices("localhost", null)).toEqual([
      "implicit",
      "starttls",
      "none",
    ]);
    expect(tlsChoices("imap.example.test", "none")).toEqual([
      "implicit",
      "starttls",
      "none",
    ]);
  });

  test("an enabled inbox without a connection isn't connected yet", () => {
    const off = { ...VIEW.health, state: "off" as const };
    expect(inboxStatusLine({ ...VIEW, health: off })).toBe("Not connected yet");
    expect(inboxStatusLine({ ...VIEW, enabled: false, health: off })).toBe(
      "Turned off",
    );
    expect(inboxStatusLine(VIEW)).toBe("Connected");
  });

  test("formChanged knows an edited form from an untouched one", () => {
    const form = formFromInbox(VIEW);
    expect(formChanged(VIEW, form)).toBe(false);
    expect(formChanged(VIEW, { ...form, label: "Other" })).toBe(true);
    expect(
      formChanged(VIEW, { ...form, imap: { ...form.imap, password: "x" } }),
    ).toBe(true);
  });
});
