// Whether a support reply goes out, waits for a veto window or waits for a
// person: the incidents policy shape (response/policy.ts `evaluatePolicy`),
// ordered rules that each name the rule text the reply box shows.
// "Autonomous = repetitive, judgement = a person": an agent's draft sends on
// its own only on a routine inbox, when it answers a customer message still
// unanswered, cites a source the server verified (a repo file at the
// session's HEAD, a page this session's web_fetch read, a record this
// session's Support connector call returned), links to at most two pages
// on exact, non-shared hosts of the project's Support websites, passes the
// draft check (no sensitive topic, no promise, nothing that looks like a
// secret), and nothing in the conversation needs a person: an injection
// flag, a request for a person, anger, a repeated question, a
// never-without-a-person topic, unknown labels, unverified mail or a reply
// address that differs. Knowledge it cites must back it at the moment of
// deciding (knowledge/backing.ts): a stale, unread or changed item, an
// internal note quoted, or a check that couldn't run holds it. One short
// clarifying question per conversation may
// send without a source. The triage route ("simple" included) never
// permits a send. A person's reply always goes; an automatic one never on
// a spam or closed conversation, nor after a person stopped the last one.
// Pure.
import {
  KNOWLEDGE_COPY,
  type KnowledgeVerdict,
  parseKnowledgeCitation,
} from "../../shared/knowledge";
import { SUPPORT_TOPIC_LABELS } from "../../shared/support-copy";
import {
  AUTO_SENDS_PER_HOUR,
  AUTO_SENDS_PER_INBOX_PER_HOUR,
  type ConversationStatus,
  type DraftCheck,
  type DraftPurpose,
  type DraftSource,
  type InboxConfig,
  type SupportActor,
  type SupportMessage,
  type TriageVerdict,
} from "../../shared/support";
import { findSecrets } from "../memory-repo/secrets";

export type ReplyDecision =
  | { kind: "needs-person"; rule: string }
  | { kind: "veto"; deadline: string; rule: string }
  | { kind: "send"; rule: string };

export const RULES = {
  inboxOff: "The inbox is off",
  spam: "The conversation is marked as spam",
  closed: "The conversation is closed",
  personStopped: "A person stopped the last reply",
  draftsWait: "Drafts wait for a person",
  topicsUnknown: "Topics unknown, so a person decides",
  topicsPending: "The newest message isn't checked yet",
  personOnly: "A person handles this conversation",
  fixedNote: 'An "it\'s fixed" note always needs a person',
  injection: "The message tries to instruct the agent",
  wantsHuman: "The customer asked for a person",
  angry: "The customer sounds upset",
  repeat: "The customer repeats an answered question",
  links: "Links outside the project's sites",
  promise: "A promise without a source needs a person",
  noSource: "No source cited",
  nothingToAnswer: "No new customer message to answer",
  draftUnchecked: "The reply couldn't be checked",
  secret: "The reply may contain a password, key or token",
  draftPromise:
    "The reply promises something about policy, a price or a deadline",
  clarifyUsed: "Only one clarifying question sends on its own",
  authFailed: "The sender could not be verified",
  replyToDiffers: "Replies would go to a different address than the sender",
  authUnverified: "The sender's mail wasn't authenticated",
  autoSendCap: `${AUTO_SENDS_PER_HOUR} automatic replies in the last hour`,
  inboxAutoSendCap: `${AUTO_SENDS_PER_INBOX_PER_HOUR} automatic replies from this inbox in the last hour`,
  knowledgeUnchecked: KNOWLEDGE_COPY.unchecked,
  internalQuoted: KNOWLEDGE_COPY.internalQuoted,
  veto: "Sends when the window ends unless someone stops it",
  newerMessage: "A newer message arrived",
  agentSent: "Sent by the agent",
} as const;

/** The rule of a draft whose cited knowledge can't back it. */
export function knowledgeRule(title: string): string {
  return KNOWLEDGE_COPY.stale(title);
}

const needsPerson = (rule: string): ReplyDecision => ({
  kind: "needs-person",
  rule,
});

