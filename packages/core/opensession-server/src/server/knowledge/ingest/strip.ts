/**
 * Customer data out of a mail text before anything from it reaches the
 * knowledge repository (or the small model that rewrites it). Removes every
 * e-mail address (also Unicode and "at/dot" spellings), the customer's name
 * and the words of their address, phone numbers, ids (IBANs, UUIDs, invoice
 * and customer ids, order numbers, IP addresses), links outside the
 * project's support sites, and, unless `structure: false`, quoted history,
 * signatures and a short greeting line.
 *
 * Fail closed: `clean` is false when secret-looking text remains (the
 * caller skips the item), and also when a link removed here held one, since
 * a pasted credential means the exchange is not one to keep.
 *
 * Reuses the support reply checks: `stripEmailAddresses` (GitHub issue
 * export), `draftLinks`/`linkAllowed` (what a mail client makes a link of
 * and which links an automatic reply may carry) and `draftHasSecret`.
 * Pure; nothing runs at import.
 */
import { stripEmailAddresses } from "../../github-issues";
import { draftHasSecret, draftLinks, linkAllowed } from "../../support/policy";

export interface Party {
  name?: string;
  address: string;
}

/** A kind of identity replacement. */
export type StripKind = "email" | "name" | "phone" | "link" | "id";

export interface StripResult {
  text: string;
  clean: boolean;
  /** The replacements that changed something, each kind once. */
  removed: StripKind[];
}

export interface StripOptions {
  /** Exact hosts whose links stay (the Support websites list). */
  keepHosts?: string[];
  /** Also cut quoted history, signatures and a greeting line. Default
   *  true; false for text that is no mail (a model's rewrite). */
  structure?: boolean;
}

/** What a name token becomes. */
export const CUSTOMER_PLACEHOLDER = "the customer";
export const EMAIL_REMOVED = "[email removed]";
export const LINK_REMOVED = "[link removed]";
export const PHONE_REMOVED = "[phone removed]";
export const ID_REMOVED = "[id removed]";
/** Placeholder texts the strip leaves behind (all but the name's). */
export const REMOVED_MARKERS = [
  EMAIL_REMOVED,
  LINK_REMOVED,
  PHONE_REMOVED,
  ID_REMOVED,
] as const;

/** Text as a mail client shows it: compatibility forms folded, invisible
 *  format characters gone, so nothing hides a name or an address. */
function visible(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\r\n?/g, "\n");
}

/** Letters NFD can't take apart. */
const LETTER_FOLD = new Map([
  ["ł", "l"],
  ["Ł", "L"],
  ["ø", "o"],
  ["Ø", "O"],
  ["ß", "ss"],
  ["đ", "d"],
  ["Đ", "D"],
]);

function foldChar(ch: string): string {
  return LETTER_FOLD.get(ch) ?? ch.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Accents off and ł/ø/ß spelled plainly, so "Łukasz" reads "Lukasz". */
export function foldLetters(text: string): string {
  let out = "";
  for (const ch of text) out += foldChar(ch);
  return out;
}

/** `foldLetters` with, for each folded index, where it starts in `text`
 *  (one more entry for the end). */
interface FoldedText {
  folded: string;
  starts: number[];
}

function foldMapped(text: string): FoldedText {
  let folded = "";
  const starts: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) starts.push(i);
    folded += f;
    i += ch.length;
  }
  starts.push(text.length);
  return { folded, starts };
}

/** Common words never treated as a name or an address word; extract reads
 *  them as no content word. Folded, lower case. */
export const FUNCTION_WORDS = new Set(
  (
    "a an the and or but nor so yet if then than that this these those there here " +
    "is are was were be been being am do does did done have has had having will " +
    "would could should shall may might must can cannot not no yes " +
    "i me my mine we us our ours you your yours he him his she her hers it its " +
    "they them their theirs who whom whose which what when where why how " +
    "of to in on at by for with from into onto over under about after before " +
    "again also just only very more most much many some such each every both " +
    "other another any all few same own once still even well like want need " +
    "make sure please thanks thank hello dear able out off up down via per " +
    "while because until since though although whether either neither " +
    "get got go goes went see let lets use used using new now one two " +
    "jest oraz przez jak ktory ktora ktore tego tylko moze dzieki prosze " +
    "czy nie tak dla albo lub ale gdy jesli juz sie pan pani panstwo " +
    "witam dzien dobry czesc pozdrawiam dziekuje"
  ).split(" "),
);

