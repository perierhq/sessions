// RFC 5322 threading: a message joins the conversation that holds the
// message it answers (`In-Reply-To`), else the newest one it references
// (`References`). Lookups stay inside one inbox, and there is no subject
// heuristic: mail without known keys starts a new conversation. A key left
// pointing at a deleted conversation is skipped.

import type { ThreadKeys } from "../../shared/support";
import { existingConversations, lookupMessageIds } from "./store";

/** References looked up per message: a long chain's newest entries are the
 *  ones that can name a live conversation, and the lookup stays bounded. */
const MAX_REFERENCES = 20;

/** In-Reply-To first, then the newest MAX_REFERENCES References newest
 *  first, deduped, own id excluded. */
export function threadCandidates(keys: ThreadKeys): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (keys.messageId) seen.add(keys.messageId);
  const references = keys.references.slice(-MAX_REFERENCES).reverse();
  for (const id of [keys.inReplyTo, ...references]) {
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
  const live = await existingConversations([...found.values()]);
  for (const id of candidates) {
    const conversationId = found.get(id);
    if (conversationId && live.has(conversationId)) return conversationId;
  }
  return null;
}
