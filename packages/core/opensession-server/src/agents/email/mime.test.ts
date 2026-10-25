import { describe, expect, test } from "bun:test";
import {
  type InboxConfig,
  type MailAddress,
  type SupportActor,
  type SupportConversation,
  type SupportDraft,
  type SupportMessage,
  defaultInboxConfig,
} from "../../shared/support";
import type { OutboundDraft } from "../../server/support/channel";
import {
  type OutgoingMail,
  buildReply,
  composeRaw,
  newMessageId,
  replyTarget,
} from "./mime";

const NOW = "2026-10-25T10:00:00.000Z";
const ADA: MailAddress = { name: "Ada", address: "ada@example.test" };

function inbox(): InboxConfig {
  const server = {
    host: "mail.example.test",
    port: 993,
    tls: "implicit" as const,
    user: "help@acme.example.test",
    passwordRef: "ref",
  };
  return defaultInboxConfig({
    id: "inb_test",
    label: "Acme help",
    address: "help@acme.example.test",
    project: "acme",
    owner: "Ada",
    createdBy: "Ada",
    now: NOW,
    imap: server,
    smtp: { ...server, port: 465 },
  });
}

function message(over: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: "sm_1",
    direction: "in",
    at: NOW,
    from: ADA,
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Help",
    text: "It broke",
    keys: { messageId: "m1@example.test", inReplyTo: null, references: [] },
    providerId: "imap:1:1",
    attachments: [],
    ...over,
  };
}

function outbound(
  messages: SupportMessage[],
  decidedBy: SupportActor | null = { kind: "person", name: "Ada" },
): OutboundDraft {
  const draft: SupportDraft = {
    id: "sd_1",
    text: "Thanks, fixed.",
    author: { kind: "agent", sessionId: "s1" },
    createdAt: NOW,
    state: "sending",
    rule: "",
    vetoDeadline: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    messageId: "out1@acme.example.test",
    decidedBy,
  };
  const conversation: SupportConversation = {
    id: "sc_1",
    channel: "email",
    inboxId: "inb_test",
    project: "acme",
    subject: messages[0]?.subject ?? "Help",
    customer: ADA,
    status: "open",
    owner: null,
    createdAt: NOW,
    lastMessageAt: NOW,
    closedAt: null,
    triage: null,
    sessionId: null,
    fixSessionId: null,
    messages,
    draft,
    autoSends: [],
    moves: [],
    issue: null,
    pendingIssue: null,
    events: [],
    revision: 1,
  };
  return { conversation, draft, inbox: inbox() };
}

