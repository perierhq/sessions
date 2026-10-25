import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  DraftState,
  SupportConversation,
  SupportDraft,
  SupportMessage,
} from "../../shared/support";
import { SUPPORT_PUSH } from "../../shared/support-copy";
import { __setOwnerRosterForTest } from "../incidents/owner";
import type { NotificationEvent } from "../notification-threads";
import {
  __resetSupportNotificationsForTest,
  planSupportNotification,
  startSupportNotifications,
  supportNotificationsSettled,
  supportUrl,
} from "./notify";
import { createConversation, updateConversation } from "./store";
import { useSupportTestKernel } from "./testing/kernel-fixture";

// Distinctive strings that must never reach an event: the push and the
// inbox row are built from fixed copy and the project only.
const SUBJECT = "Zebra-subject-7731 refund for invoice";
const CUSTOMER_NAME = "Quentin Xylophone";
const CUSTOMER_ADDRESS = "quentin.xylo@customer.example.test";
const DRAFT_TEXT = "Hello Quentin, draft-text-99417 about your refund";
const MESSAGE_TEXT = "message-text-55120 please refund me";

const FACTS = { recipient: "Ada", timeZone: "UTC" };

function message(): SupportMessage {
  return {
    id: "sm_1",
    direction: "in",
    at: "2026-10-25T13:00:00.000Z",
    from: { name: CUSTOMER_NAME, address: CUSTOMER_ADDRESS },
    to: [{ name: "", address: "help@acme.example.test" }],
    cc: [],
    subject: SUBJECT,
    text: MESSAGE_TEXT,
    keys: { messageId: "<m1@customer.example.test>", references: [] },
    providerId: "1",
    attachments: [],
  } as unknown as SupportMessage;
}

function draft(state: DraftState, over: Partial<SupportDraft> = {}) {
  return {
    id: "sd_1",
    text: DRAFT_TEXT,
    author: { kind: "agent", sessionId: "os-1" },
    createdAt: "2026-10-25T13:01:00.000Z",
    state,
    rule:
      state === "veto"
        ? "Sends when the window ends unless someone stops it"
        : "Drafts wait for a person",
    vetoDeadline: state === "veto" ? "2026-10-25T14:05:00.000Z" : null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    messageId: "<sd_1@acme.example.test>",
    decidedBy: null,
    ...over,
  } satisfies SupportDraft;
}

function conversation(
  over: Partial<SupportConversation> = {},
): SupportConversation {
  return {
    id: "sc_0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    channel: "email",
    inboxId: "inbox-1",
    project: "acme",
    subject: SUBJECT,
    customer: { name: CUSTOMER_NAME, address: CUSTOMER_ADDRESS },
    status: "open",
    owner: "Ada",
    createdAt: "2026-10-25T13:00:00.000Z",
    lastMessageAt: "2026-10-25T13:00:00.000Z",
    closedAt: null,
    triage: null,
    sessionId: null,
    fixSessionId: null,
    messages: [message()],
    draft: null,
    autoSends: [],
    moves: [],
    issue: null,
    pendingIssue: null,
    events: [],
    revision: 1,
    ...over,
  };
}

const NOW = Date.parse("2026-10-25T14:00:00.000Z");

describe("supportUrl", () => {
  test("opens the email conversation, with an optional intent", () => {
    expect(supportUrl("sc_1")).toBe("/support/email:sc_1");
    expect(supportUrl("sc_1", "stop")).toBe("/support/email:sc_1?intent=stop");
    expect(supportUrl("sc_1", "review")).toBe(
      "/support/email:sc_1?intent=review",
    );
  });
});

