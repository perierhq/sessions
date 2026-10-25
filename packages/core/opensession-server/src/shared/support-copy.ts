// User-facing copy for support inboxes, shared by the server (push wording)
// and the frontend (settings and the reply box). Sentence case, no em
// dashes. Push copy is fixed: no customer name, address, subject or text
// ever reaches a lock screen (the incidents rule).

import type { AutonomyLevel } from "./incident-response";
import type { BugHandling, MailboxBehaviour, SupportTopic } from "./support";

/** Support labels for the incident autonomy values; users never see the
 *  stored names. */
export const SUPPORT_AUTONOMY_COPY: Record<
  AutonomyLevel,
  { label: string; description: string }
> = {
  watch: {
    label: "Watch only",
    description: "Sort new mail. No agent, no drafts",
  },
  propose: { label: "Draft", description: "The agent drafts. A person sends" },
  "deploy-after-veto": {
    label: "Send after a veto window",
    description: "Sends when the window ends unless someone stops it",
  },
  "deploy-right-away": {
    label: "Send right away",
    description: "The agent sends its reply",
  },
};

export const SUPPORT_TOPIC_LABELS: Record<SupportTopic, string> = {
  refund: "Refunds",
  "account-deletion": "Account deletion",
  legal: "Legal",
  "angry-customer": "Angry customer",
};

export const MAILBOX_BEHAVIOUR_COPY: Record<MailboxBehaviour, string> = {
  untouched: "Leave untouched",
  "mark-read": "Mark read when handled",
  move: "Move to Sessions folders",
};

export const BUG_HANDLING_COPY: Record<BugHandling, string> = {
  off: "Off",
  issue: "Create an issue",
  "issue-and-agent": "Create an issue and suggest a fix",
};

export const SUPPORT_PUSH = {
  needsYouTitle: "A support reply is ready",
  needsYouBody: "Open Sessions to read it and send",
  vetoTitle: "A support reply will send",
  vetoBody: (clock: string) => `Sends at ${clock} unless you stop it`,
  failedTitle: "A support reply could not send",
  failedBody: "Open Sessions to see why",
  /** A row that waited on you, once the reply went out or was dropped. */
  sentTitle: "Reply sent",
  discardedTitle: "Reply discarded",
  settledBody: "Nothing waits on you",
  stop: "Stop",
  review: "Review",
} as const;
