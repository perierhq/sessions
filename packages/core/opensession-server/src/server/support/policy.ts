// Whether a support reply goes out, waits for a veto window or waits for a
// person: the incidents policy shape (response/policy.ts `evaluatePolicy`),
// ordered rules that each name the rule text the reply box shows. Sending
// is decided by who wrote the reply, the inbox's autonomy and the triage
// topics; the triage route ("simple" included) never permits a send, and
// unknown topics always need a person. Pure.
import { SUPPORT_TOPIC_LABELS } from "../../shared/support-copy";
import {
  AUTO_SENDS_PER_HOUR,
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
  draftsWait: "Drafts wait for a person",
  topicsUnknown: "Topics unknown, so a person decides",
  authFailed: "The sender could not be verified",
  replyToDiffers: "Replies would go to a different address than the sender",
  autoSendCap: `${AUTO_SENDS_PER_HOUR} automatic replies in the last hour`,
  veto: "Sends when the window ends unless someone stops it",
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
  autoSendsLastHour: number;
  now: number;
  /** Trust of the message the reply answers (mime.ts replyTarget). */
  lastInboundTrust: SupportMessage["trust"] | null;
}): ReplyDecision {
  const { author, inbox, triage } = input;
  if (author.kind === "person")
    return { kind: "send", rule: `Sent by ${author.name}` };
  if (!inbox.enabled) return needsPerson(RULES.inboxOff);
  if (
    inbox.autonomy !== "deploy-after-veto" &&
    inbox.autonomy !== "deploy-right-away"
  )
    return needsPerson(RULES.draftsWait);
  if (!triage || !Array.isArray(triage.topics))
    return needsPerson(RULES.topicsUnknown);
  if (input.lastInboundTrust?.authFailed) return needsPerson(RULES.authFailed);
  if (input.lastInboundTrust?.replyToDiffers)
    return needsPerson(RULES.replyToDiffers);
  const held = triage.topics.find((t) => inbox.neverWithoutAPerson.includes(t));
  if (held)
    return needsPerson(`${SUPPORT_TOPIC_LABELS[held] ?? held} needs a person`);
  if (input.autoSendsLastHour >= AUTO_SENDS_PER_HOUR)
    return needsPerson(RULES.autoSendCap);
  if (inbox.autonomy === "deploy-after-veto")
    return {
      kind: "veto",
      deadline: new Date(input.now + inbox.vetoMs).toISOString(),
      rule: RULES.veto,
    };
  return { kind: "send", rule: RULES.agentSent };
}