describe("planSupportNotification", () => {
  test("a draft that starts waiting for a person tells the owner once", () => {
    const previous = conversation();
    const next = conversation({
      draft: draft("needs-person"),
      revision: 2,
    });
    const planned = planSupportNotification(next, previous, FACTS, NOW);
    expect(planned?.user).toBe("Ada");
    expect(planned?.event).toEqual({
      kind: "support_needs_you",
      subject: {
        type: "support",
        id: next.id,
        title: SUPPORT_PUSH.needsYouTitle,
        context: "acme",
      },
      reason: "Drafts wait for a person",
      body: SUPPORT_PUSH.needsYouBody,
      url: supportUrl(next.id),
      eventKey: `${next.id}:sd_1:needs-person`,
      at: NOW,
      push: {
        body: SUPPORT_PUSH.needsYouBody,
        actions: [
          {
            action: "review",
            title: SUPPORT_PUSH.review,
            url: supportUrl(next.id, "review"),
          },
        ],
        requireInteraction: true,
        ttlSeconds: 43_200,
        urgency: "normal",
      },
    });
  });

  test("the same state again (a revision bump for another reason) plans nothing", () => {
    const previous = conversation({ draft: draft("needs-person") });
    const next = conversation({
      draft: draft("needs-person"),
      status: "waiting",
      revision: 3,
    });
    expect(planSupportNotification(next, previous, FACTS, NOW)).toBeNull();
  });

  test("states nobody has to act on plan nothing", () => {
    for (const state of ["sending", "sent", "discarded"] as const)
      expect(
        planSupportNotification(
          conversation({ draft: draft(state) }),
          conversation({ draft: draft("veto") }),
          FACTS,
          NOW,
        ),
      ).toBeNull();
    expect(
      planSupportNotification(conversation(), null, FACTS, NOW),
    ).toBeNull();
  });

  test("a new draft in the same state is news", () => {
    const previous = conversation({ draft: draft("needs-person") });
    const next = conversation({
      draft: draft("needs-person", { id: "sd_2" }),
    });
    expect(
      planSupportNotification(next, previous, FACTS, NOW)?.event.eventKey,
    ).toBe(`${next.id}:sd_2:needs-person`);
  });

  test("a veto says when it sends, in the owner's time zone, with a Stop button", () => {
    const next = conversation({ draft: draft("veto") });
    const planned = planSupportNotification(next, conversation(), FACTS, NOW);
    expect(planned?.event.kind).toBe("support_veto");
    expect(planned?.event.subject.title).toBe(SUPPORT_PUSH.vetoTitle);
    expect(planned?.event.body).toBe("Sends at 14:05 unless you stop it");
    expect(planned?.event.push).toEqual({
      body: "Sends at 14:05 unless you stop it",
      actions: [
        {
          action: "stop",
          title: SUPPORT_PUSH.stop,
          url: supportUrl(next.id, "stop"),
        },
      ],
      requireInteraction: true,
      ttlSeconds: 300,
      urgency: "high",
    });
    const warsaw = planSupportNotification(
      next,
      conversation(),
      { recipient: "Ada", timeZone: "Europe/Warsaw" },
      NOW,
    );
    expect(warsaw?.event.push?.body).toBe("Sends at 15:05 unless you stop it");
  });

  test("a veto ending within a minute still lives for 60 seconds", () => {
    const next = conversation({
      draft: draft("veto", { vetoDeadline: "2026-10-25T14:00:10.000Z" }),
    });
    expect(
      planSupportNotification(next, conversation(), FACTS, NOW)?.event.push
        ?.ttlSeconds,
    ).toBe(60);
  });

  test("a failed send is support_failed and never carries the error", () => {
    const previous = conversation({ draft: draft("sending") });
    const next = conversation({
      draft: draft("sending", {
        state: "failed",
        rule: "Sent by the agent",
        lastError: `550 5.1.1 <${CUSTOMER_ADDRESS}>: no such user`,
      }),
    });
    const planned = planSupportNotification(next, previous, FACTS, NOW);
    expect(planned?.event).toMatchObject({
      kind: "support_failed",
      subject: { title: SUPPORT_PUSH.failedTitle },
      reason: "Not sent",
      body: SUPPORT_PUSH.failedBody,
      eventKey: `${next.id}:sd_1:failed`,
      push: { body: SUPPORT_PUSH.failedBody },
    });
    expect(JSON.stringify(planned)).not.toContain(CUSTOMER_ADDRESS);
  });

  test("no customer name, address, subject or text in any event", () => {
    for (const state of ["needs-person", "veto", "failed"] as const) {
      const planned = planSupportNotification(
        conversation({ draft: draft(state) }),
        null,
        FACTS,
        NOW,
      );
      expect(planned).not.toBeNull();
      const json = JSON.stringify(planned);
      for (const secret of [
        SUBJECT,
        "Zebra-subject",
        CUSTOMER_NAME,
        "Quentin",
        CUSTOMER_ADDRESS,
        DRAFT_TEXT,
        "draft-text-99417",
        MESSAGE_TEXT,
        "message-text-55120",
      ])
        expect(json).not.toContain(secret);
    }
  });

  test("no recipient: nothing", () => {
    expect(
      planSupportNotification(
        conversation({ draft: draft("needs-person") }),
        null,
        { recipient: "", timeZone: "UTC" },
        NOW,
      ),
    ).toBeNull();
  });

  test("the recipient's own change lands quietly", () => {
    const next = conversation({
      draft: draft("needs-person", {
        rule: "Stopped by Ada",
        decidedBy: { kind: "person", name: "Ada" },
      }),
    });
    const previous = conversation({ draft: draft("veto") });
    expect(
      planSupportNotification(next, previous, FACTS, NOW)?.event.delivery,
    ).toBe("quiet");
    const other = conversation({
      draft: draft("needs-person", {
        rule: "Stopped by Grace",
        decidedBy: { kind: "person", name: "Grace" },
      }),
    });
    expect(
      planSupportNotification(other, previous, FACTS, NOW)?.event.delivery,
    ).toBeUndefined();
  });
});

