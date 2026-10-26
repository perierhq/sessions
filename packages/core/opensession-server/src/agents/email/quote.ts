// An email's text → what the sender wrote this time, the earlier mail it
// quotes, and the signature (shared/support.ts MessageSplit). The text is
// never changed; the split only marks line ranges. Heuristics, line by line,
// in one pass over at most MAX_TEXT_CHARS: every regex runs on a line (or up
// to three joined lines) cut to MAX_TEST, so untrusted mail can't make it slow.
//
// What can be quoted (a candidate):
//  - an attribution line ("On … wrote:", "Am … schrieb …:", "W dniu …
//    napisał:", and the same in a few more languages, or any line ending in
//    `<address> wrote-verb:`) with a time or a four-digit year, wrapped over
//    up to three lines, with the `>` lines after it, or everything after it
//    when no `>` lines follow;
//  - an Outlook header block (From, then Subject or a Sent/Date line with a
//    weekday or time, in common languages), an "-----Original Message-----"
//    line, or a long underscore rule over such a block: everything after it;
//  - a block of `>` lines at the very start (bottom-posting), or at the very
//    end when it matches the thread; `>` lines in the middle stay, since
//    inline quoting and pasted output are part of what the sender is saying;
//  - when the text shows none of that, the HTML part's quote container
//    (Gmail's gmail_quote, Apple's blockquote type=cite, Outlook's
//    divRplyFwdMsg …), mapped back onto the text and kept in the split as
//    `html` (a line offset), so a later re-split reuses it.
//
// The thread match: with the conversation's earlier messages (`thread`), a
// candidate only counts as quoted where it matches them. Its lines are read
// in order, and the quote ends at the first line whose words mostly don't
// follow each other in any earlier message (an Outlook inline answer, or a
// request hidden under a fake attribution); that line and the rest are new.
// A candidate with almost nothing matched isn't quoted at all. Without a
// thread (the transport, before the message is in a conversation) the
// candidates count as they are, but an attribution also needs an address.
//
// The signature is a raw "-- " line followed by at most a few short lines,
// or a trailing "Sent from my iPhone" style line naming a known device or
// app. A forward (Fwd:/FW:/WG: subject or a "Forwarded message" line) keeps
// its header blocks and its HTML quote visible. When nothing new would be
// left, the whole text is new.

import type {
  MessagePartKind,
  MessageSplit,
  SupportMessage,
} from "../../shared/support";

/** Bump when the rules change; older stored splits are recomputed on read. */
export const SPLIT_VERSION = 2;

/** The longest stretch any regex here sees. */
const MAX_TEST = 600;
/** An attribution wraps over at most this many lines. */
const MAX_ATTRIBUTION_LINES = 3;
/** An Outlook header block's lines after From. */
const MAX_HEADER_BLOCK_LINES = 8;
/** A "-- " signature has at most this many lines after the delimiter… */
const MAX_SIGNATURE_LINES = 10;
/** …each at most this long. */
const MAX_SIGNATURE_LINE = 120;
/** A mobile signature line has at most this many words. */
const MAX_MOBILE_WORDS = 6;
/** A quote matches the thread with at least this many matched words. */
const MIN_MATCHED_WORDS = 3;

const WROTE_VERBS =
  "wrote|schrieb|napisał\\(a\\)|napisała|napisał|pisze|a écrit|escribió|ha scritto|escreveu|schreef|skrev|kirjoitti|napsal\\(a\\)|napsal|írta";

/** Attribution lines, after whitespace is collapsed. Each also needs a
 *  time or a year, see isAttribution. */
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
const TIME = /(?:^|\D)\d{1,2}:\d{2}(?:\D|$)/;
const YEAR = /(?:^|\D)(?:19|20)\d{2}(?:\D|$)/;

const FROM_LINE =
  /^[*_]*(?:From|Von|Od|De|Da|Van|Från|Fra|Lähettäjä|Feladó)[*_]*\s?:[*_]*\s*\S/iu;
