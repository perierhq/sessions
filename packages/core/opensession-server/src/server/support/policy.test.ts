import { describe, expect, test } from "bun:test";
import type { KnowledgeVerdict } from "../../shared/knowledge";
import {
  AUTO_SENDS_PER_INBOX_PER_HOUR,
  type InboxConfig,
  type TriageVerdict,
} from "../../shared/support";
import {
  RULES,
  type ReplyDecision,
  decideReply,
  draftHasSecret,
  draftLinkProblem,
  draftLinks,
  knowledgeRule,
  replyLabels,
  validSource,
} from "./policy";

const NOW = Date.parse("2026-10-25T10:00:00.000Z");
/** A made-up key in the AWS format, built so no scanner reads it as one. */
const FAKE_AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
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

/** The server's check: every source verified, clean text. */
const checked = (
  sources: Input["draft"]["sources"],
  over: Partial<NonNullable<Input["draft"]["check"]>> = {},
): NonNullable<Input["draft"]["check"]> => ({
  verified: sources,
  topics: [],
  promises: false,
  at: "2026-10-25T09:59:30.000Z",
  ...over,
});

const draft = (over: Partial<Input["draft"]>): Input["draft"] => {
  const sources = over.sources ?? [
    { kind: "repo" as const, ref: "docs/export.md" },
  ];
  return {
    text: "Export from Settings, then Data.",
    promises: false,
    purpose: "reply",
    check: checked(sources),
    ...over,
    sources,
  };
};

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
    draft: draft({
      text: "Export from Settings, then Data. See https://docs.acme.example.test/export",
    }),
    unanswered: true,
    clarifyUsed: false,
    sites: { hosts: ["docs.acme.example.test"], connectors: ["acme-crm"] },
    inboxAutoSendsLastHour: 0,
    status: "open",
    personStoppedLast: false,
    knowledge: null,
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
  const SITES = ["docs.acme.example.test"];

  test("allows plain text and links on the project's sites", () => {
    expect(
      draftLinkProblem("See https://docs.acme.example.test/a#b.", SITES),
    ).toBe(false);
    expect(draftLinkProblem("2 < 3 and 4 > 1", [])).toBe(false);
  });

  test.each([
    "Log in at evil.example.test/login",
    'Open "www.evil.example.test" now',
    "Go to:evil.example.test",
    "Reply here>www.evil.example.test",
    "Open http:evil.example.test",
    "Open https:evil.example.test/x",
    "javascript:alert(1)",
    "Open evil.example.test",
    "See docs.acme.example.test.evil.test/x",
    "Visit evil\u200b.example.test",
    "Visit evil\uff0eexample\uff0etest",
    "foo://docs.acme.example.test/x",
  ])("a link elsewhere, as a linkifier finds it: %s", (text) => {
    expect(draftLinkProblem(text, SITES)).toBe(true);
  });

  test.each([
    "Run npm install, then restart Node.js.",
    "Edit package.json and docs/setup.md.",
    "Write to ada@customer.example.test.",
    "This is in v1.2.3, e.g. today.",
    "Note: it works.",
    "Call tel:+15550100 or mail mailto:help@acme.example.test.",
  ])("not a link: %s", (text) => {
    expect(draftLinks(text)).toEqual([]);
    expect(draftLinkProblem(text, SITES)).toBe(false);
  });

  test("a bare host on the project's sites is fine", () => {
    expect(draftLinkProblem("See docs.acme.example.test/export.", SITES)).toBe(
      false,
    );
  });

  test("at most two links, none with a query string", () => {
    const a = "https://docs.acme.example.test/a";
    expect(draftLinkProblem(`${a} ${a}/b`, SITES)).toBe(false);
    expect(draftLinkProblem(`${a} ${a}/b ${a}/c`, SITES)).toBe(true);
    expect(draftLinkProblem(`${a}?next=x`, SITES)).toBe(true);
  });

  test("only an exact host that isn't shared hosting", () => {
    expect(
      draftLinkProblem("https://help.acme.example.test/x", [
        "*.acme.example.test",
      ]),
    ).toBe(true);
    for (const host of ["acme.github.io", "acme.vercel.app", "github.com"])
      expect(draftLinkProblem(`https://${host}/x`, [host])).toBe(true);
    expect(
      draftLinkProblem("https://docs.acme.example.test:8443/x", [
        "docs.acme.example.test:8443",
      ]),
    ).toBe(false);
  });
});