/** Mailbox and role words: an address `support@` or a name "Sales Team"
 *  says nothing about who the customer is. */
const ROLE_WORDS = new Set(
  (
    "support team info admin administrator contact sales office mail email " +
    "noreply reply billing help hello service services account accounts " +
    "biuro kontakt pomoc obsluga firma company group dept department " +
    "example test invalid localhost www web online shop store app"
  ).split(" "),
);

/** Public mail providers: their domain says nothing about the customer. */
const PUBLIC_MAIL_LABELS = new Set(
  (
    "gmail googlemail outlook hotmail live msn yahoo icloud me mac proton " +
    "protonmail pm onet o2 interia gmx tutanota aol yandex zoho"
  ).split(" "),
);
const PUBLIC_MAIL_DOMAINS = ["wp.pl", "web.de", "op.pl", "poczta.fm"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function letterCount(word: string): number {
  return (word.match(/\p{L}/gu) ?? []).length;
}

function usable(token: string, min: number): boolean {
  return (
    letterCount(token) >= min &&
    !FUNCTION_WORDS.has(token) &&
    !ROLE_WORDS.has(token)
  );
}

/** The display-name words: each word ("o'brien", "anna-maria"), its parts
 *  and the parts joined ("obrien"). Two letters or more. */
function nameTokens(name: string | undefined): string[] {
  if (!name) return [];
  const words =
    foldLetters(visible(name))
      .toLowerCase()
      .match(/[\p{L}'’-]+/gu) ?? [];
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/^['’-]+|['’-]+$/g, "");
    const parts = word.split(/['’-]+/);
    out.push(word, parts.join(""), ...parts);
  }
  return out.filter((t) => usable(t, 2));
}

function isPublicMail(domain: string): boolean {
  if (PUBLIC_MAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)))
    return true;
  return domain.split(".").some((l) => PUBLIC_MAIL_LABELS.has(l));
}

/** Words of the address: the local part (split on . _ - +, digits
 *  dropped, three letters or more) and the domain's labels, unless it is a
 *  public mail provider. The top-level domain and labels of our own support
 *  hosts are no customer words. */
function addressTokens(
  address: string,
  keepHosts: readonly string[],
): string[] {
  const at = address.lastIndexOf("@");
  if (at < 0) return [];
  const folded = foldLetters(visible(address)).toLowerCase().trim();
  const local = folded.slice(0, folded.lastIndexOf("@"));
  const domain = folded.slice(folded.lastIndexOf("@") + 1);
  const out = local
    .split(/[._+-]+/)
    .map((t) => t.replace(/\p{N}+/gu, ""))
    .filter((t) => usable(t, 3));
  if (!isPublicMail(domain)) {
    const ours = new Set(keepHosts.flatMap((h) => h.toLowerCase().split(".")));
    const labels = domain.split(".").slice(0, -1);
    for (const label of labels) {
      for (const t of [label, ...label.split("-")]) {
        const word = t.replace(/\p{N}+/gu, "");
        if (usable(word, 3) && !ours.has(t)) out.push(word);
      }
    }
  }
  return out;
}

/** One alternative per token: apostrophes match either spelling, and a
 *  token of five letters or more takes up to three more (Polish and German
 *  endings: "Łukasza", "Nowakowi"). Digits right after are part of it
 *  ("robert42"). */
function tokenPattern(token: string): string {
  const body = [...token]
    .map((ch) => (ch === "'" || ch === "’" ? "['’]" : escapeRegExp(ch)))
    .join("");
  return letterCount(token) >= 5 ? `${body}\\p{L}{0,3}` : body;
}

/** A matcher for runs of the customer's words, or null with none. */
function nameMatcher(tokens: string[]): RegExp | null {
  const unique = [...new Set(tokens)].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return null;
  const word = `(?:${unique.map(tokenPattern).join("|")})\\p{N}*`;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${word}(?:[ \\t]+${word})*(?![\\p{L}\\p{N}])`,
    "giu",
  );
}

/** Each run of the customer's words ("Alice Customer", "ALICE", "alice_ops"
 *  → "the customer_ops") becomes "the customer". Matching ignores case and
 *  accents; the rest of the text keeps its own spelling. "the customer"
 *  already there stays as it is. */
function dropName(text: string, matcher: RegExp | null): string {
  if (!matcher) return text;
  const { folded, starts } = foldMapped(text);
  const kept: Array<[number, number]> = [];
  for (const m of folded.matchAll(/the customer/gi))
    kept.push([m.index, m.index + m[0].length]);
  let out = "";
  let last = 0;
  for (const m of folded.matchAll(matcher)) {
    const s = m.index;
    const e = s + m[0].length;
    if (kept.some(([a, b]) => s >= a && e <= b)) continue;
    out += text.slice(last, starts[s]) + CUSTOMER_PLACEHOLDER;
    last = starts[e]!;
  }
  return out + text.slice(last);
}

/** Headers that open quoted history, as English, Outlook, German, French
 *  and Polish clients write them. Everything from the first one on goes. */
const QUOTE_HEADERS = [
  /^[ \t]*On\b[^\n]{0,300}(?:\n[^\n]{0,300})?\bwrote:[ \t]*$/imu,
  /^[ \t]*Am\b[^\n]{0,300}(?:\n[^\n]{0,300})?\bschrieb\b[^\n]{0,300}:[ \t]*$/imu,
  /^[ \t]*Le\b[^\n]{0,300}(?:\n[^\n]{0,300})?\ba écrit[ \t]*:[ \t]*$/imu,
  /^[ \t]*W dniu\b[^\n]{0,300}(?:\n[^\n]{0,300})?\bnapisał(?:a|\(a\))?[ \t]*:[ \t]*$/imu,
  /^[ \t]*-{2,}[ \t]*(?:Original Message|Forwarded message|Wiadomość oryginalna|Ursprüngliche Nachricht|Message d'origine)[ \t]*-{2,}/imu,
  /^[ \t]*_{10,}[ \t]*$/mu,
  /^[ \t]*\*?(?:From|Od|Von|De)[ \t]*:\*?[^\n]*\n(?:[^\n]*\n){0,2}?[ \t]*\*?(?:Sent|Date|To|Subject|Wysłano|Data|Do|Temat|Gesendet|An|Betreff|Envoyé|À|Objet)[ \t]*:/imu,
];

/** Quoted history: from the first attribution or header block to the end,
 *  and every `>` line. */
function dropQuotes(text: string): string {
  let cut = text.length;
  for (const header of QUOTE_HEADERS) {
    const m = header.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^[ \t]*>/.test(line))
    .join("\n");
}

const SIGN_OFF =
  /^[ \t]*(?:best|best regards|kind regards|warm regards|warmest regards|regards|cheers|thanks|thank you|thanks again|many thanks|thanks in advance|sincerely|yours sincerely|yours truly|best wishes|all the best|with thanks|pozdrawiam|sent from my [\w ]+)[ \t]*[,.!]?[ \t]*$/i;

/** Everything from the signature on: a `-- ` (or `--`) line, a common
 *  sign-off line or "Sent from my phone". A sign-off with nothing written
 *  before it opens the message and stays. */
function dropSignature(text: string): string {
  const lines = text.split("\n");
  let seenContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^--[ \t]*$/.test(line) || (seenContent && SIGN_OFF.test(line)))
      return lines.slice(0, i).join("\n");
    if (line.trim()) seenContent = true;
  }
  return text;
}

const GREETING =
  /^[ \t]*(?:hi|hello|hey|dear|cześć|czesc|dzień dobry|dzien dobry|witam)(?![\p{L}\p{N}])[^\n]{0,40}$/iu;

/** A short greeting as the first line ("Hi Marta,"): it names the person. */
function dropGreeting(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (first < 0 || !GREETING.test(lines[first]!)) return text;
  return lines.slice(first + 1).join("\n");
}

/** Addresses a strict parser misses: any script, as support/policy.ts
 *  reads them for links. */
const EMAIL_LIKE = /[^\s<>"'`()[\]{},;]+@[^\s<>"'`()[\]{},;]+/gu;
const OBFUSCATED_BRACKET =
  /[\p{L}\p{N}._%+-]+[ \t]*[([{][ \t]*at[ \t]*[)\]}][ \t]*[\p{L}\p{N}-]+(?:(?:[ \t]*[([{][ \t]*dot[ \t]*[)\]}][ \t]*|[ \t]+dot[ \t]+|\.)[\p{L}\p{N}-]+)+/giu;
const OBFUSCATED_WORDS =
  /[\p{L}\p{N}._%+-]+[ \t]+at[ \t]+[\p{L}\p{N}-]+(?:(?:[ \t]*[([{][ \t]*dot[ \t]*[)\]}][ \t]*|[ \t]+dot[ \t]+|\.)[\p{L}\p{N}-]+)+/giu;

/** Ids tied to one account or machine. */
const IBAN =
  /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/gu;
const UUID_LIKE =
  /(?<![\p{L}\p{N}])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\p{L}\p{N}])/giu;
