// Whether a support reply goes out, waits for a veto window or waits for a
// person: the incidents policy shape (response/policy.ts `evaluatePolicy`),
// ordered rules that each name the rule text the reply box shows.
// "Autonomous = repetitive, judgement = a person": an agent's draft sends on
// its own only on a routine inbox, when it cites a source (a repo file, a
// page on the project's Support websites, or a Support connector record),
// links only to those websites, and nothing in the conversation needs a
// person: an injection flag, a request for a person, anger, a repeated
// question, a never-without-a-person topic, unknown labels, unverified mail
// or a reply address that differs. The triage route ("simple" included)
// never permits a send. A person's reply always goes; an automatic one
// never on a spam or closed conversation, nor after a person stopped the
// last one. Pure.
import { SUPPORT_TOPIC_LABELS } from "../../shared/support-copy";
import {
  AUTO_SENDS_PER_HOUR,
  AUTO_SENDS_PER_INBOX_PER_HOUR,
  type ConversationStatus,
  type DraftSource,
  type InboxConfig,
  type SupportActor,
  type SupportDraft,
  type SupportMessage,
  type TriageVerdict,
} from "../../shared/support";
import { fetchHostAllowed } from "../pi-web-search";

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
  authFailed: "The sender could not be verified",
  replyToDiffers: "Replies would go to a different address than the sender",
  authUnverified: "The sender's mail wasn't authenticated",
  autoSendCap: `${AUTO_SENDS_PER_HOUR} automatic replies in the last hour`,
  inboxAutoSendCap: `${AUTO_SENDS_PER_INBOX_PER_HOUR} automatic replies from this inbox in the last hour`,
  veto: "Sends when the window ends unless someone stops it",
  newerMessage: "A newer message arrived",
  agentSent: "Sent by the agent",
} as const;

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
  /** The reply itself (agent drafts are checked; a person's are not). */
  draft: {
    text: string;
    sources: DraftSource[];
    promises: boolean;
    purpose: NonNullable<SupportDraft["purpose"]>;
  };
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
  if (held)
    return needsPerson(`${SUPPORT_TOPIC_LABELS[held] ?? held} needs a person`);
  if (draftLinkProblem(input.draft.text, input.sites.hosts))
    return needsPerson(RULES.links);
  const cited = input.draft.sources.some((x) => validSource(x, input.sites));
  if (!cited)
    return needsPerson(input.draft.promises ? RULES.promise : RULES.noSource);
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
    pending: all.some((t) => !t || t.failed === true),
    injection: all.some((t) => t?.injection === true),
    wantsHuman: all.some((t) => t?.wantsHuman === true),
    angry: all.some((t) => t?.angry === true),
    repeat: all.some((t) => t?.repeat === true),
  };
}

const URL_LIKE = /\b([a-z][a-z0-9+.-]*):(?:\/\/)?[^\s<>"'()[\]]+/gi;
const HTML_TAG = /<\s*(?:[a-z][a-z0-9-]*|!|\/\s*[a-z])[^>]*>/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(/;
/** Schemes that never reach anything remote and can stay in plain text. */
const HARMLESS_SCHEMES = new Set(["mailto"]);

/** The http(s) URL's host and port when it is on `hosts`, else null. */
function allowedUrl(raw: string, hosts: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw.replace(/[.,;:!?]+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return fetchHostAllowed(url.hostname, hosts, url.port) ? url : null;
}

/** Whether an outgoing draft carries anything but plain text and links to
 *  the project's sites: HTML, an image, a link elsewhere, any scheme but
 *  http(s) (and mailto), or a data URI. */
export function draftLinkProblem(
  text: string,
  hosts: readonly string[],
): boolean {
  if (HTML_TAG.test(text) || MARKDOWN_IMAGE.test(text)) return true;
  for (const match of text.matchAll(URL_LIKE)) {
    const scheme = match[1]!.toLowerCase();
    const isUrl = match[0].includes("//") || scheme === "data";
    if (!isUrl) continue;
    if (HARMLESS_SCHEMES.has(scheme)) continue;
    if (!allowedUrl(match[0], hosts)) return true;
  }
  // A bare www. name is a link in most mail clients too.
  for (const match of text.matchAll(/(?:^|[\s(])(www\.[^\s<>"'()]+)/gi))
    if (!allowedUrl(`https://${match[1]}`, hosts)) return true;
  return false;
}

const REPO_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@+.,/-]{1,300}(?:#L\d+(?:-L?\d+)?)?$/;

/** Whether a cited source points where the policy accepts: a relative
 *  path in the project's repository, an http(s) URL on its Support
 *  websites, or `<connector>:<record id>` of one of its Support
 *  connectors. */
export function validSource(source: DraftSource, sites: ProjectSites): boolean {
  if (!source || typeof source.ref !== "string") return false;
  const ref = source.ref.trim();
  if (source.kind === "repo")
    return REPO_PATH.test(ref) && !/^[a-z][a-z0-9+.-]*:/i.test(ref);
  if (source.kind === "url") return allowedUrl(ref, sites.hosts) !== null;
  if (source.kind === "record") {
    const colon = ref.indexOf(":");
    if (colon <= 0 || colon === ref.length - 1 || ref.length > 300)
      return false;
    return sites.connectors.includes(ref.slice(0, colon));
  }
  return false;
}
