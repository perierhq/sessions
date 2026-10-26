// User-facing copy for support inboxes, shared by the server (push wording)
// and the frontend (settings and the reply box). Sentence case, no em
// dashes. Push copy is fixed: no customer name, address, subject or text
// ever reaches a lock screen (the incidents rule).

import type {
  MailboxBehaviour,
  SupportAutonomy,
  SupportTopic,
} from "./support";

/** Labels and one-line explanations for the inbox autonomy values: the
 *  one source for the inbox form, the inbox list and server copy. Users
 *  never see the stored names. */
export const SUPPORT_AUTONOMY_COPY: Record<
  SupportAutonomy,
  { label: string; description: string }
> = {
  watch: {
    label: "Watch",
    description: "Sessions sorts new mail. No agent and no drafts",
  },
  draft: {
    label: "Draft",
    description: "The agent drafts every reply. Nothing sends until you do",
  },
  routine: {
    label: "Routine",
    description:
      "Repetitive replies backed by a source send on their own. Everything that needs judgement waits for you",
  },
};

export const SUPPORT_TOPIC_LABELS: Record<SupportTopic, string> = {
  refund: "Money and refunds",
  legal: "Legal",
  security: "Security",
  "data-export": "Data export",
  "data-deletion": "Data deletion",
  "account-deletion": "Account deletion",
};

export const MAILBOX_BEHAVIOUR_COPY: Record<MailboxBehaviour, string> = {
  untouched: "Leave untouched",
  "mark-read": "Mark read when handled",
  move: "Move to Sessions folders",
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