describe("draftHasSecret", () => {
  test.each([
    `Your key is ${FAKE_AWS_KEY}`,
    "password: hunter2hunter",
    // Built at run time, so no secret scanner reads them as keys.
    `Use token=${["abc123", "def456"].join("")}`,
    ["sk", "test", "abcdefghijklmnopqrstuvwx"].join("_"),
    [
      "eyJ" + "hbGciOiJIUzI1NiJ9",
      "eyJ" + "zdWIiOiIxMjM0In0",
      "abcdefghijklmnop",
    ].join("."),
    "Here: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ZZ",
  ])("flags %s", (text) => {
    expect(draftHasSecret(text)).toBe(true);
  });

  test.each([
    "Export from Settings, then Data.",
    "Your order 3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e shipped.",
    "Fixed in 0123456789abcdef0123456789abcdef01234567.",
    "See docs/guides/exporting-your-account-data-to-csv.md",
    "Your password is reset by the link in the email.",
  ])("leaves %s", (text) => {
    expect(draftHasSecret(text)).toBe(false);
  });
});

describe("replyLabels", () => {
  test("a message whose topics are unknown holds automatic sends", () => {
    const at = "2026-10-25T09:59:00.000Z";
    const base = {
      route: "work" as const,
      injection: false,
      wantsHuman: false,
      angry: false,
      repeat: false,
      bug: false,
      thanksOnly: false,
      at,
    };
    const message = (topics: string[] | null) =>
      ({ triage: { ...base, topics } }) as never;
    expect(replyLabels([message([])]).pending).toBe(false);
    expect(replyLabels([message(null)]).pending).toBe(true);
  });
});

describe("the server's draft check", () => {
  test.each<[string, Partial<Input>, string]>([
    [
      "a source the server couldn't verify",
      {
        draft: draft({
          check: checked([]),
        }),
      },
      RULES.noSource,
    ],
    ["no check", { draft: draft({ check: null }) }, RULES.draftUnchecked],
    [
      "a check whose topics are unknown",
      { draft: draft({ check: checked([], { topics: null }) }) },
      RULES.draftUnchecked,
    ],
    [
      "the reply touches a never-without-a-person topic",
      {
        draft: draft({
          check: checked([{ kind: "repo", ref: "docs/export.md" }], {
            topics: ["legal"],
          }),
        }),
      },
      "Legal needs a person",
    ],
    [
      "the reply promises something",
      {
        draft: draft({
          check: checked([{ kind: "repo", ref: "docs/export.md" }], {
            promises: true,
          }),
        }),
      },
      RULES.draftPromise,
    ],
    [
      "the reply holds a secret",
      { draft: draft({ text: `Use the key ${FAKE_AWS_KEY}` }) },
      RULES.secret,
    ],
    [
      "no customer message waits for an answer",
      { unanswered: false },
      RULES.nothingToAnswer,
    ],
  ])("needs a person: %s", (_name, over, rule) => {
    expect(decideReply(input(over))).toEqual({ kind: "needs-person", rule });
  });
});

describe("one clarifying question", () => {
  const question = (over: Partial<Input["draft"]> = {}) =>
    draft({
      text: "Which browser do you use?",
      sources: [],
      purpose: "clarify",
      ...over,
    });

  test("sends without a source once", () => {
    expect(decideReply(input({ draft: question() }))).toEqual({
      kind: "send",
      rule: "Sent by the agent",
    });
    expect(
      decideReply(input({ draft: question(), clarifyUsed: true })),
    ).toEqual({ kind: "needs-person", rule: RULES.clarifyUsed });
  });

  test.each<[string, Partial<Input["draft"]>, string]>([
    ["too long", { text: `${"Which one? ".repeat(60)}` }, RULES.noSource],
    [
      "with a link",
      { text: "Is it https://docs.acme.example.test/a?" },
      RULES.noSource,
    ],
    ["flagged as a promise", { promises: true }, RULES.promise],
    [
      "the check finds a promise",
      { check: checked([], { promises: true }) },
      RULES.draftPromise,
    ],
    [
      "the check finds a sensitive topic",
      { check: checked([], { topics: ["refund"] }) },
      "Money and refunds needs a person",
    ],
  ])("waits when %s", (_name, over, rule) => {
    expect(decideReply(input({ draft: question(over) }))).toEqual({
      kind: "needs-person",
      rule,
    });
  });
});

