// /api/support/*: the Support list across channels, one email conversation
// and its attachment downloads. Email is for signed-in people only
// (`verifiedPerson`): without one the list still carries Plain's queue and
// says to sign in for mail, and a conversation or attachment answers 401.
// Later tasks add their routes in their own blocks below.
import {
  type SupportConversationView,
  parseSupportItemId,
} from "../../shared/support";
import { openAttachment } from "../support/attachments";
import { getInbox } from "../support/inboxes";
import { listSupportItems, SIGN_IN_FOR_MAIL } from "../support/list";
import { getConversation } from "../support/store";
import { type RouteContext, verifiedPerson } from "./context";

const PREFIX = "/api/support/";

/** Image types shown inline elsewhere keep their type; everything else is
 *  served as opaque bytes so a customer's HTML or SVG never renders here. */
const SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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
function conversationId(raw: string): string {
  const item = parseSupportItemId(raw);
  return item?.channel === "email" ? item.id : raw;
}

/** RFC 6266 filename with an ASCII fallback and the UTF-8 form. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function handleSupportRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (!path.startsWith(PREFIX) || req.method !== "GET") return undefined;
  const parts = path.slice(PREFIX.length).split("/");
  if (parts[0] !== "conversations" || parts.length > 4 || parts.length === 3)
    return undefined;
  if (parts.length === 4 && parts[2] !== "attachments") return undefined;
  const person = verifiedPerson(ctx) || null;

  // ── List (D3) ──
  if (parts.length === 1)
    return Response.json(await listSupportItems({ person }));

  if (!person) return json(401, SIGN_IN_FOR_MAIL);

  const ref = segment(parts[1]!);
  if (ref === null) return json(400, "Invalid path");
  const conversation = await getConversation(conversationId(ref));
  if (!conversation) return json(404, "Conversation not found");

  // ── One conversation (D3) ──
  if (parts.length === 2) {
    const inbox = await getInbox(conversation.inboxId);
    const view: SupportConversationView = {
      conversation,
      inbox: inbox && {
        id: inbox.id,
        label: inbox.label,
        address: inbox.address,
        autonomy: inbox.autonomy,
        vetoMs: inbox.vetoMs,
      },
    };
    return Response.json(view);
  }

  // ── Attachment download (D3) ──
  const attachmentId = segment(parts[3]!);
  if (attachmentId === null) return json(400, "Invalid path");
  const meta = conversation.messages
    .flatMap((m) => m.attachments)
    .find((a) => a.id === attachmentId);
  if (!meta) return json(404, "Attachment not found");
  const expired =
    !meta.stored ||
    (meta.expiresAt !== null && Date.parse(meta.expiresAt) <= Date.now());
  const file = expired
    ? null
    : await openAttachment(conversation.id, attachmentId).catch(() => null);
  if (!file) return json(410, "This attachment is no longer kept");
  const type = meta.mimeType.trim().toLowerCase();
  return new Response(file, {
    headers: {
      "Content-Type": SAFE_IMAGE_TYPES.has(type)
        ? type
        : "application/octet-stream",
      "Content-Disposition": contentDisposition(meta.fileName),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