describe("buildReply", () => {
  test("adds one Re: to the subject", () => {
    expect(buildReply(outbound([message()])).subject).toBe("Re: Help");
  });

  test("keeps a subject that already starts with Re:, in any case", () => {
    expect(
      buildReply(outbound([message({ subject: "RE: Help" })])).subject,
    ).toBe("RE: Help");
    expect(
      buildReply(outbound([message({ subject: "re:Help" })])).subject,
    ).toBe("re:Help");
  });

  test("replies to the last inbound message", () => {
    const first = message();
    const ours = message({
      id: "sm_2",
      direction: "out",
      from: { name: "Acme help", address: "help@acme.example.test" },
      to: [ADA],
      subject: "Re: Help",
      keys: {
        messageId: "out0@acme.example.test",
        inReplyTo: "m1@example.test",
        references: ["m1@example.test"],
      },
    });
    const second = message({
      id: "sm_3",
      subject: "Re: Help",
      keys: {
        messageId: "m2@example.test",
        inReplyTo: "out0@acme.example.test",
        references: ["m1@example.test", "out0@acme.example.test"],
      },
    });
    const mail = buildReply(outbound([first, ours, second]));
    expect(mail.inReplyTo).toBe("m2@example.test");
    expect(mail.references).toEqual([
      "m1@example.test",
      "out0@acme.example.test",
      "m2@example.test",
    ]);
    expect(mail.subject).toBe("Re: Help");
  });

  test("references are capped at 20: the thread root and the newest 19", () => {
    const references = Array.from(
      { length: 30 },
      (_, i) => `r${i}@example.test`,
    );
    const mail = buildReply(
      outbound([
        message({
          keys: { messageId: "m9@example.test", inReplyTo: null, references },
        }),
      ]),
    );
    expect(mail.references).toHaveLength(20);
    expect(mail.references[0]).toBe("r0@example.test");
    expect(mail.references[1]).toBe("r12@example.test");
    expect(mail.references.at(-1)).toBe("m9@example.test");
  });

  test("a repeated reference keeps its last place", () => {
    const mail = buildReply(
      outbound([
        message({
          keys: {
            messageId: "m3@example.test",
            inReplyTo: null,
            references: [
              "m1@example.test",
              "m2@example.test",
              "m1@example.test",
              "m3@example.test",
            ],
          },
        }),
      ]),
    );
    expect(mail.references).toEqual([
      "m2@example.test",
      "m1@example.test",
      "m3@example.test",
    ]);
  });

  test("In-Reply-To and References use the Message-ID as it was written", () => {
    const mail = buildReply(
      outbound([
        message({
          keys: {
            messageId: "AbC@mail.example.test",
            rawMessageId: "AbC@Mail.Example.TEST",
            inReplyTo: null,
            references: ["r1@example.test"],
          },
        }),
      ]),
    );
    expect(mail.inReplyTo).toBe("AbC@Mail.Example.TEST");
    expect(mail.references).toEqual([
      "r1@example.test",
      "AbC@Mail.Example.TEST",
    ]);
  });

  test("a message without a Message-ID gives no In-Reply-To", () => {
    const mail = buildReply(
      outbound([
        message({
          keys: {
            messageId: null,
            inReplyTo: null,
            references: ["r1@example.test"],
          },
        }),
      ]),
    );
    expect(mail.inReplyTo).toBeNull();
    expect(mail.references).toEqual(["r1@example.test"]);
  });

  test("to is the Reply-To when present, else From", () => {
    expect(buildReply(outbound([message()])).to).toEqual([ADA]);
    const desk = { name: "Desk", address: "desk@example.test" };
    expect(buildReply(outbound([message({ replyTo: [desk] })])).to).toEqual([
      desk,
    ]);
  });

  test("to is one address: the first Reply-To of several", () => {
    const list = [
      { name: "Desk", address: "desk@example.test" },
      { name: null, address: "boss@example.test" },
      { name: null, address: "else@example.test" },
    ];
    const mail = buildReply(outbound([message({ replyTo: list })]));
    expect(mail.to).toHaveLength(1);
    expect(mail.to).toEqual([list[0]!]);
  });

  test("never addresses the inbox's own logins or other inboxes", () => {
    const out = outbound([
      message({
        replyTo: [
          { name: null, address: "Login@Acme.example.test" },
          { name: null, address: "other-inbox@acme.example.test" },
        ],
      }),
    ]);
    out.inbox.smtp.user = "login@acme.example.test";
    expect(buildReply(out, ["other-inbox@acme.example.test"]).to).toEqual([
      ADA,
    ]);
    expect(buildReply(out).to).toEqual([
      { name: null, address: "other-inbox@acme.example.test" },
    ]);
  });

  test("with only machine mail, replies to the customer without In-Reply-To", () => {
    const bounce = message({
      from: { name: null, address: "mailer-daemon@example.test" },
      automated: true,
      keys: {
        messageId: "b1@example.test",
        inReplyTo: null,
        references: ["r1@example.test"],
      },
    });
    const mail = buildReply(outbound([bounce]));
    expect(mail.to).toEqual([ADA]);
    expect(mail.inReplyTo).toBeNull();
    expect(mail.references).toEqual([]);
  });

  test("never addresses MAILER-DAEMON or a no-reply address", () => {
    for (const address of [
      "MAILER-DAEMON@example.test",
      "no-reply@example.test",
      "noreply@example.test",
      "do-not-reply@example.test",
    ]) {
      const out = outbound([
        message({ from: { name: null, address: address.toLowerCase() } }),
      ]);
      out.conversation.customer = {
        name: null,
        address: address.toLowerCase(),
      };
      expect(buildReply(out).to).toEqual([]);
    }
  });

  test("never addresses the inbox itself", () => {
    const own = { name: null, address: "help@acme.example.test" };
    expect(buildReply(outbound([message({ replyTo: [own] })])).to).toEqual([
      ADA,
    ]);
  });

  test("from is the inbox, with its label; the id and text come from the draft", () => {
    const mail = buildReply(outbound([message()]));
    expect(mail.from).toEqual({
      name: "Acme help",
      address: "help@acme.example.test",
    });
    expect(mail.messageId).toBe("out1@acme.example.test");
    expect(mail.text).toBe("Thanks, fixed.");
  });

  test("Auto-Submitted is set only when Sessions decided the send", () => {
    expect(
      buildReply(outbound([message()], { kind: "sessions" })).headers,
    ).toEqual({
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
    });
    expect(buildReply(outbound([message()])).headers).toEqual({});
    expect(buildReply(outbound([message()], null)).headers).toEqual({});
  });

  test("line breaks in the subject do not reach the header", () => {
    const mail = buildReply(
      outbound([message({ subject: "Help\r\nBcc: x@example.test" })]),
    );
    expect(mail.subject).toBe("Re: Help Bcc: x@example.test");
  });
});

