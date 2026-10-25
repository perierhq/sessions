// Outbound email: the reply built from a draft (RFC 5322 threading headers,
// RFC 3834 Auto-Submitted for sends Sessions decided) and its raw bytes.
// The raw message is composed once, so the bytes appended to Sent are the
// bytes that went out. Pure apart from MailComposer; nothing runs at import.

import { randomUUIDv7 } from "bun";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  type MailAddress,
  type SupportMessage,
  normalizeAddress,
} from "../../shared/support";
import type { OutboundDraft } from "../../server/support/channel";

/** Ids are given without `<>`. */
export interface OutgoingMail {
  from: { name: string; address: string };
  to: MailAddress[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
}

/** The most ids in an outgoing References header; the oldest are dropped. */
export const MAX_OUTGOING_REFERENCES = 20;

/** Control characters and line breaks never reach a header. */
const oneLine = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function replySubject(subject: string): string {
  const clean = oneLine(subject);
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`.trim();
}

/** The message a reply answers: the newest inbound one a person wrote,
 *  else the newest inbound one at all. */
function answered(messages: SupportMessage[]): SupportMessage | null {
  const inbound = messages.filter((m) => m.direction === "in");
  return inbound.findLast((m) => !m.automated) ?? inbound.at(-1) ?? null;
}

function recipients(
  message: SupportMessage | null,
  out: OutboundDraft,
): MailAddress[] {
  const own = out.inbox.address.trim().toLowerCase();
  const usable = (list: MailAddress[]) => {
    const seen = new Set<string>();
    const result: MailAddress[] = [];
    for (const raw of list) {
      const address = normalizeAddress(raw);
      if (!address || address.address === own || seen.has(address.address))
        continue;
      seen.add(address.address);
      result.push(address);
    }
    return result;
  };
  for (const list of [
    message?.replyTo ?? [],
    message ? [message.from] : [],
    [out.conversation.customer],
  ]) {
    const to = usable(list);
    if (to.length) return to;
  }
  return [];
}

/** To: the last inbound message's Reply-To, else From (never the inbox
 *  itself). Subject: one "Re: " (case-insensitive, no "Re: Re:").
 *  References: the last inbound's references + its Message-ID, at most 20,
 *  oldest dropped. Auto-Submitted: "auto-replied" when
 *  draft.decidedBy is { kind: "sessions" }, absent otherwise. */
export function buildReply(out: OutboundDraft): OutgoingMail {
  const { conversation, draft, inbox } = out;
  const last = answered(conversation.messages);
  const inReplyTo = last?.keys.messageId ?? null;
  const chain = [...(last?.keys.references ?? [])];
  if (inReplyTo) chain.push(inReplyTo);
  const references = [...new Set(chain)].slice(-MAX_OUTGOING_REFERENCES);
  const headers: Record<string, string> = {};
  if (draft.decidedBy?.kind === "sessions")
    headers["Auto-Submitted"] = "auto-replied";
  return {
    from: { name: oneLine(inbox.label), address: inbox.address },
    to: recipients(last, out),
    subject: replySubject(last?.subject || conversation.subject),
    text: draft.text,
    messageId: draft.messageId,
    inReplyTo,
    references,
    headers,
  };
}

/** `<uuidv7>@<domain of the inbox address>`, without brackets. */
export function newMessageId(inboxAddress: string): string {
  const at = inboxAddress.lastIndexOf("@");
  const domain =
    at >= 0
      ? inboxAddress
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : "";
  return `${randomUUIDv7()}@${domain || "sessions.invalid"}`;
}

const bracketed = (id: string) => `<${id}>`;

/** The raw RFC 5322 message, plain text. */
export async function composeRaw(mail: OutgoingMail): Promise<Uint8Array> {
  const composer = new MailComposer({
    from: { name: mail.from.name, address: mail.from.address },
    to: mail.to.map((a) => ({ name: a.name ?? "", address: a.address })),
    subject: mail.subject,
    text: mail.text,
    messageId: bracketed(mail.messageId),
    ...(mail.inReplyTo ? { inReplyTo: bracketed(mail.inReplyTo) } : {}),
    ...(mail.references.length
      ? { references: mail.references.map(bracketed) }
      : {}),
    headers: mail.headers,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return new Uint8Array(await composer.compile().build());
}
