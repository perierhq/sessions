// An email's text → what the sender wrote this time, the earlier mail it
// quotes, and the signature (shared/support.ts MessageSplit). The text is
// never changed; the split only marks line ranges. Heuristics, line by line,
// in one pass over at most MAX_TEXT_CHARS: every regex runs on a line (or up
// to three joined lines) cut to MAX_TEST, so untrusted mail can't make it slow.
//
// What counts as quoted:
//  - an attribution line ("On … wrote:", "Am … schrieb …:", "W dniu …
//    napisał:", and the same in a few more languages, or any line ending in
//    `<address> wrote-verb:`), wrapped over up to three lines, with the `>`
//    lines after it, or everything after it when no `>` lines follow;
//  - an Outlook header block (From / Sent or Date / To or Subject, in
//    common languages), an "-----Original Message-----" line, or a long
//    underscore rule over such a block: everything after it;
//  - a block of `>` lines at the very start (bottom-posting) or the very end
//    (top-posting); `>` lines in the middle stay, since inline quoting and
//    pasted output are part of what the sender is saying;
//  - when the text shows none of that, the HTML part's quote container
//    (Gmail's gmail_quote, Apple's blockquote type=cite, Outlook's
//    divRplyFwdMsg …), mapped back onto the text (`htmlNewText`).
// The signature is the "-- " delimiter to the end of the last new stretch,
// or a trailing "Sent from my iPhone" style line. A forward (Fwd:/FW:/WG:
// subject or a "Forwarded message" line) keeps its header blocks visible.
// When nothing new would be left, the whole text is new.

import type { MessagePartKind, MessageSplit } from "../../shared/support";

/** Bump when the rules change; older stored splits are recomputed on read. */
export const SPLIT_VERSION = 1;

/** The longest stretch any regex here sees. */
const MAX_TEST = 600;
/** An attribution wraps over at most this many lines. */
const MAX_ATTRIBUTION_LINES = 3;
/** An Outlook header block's lines after From. */
const MAX_HEADER_BLOCK_LINES = 8;

const WROTE_VERBS =
  "wrote|schrieb|napisał\\(a\\)|napisała|napisał|pisze|a écrit|escribió|ha scritto|escreveu|schreef|skrev|kirjoitti|napsal\\(a\\)|napsal|írta";

/** Attribution lines, after whitespace is collapsed. Each needs a digit
 *  somewhere (a date) before it counts, see isAttribution. */
const ATTRIBUTIONS: RegExp[] = [
  /^On\s.{4,300}\swrote\s?:$/i,
  /^Am\s.{4,300}\sschrieb(?:\s.{0,300})?:$/i,
  /^(?:W dniu|Dnia)\s.{4,300}\s(?:napisał\(a\)|napisała|napisał|pisze)\s?:$/iu,
  /^Le\s.{4,300}\sa écrit\s?:$/i,
  /^El\s.{4,300}\sescribió\s?:$/i,
  /^Il\s.{4,300}\sha scritto\s?:$/i,
  /^Em\s.{4,300}\sescreveu\s?:$/i,
  /^Op\s.{4,300}\sschreef(?:\s.{0,300})?:$/i,
  /^Den\s.{4,300}\sskrev(?:\s.{0,300})?:$/i,
  // Gmail in most languages: "<date> Name <a@b> napisał(a):".
  new RegExp(
    `^.{4,400}<\\s?[^<>\\s@]+@[^<>\\s]+>\\s?(?:${WROTE_VERBS})\\s?:$`,
    "iu",
  ),
];

const FROM_LINE =
  /^[*_]*(?:From|Von|Od|De|Da|Van|Från|Fra|Lähettäjä|Feladó)[*_]*\s?:[*_]*\s*\S/iu;
const SENT_LINE =
  /^[*_]*(?:Sent|Date|Gesendet|Datum|Wysłano|Wysłane|Data|Envoyé|Date d'envoi|Enviado|Fecha|Inviato|Verzonden|Skickat|Sendt|Lähetetty|Elküldve)[*_]*\s?:/iu;
const TO_LINE =
  /^[*_]*(?:To|An|Do|À|A|Para|Aan|Till|Til|Vastaanottaja|Címzett|Subject|Betreff|Temat|Objet|Asunto|Oggetto|Assunto|Onderwerp|Ämne|Emne|Aihe|Tárgy)[*_]*\s?:/iu;
const ORIGINAL_MESSAGE =
  /^-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Wiadomość oryginalna|Oryginalna wiadomość|Message d'origine|Mensaje original|Messaggio originale|Mensagem original|Oorspronkelijk bericht|Originalmeddelande|Oprindelig meddelelse|Opprinnelig melding|Alkuperäinen viesti)\s*-{2,}$/iu;
const UNDERSCORE_RULE = /^_{10,}$/;
const FORWARDED_LINE =
  /^-{2,}\s*(?:Forwarded message|Weitergeleitete Nachricht|Przekazana wiadomość|Message transféré|Mensaje reenviado|Messaggio inoltrato|Mensagem encaminhada|Doorgestuurd bericht)\s*-{2,}$/iu;
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|pd|rv|i|enc|vs)\s*:/i;