export function decideReply(input: {
  author: SupportActor;
  inbox: Pick<
    InboxConfig,
    "enabled" | "autonomy" | "vetoMs" | "neverWithoutAPerson"
  >;
  triage: TriageVerdict | null;
  /** The labels of the customer messages the reply answers (since our
   *  last reply, and the pinned one): `pending` when any has none yet or
   *  its labelling failed; each flag when any message has it. */
  labels: ReplyLabels;
  /** Injection flags on the conversation so far, and whether it was
   *  handed to a person for good. */
  injectionFlags: number;
  personOnly: boolean;
  /** The reply itself (agent drafts are checked; a person's are not).
   *  `check` is the server's check (verify.ts); null when there is none. */
  draft: {
    text: string;
    sources: DraftSource[];
    promises: boolean;
    purpose: DraftPurpose;
    check: DraftCheck | null;
  };
  /** A customer message arrived since our last reply. */
  unanswered: boolean;
  /** An automatic clarifying question already went out. */
  clarifyUsed: boolean;
  /** The project's Support websites (hosts, `*.` wildcards allowed) and
   *  Support connectors: where sources and links may point. */
  sites: ProjectSites;
  autoSendsLastHour: number;
  /** Automatic sends of the inbox in the last hour, across conversations. */
  inboxAutoSendsLastHour: number;
  now: number;
  /** Trust of the message the reply answers (mime.ts replyTarget). */
  lastInboundTrust: SupportMessage["trust"] | null;
  status: ConversationStatus;
  /** A person stopped or discarded the conversation's last draft, or its
   *  last send may have gone out (reply.ts): held until a person acts. */
  personStoppedLast: boolean;
  /** The knowledge check of the draft as of now (knowledge/backing.ts);
   *  null when the draft cites none and the project has no knowledge. */
  knowledge: KnowledgeVerdict | null;
}): ReplyDecision {
  const { author, inbox, triage } = input;
  if (author.kind === "person")
    return { kind: "send", rule: `Sent by ${author.name}` };
  if (!inbox.enabled) return needsPerson(RULES.inboxOff);
  if (input.status === "spam") return needsPerson(RULES.spam);
  if (input.status === "closed") return needsPerson(RULES.closed);
  if (input.personStoppedLast) return needsPerson(RULES.personStopped);
  if (input.personOnly) return needsPerson(RULES.personOnly);
  if (input.draft.purpose === "fixed-note") return needsPerson(RULES.fixedNote);
  if (inbox.autonomy !== "routine") return needsPerson(RULES.draftsWait);
  if (!triage || !Array.isArray(triage.topics))
    return needsPerson(RULES.topicsUnknown);
  if (input.labels.pending) return needsPerson(RULES.topicsPending);
  if (input.lastInboundTrust?.authFailed) return needsPerson(RULES.authFailed);
  if (input.lastInboundTrust?.replyToDiffers)
    return needsPerson(RULES.replyToDiffers);
  if (input.lastInboundTrust?.authVerified !== true)
    return needsPerson(RULES.authUnverified);
  if (input.labels.injection || input.injectionFlags > 0)
    return needsPerson(RULES.injection);
  if (input.labels.wantsHuman) return needsPerson(RULES.wantsHuman);
  if (
    input.labels.angry ||
    (triage.topics as string[]).includes(LEGACY_ANGRY_TOPIC)
  )
    return needsPerson(RULES.angry);
  if (input.labels.repeat) return needsPerson(RULES.repeat);
  const held = triage.topics.find((t) => inbox.neverWithoutAPerson.includes(t));
  if (held) return needsPerson(topicRule(held));
  if (!input.unanswered) return needsPerson(RULES.nothingToAnswer);
  const { draft } = input;
  if (draftHasSecret(draft.text)) return needsPerson(RULES.secret);
  if (draftLinkProblem(draft.text, input.sites.hosts))
    return needsPerson(RULES.links);
  const check = draft.check;
  if (!check || !Array.isArray(check.topics))
    return needsPerson(RULES.draftUnchecked);
  const heldInDraft = check.topics.find((t) =>
    inbox.neverWithoutAPerson.includes(t),
  );
  if (heldInDraft) return needsPerson(topicRule(heldInDraft));
  if (check.promises) return needsPerson(RULES.draftPromise);
  const { knowledge } = input;
  if (knowledge?.failed) return needsPerson(RULES.knowledgeUnchecked);
  if (knowledge?.internalQuoted) return needsPerson(RULES.internalQuoted);
  const stale = knowledge?.blocked[0];
  if (stale) return needsPerson(knowledgeRule(stale.title));
  // Knowledge backs a reply only through the verdict of now, never through
  // what was verified when the draft was written.
  const cited = [
    ...check.verified.filter((x) => x?.kind !== "knowledge"),
    ...(knowledge?.backing ?? []),
  ].some((x) => validSource(x, input.sites));
  if (!cited) {
    if (!isClarifyingQuestion(draft))
      return needsPerson(draft.promises ? RULES.promise : RULES.noSource);
    if (input.clarifyUsed) return needsPerson(RULES.clarifyUsed);
  }
  if (input.autoSendsLastHour >= AUTO_SENDS_PER_HOUR)
    return needsPerson(RULES.autoSendCap);
  if (input.inboxAutoSendsLastHour >= AUTO_SENDS_PER_INBOX_PER_HOUR)
    return needsPerson(RULES.inboxAutoSendCap);
  if (inbox.vetoMs !== null)
    return {
      kind: "veto",
      deadline: new Date(input.now + inbox.vetoMs).toISOString(),
      rule: RULES.veto,
    };
  return { kind: "send", rule: RULES.agentSent };
}

