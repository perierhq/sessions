// Email conversations for the Support pane's tests: one customer message,
// no draft, and overrides for everything else. example.test addresses only.
import type {
  DraftState,
  SupportConversation,
  SupportDraft,
  SupportMessage,
} from "../../shared/support";

export const AT = "2026-10-25T10:00:00.000Z";

export function message(over: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: "sm_1",
    direction: "in",
    at: AT,
    from: { name: "Grace", address: "grace@example.test" },
    to: [{ name: null, address: "help@acme.example.test" }],
    cc: [],
    subject: "Login broken",
    text: "I can't sign in",
    keys: { messageId: "a@example.test", inReplyTo: null, references: [] },
    providerId: "imap:1:1",
    attachments: [],
    ...over,
  };
}

export function draft(
  state: DraftState,
  over: Partial<SupportDraft> = {},
): SupportDraft {
  return {
    id: "sd_1",
    text: "Try resetting your password",
    author: { kind: "agent", sessionId: "s1" },
    createdAt: AT,
    state,
    rule: "Draft: a person sends",
    vetoDeadline: state === "veto" ? "2026-10-25T10:15:00.000Z" : null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: state === "failed" ? "The mail server refused the reply" : null,
    messageId: "out@acme.example.test",
    decidedBy: null,
    ...over,
  };
}

export function conversation(
  over: Partial<SupportConversation> = {},
): SupportConversation {
  return {
    id: "sc_0001",
    channel: "email",
    inboxId: "inb_0001",
    project: "acme",
    subject: "Login broken",
    customer: { name: "Grace", address: "grace@example.test" },
    status: "open",
    owner: null,
    createdAt: AT,
    lastMessageAt: AT,
    closedAt: null,
    triage: null,
    sessionId: null,
    fixSessionId: null,
    messages: [message({})],
    draft: null,
    autoSends: [],
    moves: [],
    issue: null,
    pendingIssue: null,
    events: [],
    revision: 1,
    ...over,
  };
}
