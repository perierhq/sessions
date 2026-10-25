// Test fixture: a support channel adapter that sends through the mail
// fixture's SMTP server with the real reply builder and SMTP transport
// (buildReply → SmtpTransport.send), for the reply path's tests while the
// email channel adapter is not wired in. `mark` only records.
// Not on any live import chain (excluded from the side-effect scan).
import { buildReply } from "../../../agents/email/mime";
import { SmtpTransport } from "../../../agents/email/smtp-transport";
import type { InboxConfig, SupportConversation } from "../../../shared/support";
import type { SupportChannelAdapter } from "../channel";
import { MAIL_PASSWORD } from "./mail-fixture";

export interface FixtureAdapter extends SupportChannelAdapter {
  marks: Array<{ conversationId: string; state: "handled" | "spam" }>;
  /** Sends started so far. */
  sends: number;
  close(): void;
}

export function fixtureEmailAdapter(inbox: InboxConfig): FixtureAdapter {
  const transport = new SmtpTransport({ inbox, password: MAIL_PASSWORD });
  const adapter: FixtureAdapter = {
    channel: "email",
    inboxId: inbox.id,
    marks: [],
    sends: 0,
    connect: async () => {},
    disconnect: async () => {},
    health: () => ({
      state: "live",
      since: new Date().toISOString(),
      reason: null,
      retryAt: null,
      lastMessageAt: null,
    }),
    async send(out) {
      adapter.sends++;
      const sent = await transport.send(buildReply(out));
      return {
        messageId: sent.messageId,
        providerId: null,
        sentAt: new Date().toISOString(),
      };
    },
    async mark(c: SupportConversation, state) {
      adapter.marks.push({ conversationId: c.id, state });
    },
    close: () => transport.close(),
  };
  return adapter;
}
