import { afterEach, describe, expect, test } from "bun:test";
import {
  SUPPORT_EVENT_KEY,
  type SupportCloudEvent,
  type SupportConversation,
  type SupportMessage,
} from "../../shared/support";
import {
  __setSupportEventPublisherForTest,
  publishSupportEvent,
  supportCloudEvent,
} from "./events";

const message: SupportMessage = {
  id: "sm_0193a1b2-0000-7000-8000-000000000001",
  direction: "in",
  at: "2026-10-25T10:00:00.000Z",
  from: { name: "Ada", address: "ada@example.test" },
  to: [{ name: null, address: "help@acme.example.test" }],
  cc: [],
  subject: "Login broken",
  text: "SECRET-BODY-TEXT please help",
  keys: { messageId: "m1@example.test", inReplyTo: null, references: [] },
  providerId: "imap:1:1",
  attachments: [],
};

const conversation = {
  id: "sc_0193a1b2-0000-7000-8000-000000000002",
  channel: "email",
  inboxId: "inb_0193a1b2-0000-7000-8000-000000000003",
  project: "acme",
  subject: "Login broken",
  customer: { name: "Ada", address: "ada@example.test" },
  messages: [message],
} as unknown as SupportConversation;

afterEach(() => __setSupportEventPublisherForTest(undefined));

describe("supportCloudEvent", () => {
  test("is a CloudEvents 1.0 envelope with ids and no body", () => {
    const now = "2026-10-25T10:00:01.000Z";
    const event = supportCloudEvent(conversation, message, true, now);
    expect(event.specversion).toBe("1.0");
    expect(event.type).toBe("support.message.received");
    expect(event.source).toBe(`sessions/support/${conversation.inboxId}`);
    expect(event.id).toBe(message.id);
    expect(event.time).toBe(now);
    expect(event.datacontenttype).toBe("application/json");
    expect(Object.keys(event.data).sort()).toEqual(
      [
        "conversationId",
        "inboxId",
        "channel",
        "project",
        "messageId",
        "subject",
        "customer",
        "isNewConversation",
      ].sort(),
    );
    expect(event.data).toEqual({
      conversationId: conversation.id,
      inboxId: conversation.inboxId,
      channel: "email",
      project: "acme",
      messageId: message.id,
      subject: "Login broken",
      customer: "ada@example.test",
      isNewConversation: true,
    });
    expect(JSON.stringify(event)).not.toContain("SECRET-BODY-TEXT");
  });
});

describe("publishSupportEvent", () => {
  test("hands the serialised event to the publisher under the support key", async () => {
    const calls: Array<[string, string]> = [];
    __setSupportEventPublisherForTest(async (key, payload) => {
      calls.push([key, payload]);
      return 0;
    });
    const event = supportCloudEvent(conversation, message, false, message.at);
    await publishSupportEvent(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(SUPPORT_EVENT_KEY);
    expect(JSON.parse(calls[0]![1]) as SupportCloudEvent).toEqual(event);
  });
});
