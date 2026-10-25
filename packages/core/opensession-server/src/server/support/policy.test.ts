import { describe, expect, test } from "bun:test";
import {
  AUTO_SENDS_PER_INBOX_PER_HOUR,
  type InboxConfig,
  type TriageVerdict,
} from "../../shared/support";
import {
  RULES,
  type ReplyDecision,
  decideReply,
  draftLinkProblem,
} from "./policy";

const NOW = Date.parse("2026-10-25T10:00:00.000Z");
const AGENT = { kind: "agent" as const, sessionId: "os-1" };

type Inbox = Pick<
  InboxConfig,
  "enabled" | "autonomy" | "vetoMs" | "neverWithoutAPerson"
>;

function inbox(over: Partial<Inbox> = {}): Inbox {
  return {
    enabled: true,
    autonomy: "routine",
    vetoMs: null,
    neverWithoutAPerson: ["refund", "account-deletion", "legal"],
    ...over,
  };
}

function triage(over: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    route: "work",
    reason: "test",
    topics: [],
    bug: false,
    at: "2026-10-25T09:59:00.000Z",
    ...over,
  };
}

type Input = Parameters<typeof decideReply>[0];

function labels(): Input["labels"] {
  return {
    pending: false,
    injection: false,
    wantsHuman: false,
    angry: false,
    repeat: false,
  };
}

const draft = (over: Partial<Input["draft"]>): Input["draft"] => ({
  text: "Export from Settings, then Data.",
  sources: [{ kind: "repo", ref: "docs/export.md" }],
  promises: false,
  purpose: "reply",
  ...over,
});

function input(over: Partial<Input> = {}): Input {
  return {
    author: AGENT,
    inbox: inbox(),
    triage: triage(),
    autoSendsLastHour: 0,
    now: NOW,
    lastInboundTrust: {
      replyToDiffers: false,
      authFailed: false,
      authVerified: true,
    },
    labels: {
      pending: false,
      injection: false,
      wantsHuman: false,
      angry: false,
      repeat: false,
    },
    injectionFlags: 0,
    personOnly: false,
    draft: {
      text: "Export from Settings, then Data. See https://docs.acme.example.test/export",
      sources: [{ kind: "repo", ref: "docs/export.md" }],
      promises: false,
      purpose: "reply",
    },
    sites: { hosts: ["docs.acme.example.test"], connectors: ["acme-crm"] },
    inboxAutoSendsLastHour: 0,
    status: "open",
    personStoppedLast: false,
    ...over,
  };
}