function topicRule(topic: string): string {
  return `${SUPPORT_TOPIC_LABELS[topic as keyof typeof SUPPORT_TOPIC_LABELS] ?? topic} needs a person`;
}

/** The longest clarifying question that may send without a source. */
export const CLARIFY_MAX_CHARS = 600;

/** A short clarifying question without links or promises: the one reply
 *  per conversation that may send without a source. */
function isClarifyingQuestion(draft: {
  text: string;
  promises: boolean;
  purpose: DraftPurpose;
}): boolean {
  if (draft.purpose !== "clarify" || draft.promises) return false;
  if (draft.text.length >= CLARIFY_MAX_CHARS) return false;
  const links = draftLinks(draft.text);
  return links !== null && links.length === 0;
}

export interface ReplyLabels {
  pending: boolean;
  injection: boolean;
  wantsHuman: boolean;
  angry: boolean;
  repeat: boolean;
}

export interface ProjectSites {
  hosts: string[];
  connectors: string[];
}

/** A topic older conversations may still carry: anger, now a label. */
const LEGACY_ANGRY_TOPIC = "angry-customer";

/** The labels of `answered` (see decideReply's `labels`). */
export function replyLabels(answered: readonly SupportMessage[]): ReplyLabels {
  const all = answered.map((m) => m.triage);
  return {
    // Unknown topics (a failed or partial labelling) hold the send too.
    pending: all.some(
      (t) => !t || t.failed === true || !Array.isArray(t.topics),
    ),
    injection: all.some((t) => t?.injection === true),
    wantsHuman: all.some((t) => t?.wantsHuman === true),
    angry: all.some((t) => t?.angry === true),
    repeat: all.some((t) => t?.repeat === true),
  };
}

// ── Links ────────────────────────────────────────────────────────────────

/** Links an automatic reply may carry at most. */
export const MAX_DRAFT_LINKS = 2;