describe("knowledge", () => {
  const ARTICLE = "articles/export.md@3f2a1b0";
  const cited = { kind: "knowledge" as const, ref: ARTICLE };
  const verdict = (over: Partial<KnowledgeVerdict> = {}): KnowledgeVerdict => ({
    backing: [],
    blocked: [],
    internalQuoted: null,
    failed: false,
    at: "2026-10-25T09:59:30.000Z",
    ...over,
  });
  const stale = verdict({
    blocked: [
      {
        ref: ARTICLE,
        path: "articles/export.md",
        title: "Export",
        reason: "docs/export.md changed in 9c1d2e0",
      },
    ],
  });

  test("the copy", () => {
    expect(RULES.knowledgeUnchecked).toBe("Knowledge couldn't be checked");
    expect(RULES.internalQuoted).toBe("The reply quotes an internal note");
    expect(knowledgeRule("Export")).toBe(
      "Knowledge may be out of date: Export",
    );
  });

  test("a stale article holds a draft that would send", () => {
    expect(decideReply(input())).toEqual({
      kind: "send",
      rule: "Sent by the agent",
    });
    expect(decideReply(input({ knowledge: stale }))).toEqual({
      kind: "needs-person",
      rule: "Knowledge may be out of date: Export",
    });
  });

  test("a stale article next to a verified repo source still holds", () => {
    const sources = [{ kind: "repo" as const, ref: "docs/export.md" }, cited];
    expect(
      decideReply(input({ draft: draft({ sources }), knowledge: stale })),
    ).toEqual({
      kind: "needs-person",
      rule: "Knowledge may be out of date: Export",
    });
  });

  test("a check that failed holds the draft", () => {
    expect(
      decideReply(input({ knowledge: verdict({ failed: true }) })),
    ).toEqual({ kind: "needs-person", rule: "Knowledge couldn't be checked" });
  });

  test("an internal quote holds the draft", () => {
    expect(
      decideReply(
        input({
          knowledge: verdict({
            internalQuoted: { path: "articles/ops.md", title: "Ops" },
          }),
        }),
      ),
    ).toEqual({
      kind: "needs-person",
      rule: "The reply quotes an internal note",
    });
  });

  test("a backing article is a source of its own", () => {
    const only = draft({ sources: [cited] });
    expect(
      decideReply(
        input({ draft: only, knowledge: verdict({ backing: [cited] }) }),
      ),
    ).toEqual({ kind: "send", rule: "Sent by the agent" });
    expect(
      decideReply(
        input({
          draft: only,
          knowledge: verdict({ backing: [cited] }),
          inbox: inbox({ vetoMs: 60_000 }),
        }),
      ),
    ).toEqual({
      kind: "veto",
      deadline: new Date(NOW + 60_000).toISOString(),
      rule: RULES.veto,
    });
  });

  test("a knowledge source counts only through the verdict", () => {
    // Listed as verified by the check, but not backing now.
    const only = draft({ sources: [cited] });
    expect(decideReply(input({ draft: only }))).toEqual({
      kind: "needs-person",
      rule: RULES.noSource,
    });
    expect(decideReply(input({ draft: only, knowledge: verdict() }))).toEqual({
      kind: "needs-person",
      rule: RULES.noSource,
    });
  });

  test("the draft check's rules come first", () => {
    expect(
      decideReply(
        input({
          draft: draft({
            check: checked([{ kind: "repo", ref: "docs/export.md" }], {
              promises: true,
            }),
          }),
          knowledge: stale,
        }),
      ),
    ).toEqual({ kind: "needs-person", rule: RULES.draftPromise });
  });

  test("a person's reply is unaffected", () => {
    expect(
      decideReply(
        input({
          author: { kind: "person", name: "Ada" },
          knowledge: verdict({ failed: true }),
        }),
      ),
    ).toEqual({ kind: "send", rule: "Sent by Ada" });
  });

  test("validSource takes a knowledge citation", () => {
    const sites = { hosts: [], connectors: [] };
    expect(validSource(cited, sites)).toBe(true);
    expect(
      validSource(
        {
          kind: "knowledge",
          ref: "knowledge:sources/mail/2026-10/a@b.test.md@3f2a1b0",
        },
        sites,
      ),
    ).toBe(true);
    for (const ref of [
      "../x@abc1234",
      "articles/x.md",
      "KNOWLEDGE.md@abc1234",
      "articles/x.md@xyz",
    ])
      expect(validSource({ kind: "knowledge", ref }, sites)).toBe(false);
  });
});

test("rule copy has no semicolons or em dashes", () => {
  for (const rule of Object.values(RULES)) {
    expect(rule).not.toContain(";");
    expect(rule).not.toContain("\u2014");
  }
});
