// Raw RFC 5322 source → InboundMessage. mailparser does the MIME work
// (charsets, transfer encodings, HTML-only bodies rendered as text); this
// file only maps its result onto the support wire type: normalized
// addresses, threading keys without `<>`, the loop-detection headers and
// a text cap. An oversize message arrives as its header block only.
// The content is untrusted and never logged.

import {
  type AddressObject,
  type EmailAddress,
  simpleParser,
} from "mailparser";
import {
  type InboundMessage,
  MAX_TEXT_CHARS,
  type MailAddress,
  normalizeAddress,
  normalizeMessageId,
} from "../../shared/support";

/** The headers isAutomatedMail and ingest read. */
const LOOP_HEADERS = new Set([
  "auto-submitted",
  "precedence",
  "list-id",
  "list-unsubscribe",
  "x-autoreply",
  "x-auto-response-suppress",
  "return-path",
  "authentication-results",
]);

const CUT_MARK = "\n[…cut]";

function flatten(entries: EmailAddress[]): EmailAddress[] {
  return entries.flatMap((entry) =>
    entry.group ? flatten(entry.group) : [entry],
  );
}

function addresses(
  header: AddressObject | AddressObject[] | undefined,
): MailAddress[] {
  if (!header) return [];
  const objects = Array.isArray(header) ? header : [header];
  const out: MailAddress[] = [];
  for (const entry of flatten(objects.flatMap((o) => o.value))) {
    const address = normalizeAddress(entry);
    if (address) out.push(address);
  }
  return out;
}

function headerValue(line: string): string {
  const unfolded = line.replace(/\r?\n[ \t]+/g, " ");
  const colon = unfolded.indexOf(":");
  return (colon < 0 ? "" : unfolded.slice(colon + 1)).trim();
}

/** `<a@b> <c@d>` (or bare ids separated by whitespace or commas). */
function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = value.match(/<[^<>]*>/g);
  const raw = bracketed ?? value.split(/[\s,]+/);
  const ids: string[] = [];
  for (const candidate of raw) {
    const id = normalizeMessageId(candidate);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS - CUT_MARK.length) + CUT_MARK;
}

export async function parseInbound(
  source: Uint8Array,
  ctx: {
    inboxId: string;
    providerId: string;
    receivedAt: string;
    oversize?: boolean;
  },
): Promise<InboundMessage> {
  const parsed = await simpleParser(Buffer.from(source), {
    skipTextToHtml: true,
    skipImageLinks: true,
    keepCidLinks: true,
  });

  const raw = new Map<string, string[]>();
  for (const { key, line } of parsed.headerLines) {
    const values = raw.get(key) ?? [];
    values.push(headerValue(line));
    raw.set(key, values);
  }
  const first = (name: string) => raw.get(name)?.[0];

  const loopHeaders: Record<string, string> = {};
  for (const name of LOOP_HEADERS) {
    const values = raw.get(name);
    if (values?.length) loopHeaders[name] = values.join("\n");
  }

  const from = addresses(parsed.from)[0] ??
    messageIds(first("return-path"))
      .map((address) => ({ name: null, address: address.toLowerCase() }))
      .at(0) ?? { name: null, address: "" };

  const message: InboundMessage = {
    inboxId: ctx.inboxId,
    channel: "email",
    providerId: ctx.providerId,
    receivedAt: ctx.receivedAt,
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    subject: (parsed.subject ?? "").trim(),
    text: ctx.oversize ? "" : capText((parsed.text ?? "").trim()),
    keys: {
      messageId: messageIds(first("message-id"))[0] ?? null,
      inReplyTo: messageIds(first("in-reply-to"))[0] ?? null,
      references: messageIds(raw.get("references")?.join(" ")),
    },
    loopHeaders,
    attachments: ctx.oversize
      ? []
      : parsed.attachments.map((attachment, index) => ({
          id: `att_${index + 1}`,
          fileName: attachment.filename ?? `attachment-${index + 1}`,
          mimeType: attachment.contentType,
          sizeBytes: attachment.size,
          stored: false,
          expiresAt: null,
          content: new Uint8Array(
            attachment.content.buffer,
            attachment.content.byteOffset,
            attachment.content.byteLength,
          ),
        })),
  };
  if (ctx.oversize) message.oversize = true;
  return message;
}