const SENT_LINE =
  /^[*_]*(?:Sent|Date|Gesendet|Datum|Wysłano|Wysłane|Data|Envoyé|Date d'envoi|Enviado|Fecha|Inviato|Verzonden|Skickat|Sendt|Lähetetty|Elküldve)[*_]*\s?:/iu;
const TO_LINE =
  /^[*_]*(?:To|An|Do|À|A|Para|Aan|Till|Til|Vastaanottaja|Címzett|Cc|Kopie|DW|UDW|Kopia)[*_]*\s?:/iu;
const SUBJECT_LINE =
  /^[*_]*(?:Subject|Betreff|Temat|Objet|Asunto|Oggetto|Assunto|Onderwerp|Ämne|Emne|Aihe|Tárgy)[*_]*\s?:/iu;
const ORIGINAL_MESSAGE =
  /^-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Wiadomość oryginalna|Oryginalna wiadomość|Message d'origine|Mensaje original|Messaggio originale|Mensagem original|Oorspronkelijk bericht|Originalmeddelande|Oprindelig meddelelse|Opprinnelig melding|Alkuperäinen viesti)\s*-{2,}$/iu;
const UNDERSCORE_RULE = /^_{10,}$/;
const FORWARDED_LINE =
  /^-{2,}\s*(?:Forwarded message|Weitergeleitete Nachricht|Przekazana wiadomość|Message transféré|Mensaje reenviado|Messaggio inoltrato|Mensagem encaminhada|Doorgestuurd bericht)\s*-{2,}$/iu;
const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|pd|rv|i|enc|vs)\s*:/i;
/** Reply and forward prefixes, left out when subjects are compared. */
const SUBJECT_PREFIXES = new Set([
  "re",
  "aw",
  "sv",
  "vs",
  "odp",
  "fw",
  "fwd",
  "wg",
  "tr",
  "pd",
  "rv",
  "enc",
  "i",
]);
/** Weekday names and their short forms, for a pasted Sent: line. */
const WEEKDAYS = new Set(
  (
    "mon tue tues wed thu thur thurs fri sat sun monday tuesday wednesday " +
    "thursday friday saturday sunday mo di mi do fr sa so montag dienstag " +
    "mittwoch donnerstag freitag samstag sonntag pon wt śr czw pt sob niedz " +
    "nd poniedziałek wtorek środa czwartek piątek sobota niedziela lun mar " +
    "mer jeu ven sam dim lundi mardi mercredi jeudi vendredi samedi dimanche " +
    "lunes martes miércoles jueves viernes sábado domingo lunedì martedì " +
    "mercoledì giovedì venerdì sabato maandag dinsdag woensdag donderdag " +
    "vrijdag zaterdag zondag"
  ).split(" "),
);

/** The beginnings of a mobile signature line; it must also name a known
 *  device or app (MOBILE_DEVICE). */
const MOBILE_SIGNATURES: RegExp[] = [
  /^Sent (?:from|with|via) /i,
  /^Get Outlook for /i,
  /^Von meinem .{1,40} gesendet\.?$/i,
  /^Gesendet (?:von|mit) /i,
  /^Wysłane z /iu,
  /^Wysłano z /iu,
  /^Envoyé de /iu,
  /^Enviado (?:desde|do|de) /iu,
  /^Inviato da/i,
  /^Verzonden (?:vanaf|met) /i,
  /^Skickat från /iu,
];
const MOBILE_DEVICE =
  /(?:^|[^\p{L}])(?:iPhone|iPad|iPod|Apple Watch|Android|Galaxy|Pixel|Samsung|Huawei|Xiaomi|OnePlus|BlackBerry|Outlook|Gmail|Yahoo Mail|Proton Mail|ProtonMail|Mail for Windows|Spark|Airmail|Fastmail)(?:[^\p{L}]|$)/iu;

interface Line {
  start: number;
  /** Where the line ends, before its newline. */
  end: number;
  /** Trimmed, without CR, cut to MAX_TEST. */
  text: string;
  /** `text` without its leading `>` marks. */
  bare: string;
  blank: boolean;
  quote: boolean;
  /** Exactly "-- ", the signature delimiter (a CR before the newline aside). */
  delimiter: boolean;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const head = text.slice(start, Math.min(end, start + MAX_TEST * 2));
    const trimmed = head.trim().slice(0, MAX_TEST);
    const rawEnd = text[end - 1] === "\r" ? end - 1 : end;
    lines.push({
      start,
      end,
      text: trimmed,
      bare: trimmed.replace(/^(?:>\s?)+/, "").trim(),
      blank: trimmed === "",
      quote: trimmed.startsWith(">"),
      delimiter: rawEnd - start === 3 && text.slice(start, rawEnd) === "-- ",
    });
    if (nl < 0) break;
    start = nl + 1;
  }
  return lines;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Lowercased runs of letters and digits: what a quote and the mail it
 *  copies agree on, whatever the wrapping, `>` marks or punctuation. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** How an attribution reads: whether it is one, and whether it names an
 *  address. */
function attribution(joined: string): { address: boolean } | null {
  const text = joined.replace(/\s+/g, " ").slice(0, MAX_TEST);
  if (!TIME.test(text) && !YEAR.test(text)) return null;
  if (!ATTRIBUTIONS.some((re) => re.test(text))) return null;
  return { address: text.includes("@") };
}