describe("decideReply", () => {
  test.each<[string, Partial<Input>, ReplyDecision]>([
    [
      "1. a person sends",
      { author: { kind: "person", name: "Ada" } },
      { kind: "send", rule: "Sent by Ada" },
    ],
    [
      "2. inbox off",
      { inbox: inbox({ enabled: false }) },
      { kind: "needs-person", rule: "The inbox is off" },
    ],
    [
      "2a. spam",
      { status: "spam" },
      { kind: "needs-person", rule: "The conversation is marked as spam" },
    ],
    [
      "2a. closed",
      { status: "closed" },
      { kind: "needs-person", rule: "The conversation is closed" },
    ],
    [
      "2b. a person stopped the last reply",
      { personStoppedLast: true },
      { kind: "needs-person", rule: "A person stopped the last reply" },
    ],
    [
      "3. watch",
      { inbox: inbox({ autonomy: "watch" }) },
      { kind: "needs-person", rule: "Drafts wait for a person" },
    ],
    [
      "3. draft",
      { inbox: inbox({ autonomy: "draft" }) },
      { kind: "needs-person", rule: "Drafts wait for a person" },
    ],
    [
      "4. no triage",
      { triage: null },
      { kind: "needs-person", rule: "Topics unknown, so a person decides" },
    ],
    [
      "4. topics unknown",
      { triage: triage({ topics: null }) },
      { kind: "needs-person", rule: "Topics unknown, so a person decides" },
    ],
    [
      "4a. sender not verified",
      { lastInboundTrust: { replyToDiffers: false, authFailed: true } },
      { kind: "needs-person", rule: "The sender could not be verified" },
    ],
    [
      "4a. reply-to differs",
      { lastInboundTrust: { replyToDiffers: true, authFailed: false } },
      {
        kind: "needs-person",
        rule: "Replies would go to a different address than the sender",
      },
    ],
    [
      "4. a message's labels not checked yet",
      { labels: { ...labels(), pending: true } },
      {
        kind: "needs-person",
        rule: "The newest message isn't checked yet",
      },
    ],
    [
      "4a. sender's mail not authenticated",
      {
        lastInboundTrust: {
          replyToDiffers: false,
          authFailed: false,
          authVerified: false,
        },
      },
      {
        kind: "needs-person",
        rule: "The sender's mail wasn't authenticated",
      },
    ],
    [
      "4a. no Authentication-Results at all",
      { lastInboundTrust: { replyToDiffers: false, authFailed: false } },
      {
        kind: "needs-person",
        rule: "The sender's mail wasn't authenticated",
      },
    ],
    [
      "6. the inbox's hourly cap",
      { inboxAutoSendsLastHour: AUTO_SENDS_PER_INBOX_PER_HOUR },
      {
        kind: "needs-person",
        rule: `${AUTO_SENDS_PER_INBOX_PER_HOUR} automatic replies from this inbox in the last hour`,
      },
    ],
    [
      "5. a never-without-a-person topic",
      { triage: triage({ topics: ["legal"] }) },
      { kind: "needs-person", rule: "Legal needs a person" },
    ],
    [
      "6. three automatic replies this hour",
      { autoSendsLastHour: 3 },
      { kind: "needs-person", rule: "3 automatic replies in the last hour" },
    ],
    [
      "7. veto window",
      { inbox: inbox({ vetoMs: 600_000 }) },
      {
        kind: "veto",
        deadline: new Date(NOW + 600_000).toISOString(),
        rule: "Sends when the window ends unless someone stops it",
      },
    ],
    ["8. send right away", {}, { kind: "send", rule: "Sent by the agent" }],
  ])("%s", (_name, over, expected) => {
    expect(decideReply(input(over))).toEqual(expected);
  });

  test("a person sends on a spam or closed conversation, and after a stop", () => {
    for (const over of [
      { status: "spam" as const },
      { status: "closed" as const },
      { personStoppedLast: true },
    ])
      expect(
        decideReply(
          input({ author: { kind: "person", name: "Ada" }, ...over }),
        ),
      ).toEqual({ kind: "send", rule: "Sent by Ada" });
  });

  test("a person wins over a refund topic", () => {
    expect(
      decideReply(
        input({
          author: { kind: "person", name: "Ada" },
          triage: triage({ topics: ["refund"] }),
          inbox: inbox({ autonomy: "draft" }),
        }),
      ),
    ).toEqual({ kind: "send", rule: "Sent by Ada" });
  });

  test("a never-without-a-person topic wins over the veto window", () => {
    expect(
      decideReply(
        input({
          inbox: inbox({ vetoMs: 600_000 }),
          triage: triage({ topics: ["security", "refund"] }),
        }),
      ),
    ).toEqual({
      kind: "needs-person",
      rule: "Money and refunds needs a person",
    });
  });

  test("a topic outside the inbox's list does not hold the reply", () => {
    expect(
      decideReply(input({ triage: triage({ topics: ["security"] }) })),
    ).toEqual({ kind: "send", rule: "Sent by the agent" });
  });

  test("two automatic replies this hour still send right away", () => {
    expect(decideReply(input({ autoSendsLastHour: 2 }))).toEqual({
      kind: "send",
      rule: "Sent by the agent",
    });
  });

  test("the veto deadline is now + vetoMs exactly", () => {
    const decision = decideReply(input({ inbox: inbox({ vetoMs: 1234 }) }));
    expect(decision.kind).toBe("veto");
    if (decision.kind === "veto")
      expect(Date.parse(decision.deadline)).toBe(NOW + 1234);
  });

  test("triage route 'simple' is never permission to send", () => {
    for (const autonomy of ["watch", "draft"] as const)
      expect(
        decideReply(
          input({
            inbox: inbox({ autonomy }),
            triage: triage({ route: "simple" }),
          }),
        ).kind,
      ).toBe("needs-person");
    expect(
      decideReply(input({ triage: triage({ route: "simple", topics: null }) })),
    ).toEqual({
      kind: "needs-person",
      rule: "Topics unknown, so a person decides",
    });
  });

  test("a failed triage holds the reply", () => {
    expect(
      decideReply(input({ triage: triage({ topics: null, failed: true }) }))
        .kind,
    ).toBe("needs-person");
  });

  test.each<[string, Partial<Input>, string]>([
    ["handed to a person", { personOnly: true }, RULES.personOnly],
    [
      "an it's fixed note",
      { draft: draft({ purpose: "fixed-note" }) },
      RULES.fixedNote,
    ],
    [
      "an injection flag on a message it answers",
      { labels: { ...labels(), injection: true } },
      RULES.injection,
    ],
    ["an injection flag earlier on", { injectionFlags: 1 }, RULES.injection],
    [
      "the customer asks for a person",
      { labels: { ...labels(), wantsHuman: true } },
      RULES.wantsHuman,
    ],
    [
      "the customer is angry",
      { labels: { ...labels(), angry: true } },
      RULES.angry,
    ],
    [
      "an older angry-customer topic",
      { triage: triage({ topics: ["angry-customer" as never] }) },
      RULES.angry,
    ],
    [
      "a repeated question",
      { labels: { ...labels(), repeat: true } },
      RULES.repeat,
    ],
    ["no source", { draft: draft({ sources: [] }) }, RULES.noSource],
    [
      "a promise without a source",
      { draft: draft({ sources: [], promises: true }) },
      RULES.promise,
    ],
    [
      "a source that is a path outside the repo",
      { draft: draft({ sources: [{ kind: "repo", ref: "../secrets.env" }] }) },
      RULES.noSource,
    ],
    [
      "a URL source outside the project's sites",
      {
        draft: draft({
          sources: [{ kind: "url", ref: "https://evil.example.test/x" }],
        }),
      },
      RULES.noSource,
    ],
    [
      "a record of a connector the project doesn't tick",
      { draft: draft({ sources: [{ kind: "record", ref: "other:42" }] }) },
      RULES.noSource,
    ],
    [
      "a link outside the project's sites",
      { draft: draft({ text: "See https://evil.example.test/login" }) },
      RULES.links,
    ],
    [
      "a plain http link elsewhere, with a port",
      { draft: draft({ text: "See http://docs.acme.example.test:8080/x" }) },
      RULES.links,
    ],
    [
      "another scheme",
      { draft: draft({ text: "Open ftp://docs.acme.example.test/x" }) },
      RULES.links,
    ],
    [
      "an image",
      { draft: draft({ text: "![x](https://docs.acme.example.test/a.png)" }) },
      RULES.links,
    ],
    [
      "HTML",
      {
        draft: draft({
          text: 'Hi <img src="https://docs.acme.example.test/t.gif">',
        }),
      },
      RULES.links,
    ],
    [
      "a data URI",
      { draft: draft({ text: "data:text/html;base64,PHNjcmlwdD4=" }) },
      RULES.links,
    ],
  ])("needs a person: %s", (_name, over, rule) => {
    expect(decideReply(input(over))).toEqual({ kind: "needs-person", rule });
  });

  test("routine sends with a cited source of each kind", () => {
    for (const source of [
      { kind: "repo" as const, ref: "docs/export.md" },
      { kind: "url" as const, ref: "https://docs.acme.example.test/export" },
      { kind: "record" as const, ref: "acme-crm:cus_42" },
    ])
      expect(
        decideReply(
          input({ draft: draft({ sources: [source], promises: true }) }),
        ),
      ).toEqual({ kind: "send", rule: "Sent by the agent" });
  });

  test("a person's reply skips the draft checks", () => {
    expect(
      decideReply(
        input({
          author: { kind: "person", name: "Ada" },
          labels: { ...labels(), injection: true },
          draft: draft({ sources: [], text: "https://elsewhere.example.test" }),
        }),
      ),
    ).toEqual({ kind: "send", rule: "Sent by Ada" });
  });
});

describe("draftLinkProblem", () => {
  test("allows plain text and links on the project's sites", () => {
    expect(
      draftLinkProblem("See https://docs.acme.example.test/a?b=1.", [
        "docs.acme.example.test",
      ]),
    ).toBe(false);
    expect(draftLinkProblem("2 < 3 and 4 > 1", [])).toBe(false);
  });
});