const SIGNATURE_DELIMITER = /^--\s?$/;
const MOBILE_SIGNATURES: RegExp[] = [
  /^Sent from my \S.{0,40}$/i,
  /^Sent from (?:Outlook|Mail|Yahoo Mail|Gmail|Proton Mail)\b.{0,40}$/i,
  /^Sent with Proton Mail\b.{0,40}$/i,
  /^Get Outlook for \S.{0,30}$/i,
  /^Von meinem \S.{0,40} gesendet\.?$/i,
  /^Gesendet von meinem \S.{0,40}$/i,
  /^Wysłane z (?:mojego )?\S.{0,40}$/iu,
  /^Wysłano z (?:mojego )?\S.{0,40}$/iu,
  /^Envoyé de mon \S.{0,40}$/iu,
  /^Enviado desde mi \S.{0,40}$/iu,
  /^Inviato da(?:l mio)? \S.{0,40}$/i,
  /^Verzonden (?:vanaf|met) \S.{0,40}$/i,
];

interface Line {
  start: number;
  /** Trimmed, without CR, cut to MAX_TEST. */
  text: string;
  blank: boolean;
  quote: boolean;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const head = text.slice(start, Math.min(end, start + MAX_TEST * 2));
    const trimmed = head.trim().slice(0, MAX_TEST);
    lines.push({
      start,
      text: trimmed,
      blank: trimmed === "",
      quote: trimmed.startsWith(">"),
    });
    if (nl < 0) break;
    start = nl + 1;
  }
  return lines;
}

function isAttribution(joined: string): boolean {
  const text = joined.replace(/\s+/g, " ").slice(0, MAX_TEST);
  return /\d/.test(text) && ATTRIBUTIONS.some((re) => re.test(text));
}

/** The line an attribution starts on, for each line one ends on. Tried
 *  from the shortest wrap up, so a sentence before the header isn't
 *  taken into it. */
function attributions(lines: Line[]): Map<number, number> {
  const startsAt = new Map<number, number>();
  for (let end = 0; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.blank || line.quote || !line.text.endsWith(":")) continue;
    let joined = "";
    for (let k = 0; k < MAX_ATTRIBUTION_LINES; k++) {
      const start = end - k;
      if (start < 0) break;
      const first = lines[start]!;
      if (first.blank || first.quote) break;
      joined = joined ? `${first.text} ${joined}` : first.text;
      if (isAttribution(joined)) {
        startsAt.set(start, end);
        break;
      }
    }
  }
  return startsAt;
}

function isHeaderBlock(lines: Line[], at: number): boolean {
  if (!FROM_LINE.test(lines[at]!.text)) return false;
  let sent = false;
  let to = false;
  const last = Math.min(lines.length - 1, at + MAX_HEADER_BLOCK_LINES);
  for (let i = at + 1; i <= last; i++) {
    const text = lines[i]!.text;
    if (SENT_LINE.test(text)) sent = true;
    else if (TO_LINE.test(text)) to = true;
    if (sent && to) return true;
  }
  return false;
}

function nextFilled(lines: Line[], from: number, limit = Infinity): number {
  for (let i = from; i < lines.length && i - from < limit; i++)
    if (!lines[i]!.blank) return i;
  return -1;
}

function previousFilled(lines: Line[], from: number): number {
  for (let i = from; i >= 0; i--) if (!lines[i]!.blank) return i;
  return -1;
}

/** Letters and digits only, lowercased: what an HTML rendering and the
 *  plain part of the same mail agree on. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The line after the one where `prefix` (the HTML part's text before its
 *  quote) ends in `text`, or -1 when the text doesn't start with it. */
function lineAfterPrefix(text: string, lines: Line[], prefix: string): number {
  const want = [...prefix.toLowerCase()].filter((c) => WORD_CHAR.test(c));
  if (want.length === 0) return -1;
  let matched = 0;
  let endAt = -1;
  let i = 0;
  for (const ch of text) {
    if (WORD_CHAR.test(ch)) {
      if (ch.toLowerCase() !== want[matched]) return -1;
      matched++;
      if (matched === want.length) {
        endAt = i;
        break;
      }
    }
    i += ch.length;
  }
  if (endAt < 0) return -1;
  for (let l = 0; l < lines.length; l++) if (lines[l]!.start > endAt) return l;
  return -1;
}

export interface SplitOptions {
  /** The message's subject: a forward keeps its header blocks visible. */
  subject?: string;
  /** The HTML part's text before its quote container, when it has one. */
  htmlNewText?: string | null;
}