describe("startSupportNotifications", () => {
  useSupportTestKernel();
  const delivered: Array<{ user: string; event: NotificationEvent }> = [];

  beforeEach(() => {
    delivered.length = 0;
    __resetSupportNotificationsForTest();
    __setOwnerRosterForTest(
      [
        { name: "Ada Lovelace", email: "ada@acme.example.test" },
        { name: "Grace Hopper", email: "grace@acme.example.test" },
      ] as never,
      "Grace",
    );
    startSupportNotifications({
      notify: async (user, event) => {
        delivered.push({ user, event });
        return null;
      },
      timeZone: () => "UTC",
      now: () => NOW,
    });
  });
  afterEach(() => {
    __resetSupportNotificationsForTest();
    __setOwnerRosterForTest(undefined);
  });

  async function settle() {
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    await supportNotificationsSettled();
  }

  async function seed(owner: string | null) {
    return createConversation({
      channel: "email",
      inboxId: "inbox-1",
      project: "acme",
      subject: SUBJECT,
      customer: { name: CUSTOMER_NAME, address: CUSTOMER_ADDRESS },
      owner,
      first: message(),
      now: "2026-10-25T13:00:00.000Z",
    });
  }

  test("a committed change into needs-person reaches the owner", async () => {
    const c = await seed("Ada");
    await settle();
    expect(delivered).toEqual([]);
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: draft("needs-person"),
    }));
    await settle();
    expect(delivered.map((d) => [d.user, d.event.kind])).toEqual([
      ["Ada", "support_needs_you"],
    ]);
    // Another change that leaves the draft alone tells nobody.
    await updateConversation(c.id, (x) => ({ ...x, status: "waiting" }));
    await settle();
    expect(delivered).toHaveLength(1);
  });

  test("no owner: the instance owner hears", async () => {
    const c = await seed(null);
    await updateConversation(c.id, (x) => ({ ...x, draft: draft("veto") }));
    await settle();
    expect(delivered.map((d) => [d.user, d.event.kind])).toEqual([
      ["Grace", "support_veto"],
    ]);
  });

  test("starting twice subscribes once", async () => {
    startSupportNotifications();
    const c = await seed("Ada");
    await updateConversation(c.id, (x) => ({ ...x, draft: draft("failed") }));
    await settle();
    expect(delivered).toHaveLength(1);
  });
});