/** "INV-48213", "ACME2026": letters then four digits or more. */
const PREFIXED_ID =
  /(?<![\p{L}\p{N}_])\p{L}{2,}[-_]?\d{4,}(?:[-_][\p{L}\p{N}]+)*(?![\p{L}\p{N}_])/gu;
/** Standards and formats, not ids: "ISO8601", "CVE-2024-1234". */
const NOT_AN_ID_PREFIX = new Set(
  "rfc iso es ecma cve utf sha md win http https ipv tls ssl x".split(" "),
);
/** "cus_N3xT9aQ2LmP0": a short type prefix, an underscore, a mixed id. */
const TYPED_ID =
  /(?<![\p{L}\p{N}_])[a-z]{2,10}_[A-Za-z0-9]{8,}(?![\p{L}\p{N}_])/gu;
const ORDER_NUMBER = /(?<![\p{L}\p{N}&])#\d{3,}(?![\p{L}\p{N}])/gu;
const IPV4 = /(?<![\p{N}.])(?:\d{1,3}\.){3}\d{1,3}(?![\p{N}]|\.\d)/gu;
const IPV6 =
  /(?<![\p{L}\p{N}_:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\p{L}\p{N}_:])/giu;

function isIban(m: string): boolean {
  return (m.match(/\d/g) ?? []).length >= 8;
}
function isPrefixedId(m: string): boolean {
  const prefix = /^\p{L}+/u.exec(m)?.[0] ?? "";
  return !NOT_AN_ID_PREFIX.has(prefix.toLowerCase());
}
function isTypedId(m: string): boolean {
  const tail = m.slice(m.indexOf("_") + 1);
  return /\d/.test(tail) && /\p{L}/u.test(tail);
}
function isIpv4(m: string): boolean {
  return m.split(".").every((o) => Number(o) <= 255);
}
function isIpv6(m: string): boolean {
  if (/^\d{1,2}(?::\d{2}){1,2}$/.test(m)) return false;
  const groups = m.split(":");
  const filled = groups.filter(Boolean).length;
  return m.includes("::") ? filled >= 2 : groups.length === 8 && filled === 8;
}