/** `text` split into new, quoted and signature ranges. */
export function splitEmailText(
  text: string,
  options: SplitOptions = {},
): MessageSplit {
  const whole: MessageSplit = {
    v: SPLIT_VERSION,
    parts: text ? [{ kind: "new", start: 0, end: text.length }] : [],
  };
  if (!text.trim()) return whole;
  const lines = linesOf(text);
  const kinds: MessagePartKind[] = lines.map(() => "new");
  const forwarded = FORWARD_SUBJECT.test(options.subject ?? "");
  const headers = attributions(lines);
  const quoteFrom = (from: number, to = lines.length - 1) => {
    for (let i = from; i <= to; i++) kinds[i] = "quoted";
  };

  let quoted = false;
  let sawForward = forwarded;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.blank || line.quote) continue;
    if (FORWARDED_LINE.test(line.text)) {
      sawForward = true;
      continue;
    }
    if (!sawForward) {
      if (ORIGINAL_MESSAGE.test(line.text) || isHeaderBlock(lines, i)) {
        quoteFrom(i);
        quoted = true;
        break;
      }
      if (UNDERSCORE_RULE.test(line.text)) {
        const next = nextFilled(lines, i + 1, 3);
        if (next >= 0 && isHeaderBlock(lines, next)) {
          quoteFrom(i);
          quoted = true;
          break;
        }
      }
    }
    const end = headers.get(i);
    if (end === undefined) continue;
    const next = nextFilled(lines, end + 1);
    if (next < 0 || !lines[next]!.quote) {
      quoteFrom(i);
      quoted = true;
      break;
    }
    let last = next;
    for (let j = next; j < lines.length; j++) {
      if (lines[j]!.quote) last = j;
      else if (!lines[j]!.blank) break;
    }
    quoteFrom(i, last);
    quoted = true;
    i = last;
  }

  // `>` blocks at the very start or the very end.
  const firstNew = lines.findIndex(
    (l, i) => kinds[i] === "new" && !l.blank && !l.quote,
  );
  if (firstNew > 0 && lines.slice(0, firstNew).some((l) => l.quote)) {
    quoteFrom(0, firstNew - 1);
    quoted = true;
  }
  let tail = lines.length - 1;
  while (tail >= 0 && (lines[tail]!.blank || kinds[tail] === "quoted")) tail--;
  let tailQuote = tail;
  while (tailQuote >= 0 && (lines[tailQuote]!.quote || lines[tailQuote]!.blank))
    tailQuote--;
  if (tailQuote < tail) {
    const from = nextFilled(lines, tailQuote + 1);
    if (from >= 0 && previousFilled(lines, from - 1) >= 0) {
      quoteFrom(from, tail);
      quoted = true;
    }
  }

  if (!quoted && options.htmlNewText) {
    const after = lineAfterPrefix(text, lines, options.htmlNewText);
    const next = after < 0 ? -1 : nextFilled(lines, after);
    if (next >= 0) quoteFrom(next);
  }

  markSignature(lines, kinds);

  if (!lines.some((l, i) => kinds[i] === "new" && !l.blank)) return whole;
  return { v: SPLIT_VERSION, parts: toParts(text, lines, kinds) };
}

/** The signature at the end of the last stretch of new lines, when
 *  something new comes before it. */
function markSignature(lines: Line[], kinds: MessagePartKind[]): void {
  let end = lines.length - 1;
  while (end >= 0 && (kinds[end] !== "new" || lines[end]!.blank)) end--;
  if (end < 0) return;
  let start = end;
  while (start > 0 && kinds[start - 1] === "new") start--;
  const first = lines.findIndex((l, i) => kinds[i] === "new" && !l.blank);
  for (let i = Math.max(start, first + 1); i <= end; i++) {
    if (SIGNATURE_DELIMITER.test(lines[i]!.text)) {
      for (let j = i; j <= end; j++) kinds[j] = "signature";
      return;
    }
  }
  const last = lines[end]!.text;
  if (end > first && MOBILE_SIGNATURES.some((re) => re.test(last)))
    kinds[end] = "signature";
}

function toParts(
  text: string,
  lines: Line[],
  kinds: MessagePartKind[],
): MessageSplit["parts"] {
  const parts: MessageSplit["parts"] = [];
  for (let i = 0; i < lines.length; i++) {
    // A blank line stays with the part before it, so no part is only
    // whitespace between two others.
    const kind =
      lines[i]!.blank && parts.length ? parts.at(-1)!.kind : kinds[i]!;
    const start = lines[i]!.start;
    const end = i + 1 < lines.length ? lines[i + 1]!.start : text.length;
    if (end <= start) continue;
    const last = parts.at(-1);
    if (last && last.kind === kind) last.end = end;
    else parts.push({ kind, start, end });
  }
  return parts;
}
