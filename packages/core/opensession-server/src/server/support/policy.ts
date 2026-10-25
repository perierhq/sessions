// Whether a support reply goes out, waits for a veto window or waits for a
// person: the incidents policy shape (response/policy.ts `evaluatePolicy`),
// ordered rules that each name the rule text the reply box shows. Sending
// is decided by who wrote the reply, the inbox's autonomy and the triage
// topics; the triage route ("simple" included) never permits a send, and
// unknown topics always need a person. A person's reply always goes; an
// automatic one never on a spam or closed conversation, nor after a person
// stopped the last one. Pure.
import { SUPPORT_TOPIC_LABELS } from "../../shared/support-copy";
import {
  AUTO_SENDS_PER_HOUR,
  AUTO_SENDS_PER_INBOX_PER_HOUR,
  type ConversationStatus,
  type InboxConfig,
  type SupportActor,
  type SupportMessage,
  type TriageVerdict,
} from "../../shared/support";

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
  topicsPending: "The newest message's topics aren't checked yet",
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
  /** Every customer message the reply answers had its topics classified
   *  into triage.topics (routing.ts). */
  topicsChecked: boolean;
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
  if (
    inbox.autonomy !== "deploy-after-veto" &&
    inbox.autonomy !== "deploy-right-away"
  )
    return needsPerson(RULES.draftsWait);
  if (!triage || !Array.isArray(triage.topics))
    return needsPerson(RULES.topicsUnknown);
  if (!input.topicsChecked) return needsPerson(RULES.topicsPending);
  if (input.lastInboundTrust?.authFailed) return needsPerson(RULES.authFailed);
  if (input.lastInboundTrust?.replyToDiffers)
    return needsPerson(RULES.replyToDiffers);
  if (input.lastInboundTrust?.authVerified !== true)
    return needsPerson(RULES.authUnverified);
  const held = triage.topics.find((t) => inbox.neverWithoutAPerson.includes(t));
  if (held)
    return needsPerson(`${SUPPORT_TOPIC_LABELS[held] ?? held} needs a person`);
  if (input.autoSendsLastHour >= AUTO_SENDS_PER_HOUR)
    return needsPerson(RULES.autoSendCap);
  if (input.inboxAutoSendsLastHour >= AUTO_SENDS_PER_INBOX_PER_HOUR)
    return needsPerson(RULES.inboxAutoSendCap);
  if (inbox.autonomy === "deploy-after-veto")
    return {
      kind: "veto",
      deadline: new Date(input.now + inbox.vetoMs).toISOString(),
      rule: RULES.veto,
    };
  return { kind: "send", rule: RULES.agentSent };
}
