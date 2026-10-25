// RFC 5322 threading: a message joins the conversation that holds the
// message it answers (`In-Reply-To`), else the newest one it references
// (`References`). Lookups stay inside one inbox, and there is no subject
// heuristic: mail without known keys starts a new conversation.

import type { ThreadKeys } from "../../shared/support";
import { lookupMessageIds } from "./store";

/** In-Reply-To first, then References newest first, deduped, own id excluded. */
export function threadCandidates(keys: ThreadKeys): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (keys.messageId) seen.add(keys.messageId);
  for (const id of [keys.inReplyTo, ...[...keys.references].reverse()]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The conversation a message belongs to, within one inbox only. */
export async function findConversation(
  inboxId: string,
  keys: ThreadKeys,
): Promise<string | null> {
  const candidates = threadCandidates(keys);
  if (!candidates.length) return null;
  const found = await lookupMessageIds(inboxId, candidates);
  for (const id of candidates) {
    const conversationId = found.get(id);
    if (conversationId) return conversationId;
  }
  return null;
}
