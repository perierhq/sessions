import { describe, expect, test } from "bun:test";
import type { InboxConfig, TriageVerdict } from "../../shared/support";
import { type ReplyDecision, decideReply } from "./policy";

const NOW = Date.parse("2026-10-25T10:00:00.000Z");
const AGENT = { kind: "agent" as const, sessionId: "os-1" };

type Inbox = Pick<
  InboxConfig,
  "enabled" | "autonomy" | "vetoMs" | "neverWithoutAPerson"
>;

function inbox(over: Partial<Inbox> = {}): Inbox {
  return {
    enabled: true,
    autonomy: "deploy-right-away",
    vetoMs: 600_000,
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

function input(over: Partial<Input> = {}): Input {
  return {
    author: AGENT,
    inbox: inbox(),
    triage: triage(),
    autoSendsLastHour: 0,
    now: NOW,
    lastInboundTrust: { replyToDiffers: false, authFailed: false },
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
      "3. propose",
      { inbox: inbox({ autonomy: "propose" }) },
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
      { inbox: inbox({ autonomy: "deploy-after-veto" }) },
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
        decideReply(input({ author: { kind: "person", name: "Ada" }, ...over })),
      ).toEqual({ kind: "send", rule: "Sent by Ada" });
  });

  test("a person wins over a refund topic", () => {
    expect(
      decideReply(
        input({
          author: { kind: "person", name: "Ada" },
          triage: triage({ topics: ["refund"] }),
          inbox: inbox({ autonomy: "propose" }),
        }),
      ),
    ).toEqual({ kind: "send", rule: "Sent by Ada" });
  });

  test("a never-without-a-person topic wins over the veto window", () => {
    expect(
      decideReply(
        input({
          inbox: inbox({ autonomy: "deploy-after-veto" }),
          triage: triage({ topics: ["angry-customer", "refund"] }),
        }),
      ),
    ).toEqual({ kind: "needs-person", rule: "Refunds needs a person" });
  });

  test("a topic outside the inbox's list does not hold the reply", () => {
    expect(
      decideReply(input({ triage: triage({ topics: ["angry-customer"] }) })),
    ).toEqual({ kind: "send", rule: "Sent by the agent" });
  });

  test("two automatic replies this hour still send right away", () => {
    expect(decideReply(input({ autoSendsLastHour: 2 }))).toEqual({
      kind: "send",
      rule: "Sent by the agent",
    });
  });

  test("the veto deadline is now + vetoMs exactly", () => {
    const decision = decideReply(
      input({ inbox: inbox({ autonomy: "deploy-after-veto", vetoMs: 1234 }) }),
    );
    expect(decision.kind).toBe("veto");
    if (decision.kind === "veto")
      expect(Date.parse(decision.deadline)).toBe(NOW + 1234);
  });

  test("triage route 'simple' is never permission to send", () => {
    for (const autonomy of ["watch", "propose"] as const)
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
});
