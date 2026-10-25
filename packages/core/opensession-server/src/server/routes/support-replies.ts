// /api/support/conversations/:id/{reply,drafts/:draftId/{send,discard,stop}}:
// a person replies, sends (optionally edited), discards a draft or stops a
// veto window. Signed-in people only (`verifiedPerson`): the automation
// principal and claimed names are never a person here. Everything goes
// through the one reply path (support/reply.ts); each answers with the
// conversation as GET /api/support/conversations/:id does.
import {
  type SupportActor,
  type SupportConversationView,
  parseSupportItemId,
} from "../../shared/support";
import { getInbox } from "../support/inboxes";
import {
  discardDraft,
  replyAsPerson,
  sendDraft,
  stopVeto,
} from "../support/reply";
import { getConversation } from "../support/store";
import { type RouteContext, verifiedPerson } from "./context";

const PREFIX = "/api/support/conversations/";
const SIGN_IN = "Sign in to reply to support mail";

const json = (status: number, error: string) =>
  Response.json({ error }, { status });

function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A conversation id, also accepted as its list item id (`email:sc_…`). */
export function conversationId(raw: string): string {
  const item = parseSupportItemId(raw);
  return item?.channel === "email" ? item.id : raw;
}

/** Ids as the store makes them; anything else is not found. */
export const CONVERSATION_ID = /^sc_[0-9a-f-]{1,64}$/;
const DRAFT_ID = /^sd_[0-9a-f-]{1,64}$/;

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The same shape GET /api/support/conversations/:id answers with. */
export async function conversationViewResponse(id: string): Promise<Response> {
  const conversation = await getConversation(id);
  if (!conversation) return json(404, "Conversation not found");
  const inbox = await getInbox(conversation.inboxId);
  const body: SupportConversationView = {
    conversation,
    inbox: inbox && {
      id: inbox.id,
      label: inbox.label,
      address: inbox.address,
      autonomy: inbox.autonomy,
      moveLock: inbox.moveLock,
      bugHandling: inbox.bugHandling,
    },
  };
  return Response.json(body);
}

export async function handleSupportReplyRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (req.method !== "POST" || !path.startsWith(PREFIX)) return undefined;
  const parts = path.slice(PREFIX.length).split("/");
  const isReply = parts.length === 2 && parts[1] === "reply";
  const action = parts.length === 4 && parts[1] === "drafts" ? parts[3] : null;
  if (
    !isReply &&
    action !== "send" &&
    action !== "discard" &&
    action !== "stop"
  )
    return undefined;

  const person = verifiedPerson(ctx);
  if (!person) return json(401, SIGN_IN);
  const ref = segment(parts[0]!);
  const draftId = action ? segment(parts[2]!) : "";
  if (ref === null || draftId === null) return json(400, "Invalid path");
  const id = conversationId(ref);
  if (!CONVERSATION_ID.test(id)) return json(404, "Conversation not found");
  if (action && !DRAFT_ID.test(draftId)) return json(404, "Draft not found");
  // The display name for rules; the signed-in login for the audit.
  const login = ctx.authUser?.login ?? "";
  const by: SupportActor = {
    kind: "person",
    name: person,
    ...(login ? { login } : {}),
  };
  const body = await readBody(req);

  let result: { ok: true } | { ok: false; status: number; error: string };
  if (isReply) {
    if (typeof body.text !== "string") return json(400, "Write a reply first");
    result = await replyAsPerson(id, body.text, { name: person, login });
  } else if (action === "send") {
    if (body.text !== undefined && typeof body.text !== "string")
      return json(400, "The reply text must be text");
    result = await sendDraft(
      id,
      draftId,
      by,
      typeof body.text === "string" ? { text: body.text } : undefined,
    );
  } else if (action === "discard") {
    result = await discardDraft(id, draftId, by);
  } else {
    result = await stopVeto(id, draftId, by);
  }
  if (!result.ok) return json(result.status, result.error);
  return conversationViewResponse(id);
}