type Rule = [RegExp, (m: string) => boolean];
const ID_RULES: Rule[] = [
  [IBAN, isIban],
  [UUID_LIKE, () => true],
  [TYPED_ID, isTypedId],
  [PREFIXED_ID, isPrefixedId],
  [ORDER_NUMBER, () => true],
  [IPV4, isIpv4],
  [IPV6, isIpv6],
];

function replaceIds(text: string, onHit: () => void): string {
  let out = text;
  for (const [re, ok] of ID_RULES) {
    out = out.replace(re, (m: string) => {
      if (!ok(m)) return m;
      onHit();
      return ID_REMOVED;
    });
  }
  return out;
}

/** True when `text` holds an id, an IP address or an address of any
 *  spelling the strip removes. */
export function hasIdentifier(text: string): boolean {
  const shown = visible(text);
  let hit = false;
  replaceIds(shown, () => {
    hit = true;
  });
  if (hit) return true;
  if (new RegExp(EMAIL_LIKE.source, "u").test(shown)) return true;
  if (new RegExp(OBFUSCATED_BRACKET.source, "iu").test(shown)) return true;
  for (const m of shown.matchAll(OBFUSCATED_WORDS))
    if (/[ \t]dot[ \t]|[([{][ \t]*dot/i.test(m[0])) return true;
  return false;
}

/** A path segment or fragment of 16 characters or more that mixes letters
 *  and digits: a token, a share id or a record id, not a page name. */
function opaqueLink(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link.replace(/[.,;:!?'")\]]+$/, ""));
  } catch {
    return true;
  }
  const parts = [...url.pathname.split("/"), url.hash.slice(1)];
  return parts.some((p) => {
    let seg = p;
    try {
      seg = decodeURIComponent(p);
    } catch {}
    return seg.length >= 16 && /\p{L}/u.test(seg) && /\p{N}/u.test(seg);
  });
}

/** Every whitespace-separated word a mail client would make a link of,
 *  unless each of its links goes to a kept host and says nothing about the
 *  customer: no opaque path segment, no id, none of their words. A word
 *  whose link can't be read goes too. */
function dropLinks(
  text: string,
  keepHosts: readonly string[],
  names: RegExp | null,
  onHit: () => void,
): string {
  return text.replace(/\S+/g, (word) => {
    const links = draftLinks(word);
    if (links !== null && links.length === 0) return word;
    const kept =
      links !== null &&
      links.every((l) => linkAllowed(l, keepHosts) && !opaqueLink(l)) &&
      !hasIdentifier(word) &&
      !(names && new RegExp(names.source, "iu").test(foldLetters(word)));
    if (kept) return word;
    onHit();
    return LINK_REMOVED;
  });
}

/** Phone-like runs: digits with spaces, dashes, dots, parentheses or a
 *  leading `+`, seven digits or more. An ISO date is not one. */
const PHONE_LIKE =
  /(?<![\p{L}\p{N}_])\+?\(?\d[\d \t().-]{5,}\d(?![\p{L}\p{N}_])/gu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dropPhones(text: string, onHit: () => void): string {
  return text.replace(PHONE_LIKE, (run) => {
    if (ISO_DATE.test(run.trim())) return run;
    const digits = run.replace(/\D/g, "").length;
    if (digits < 7) return run;
    onHit();
    return PHONE_REMOVED;
  });
}

function dropAddresses(
  text: string,
  addresses: readonly string[],
  onHit: () => void,
): string {
  const hit = (out: string, before: string) => {
    if (out !== before) onHit();
    return out;
  };
  let out = text;
  for (const address of addresses)
    out = hit(
      out.replace(new RegExp(escapeRegExp(address), "gi"), EMAIL_REMOVED),
      out,
    );
  out = hit(stripEmailAddresses(out), out);
  out = hit(out.replace(EMAIL_LIKE, EMAIL_REMOVED), out);
  out = hit(out.replace(OBFUSCATED_BRACKET, EMAIL_REMOVED), out);
  out = hit(
    out.replace(OBFUSCATED_WORDS, (m) =>
      /[ \t]dot[ \t]|[([{][ \t]*dot/i.test(m) ? EMAIL_REMOVED : m,
    ),
    out,
  );
  return out;
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `text` without the customer's identity: addresses, name and address
 * words (→ "the customer"), phone numbers, ids, links to hosts other than
 * `keepHosts` (exact, non-wildcard entries as on the Support websites
 * list) and, with `structure` (the default), quoted replies, signatures
 * and a greeting line. `clean` is false when secret-looking text remains
 * or a removed address or link held one. `customer` may be every sender
 * of a thread: each one's name and address words go.
 */
export function stripCustomerData(
  text: string,
  customer: Party | readonly Party[],
  opts: StripOptions = {},
): StripResult {
  const parties: readonly Party[] = Array.isArray(customer)
    ? customer
    : [customer as Party];
  const keepHosts = opts.keepHosts ?? [];
  const shown = visible(text);
  const body =
    opts.structure === false
      ? shown
      : dropGreeting(dropSignature(dropQuotes(shown)));
  // Checked before anything is replaced: a secret inside a link or an
  // address is removed with it, but its presence still skips the item.
  const secretBefore = draftHasSecret(body);
  const removed = new Set<StripKind>();
  const mark = (kind: StripKind) => () => removed.add(kind);
  const addresses = parties
    .map((p) => visible(p.address).trim())
    .filter(Boolean);
  const names = nameMatcher([
    ...parties.flatMap((p) => nameTokens(p.name)),
    ...addresses.flatMap((a) => addressTokens(a, keepHosts)),
  ]);
  let out = dropAddresses(body, addresses, mark("email"));
  out = dropLinks(out, keepHosts, names, mark("link"));
  out = replaceIds(out, mark("id"));
  out = dropPhones(out, mark("phone"));
  const named = dropName(out, names);
  if (named !== out) removed.add("name");
  out = tidy(named);
  return {
    text: out,
    clean: !secretBefore && !draftHasSecret(out),
    removed: [...removed],
  };
}
