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

/** One plain mailbox: exactly one `@`, no whitespace or controls. */
function plainAddress(address: MailAddress): MailAddress | null {
  const value = address.address;
  if (value.length > MAX_LINE || /[\s\u0000-\u001f\u007f-\u009f]/.test(value))
    return null;
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1 || value.indexOf("@", at + 1) >= 0)
    return null;
  const name = address.name ? cleanLine(address.name) : "";
  return { name: name || null, address: value };
}

function addresses(
  header: AddressObject | AddressObject[] | undefined,
): MailAddress[] {
  if (!header) return [];
  const objects = Array.isArray(header) ? header : [header];
  const out: MailAddress[] = [];
  for (const entry of flatten(objects.flatMap((o) => o.value))) {
    const normalized = normalizeAddress(entry);
    const address = normalized && plainAddress(normalized);
    if (address) out.push(address);
  }
  return out;
}

function headerValue(line: string): string {
  const unfolded = line.replace(/\r?\n[ \t]+/g, " ");
  const colon = unfolded.indexOf(":");
  return (colon < 0 ? "" : unfolded.slice(colon + 1)).trim();
}

/** RFC 5322 line limit: no longer id or header text is legitimate. */
const MAX_LINE = 998;
/** References keeps the thread root and the newest ancestors. */
const REFERENCES_TAIL = 20;

/** `<a@b> <c@d>` (or bare ids separated by whitespace or commas), unique,
 *  in order. Linear: the header is untrusted and can be a megabyte. */
function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const bracketed = value.match(/<[^<>]*>/g);
  const raw = bracketed ?? value.split(/[\s,]+/);
  const ids = new Set<string>();
  for (const candidate of raw) {
    if (candidate.length > MAX_LINE + 2) continue;
    const id = normalizeMessageId(candidate);
    if (id && id.length <= MAX_LINE) ids.add(id);
  }
  return [...ids];
}

function references(value: string | undefined): string[] {
  const ids = messageIds(value);
  if (ids.length <= REFERENCES_TAIL + 1) return ids;
  return [ids[0]!, ...ids.slice(-REFERENCES_TAIL)];
}

/** C0 and C1 controls, CR and LF included. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** One line of untrusted text for display: controls become spaces,
 *  whitespace collapses, at most `max` characters. */
export function cleanLine(text: string, max = MAX_LINE): string {
  return cutText(text.replace(CONTROLS, " ").replace(/\s+/g, " ").trim(), max);
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return cutText(text, MAX_TEXT_CHARS - CUT_MARK.length) + CUT_MARK;
}

/** HTML longer than this is not given to html-to-text. */
const MAX_HTML_TO_PARSE = 2_000_000;
const UNREADABLE_TEXT = "(This message couldn't be read)";

/** The cheap fallback when html-to-text refused: one linear pass over the
 *  first MAX_HTML_TO_PARSE characters that drops tags, script and style. */
function stripTags(html: string): string {
  const input = cutText(html, MAX_HTML_TO_PARSE);
  const lower = input.toLowerCase();
  const out: string[] = [];
  let at = 0;
  while (at < input.length) {
    const open = input.indexOf("<", at);
    if (open < 0) {
      out.push(input.slice(at));
      break;
    }
    out.push(input.slice(at, open));
    const close = input.indexOf(">", open);
    if (close < 0) break;
    const tag = lower.slice(open + 1, Math.min(close, open + 8));
    const skip = /^(script|style)\b/.exec(tag)?.[1];
    if (skip) {
      const end = lower.indexOf(`</${skip}`, close);
      const after = end < 0 ? -1 : lower.indexOf(">", end);
      if (after < 0) break;
      at = after + 1;
      out.push(" ");
      continue;
    }
    out.push(/^(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b/.test(tag) ? "\n" : " ");
    at = close + 1;
  }
  return out
    .join("")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "‹")
    .replace(/&gt;/gi, "›")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n[ \t\n]*/g, "\n");
}

export async function parseInbound(
  source: Uint8Array,
  ctx: {
    inboxId: string;
    providerId: string;
    receivedAt: string;
    oversize?: boolean;
    /** The full source didn't parse: `source` is its header block. */
    unreadable?: boolean;
  },
): Promise<InboundMessage> {
  const headersOnly = Boolean(ctx.oversize || ctx.unreadable);
  const parsed = await simpleParser(Buffer.from(source), {
    skipTextToHtml: true,
    skipImageLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: MAX_HTML_TO_PARSE,
  });
  const body =
    parsed.textConversionError && typeof parsed.html === "string"
      ? stripTags(parsed.html)
      : (parsed.text ?? "");

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
    subject: cleanLine(parsed.subject ?? ""),
    text: ctx.unreadable
      ? UNREADABLE_TEXT
      : ctx.oversize
        ? ""
        : capText(body.trim()),
    keys: {
      messageId: messageIds(first("message-id"))[0] ?? null,
      inReplyTo: messageIds(first("in-reply-to"))[0] ?? null,
      references: references(raw.get("references")?.join(" ")),
    },
    loopHeaders,
    attachments: headersOnly
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
  if (ctx.unreadable) message.unreadable = true;
  else if (ctx.oversize) message.oversize = true;
  return message;
}