interface Attribution {
  /** The line it ends on. */
  end: number;
  address: boolean;
}

/** The attributions by the line each starts on. Tried from the shortest
 *  wrap up, so a sentence before the header isn't taken into it. `>` lines
 *  count too (`bare`), for a quote inside a quote. */
function attributions(lines: Line[]): Map<number, Attribution> {
  const startsAt = new Map<number, Attribution>();
  for (let end = 0; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.blank || !line.bare.endsWith(":")) continue;
    let joined = "";
    for (let k = 0; k < MAX_ATTRIBUTION_LINES; k++) {
      const start = end - k;
      if (start < 0) break;
      const first = lines[start]!;
      if (first.blank || first.quote !== line.quote) break;
      joined = joined ? `${first.bare} ${joined}` : first.bare;
      const found = attribution(joined);
      if (found) {
        startsAt.set(start, { end, address: found.address });
        break;
      }
    }
  }
  return startsAt;
}

/** A line the HTML hint may start with: short, with a time, a year or an
 *  address in it. */
function looksLikeAttribution(text: string): boolean {
  return (
    text.length <= 200 &&
    (TIME.test(text) || YEAR.test(text) || text.includes("@"))
  );
}

function hasWeekdayOrTime(text: string): boolean {
  return TIME.test(text) || wordsOf(text).some((w) => WEEKDAYS.has(w));
}

/** From, then within a few lines a Subject line or a Sent/Date line with a
 *  weekday or a time: a pasted header block, not a sentence. */
function isHeaderBlock(lines: Line[], at: number): boolean {
  if (!FROM_LINE.test(lines[at]!.text)) return false;
  const last = Math.min(lines.length - 1, at + MAX_HEADER_BLOCK_LINES);
  for (let i = at + 1; i <= last; i++) {
    const text = lines[i]!.text;
    if (SUBJECT_LINE.test(text)) return true;
    if (SENT_LINE.test(text) && hasWeekdayOrTime(text)) return true;
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

/** The earlier messages of a conversation, as a quote is matched against
 *  them: which words follow each other in their texts, and the words of
 *  their subjects. Built once and grown message by message. */
export class ThreadMatcher {
  private readonly pairs = new Set<string>();
  private readonly subjectWords = new Set<string>();

  add(m: { text: string | null; subject?: string }): this {
    if (m.text) {
      const words = wordsOf(m.text);
      for (let i = 1; i < words.length; i++)
        this.pairs.add(`${words[i - 1]} ${words[i]}`);
    }
    for (const w of wordsOf(m.subject ?? "")) this.subjectWords.add(w);
    return this;
  }

  get empty(): boolean {
    return this.pairs.size === 0;
  }

  hasPair(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && this.pairs.has(`${a} ${b}`);
  }

  /** Whether a pasted Subject line names an earlier subject. */
  knowsSubject(value: string): boolean {
    const words = wordsOf(value).filter((w) => !SUBJECT_PREFIXES.has(w));
    if (words.length === 0) return true;
    const known = words.filter((w) => this.subjectWords.has(w)).length;
    return known * 5 >= words.length * 3;
  }
}

/** A thread from earlier messages, oldest first. */
export function threadOf(
  messages: ReadonlyArray<{ text: string | null; subject?: string }>,
): ThreadMatcher {
  const thread = new ThreadMatcher();
  for (const m of messages) thread.add(m);
  return thread;
}

const BLANK = 0;
/** Carries no words of its own: a header field, an attribution, a rule. */
const NEUTRAL = 1;
const MATCHED = 2;
const UNMATCHED = 3;

/** Lines a quote may carry that come from the mail client, not the mail. */
function isNeutral(line: Line, attributed: boolean): boolean {
  const t = line.bare;
  return (
    attributed ||
    t === "--" ||
    FROM_LINE.test(t) ||
    TO_LINE.test(t) ||
    (SENT_LINE.test(t) && /\d/.test(t)) ||
    ORIGINAL_MESSAGE.test(t) ||
    UNDERSCORE_RULE.test(t) ||
    FORWARDED_LINE.test(t)
  );
}

interface Statuses {
  of: number[];
  /** Matched words per line. */
  words: number[];
}

/** Each line against the thread: blank, neutral, matched (most of its
 *  words follow each other in an earlier message) or unmatched. Words are
 *  read as one stream across lines, so a quote rewrapped by the mail
 *  client still matches. */
function lineStatuses(
  text: string,
  lines: Line[],
  thread: ThreadMatcher,
  headers = attributions(lines),
): Statuses {
  const attributed = new Set<number>();
  for (const [start, a] of headers)
    for (let i = start; i <= a.end; i++) attributed.add(i);
  const of = lines.map(() => BLANK);
  const words = lines.map(() => 0);
  const stream: string[] = [];
  const owner: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.blank) continue;
    if (isNeutral(line, attributed.has(i))) {
      of[i] = NEUTRAL;
      continue;
    }
    if (SUBJECT_LINE.test(line.bare)) {
      const value = line.bare.slice(line.bare.indexOf(":") + 1);
      if (thread.knowsSubject(value)) {
        of[i] = NEUTRAL;
        continue;
      }
    }
    const lineWords = wordsOf(text.slice(line.start, line.end));
    if (lineWords.length === 0) {
      of[i] = NEUTRAL;
      continue;
    }
    for (const w of lineWords) {
      stream.push(w);
      owner.push(i);
    }
  }
  const total = lines.map(() => 0);
  for (let k = 0; k < stream.length; k++) {
    const i = owner[k]!;
    total[i]!++;
    if (
      thread.hasPair(stream[k - 1], stream[k]) ||
      thread.hasPair(stream[k], stream[k + 1])
    )
      words[i]!++;
  }
  for (let i = 0; i < lines.length; i++)
    if (total[i]! > 0)
      of[i] = words[i]! * 5 >= total[i]! * 3 ? MATCHED : UNMATCHED;
  return { of, words };
}