const HTML_TAG = /<\s*(?:[a-z][a-z0-9-]*|!|\/\s*[a-z])[^>]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(/;
/** `scheme:` anywhere a word starts, with or without `//`. */
const SCHEME_LIKE = /\b([a-z][a-z0-9+.-]*):(\/\/)?[^\s<>"'`()[\]{}]*/gi;
/** Schemes that never reach anything remote and can stay in plain text. */
const HARMLESS_SCHEMES = new Set(["mailto", "tel"]);
/** Schemes a mail client opens even without `//` (`http:evil.test`). */
const LINK_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "sftp",
  "file",
  "data",
  "javascript",
  "vbscript",
  "blob",
  "ws",
  "wss",
  "ssh",
  "git",
  "irc",
  "news",
  "nntp",
  "smb",
  "telnet",
  "gopher",
  "ldap",
]);
const EMAIL_LIKE = /[^\s<>"'`()[\]{},;]+@[^\s<>"'`()[\]{},;]+/gu;
/** A bare host name as linkifiers find it (`evil.test/x`, `www.evil.test`),
 *  not inside a word, a path or an address. */
const BARE_HOST =
  /(?<![\p{L}\p{N}_@.\-/\\])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(\p{L}{2,63}|xn--[a-z0-9-]{1,59}))(?![\p{L}\p{N}_-])(:\d{1,5})?([/?#][^\s<>"'`()[\]{}]*)?/giu;
/** File name endings that are no top-level domain, so `package.json` or
 *  `Node.js` don't read as links. Anything else counts as a host (a mail
 *  client may link it), so an unknown ending holds the send. */
const NOT_A_TLD = new Set(
  (
    "js ts jsx tsx mjs cjs json jsonc yml yaml toml ini cfg conf env txt csv tsv " +
    "log lock html htm css scss sass less xml svg png jpg jpeg gif webp ico pdf " +
    "doc docx xls xlsx ppt pptx sql db sqlite tar gz tgz bz2 xz rar exe dll bin " +
    "dmg deb rpm jar kt kts swift rb php cpp hpp cs vue svelte lua erl hs scala " +
    "clj dart bat cmd ps1 sln csproj gradle cmake proto graphql gql prisma wasm " +
    "map mod sum bak tmp swp orig patch diff md5 sha256 mdx rst adoc"
  ).split(" "),
);
/** Hosting where anyone can publish: a link there never sends on its own,
 *  even when the Support websites list names it. */
const SHARED_HOSTS = [
  "github.com",
  "githubusercontent.com",
  "github.io",
  "gitlab.com",
  "gitlab.io",
  "bitbucket.org",
  "bitbucket.io",
  "vercel.app",
  "now.sh",
  "netlify.app",
  "netlify.com",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "azurestaticapps.net",
  "cloudfront.net",
  "amazonaws.com",
  "windows.net",
  "googleapis.com",
  "googleusercontent.com",
  "sites.google.com",
  "docs.google.com",
  "drive.google.com",
  "forms.gle",
  "notion.site",
  "notion.so",
  "medium.com",
  "substack.com",
  "gitbook.io",
  "readthedocs.io",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "squarespace.com",
  "carrd.co",
  "glitch.me",
  "replit.app",
  "repl.co",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "surge.sh",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "trycloudflare.com",
  "codesandbox.io",
  "csb.app",
  "stackblitz.io",
  "deno.dev",
  "dropbox.com",
  "dropboxusercontent.com",
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "pastebin.com",
];

/** Whether `host` is on shared hosting (SHARED_HOSTS or under one). */
export function isSharedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, "");
  return SHARED_HOSTS.some((s) => name === s || name.endsWith(`.${s}`));
}

/** Text as a mail client shows it: compatibility forms folded, invisible
 *  format characters gone. */
function visible(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/** Every link a mail client may make of `text`, as URLs to check: scheme
 *  links (`https://`, `http:evil.test`, `javascript:`), bare host names
 *  (`evil.test/x`, `www.evil.test`, after quotes, colons or `>`). null when
 *  a link can't be read. mailto and tel are left out. */
export function draftLinks(text: string): string[] | null {
  let rest = visible(text);
  const links: string[] = [];
  let unreadable = false;
  rest = rest.replace(SCHEME_LIKE, (match, scheme: string, slashes) => {
    const name = scheme.toLowerCase();
    if (HARMLESS_SCHEMES.has(name)) return " ";
    if (!slashes && !LINK_SCHEMES.has(name)) return match;
    if (!LINK_SCHEMES.has(name) && name !== "http" && name !== "https")
      unreadable = true;
    links.push(match);
    return " ";
  });
  rest = rest.replace(EMAIL_LIKE, " ");
  for (const m of rest.matchAll(BARE_HOST)) {
    const host = m[1]!;
    const tld = m[2]!.toLowerCase();
    if (!host.toLowerCase().startsWith("www.") && NOT_A_TLD.has(tld)) continue;
    links.push(`https://${host}${m[3] ?? ""}${m[4] ?? ""}`);
  }
  return unreadable ? null : links;
}

/** Whether an automatic reply may carry this link: http(s), no user or
 *  password, no query string, a default port (or the entry's own), and a
 *  host that is exactly a non-wildcard entry of `hosts` and not shared
 *  hosting. */
export function linkAllowed(raw: string, hosts: readonly string[]): boolean {
  const trimmed = raw.replace(/[.,;:!?'")\]]+$/, "");
  if (trimmed.includes("?")) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password || url.search) return false;
  const name = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!name || isSharedHost(name)) return false;
  return hosts.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e || e.startsWith("*.")) return false;
    const m = /^(.+?)(?::(\d+))?$/.exec(e);
    const host = m?.[1]?.replace(/\.+$/, "");
    if (host !== name) return false;
    return m?.[2] ? url.port === m[2] : url.port === "";
  });
}

