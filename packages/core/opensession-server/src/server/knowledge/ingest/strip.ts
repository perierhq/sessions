/**
 * Customer data out of a mail text before anything from it reaches the
 * knowledge repository (or the small model that rewrites it). Removes every
 * e-mail address, the customer's name, phone numbers, links outside the
 * project's support sites, quoted history and signatures.
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

export interface StripResult {
  text: string;
  clean: boolean;
}

/** What a name token becomes. */
export const CUSTOMER_PLACEHOLDER = "the customer";
const LINK_REMOVED = "[link removed]";
const PHONE_REMOVED = "[phone removed]";

/** Text as a mail client shows it: compatibility forms folded, invisible
 *  format characters gone, so nothing hides a name or an address. */
function visible(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\r\n?/g, "\n");
}

/** "On Mon, 19 Oct 2026, Ada <ada@x> wrote:" (clients wrap it onto two
 *  lines), and Outlook's separator. */
const ATTRIBUTION =
  /^[ \t]*On\b[^\n]{0,300}(?:\n[^\n]{0,300})?\bwrote:[ \t]*$/gim;
const ORIGINAL_MESSAGE =
  /^[ \t]*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}[\s\S]*$/im;

/** Quoted history: the attribution line, every `>` line, and everything
 *  after an Outlook "Original Message" separator. */
function dropQuotes(text: string): string {
  return text
    .replace(ORIGINAL_MESSAGE, "")
    .replace(ATTRIBUTION, "")
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

/** Every whitespace-separated word a mail client would make a link of,
 *  unless each of its links goes to a kept host. A word whose link can't
 *  be read goes too. */
function dropLinks(text: string, keepHosts: readonly string[]): string {
  return text.replace(/\S+/g, (word) => {
    const links = draftLinks(word);
    if (links === null) return LINK_REMOVED;
    if (links.length === 0) return word;
    return links.every((l) => linkAllowed(l, keepHosts)) ? word : LINK_REMOVED;
  });
}

/** Phone-like runs: digits with spaces, dashes, dots, parentheses or a
 *  leading `+`, seven digits or more. An ISO date is not one. */
const PHONE_LIKE =
  /(?<![\p{L}\p{N}_])\+?\(?\d[\d \t().-]{5,}\d(?![\p{L}\p{N}_])/gu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dropPhones(text: string): string {
  return text.replace(PHONE_LIKE, (run) => {
    if (ISO_DATE.test(run.trim())) return run;
    const digits = run.replace(/\D/g, "").length;
    return digits >= 7 ? PHONE_REMOVED : run;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The display-name words worth hiding: two letters or more. */
function nameTokens(name: string | undefined): string[] {
  if (!name) return [];
  const words = visible(name).match(/[\p{L}\p{M}'’-]+/gu) ?? [];
  const tokens = words
    .map((w) => w.replace(/^['’-]+|['’-]+$/g, ""))
    .filter((w) => (w.match(/\p{L}/gu) ?? []).length >= 2);
  // Longest first, so "Anna" wins over "Ann" in the alternation.
  return [...new Set(tokens.map((t) => t.toLowerCase()))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Each run of the customer's name words ("Alice Customer", "ALICE")
 *  becomes "the customer". Whole words only, any case. */
function dropName(text: string, name: string | undefined): string {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return text;
  const word = `(?:${tokens.map(escapeRegExp).join("|")})`;
  const run = new RegExp(
    `(?<![\\p{L}\\p{N}_])${word}(?:[ \\t]+${word})*(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return text.replace(run, CUSTOMER_PLACEHOLDER);
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
 * `text` without the customer's identity: addresses, name words (→ "the
 * customer"), phone numbers, links to hosts other than `keepHosts` (exact,
 * non-wildcard entries as on the Support websites list), quoted replies and
 * signatures. `clean` is false when secret-looking text remains or a
 * removed address or link held one.
 */
export function stripCustomerData(
  text: string,
  customer: Party,
  opts: { keepHosts?: string[] } = {},
): StripResult {
  const body = dropSignature(dropQuotes(visible(text)));
  // Checked before anything is replaced: a secret inside a link or an
  // address is removed with it, but its presence still skips the item.
  const secretBefore = draftHasSecret(body);
  const address = visible(customer.address).trim();
  let out = address
    ? body.replace(new RegExp(escapeRegExp(address), "gi"), "[email removed]")
    : body;
  out = stripEmailAddresses(out);
  out = dropLinks(out, opts.keepHosts ?? []);
  out = dropPhones(out);
  out = dropName(out, customer.name);
  out = tidy(out);
  return { text: out, clean: !secretBefore && !draftHasSecret(out) };
}
