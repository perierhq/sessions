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
  handleSupportChange,
  planSupportNotification,
  SUPPORT_ALERT_COOLDOWN_MS,
  startSupportNotifications,
  supportNotificationsSettled,
  supportUrl,
} from "./notify";
import { INTERRUPTED_SEND } from "./reply";
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
      eventKey: `${next.id}:sd_1:needs-person:2`,
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
      cooldown: { key: "support_needs_you", ms: SUPPORT_ALERT_COOLDOWN_MS },
    });
    expect(SUPPORT_ALERT_COOLDOWN_MS).toBe(900_000);
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
    expect(
      planSupportNotification(
        conversation({ draft: draft("sending") }),
        conversation({ draft: draft("veto") }),
        FACTS,
        NOW,
      ),
    ).toBeNull();
    // A sent or discarded draft that was never in the inbox before: nothing
    // to settle.
    for (const state of ["sent", "discarded"] as const)
      expect(
        planSupportNotification(
          conversation({ draft: draft(state) }),
          conversation({ draft: draft(state, { id: "sd_0" }) }),
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
    ).toBe(`${next.id}:sd_2:needs-person:1`);
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
      eventKey: `${next.id}:sd_1:failed:1`,
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

  test("the recipient's own change replaces the banner silently", () => {
    const next = conversation({
      draft: draft("needs-person", {
        rule: "Stopped by Ada",
        decidedBy: { kind: "person", name: "Ada" },
      }),
    });
    const previous = conversation({ draft: draft("veto") });
    const own = planSupportNotification(next, previous, FACTS, NOW)?.event;
    expect(own?.delivery).toBe("replace");
    expect(own?.cooldown).toBeUndefined();
    // Compared without case.
    expect(
      planSupportNotification(
        next,
        previous,
        { recipient: "ada", timeZone: "UTC" },
        NOW,
      )?.event.delivery,
    ).toBe("replace");
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

  test("a failed send alerts even when the recipient sent it", () => {
    const by = { kind: "person", name: "Ada" } as const;
    const previous = conversation({
      draft: draft("sending", { decidedBy: by, attempts: 1 }),
    });
    // Retries the person never saw fail.
    const retried = conversation({
      draft: draft("failed", {
        decidedBy: by,
        attempts: 3,
        lastError: "421 try later",
      }),
    });
    const retriedEvent = planSupportNotification(
      retried,
      previous,
      FACTS,
      NOW,
    )?.event;
    expect(retriedEvent?.delivery).toBeUndefined();
    expect(retriedEvent?.cooldown).toEqual({
      key: "support_failed",
      ms: SUPPORT_ALERT_COOLDOWN_MS,
    });
    // A restart cut the send off: nobody saw that either.
    const interrupted = conversation({
      draft: draft("failed", {
        decidedBy: by,
        attempts: 1,
        lastError: INTERRUPTED_SEND,
      }),
    });
    expect(
      planSupportNotification(interrupted, previous, FACTS, NOW)?.event
        .delivery,
    ).toBeUndefined();
    // The first attempt failed while they waited: they read it in the 502.
    const seen = conversation({
      draft: draft("failed", {
        decidedBy: by,
        attempts: 1,
        lastError: "550 no such user",
      }),
    });
    expect(
      planSupportNotification(seen, previous, FACTS, NOW)?.event.delivery,
    ).toBe("replace");
  });

  test("a veto alert has no cooldown; one with no future deadline plans nothing", () => {
    const veto = planSupportNotification(
      conversation({ draft: draft("veto") }),
      conversation(),
      FACTS,
      NOW,
    )?.event;
    expect(veto?.cooldown).toBeUndefined();
    for (const vetoDeadline of [null, "2026-10-25T13:59:00.000Z"])
      expect(
        planSupportNotification(
          conversation({ draft: draft("veto", { vetoDeadline }) }),
          conversation(),
          FACTS,
          NOW,
        ),
      ).toBeNull();
  });

  test("a veto banner lives at most an hour", () => {
    const next = conversation({
      draft: draft("veto", { vetoDeadline: "2026-10-25T18:00:00.000Z" }),
    });
    expect(
      planSupportNotification(next, conversation(), FACTS, NOW)?.event.push
        ?.ttlSeconds,
    ).toBe(3600);
  });

  test("the dedupe key names the revision, so a draft back in a state is news", () => {
    const first = planSupportNotification(
      conversation({ draft: draft("veto"), revision: 4 }),
      conversation({ draft: draft("needs-person"), revision: 3 }),
      FACTS,
      NOW,
    );
    const again = planSupportNotification(
      conversation({ draft: draft("veto"), revision: 7 }),
      conversation({ draft: draft("needs-person"), revision: 6 }),
      FACTS,
      NOW,
    );
    expect(first?.event.eventKey).toMatch(/:sd_1:veto:4$/);
    expect(again?.event.eventKey).toMatch(/:sd_1:veto:7$/);
  });

  test("a waiting draft that is sent or discarded settles its row silently", () => {
    const sent = planSupportNotification(
      conversation({
        draft: draft("sent", { rule: "Sent by Grace" }),
        revision: 5,
      }),
      conversation({ draft: draft("sending"), revision: 4 }),
      FACTS,
      NOW,
    );
    expect(sent?.user).toBe("Ada");
    expect(sent?.event).toEqual({
      kind: "support_needs_you",
      subject: {
        type: "support",
        id: sent?.event.subject.id ?? "",
        title: SUPPORT_PUSH.sentTitle,
        context: "acme",
      },
      reason: SUPPORT_PUSH.settledBody,
      body: SUPPORT_PUSH.settledBody,
      url: supportUrl(sent?.event.subject.id ?? ""),
      eventKey: `${sent?.event.subject.id}:sd_1:sent:5`,
      at: NOW,
      delivery: "replace",
      existingOnly: true,
      push: {
        body: SUPPORT_PUSH.settledBody,
        ttlSeconds: 3600,
        urgency: "low",
      },
    });
    expect(SUPPORT_PUSH.sentTitle).toBe("Reply sent");
    const discarded = planSupportNotification(
      conversation({
        draft: draft("discarded", {
          rule: "Discarded by Ada",
          decidedBy: { kind: "person", name: "Ada" },
        }),
      }),
      conversation({ draft: draft("veto") }),
      FACTS,
      NOW,
    );
    expect(discarded?.event.subject.title).toBe(SUPPORT_PUSH.discardedTitle);
    expect(SUPPORT_PUSH.discardedTitle).toBe("Reply discarded");
    expect(discarded?.event.delivery).toBe("replace");
    expect(discarded?.event.existingOnly).toBe(true);
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

  test("no owner: the inbox owner hears before the instance owner", async () => {
    const seen: string[] = [];
    const deps = {
      notify: async (user: string) => {
        seen.push(user);
        return null;
      },
      timeZone: () => "UTC",
      now: () => NOW,
    };
    const next = conversation({ owner: null, draft: draft("needs-person") });
    await handleSupportChange(next, conversation({ owner: null }), {
      ...deps,
      inboxOwner: async () => "Ada",
    });
    await handleSupportChange(next, conversation({ owner: null }), {
      ...deps,
      inboxOwner: async () => null,
    });
    expect(seen).toEqual(["Ada", "Grace"]);
  });

  test("a sent draft reaches the notifier as a settle", async () => {
    const c = await seed("Ada");
    await updateConversation(c.id, (x) => ({ ...x, draft: draft("veto") }));
    await updateConversation(c.id, (x) => ({
      ...x,
      draft: draft("sending"),
    }));
    await updateConversation(c.id, (x) => ({ ...x, draft: draft("sent") }));
    await settle();
    expect(delivered.map((d) => [d.event.kind, d.event.subject.title])).toEqual(
      [
        ["support_veto", SUPPORT_PUSH.vetoTitle],
        ["support_needs_you", SUPPORT_PUSH.sentTitle],
      ],
    );
  });

  test("starting twice subscribes once", async () => {
    startSupportNotifications();
    const c = await seed("Ada");
    await updateConversation(c.id, (x) => ({ ...x, draft: draft("failed") }));
    await settle();
    expect(delivered).toHaveLength(1);
  });
});