/** Whether an outgoing agent draft carries anything but plain text and at
 *  most MAX_DRAFT_LINKS links an automatic reply may carry (linkAllowed):
 *  HTML, an image, a link elsewhere, any other scheme or a data URI. */
export function draftLinkProblem(
  text: string,
  hosts: readonly string[],
): boolean {
  const shown = visible(text);
  if (HTML_TAG.test(shown) || MARKDOWN_IMAGE.test(shown)) return true;
  const links = draftLinks(text);
  if (links === null || links.length > MAX_DRAFT_LINKS) return true;
  return links.some((link) => !linkAllowed(link, hosts));
}

// ── Secrets ──────────────────────────────────────────────────────────────

/** Beyond the credential formats memory refuses (memory-repo/secrets.ts):
 *  a password, key or token written out, test keys, JWTs and long
 *  random-looking strings. Fail closed: a hit only makes a person look. */
const SECRET_PATTERNS = [
  /\b(?:password|passwd|passcode|pwd|secret|token|api[ _-]?key|access[ _-]?key|client[ _-]?secret|private[ _-]?key)\s*[:=]\s*["'`]?\S{6,}/i,
  /\b(?:[rs]k_test_|whsec_|xapp-|glpat-|npm_|pypi-)[A-Za-z0-9_-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];
const LONG_TOKEN = /[A-Za-z0-9_+/=-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/i;

/** Whether `text` holds something that looks like a token, key or
 *  password. */
export function draftHasSecret(text: string): boolean {
  const shown = visible(text);
  if (findSecrets(shown).length > 0) return true;
  if (SECRET_PATTERNS.some((p) => p.test(shown))) return true;
  for (const [token] of shown.matchAll(LONG_TOKEN)) {
    if (UUID.test(token) || GIT_SHA.test(token)) continue;
    // A path or a URL is no secret; its parts are checked above.
    if (token.includes("/")) continue;
    if (/\d/.test(token) && /[A-Za-z]/.test(token)) return true;
  }
  return false;
}

// ── Sources ──────────────────────────────────────────────────────────────

const REPO_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[\w@+.,/-]{1,300}(?:#L\d+(?:-L?\d+)?)?$/;

/** The file path of a repo source without its `#L10-L20` anchor, or null
 *  when it isn't a relative path to a file (no `.` or `..` parts, no
 *  scheme, no trailing slash). */
export function repoSourcePath(ref: string): string | null {
  const trimmed = ref.trim();
  if (!REPO_PATH.test(trimmed) || /^[a-z][a-z0-9+.-]*:/i.test(trimmed))
    return null;
  return trimmed.replace(/#L\d+(?:-L?\d+)?$/, "");
}

/** `<connector>:<record id>` split, or null. */
export function recordSource(
  ref: string,
): { connector: string; id: string } | null {
  const trimmed = ref.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1 || trimmed.length > 300)
    return null;
  return { connector: trimmed.slice(0, colon), id: trimmed.slice(colon + 1) };
}

/** Whether a cited source has a shape the policy accepts: a relative file
 *  path in the project's repository, an http(s) URL an automatic reply may
 *  link to (linkAllowed), `<connector>:<record id>` of one of its Support
 *  connectors, or a knowledge citation `<path>@<commit>`. Whether it exists
 *  is verify.ts's check (knowledge/backing.ts for knowledge). */
export function validSource(source: DraftSource, sites: ProjectSites): boolean {
  if (!source || typeof source.ref !== "string") return false;
  if (source.kind === "repo") return repoSourcePath(source.ref) !== null;
  if (source.kind === "url") return linkAllowed(source.ref.trim(), sites.hosts);
  if (source.kind === "record") {
    const record = recordSource(source.ref);
    return record !== null && sites.connectors.includes(record.connector);
  }
  if (source.kind === "knowledge")
    return parseKnowledgeCitation(source.ref.trim()) !== null;
  return false;
}