/** Whether quoted `text` (a quoted part of a message) matches `thread`
 *  line by line: no line of its own words, and enough matched. */
export function quoteMatchesThread(
  text: string,
  thread: ThreadMatcher,
): boolean {
  if (thread.empty) return false;
  const lines = linesOf(text);
  const { of, words } = lineStatuses(text, lines, thread);
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    if (of[i] === UNMATCHED) return false;
    if (of[i] === MATCHED) matched += words[i]!;
  }
  return matched >= MIN_MATCHED_WORDS;
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

/** The line the HTML hint starts the quote on, or -1. */
function hintLine(text: string, lines: Line[], options: SplitOptions): number {
  if (typeof options.htmlAt === "number") {
    const at = lines.findIndex((l) => l.start === options.htmlAt);
    return at >= 0 && !lines[at]!.blank ? at : -1;
  }
  if (!options.htmlNewText) return -1;
  const after = lineAfterPrefix(text, lines, options.htmlNewText);
  return after < 0 ? -1 : nextFilled(lines, after);
}

export interface SplitOptions {
  /** The message's subject: a forward keeps its header blocks visible. */
  subject?: string;
  /** The HTML part's text before its quote container, when it has one. */
  htmlNewText?: string | null;
  /** The same hint already resolved: the offset of the line the HTML quote
   *  starts on (an earlier split's `html`). Wins over htmlNewText. */
  htmlAt?: number;
  /** The conversation's earlier messages. With it, quoted text must match
   *  them; see the top of this file. */
  thread?: ThreadMatcher;
}

