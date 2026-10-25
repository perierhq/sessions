import type {
  ForgetCustomerResult,
  InboxPatch,
  InboxTestBody,
  InboxTestResult,
  InboxView,
  InboxesResponse,
  NewInboxInput,
  SupportChannelKind,
  SupportConversationView,
  SupportListItem,
} from "../../../shared/support";
import { request } from "./request";

export interface SupportItems {
  items: SupportListItem[];
  channels: Array<{
    channel: SupportChannelKind;
    label: string;
    error: string | null;
  }>;
  /** Email had more open conversations than the list carries. */
  truncated: boolean;
}

/** The Support list across channels (email conversations and Plain's queue). */
export async function fetchSupportItems(): Promise<SupportItems> {
  const body = await request<SupportItems | null>("/support/conversations", {
    label: "Failed to load the support list",
  });
  return {
    items: body?.items ?? [],
    channels: body?.channels ?? [],
    truncated: body?.truncated ?? false,
  };
}

/** One email conversation, by conversation id or list item id. */
export function fetchSupportConversation(
  id: string,
): Promise<SupportConversationView> {
  return request<SupportConversationView>(
    `/support/conversations/${encodeURIComponent(id)}`,
    { label: "Failed to load the conversation" },
  );
}

// ── Inboxes (Settings → Inboxes) ────────────────────────────────────────

/** The inboxes, whether email support is on, and the projects to pick. */
export function fetchInboxes(): Promise<InboxesResponse> {
  return request<InboxesResponse>("/support/inboxes", {
    label: "Failed to load the inboxes",
  });
}

export function createInbox(
  input: NewInboxInput,
): Promise<{ inbox: InboxView }> {
  return request<{ inbox: InboxView }>("/support/inboxes", {
    method: "POST",
    body: input,
    label: "Couldn't connect the inbox",
  });
}

export function patchInbox(
  id: string,
  patch: InboxPatch,
): Promise<{ inbox: InboxView }> {
  return request<{ inbox: InboxView }>(
    `/support/inboxes/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch, label: "Couldn't save the inbox" },
  );
}

export function deleteInbox(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/support/inboxes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Couldn't remove the inbox",
  });
}

/** One login to each server; never stores anything. */
export function testInbox(body: InboxTestBody): Promise<InboxTestResult> {
  return request<InboxTestResult>("/support/inboxes/test", {
    method: "POST",
    body,
    label: "Couldn't test the connection",
  });
}

/** Deletes everything Sessions holds for this customer (instance owner). */
export function forgetCustomer(email: string): Promise<ForgetCustomerResult> {
  return request<ForgetCustomerResult>("/support/customers/forget", {
    method: "POST",
    body: { email },
    label: "Couldn't forget this customer",
  });
}

// ── One email conversation: replies and actions (D4) ───────────────────
// Each answers with the conversation as fetchSupportConversation does. A
// 409 means someone else changed it first (another person, the tick).

/** What the conversation routes read from a body. */
interface ConversationActionBody {
  text?: string;
  project?: string;
  reason?: string;
  owner?: string;
  task?: string;
  expectedRevision?: number;
}

function conversationAction(
  id: string,
  action: string,
  label: string,
  body: ConversationActionBody = {},
): Promise<SupportConversationView> {
  return request<SupportConversationView>(
    `/support/conversations/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body, label },
  );
}

const draftPath = (draftId: string, action: string) =>
  `drafts/${encodeURIComponent(draftId)}/${action}`;

/** A person's own reply, sent now. */
export function replyToConversation(
  id: string,
  text: string,
): Promise<SupportConversationView> {
  return conversationAction(id, "reply", "Couldn't send the reply", { text });
}

/** Sends a draft, as edited when `edit` is given. */
export function sendDraft(
  id: string,
  draftId: string,
  edit?: { text: string },
): Promise<SupportConversationView> {
  return conversationAction(
    id,
    draftPath(draftId, "send"),
    "Couldn't send the reply",
    edit ? { text: edit.text } : {},
  );
}

export function discardDraft(
  id: string,
  draftId: string,
): Promise<SupportConversationView> {
  return conversationAction(
    id,
    draftPath(draftId, "discard"),
    "Couldn't discard the draft",
  );
}

/** Ends a veto window: the draft waits for a person. */
export function stopVeto(
  id: string,
  draftId: string,
): Promise<SupportConversationView> {
  return conversationAction(
    id,
    draftPath(draftId, "stop"),
    "Couldn't stop the reply",
  );
}

export function moveConversation(
  id: string,
  project: string,
  reason: string,
): Promise<SupportConversationView> {
  return conversationAction(id, "move", "Couldn't move the conversation", {
    project,
    reason,
  });
}

export function setConversationOwner(
  id: string,
  owner: string,
): Promise<SupportConversationView> {
  return conversationAction(id, "owner", "Couldn't change the owner", {
    owner,
  });
}

export function closeConversation(
  id: string,
): Promise<SupportConversationView> {
  return conversationAction(id, "close", "Couldn't mark it as done");
}

export function reopenConversation(
  id: string,
): Promise<SupportConversationView> {
  return conversationAction(id, "reopen", "Couldn't reopen the conversation");
}

export function markNotSpam(id: string): Promise<SupportConversationView> {
  return conversationAction(id, "not-spam", "Couldn't mark it as not spam");
}

/** Creates the issue the agent reported and a person was asked to approve.
 *  `expectedRevision`: the conversation revision the person saw (409 when
 *  it changed since). */
export function approveIssue(
  id: string,
  expectedRevision: number,
): Promise<SupportConversationView> {
  return conversationAction(id, "issue/approve", "Couldn't create the issue", {
    expectedRevision,
  });
}

/** Starts a fix session from the agent's suggested task, as edited. */
export function startFixSession(
  id: string,
  expectedRevision: number,
  task: string,
): Promise<SupportConversationView> {
  return conversationAction(id, "fix", "Couldn't start the fix session", {
    expectedRevision,
    task,
  });
}

export function dismissIssue(id: string): Promise<SupportConversationView> {
  return conversationAction(id, "issue/dismiss", "Couldn't dismiss the issue");
}
