/**
 * Mail threads into question/answer pairs for the mailbox backfill. Our
 * reply is the answer; the question is the customer message it replies
 * to: its In-Reply-To when that is a customer message, else the nearest
 * customer message in its References. One pair per reply of ours, so two
 * replies to one question make two pairs; a reply with no customer
 * message above it (outreach, a thread whose start is outside the window)
 * or whose In-Reply-To is our own message (a follow-up) makes none, and a
 * customer message is never an answer. Message-IDs compare as normalizeMessageId writes them.
 * Automated mail is left out before this (mailbox.ts). Pure.
 */
import { normalizeMessageId } from "../../../shared/support";
import type { Party } from "./strip";

export interface MailRecord {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: Party;
  /** When it was sent (the folder's internal date), ISO 8601. */
  at: string;
  text: string;
  /** Read from the inbox's Sent folder, from one of this inbox's own
   *  addresses. */
  ours: boolean;
}

export interface QaPair {
  question: MailRecord;
  answer: MailRecord;
}

export function pairThreads(records: MailRecord[]): QaPair[] {
  // A message can sit in two folders; the first counts (mailbox.ts reads
  // Sent first, so our copy wins).
  const byId = new Map<string, MailRecord>();
  const order: Array<{ id: string; record: MailRecord }> = [];
  for (const record of records) {
    const id = normalizeMessageId(record.messageId);
    if (!id || byId.has(id)) continue;
    byId.set(id, record);
    order.push({ id, record });
  }

  const customer = (raw: string | null): MailRecord | null => {
    const id = normalizeMessageId(raw);
    const found = id ? byId.get(id) : undefined;
    return found && !found.ours ? found : null;
  };

  const pairs: QaPair[] = [];
  for (const { record } of order) {
    if (!record.ours) continue;
    // A reply to our own message follows up on what we said; the question
    // above it was answered by that message.
    const parentId = normalizeMessageId(record.inReplyTo);
    if (parentId && byId.get(parentId)?.ours) continue;
    let question = customer(record.inReplyTo);
    for (let i = record.references.length - 1; !question && i >= 0; i--)
      question = customer(record.references[i]!);
    if (question) pairs.push({ question, answer: record });
  }
  return pairs;
}