describe("replyTarget", () => {
  test("is the answered message and its one recipient", () => {
    const desk = { name: "Desk", address: "desk@example.test" };
    const answered = message({ id: "sm_2", replyTo: [desk, ADA] });
    const out = outbound([message(), answered]);
    expect(replyTarget(out.conversation)).toEqual({
      message: answered,
      to: [desk],
    });
  });

  test("skips machine mail and falls back to the customer", () => {
    const bounce = message({ automated: true });
    const out = outbound([bounce]);
    expect(replyTarget(out.conversation)).toEqual({
      message: null,
      to: [ADA],
    });
  });
});

describe("composeRaw", () => {
  test("line breaks in names, addresses and ids never start a header", async () => {
    const evil = "\r\nBcc: spy@evil.test\r\n";
    const mail: OutgoingMail = {
      from: {
        name: `Acme${evil}help`,
        address: `help@acme.example.test${evil}`,
      },
      to: [{ name: `Ada${evil}`, address: `ada@example.test${evil}` }],
      subject: `Hi${evil}`,
      text: "Body",
      messageId: `out1@acme.example.test>${evil}X-Id: <x`,
      inReplyTo: `m2@example.test>${evil}`,
      references: [`m1@example.test${evil}`, "m2@example.test"],
      headers: { "Auto-Submitted": `auto-replied${evil}` },
    };
    const raw = new TextDecoder().decode(await composeRaw(mail));
    const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
    const names = head
      .split("\r\n")
      .filter((line) => !/^[ \t]/.test(line))
      .map((line) => line.slice(0, line.indexOf(":")).toLowerCase());
    expect(names).not.toContain("bcc");
    expect(names).not.toContain("x-id");
    expect(head).not.toMatch(/\r\n[Bb]cc:/);
    expect(head).not.toMatch(/(^|\n)X-Id:/);
    for (const name of ["message-id", "in-reply-to", "references"])
      expect(names.filter((n) => n === name)).toHaveLength(1);
    expect(head).toMatch(/\r\nIn-Reply-To: <m2@example\.test[^\r\n]*>\r\n/);
    // Ids keep no whitespace, angle brackets or line breaks inside.
    const id = head.match(/\r\nMessage-ID: <([^\r\n]*)>\r\n/)?.[1];
    expect(id).toBeDefined();
    expect(id).not.toMatch(/[\s<>]/);
  });
});

describe("newMessageId", () => {
  test("is a uuid at the inbox domain, without brackets", () => {
    const id = newMessageId("support@Example.test");
    expect(id).toMatch(/^[0-9a-f-]{36}@example\.test$/);
    expect(newMessageId("support@example.test")).not.toBe(id);
  });
});
