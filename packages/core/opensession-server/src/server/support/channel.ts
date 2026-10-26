// The support channel layer: what every transport (email today, Plain and
// webhooks later) implements, and the registry of live adapters by inbox.
// Inbound and outbound are separate so a webhook transport can replace
// `connect` only. The only caller of an adapter's `send` is `sendDraft` in
// reply.ts. Nothing runs at import.

import type {
  InboundMessage,
  InboxConfig,
  InboxHealth,
  SupportChannelKind,
  SupportConversation,
  SupportDraft,
} from "../../shared/support";

/** Resolves only after the message is durable. */
export type InboundSink = (
  message: InboundMessage,
) => Promise<"stored" | "duplicate" | "ignored">;

export interface OutboundDraft {
  conversation: SupportConversation;
  draft: SupportDraft;
  inbox: InboxConfig;
}

export interface SentReceipt {
  messageId: string;
  providerId: string | null;
  sentAt: string;
}

/** A send that may have reached the server (the connection broke or timed
 *  out once the message was on its way): permanent, never sent again
 *  automatically. Also the copy for a send a restart cut off. */
export const INTERRUPTED_SEND =
  "Interrupted while sending. Check the mailbox's Sent folder before sending again";

/** A failed send. `permanent` failures are never retried. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SendError";
  }
}

/** One adapter per inbox (email) or per account (Plain, later). */
export interface SupportChannelAdapter {
  readonly channel: SupportChannelKind;
  readonly inboxId: string;
  connect(sink: InboundSink): Promise<void>;
  disconnect(): Promise<void>;
  /** Tries again now after a pause no retry is planned for (a refused
   *  login): someone saved the inbox or a test with its stored passwords
   *  passed. Does nothing while connected or backing off. */
  resume?(): Promise<void>;
  health(): InboxHealth;
  /** Takes in the unread mail of the last `days` days that was already
   *  there when the inbox first connected, through the inbound sink;
   *  resolves to how many messages were offered. Rejects when not
   *  connected. */
  bringIn?(days: number): Promise<number>;
  /** Throws SendError. */
  send(out: OutboundDraft): Promise<SentReceipt>;
  mark?(
    conversation: SupportConversation,
    state: "handled" | "spam",
  ): Promise<void>;
}

// On globalThis, like the one-shot pool, so a hot reload of this module
// does not orphan live adapters and their connections.
const adapters: Map<string, SupportChannelAdapter> = ((
  globalThis as any
).__sessionsSupportChannelAdapters ??= new Map());

/** Replaces an adapter registered for the same inbox. */
export function registerChannelAdapter(adapter: SupportChannelAdapter): void {
  adapters.set(adapter.inboxId, adapter);
}

export function unregisterChannelAdapter(
  inboxId: string,
): SupportChannelAdapter | undefined {
  const adapter = adapters.get(inboxId);
  adapters.delete(inboxId);
  return adapter;
}

export function channelAdapterFor(
  inboxId: string,
): SupportChannelAdapter | undefined {
  return adapters.get(inboxId);
}

export function listChannelAdapters(): SupportChannelAdapter[] {
  return [...adapters.values()];
}

export function __resetChannelAdaptersForTest(): void {
  adapters.clear();
}
