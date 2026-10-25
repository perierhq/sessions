// The CloudEvents 1.0 envelope for each customer message, published on the
// automation event bus as `support:message_received` so operators' own
// automations can react. Core triage and routing never depend on it. The
// event carries ids, subject and customer address, never the body.

import {
  SUPPORT_EVENT_KEY,
  SUPPORT_EVENT_TYPE,
  type SupportCloudEvent,
  type SupportConversation,
  type SupportMessage,
} from "../../shared/support";

type Publisher = (eventKey: string, payload: string) => Promise<number>;

let publisherOverride: Publisher | undefined;

/** Replace the automation bus (tests); undefined restores it. */
export function __setSupportEventPublisherForTest(
  publisher: Publisher | undefined,
): void {
  publisherOverride = publisher;
}

export function supportCloudEvent(
  c: SupportConversation,
  m: SupportMessage,
  isNew: boolean,
  now: string,
): SupportCloudEvent {
  return {
    specversion: "1.0",
    type: SUPPORT_EVENT_TYPE,
    source: `sessions/support/${c.inboxId}`,
    id: m.id,
    time: now,
    datacontenttype: "application/json",
    data: {
      conversationId: c.id,
      inboxId: c.inboxId,
      channel: c.channel,
      project: c.project,
      messageId: m.id,
      subject: c.subject,
      customer: c.customer.address,
      isNewConversation: isNew,
    },
  };
}

export async function publishSupportEvent(e: SupportCloudEvent): Promise<void> {
  // Lazy, as other agents do: automations.ts is heavy and ingest stays light.
  const publish =
    publisherOverride ??
    (await import("../automations")).fireAutomationsForEvent;
  await publish(SUPPORT_EVENT_KEY, JSON.stringify(e));
}