/** `text` split into new, quoted and signature ranges. */
export function splitEmailText(
  text: string,
  options: SplitOptions = {},
): MessageSplit {
  const lines = linesOf(text);
  const hint = text.trim() ? hintLine(text, lines, options) : -1;
  const html = hint >= 0 ? { html: lines[hint]!.start } : {};
  const whole: MessageSplit = {
    v: SPLIT_VERSION,
    parts: text ? [{ kind: "new", start: 0, end: text.length }] : [],
    ...html,
  };
  if (!text.trim()) return whole;
  const kinds: MessagePartKind[] = lines.map(() => "new");
  const { thread } = options;
  const headers = attributions(lines);
  const status =
    thread && !thread.empty ? lineStatuses(text, lines, thread, headers) : null;
  const last = lines.length - 1;
  let quoted = false;

  /** Marks the candidate quote from line `from` (its header) to `to`, its
   *  body starting at `body`. With a thread, only up to its last line
   *  before one that doesn't match, and only when enough matched. Returns
   *  the line the scan goes on after. */
  const take = (from: number, body: number, to: number, header = 0): number => {
    if (thread && !status) return to;
    let end = to;
    if (status) {
      let matched = 0;
      end = -1;
      let j = body;
      for (; j <= to; j++) {
        const s = status.of[j];
        // An attribution in a language the rules don't know, at the top
        // of an HTML quote: a short line with a date, time or address.
        if (s === UNMATCHED && end < 0 && j - body < header) {
          if (looksLikeAttribution(lines[j]!.text)) continue;
        }
        if (s === UNMATCHED) break;
        if (s === MATCHED) {
          end = j;
          matched += status.words[j]!;
        }
      }
      // Nothing that starts before line j can match more than this did.
      if (end < 0 || matched < MIN_MATCHED_WORDS) return Math.max(from, j - 1);
    }
    for (let i = from; i <= end; i++) kinds[i] = "quoted";
    quoted = true;
    return end;
  };

  const forwarded = FORWARD_SUBJECT.test(options.subject ?? "");
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
        i = take(i, i + 1, last);
        continue;
      }
      if (UNDERSCORE_RULE.test(line.text)) {
        const next = nextFilled(lines, i + 1, 3);
        if (next >= 0 && isHeaderBlock(lines, next)) {
          i = take(i, i + 1, last);
          continue;
        }
      }
    }
    const found = headers.get(i);
    // Without a thread to match, an attribution needs an address too.
    if (!found || (!thread && !found.address)) continue;
    const next = nextFilled(lines, found.end + 1);
    if (next < 0 || !lines[next]!.quote) {
      i = take(i, found.end + 1, last);
      continue;
    }
    let lastQuote = next;
    for (let j = next; j < lines.length; j++) {
      if (lines[j]!.quote) lastQuote = j;
      else if (!lines[j]!.blank) break;
    }
    i = take(i, found.end + 1, lastQuote);
  }

  // `>` lines at the very start: bottom-posting.
  const firstNew = lines.findIndex(
    (l, i) => kinds[i] === "new" && !l.blank && !l.quote,
  );
  if (firstNew > 0 && lines.slice(0, firstNew).some((l) => l.quote))
    take(0, 0, firstNew - 1);
  // `>` lines at the very end: top-posting, but also pasted output, so only
  // when they match the thread, or (without one) open with an attribution
  // that names an address, as Apple Mail's do.
  let tail = last;
  while (tail >= 0 && (lines[tail]!.blank || kinds[tail] === "quoted")) tail--;
  let before = tail;
  while (before >= 0 && (lines[before]!.quote || lines[before]!.blank))
    before--;
  if (before < tail) {
    const from = nextFilled(lines, before + 1);
    const opens = from >= 0 ? headers.get(from) : undefined;
    if (
      from >= 0 &&
      previousFilled(lines, from - 1) >= 0 &&
      (thread || opens?.address)
    )
      take(from, from, tail);
  }

  if (!quoted && !sawForward && hint >= 0)
    take(hint, hint, last, MAX_ATTRIBUTION_LINES);

  markSignature(text, lines, kinds);

  if (!lines.some((l, i) => kinds[i] === "new" && !l.blank)) return whole;
  return { v: SPLIT_VERSION, parts: toParts(text, lines, kinds), ...html };
}

/** A stored message's split against `thread` (the messages before it),
 *  reusing the HTML hint of its earlier split. undefined once retention
 *  removed the text. */
export function splitInThread(
  m: Pick<SupportMessage, "text" | "subject" | "split">,
  thread: ThreadMatcher,
): MessageSplit | undefined {
  if (m.text === null) return undefined;
  return splitEmailText(m.text, {
    subject: m.subject,
    htmlAt: m.split?.html,
    thread,
  });
}

/** "Sent from my iPhone": a known device or app, one short line. */
function isMobileSignature(text: string): boolean {
  if (text.includes(",")) return false;
  if (text.split(/\s+/).length > MAX_MOBILE_WORDS) return false;
  return (
    MOBILE_SIGNATURES.some((re) => re.test(text)) && MOBILE_DEVICE.test(text)
  );
}

/** The signature at the end of the last stretch of new lines, when
 *  something new comes before it. */
function markSignature(
  text: string,
  lines: Line[],
  kinds: MessagePartKind[],
): void {
  let end = lines.length - 1;
  while (end >= 0 && (kinds[end] !== "new" || lines[end]!.blank)) end--;
  if (end < 0) return;
  let start = end;
  while (start > 0 && kinds[start - 1] === "new") start--;
  const first = lines.findIndex((l, i) => kinds[i] === "new" && !l.blank);
  for (let i = Math.max(start, first + 1); i <= end; i++) {
    if (!lines[i]!.delimiter) continue;
    const after = lines.slice(i + 1, end + 1).filter((l) => !l.blank);
    const short =
      after.length <= MAX_SIGNATURE_LINES &&
      after.every(
        (l) => text.slice(l.start, l.end).trim().length <= MAX_SIGNATURE_LINE,
      );
    if (short) for (let j = i; j <= end; j++) kinds[j] = "signature";
    return;
  }
  if (end > first && isMobileSignature(lines[end]!.text))
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
