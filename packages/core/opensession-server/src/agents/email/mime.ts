// Outbound email: the reply built from a draft (one recipient, RFC 5322
// threading headers, RFC 3834 Auto-Submitted for sends Sessions decided) and
// its raw bytes. replyTarget is the one place that picks who a reply goes
// to and which message it answers; the send decision checks the same.
// The raw message is composed once, so the bytes appended to Sent are the
// bytes that went out. Pure apart from MailComposer; nothing runs at import.

import { randomUUIDv7 } from "bun";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  type MailAddress,
  type SupportConversation,
  type SupportMessage,
  normalizeAddress,
  normalizeMessageId,
  ownMailAddresses,
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

/** The most ids in an outgoing References header: the thread root and the
 *  newest; the ones in between are dropped. */
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

/** Local parts that never take a reply: bounce senders and no-reply
 *  addresses. */
const NO_REPLY = /^(mailer-daemon|no-?reply|do-?not-?reply)([+._-].*)?$/i;

function replyable(address: string): boolean {
  const at = address.lastIndexOf("@");
  return at > 0 && !NO_REPLY.test(address.slice(0, at));
}

/** The message a reply answers: the newest inbound one a person wrote;
 *  null when there is none (machine mail only). */
function answered(messages: SupportMessage[]): SupportMessage | null {
  return messages.findLast((m) => m.direction === "in" && !m.automated) ?? null;
}

/** The first address of `list` a reply may go to: not one of `own`, not
 *  a bounce or no-reply address. */
function firstUsable(
  list: MailAddress[],
  own: ReadonlySet<string>,
): MailAddress | null {
  for (const raw of list) {
    const address = normalizeAddress(raw);
    if (address && !own.has(address.address) && replyable(address.address))
      return address;
  }
  return null;
}

/** Who a reply goes to and which message it answers. `message` is the
 *  newest inbound message a person wrote, or null when the conversation
 *  holds machine mail only. `to` is ONE address: the first usable
 *  Reply-To of `message`, else its From, else the conversation's
 *  customer; never one of `own` (see ownMailAddresses) nor a bounce or
 *  no-reply address; empty when nothing is usable. A send whose
 *  `to[0].address` isn't `message.from.address` goes somewhere the sender
 *  didn't write from: the caller decides whether a person must look. */
export function replyTarget(
  conversation: SupportConversation,
  own: Iterable<string> = [],
): { message: SupportMessage | null; to: MailAddress[] } {
  const ownSet = new Set([...own].map((a) => a.trim().toLowerCase()));
  const message = answered(conversation.messages);
  const lists = message
    ? [message.replyTo ?? [], [message.from], [conversation.customer]]
    : [[conversation.customer]];
  for (const list of lists) {
    const to = firstUsable(list, ownSet);
    if (to) return { message, to: [to] };
  }
  return { message, to: [] };
}

/** `chain` without repeats (a repeat keeps its last place), at most
 *  MAX_OUTGOING_REFERENCES: the thread root and the newest ids. Repeats
 *  are found by the normalized id; the form kept is the last one. */
function referencesOf(chain: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i]!;
    const key = normalizeMessageId(id) ?? id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(id);
  }
  unique.reverse();
  if (unique.length <= MAX_OUTGOING_REFERENCES) return unique;
  return [unique[0]!, ...unique.slice(-(MAX_OUTGOING_REFERENCES - 1))];
}

/** To: replyTarget's one address. Subject: one "Re: " (case-insensitive,
 *  no "Re: Re:"). In-Reply-To: the answered message's Message-ID as it was
 *  written; none when only machine mail came in. References: its
 *  references + its Message-ID, without repeats, at most 20 (the root and
 *  the newest). Auto-Submitted: "auto-replied" and
 *  X-Auto-Response-Suppress: All when draft.decidedBy is
 *  { kind: "sessions" }, absent otherwise. `otherInboxAddresses`: the
 *  addresses of the other inboxes, never addressed. */
export function buildReply(
  out: OutboundDraft,
  otherInboxAddresses: readonly string[] = [],
): OutgoingMail {
  const { conversation, draft, inbox } = out;
  const { message: last, to } = replyTarget(
    conversation,
    ownMailAddresses(inbox, otherInboxAddresses),
  );
  const inReplyTo = last?.keys.rawMessageId ?? last?.keys.messageId ?? null;
  const chain = [...(last?.keys.references ?? [])];
  if (inReplyTo) chain.push(inReplyTo);
  const headers: Record<string, string> = {};
  if (draft.decidedBy?.kind === "sessions") {
    headers["Auto-Submitted"] = "auto-replied";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  return {
    from: { name: oneLine(inbox.label), address: inbox.address },
    to,
    subject: replySubject(last?.subject || conversation.subject),
    text: draft.text,
    messageId: draft.messageId,
    inReplyTo,
    references: referencesOf(chain),
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

/** An id or an address: no whitespace, controls or angle brackets. */
const bare = (value: string) =>
  value.replace(/[\s\u0000-\u001f\u007f-\u009f<>]+/g, "");
const bracketed = (id: string) => `<${bare(id)}>`;
/** A header name: RFC 5322 ftext, no colon. */
const headerName = (name: string) => name.replace(/[^!-9;-~]+/g, "");

/** The raw RFC 5322 message, plain text. Every header value is one line:
 *  names and the subject lose line breaks and controls; ids and addresses
 *  also lose whitespace and angle brackets. */
export async function composeRaw(mail: OutgoingMail): Promise<Uint8Array> {
  const references = mail.references.map(bare).filter(Boolean);
  const inReplyTo = mail.inReplyTo ? bare(mail.inReplyTo) : "";
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(mail.headers)) {
    const key = headerName(name);
    if (key) headers[key] = oneLine(value);
  }
  const composer = new MailComposer({
    from: { name: oneLine(mail.from.name), address: bare(mail.from.address) },
    to: mail.to.map((a) => ({
      name: oneLine(a.name ?? ""),
      address: bare(a.address),
    })),
    subject: oneLine(mail.subject),
    text: mail.text,
    messageId: bracketed(mail.messageId),
    ...(inReplyTo ? { inReplyTo: `<${inReplyTo}>` } : {}),
    ...(references.length
      ? { references: references.map((id) => `<${id}>`) }
      : {}),
    headers,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return new Uint8Array(await composer.compile().build());
}
