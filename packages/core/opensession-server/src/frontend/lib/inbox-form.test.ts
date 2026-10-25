import { describe, expect, test } from "bun:test";
import type { InboxView } from "../../shared/support";
import {
  AUTONOMY_CHOICES,
  draftStatsLine,
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
  routineWaitLocked,
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
  autonomy: "draft",
  vetoMs: 900_000,
  neverWithoutAPerson: ["refund", "legal"],
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

  test("routine with a wait sends its minutes as vetoMs", () => {
    const form = formFromInbox(VIEW);
    form.autonomy = "routine";
    form.vetoMinutes = "5";
    expect(patchFromForm(VIEW, form)).toEqual({
      expectedRevision: 3,
      autonomy: "routine",
      vetoMs: 300_000,
    });
  });

  test("routine without a wait sends vetoMs null", () => {
    const form = formFromInbox(VIEW);
    form.autonomy = "routine";
    form.routineWaits = false;
    expect(patchFromForm(VIEW, form)).toEqual({
      expectedRevision: 3,
      autonomy: "routine",
      vetoMs: null,
    });
  });

  test("a routine inbox that sends right away reads back without a wait", () => {
    const saved: InboxView = { ...VIEW, autonomy: "routine", vetoMs: null };
    const form = formFromInbox(saved);
    expect(form.routineWaits).toBe(false);
    expect(form.vetoMinutes).toBe("10");
    expect(patchFromForm(saved, form)).toEqual({ expectedRevision: 3 });
    form.routineWaits = true;
    expect(patchFromForm(saved, form)).toEqual({
      expectedRevision: 3,
      vetoMs: 600_000,
    });
  });

  test("leaving routine sends no veto window", () => {
    const saved: InboxView = { ...VIEW, autonomy: "routine", vetoMs: null };
    const form = formFromInbox(saved);
    form.autonomy = "draft";
    expect(patchFromForm(saved, form)).toEqual({
      expectedRevision: 3,
      autonomy: "draft",
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
    form.autonomy = "routine";
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
    expect(input.autonomy).toBe("routine");
    expect(input.project).toBe("acme");
    expect(input).not.toHaveProperty("moveLock");
    expect(input).not.toHaveProperty("bugHandling");
  });

  test("starts at Draft with every never-without-a-person topic", () => {
    const form = emptyInboxForm("acme", "");
    expect(form.autonomy).toBe("draft");
    expect(form.neverWithoutAPerson).toEqual([
      "refund",
      "legal",
      "security",
      "data-export",
      "data-deletion",
      "account-deletion",
    ]);
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
  test("only for routine on a project with connectors", () => {
    expect(showsConnectorWarning("routine", true)).toBe(true);
    expect(showsConnectorWarning("draft", true)).toBe(false);
    expect(showsConnectorWarning("watch", true)).toBe(false);
    expect(showsConnectorWarning("routine", false)).toBe(false);
  });
});

describe("autonomy", () => {
  test("three choices, each with one plain line", () => {
    expect(AUTONOMY_CHOICES.map((c) => c.label)).toEqual([
      "Watch",
      "Draft",
      "Routine",
    ]);
    for (const choice of AUTONOMY_CHOICES) {
      expect(choice.description).not.toContain("\u2014");
      expect(choice.description.length).toBeLessThan(110);
    }
  });

  test("the drafts figure counts unchanged sends out of every settled draft", () => {
    const stats = { days: 30, sentUnchanged: 12, sentEdited: 2, discarded: 1 };
    expect(draftStatsLine(stats)).toBe(
      "12 of 15 drafts sent unchanged in the last 30 days",
    );
    expect(
      draftStatsLine({
        days: 30,
        sentUnchanged: 1,
        sentEdited: 0,
        discarded: 0,
      }),
    ).toBe("1 of 1 draft sent unchanged in the last 30 days");
    expect(
      draftStatsLine({
        days: 30,
        sentUnchanged: 0,
        sentEdited: 0,
        discarded: 0,
      }),
    ).toBe("No drafts in the last 30 days");
  });

  test("only the instance owner may turn off the wait", () => {
    const form = formFromInbox({ ...VIEW, autonomy: "routine" });
    expect(routineWaitLocked(form, VIEW, true)).toBeNull();
    expect(routineWaitLocked(form, VIEW, false)).toBe(
      "Only the instance owner can let routine replies send right away",
    );
    const owners: InboxView = { ...VIEW, autonomy: "routine", vetoMs: null };
    expect(routineWaitLocked(formFromInbox(owners), owners, false)).toBeNull();
  });

  test("a routine wait outside 1 to 1440 minutes is named", () => {
    const form = formFromInbox(VIEW);
    form.autonomy = "routine";
    form.vetoMinutes = "0";
    expect(inboxFormError(form, VIEW)).toBe(
      "Wait before sending must be from 1 to 1440 minutes",
    );
    form.routineWaits = false;
    expect(inboxFormError(form, VIEW)).toBeNull();
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

  test("vetoMs is sent only for routine", () => {
    const form = filled();
    expect(newInboxFromForm(form)).not.toHaveProperty("vetoMs");
    form.autonomy = "routine";
    expect(newInboxFromForm(form).vetoMs).toBe(600_000);
    form.routineWaits = false;
    expect(newInboxFromForm(form).vetoMs).toBeNull();
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
