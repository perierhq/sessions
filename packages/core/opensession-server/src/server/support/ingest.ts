// Ingest: the InboundSink every support channel hands mail to. It dedupes
// (provider id, then Message-ID), threads (RFC 5322 keys within one inbox,
// and only for a sender already in the conversation), stores the message
// and its attachments, then publishes the CloudEvent and hands the message
// to the pipeline (triage, routing) in the background. The result resolves
// only after the message is durable, so a transport may advance its cursor.
//
// A pipeline hand-off that fails leaves its `triage:<conversationId>` key in
// the `support-pending` work index; the tick retries it with backoff. Nothing
// runs at import.
import { randomUUIDv7 } from "bun";
import {
  type AttachmentMeta,
  type InboundMessage,
  type InboxConfig,
  MAX_SOURCE_BYTES,
  MAX_TEXT_CHARS,
  type MailAddress,
  type SupportConversation,
  type SupportMessage,
  normalizeAddress,
} from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";
import { saveAttachment } from "./attachments";
import { publishSupportEvent, supportCloudEvent } from "./events";
import { getInbox } from "./inboxes";
import { isAutomatedMail } from "./loops";
import {
  createConversation,
  getConversation,
  lookupMessageIds,
  lookupProviderId,
  rememberMessageIds,
  updateConversation,
} from "./store";
import { findConversation } from "./threading";

export interface SupportPipeline {
  onInbound(
    conversation: SupportConversation,
    message: SupportMessage,
    isNew: boolean,
  ): Promise<void>;
}

const UNREADABLE_TEXT = "(This message couldn't be read)";
/** The first background hand-off owns the key this long before a tick may
 *  retry it. */
const FIRST_RETRY_MS = 60_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 900_000;

let pipeline: SupportPipeline | null = null;

/** C2 installs the real pipeline at boot; null removes it. */
export function setSupportPipeline(p: SupportPipeline | null): void {
  pipeline = p;
}

// Bound on first use, never at import: the catalog client is a live effect.
let pendingDocs: ReturnType<typeof catalogDocuments> | undefined;
const pendingIndex = () =>
  (pendingDocs ??= catalogDocuments("support-pending"));

interface PendingInbound {
  conversationId: string;
  /** SupportMessage.id of the newest message waiting for the pipeline. */
  messageId: string;
  /** True while any message it stands for started the conversation. */
  isNew: boolean;
  attempts: number;
  nextAttemptAt: number;
}

const pendingKey = (conversationId: string) => `triage:${conversationId}`;

function isPending(value: unknown): value is PendingInbound {
  const p = value as PendingInbound | null;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.conversationId === "string" &&
    typeof p.messageId === "string" &&
    typeof p.nextAttemptAt === "number"
  );
}

/** Hand-offs running in this process, by pending key. */
const inFlight = new Map<string, Promise<void>>();

/** Settles every background hand-off (tests). */
export async function __awaitInboundForTest(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight.values()]);
}

const sameAddress = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** replyToDiffers: a reply would go somewhere the sender didn't write
 *  from: more than one Reply-To, or one that isn't the From address. */
function trustOf(m: InboundMessage): SupportMessage["trust"] {
  const replyToDiffers =
    m.replyTo.length > 1 ||
    m.replyTo.some((r) => !sameAddress(r.address, m.from.address));
  const results = (m.loopHeaders["authentication-results"] ?? "").toLowerCase();
  const failed = (method: string) =>
    new RegExp(`(^|[\\s;])${method}\\s*=\\s*fail\\b`).test(results);
  const authFailed = failed("dmarc") || (failed("spf") && failed("dkim"));
  return { replyToDiffers, authFailed };
}

/** Our own sending addresses besides the inbox address. */
function ownAddresses(inbox: InboxConfig): string[] {
  return [inbox.address, inbox.smtp.user, inbox.imap.user].filter((a) =>
    a.includes("@"),
  );
}

/** A known Message-ID is a duplicate when the message stored under it came
 *  from the same sender (another copy of the same mail, or our own sent
 *  mail coming back). From another sender it is a reused id: new mail. */
async function isDuplicateMessageId(
  inbox: InboxConfig,
  messageId: string,
  from: string,
): Promise<boolean> {
  const known = (await lookupMessageIds(inbox.id, [messageId])).get(messageId);
  if (!known) return false;
  const c = await getConversation(known);
  if (!c) return false;
  const stored = c.messages.find((x) => x.keys.messageId === messageId);
  if (stored) return sameAddress(stored.from.address, from);
  if (c.draft?.messageId === messageId) return sameAddress(inbox.address, from);
  // Remembered but no longer (or not yet) in the document: our outbound id
  // or a message trimmed out. Keep it out rather than import it twice.
  return true;
}

/** The thread only takes mail from someone already in it. */
function isParticipant(c: SupportConversation, address: string): boolean {
  if (sameAddress(c.customer.address, address)) return true;
  return c.messages.some((x) =>
    [x.from, ...x.to, ...x.cc].some((a) => sameAddress(a.address, address)),
  );
}

function textOf(m: InboundMessage): string {
  if (m.unreadable) return UNREADABLE_TEXT;
  if (m.oversize)
    return `[Message too large to import: over ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} MB]`;
  return m.text.slice(0, MAX_TEXT_CHARS);
}

/** Attachment meta without bytes, with ids unique across the conversation's
 *  directory (`[A-Za-z0-9_-]`, the attachments store's rule). */
function attachmentMetas(
  m: InboundMessage,
): Array<{ meta: AttachmentMeta; content?: Uint8Array }> {
  return m.attachments.map(({ content, ...meta }) => ({
    meta: {
      ...meta,
      id: `att_${randomUUIDv7()}`,
      sizeBytes: content?.byteLength ?? meta.sizeBytes,
      stored: false,
      expiresAt: null,
    },
    content,
  }));
}

/** Saves bytes up to MAX_SOURCE_BYTES in total; the rest keep name and size
 *  only. A failed write is logged and leaves that attachment unstored. */
async function saveAttachments(
  conversationId: string,
  items: Array<{ meta: AttachmentMeta; content?: Uint8Array }>,
  inbox: InboxConfig,
): Promise<AttachmentMeta[]> {
  let budget = MAX_SOURCE_BYTES;
  const out: AttachmentMeta[] = [];
  for (const { meta, content } of items) {
    if (!content || content.byteLength > budget) {
      out.push(meta);
      continue;
    }
    try {
      out.push(
        await saveAttachment(
          conversationId,
          meta,
          content,
          inbox.retention,
          Date.now(),
        ),
      );
      budget -= content.byteLength;
    } catch (error) {
      console.warn(
        `[support] attachment for ${conversationId} not saved:`,
        error instanceof Error ? error.message : error,
      );
      out.push(meta);
    }
  }
  return out;
}

function withAttachments(
  c: SupportConversation,
  messageId: string,
  attachments: AttachmentMeta[],
): SupportConversation {
  return {
    ...c,
    messages: c.messages.map((x) =>
      x.id === messageId ? { ...x, attachments } : x,
    ),
  };
}

function appendMessage(
  c: SupportConversation,
  message: SupportMessage,
): SupportConversation {
  const next: SupportConversation = {
    ...c,
    messages: [...c.messages, message],
    lastMessageAt: message.at > c.lastMessageAt ? message.at : c.lastMessageAt,
  };
  // Machine mail never reopens a conversation.
  if (message.automated) return next;
  if (c.status === "waiting") next.status = "open";
  else if (c.status === "closed") {
    next.status = "open";
    next.closedAt = null;
    next.events = [
      ...c.events,
      {
        at: message.at,
        kind: "reopened",
        actor: { kind: "customer" },
        detail: "Customer wrote after close",
      },
    ];
  }
  return next;
}

export async function ingestInbound(
  m: InboundMessage,
): Promise<"stored" | "duplicate" | "ignored"> {
  const inbox = await getInbox(m.inboxId);
  if (!inbox || !inbox.enabled) return "ignored";

  if (await lookupProviderId(inbox.id, m.providerId)) return "duplicate";
  const ownId = m.keys.messageId;
  if (ownId && (await isDuplicateMessageId(inbox, ownId, m.from.address)))
    return "duplicate";

  const automated = isAutomatedMail(m, ownAddresses(inbox), inbox.address);
  const from: MailAddress = normalizeAddress(m.from) ?? {
    name: m.from.name,
    address: "",
  };

  let threadId = await findConversation(inbox.id, m.keys);
  let thread = threadId ? await getConversation(threadId) : null;
  if (thread && !isParticipant(thread, from.address)) thread = null;
  threadId = thread?.id ?? null;

  const attachments = attachmentMetas(m);
  const message: SupportMessage = {
    id: `sm_${randomUUIDv7()}`,
    direction: "in",
    at: m.receivedAt,
    from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    text: textOf(m),
    keys: m.keys,
    providerId: m.providerId,
    attachments: attachments.map((a) => a.meta),
    trust: trustOf(m),
  };
  if (automated.automated) message.automated = true;
  const replyTo = m.replyTo.flatMap((a) => normalizeAddress(a) ?? []);
  if (replyTo.length) message.replyTo = replyTo;

  let conversation: SupportConversation | null = null;
  let isNew = false;
  if (threadId) {
    // Bytes first: the append then records them as stored.
    const saved = await saveAttachments(threadId, attachments, inbox);
    conversation = await updateConversation(threadId, (c) =>
      appendMessage(c, { ...message, attachments: saved }),
    );
  }
  if (!conversation) {
    isNew = true;
    conversation = await createConversation({
      channel: m.channel,
      inboxId: inbox.id,
      project: inbox.project,
      subject: m.subject,
      customer: from,
      owner: null,
      first: message,
      now: new Date().toISOString(),
    });
    if (attachments.length) {
      const saved = await saveAttachments(conversation.id, attachments, inbox);
      conversation =
        (await updateConversation(conversation.id, (c) =>
          withAttachments(c, message.id, saved),
        )) ?? conversation;
    }
  }
  const stored =
    conversation.messages.find((x) => x.id === message.id) ?? message;

  await rememberMessageIds(inbox.id, conversation.id, ownId ? [ownId] : [], [
    m.providerId,
  ]);

  if (message.automated) return "stored";

  await markPending(conversation.id, message.id, isNew);
  try {
    await publishSupportEvent(
      supportCloudEvent(conversation, stored, isNew, new Date().toISOString()),
    );
  } catch (error) {
    console.warn(
      `[support] event for ${conversation.id} not published:`,
      error instanceof Error ? error.message : error,
    );
  }
  handOff(conversation, stored, isNew);
  return "stored";
}

async function markPending(
  conversationId: string,
  messageId: string,
  isNew: boolean,
): Promise<void> {
  await pendingIndex().update<PendingInbound>(
    pendingKey(conversationId),
    (value) => ({
      conversationId,
      messageId,
      isNew: isNew || (isPending(value) && value.isNew),
      attempts: isPending(value) ? value.attempts : 0,
      nextAttemptAt: Date.now() + FIRST_RETRY_MS,
    }),
  );
}

/** Runs the pipeline for one pending key; never rejects. On success the key
 *  goes, unless a newer message replaced it meanwhile. On failure it is
 *  pushed back with backoff. */
function handOff(
  conversation: SupportConversation,
  message: SupportMessage,
  isNew: boolean,
  /** The pending entry's message id, when it differs from `message`. */
  pendingMessageId = message.id,
): Promise<void> {
  const key = pendingKey(conversation.id);
  const previous = inFlight.get(key);
  const run = (async () => {
    // One hand-off per conversation at a time, in arrival order.
    if (previous) await previous;
    const p = pipeline;
    if (!p) return;
    let ok = false;
    try {
      await p.onInbound(conversation, message, isNew);
      ok = true;
    } catch (error) {
      console.warn(
        `[support] pipeline failed for ${conversation.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
    await settlePending(key, pendingMessageId, ok).catch((error: unknown) =>
      console.warn(
        `[support] pending key ${key} not settled:`,
        error instanceof Error ? error.message : error,
      ),
    );
  })();
  inFlight.set(key, run);
  void run.finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  return run;
}

async function settlePending(
  key: string,
  messageId: string,
  ok: boolean,
): Promise<void> {
  await pendingIndex().update<PendingInbound>(key, (value) => {
    // Gone or malformed: nothing to keep.
    if (!isPending(value)) return null;
    // A newer message took the key over; it settles itself.
    if (value.messageId !== messageId) return value;
    if (ok) return null;
    const attempts = value.attempts + 1;
    return {
      ...value,
      attempts,
      nextAttemptAt:
        Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (attempts - 1)),
    };
  });
}

/** Retries due pipeline hand-offs; resolves to how many it ran. Keys whose
 *  conversation is gone are dropped. With no pipeline installed the keys
 *  wait. Called by the support tick. */
export async function retryPendingInbound(now: number): Promise<number> {
  if (!pipeline) return 0;
  let ran = 0;
  for (const { key, value } of await pendingIndex().list()) {
    if (!key.startsWith("triage:") || inFlight.has(key)) continue;
    if (!isPending(value)) {
      await pendingIndex().delete(key);
      continue;
    }
    if (value.nextAttemptAt > now) continue;
    const conversation = await getConversation(value.conversationId);
    const message =
      conversation?.messages.find((x) => x.id === value.messageId) ??
      conversation?.messages.findLast(
        (x) => x.direction === "in" && !x.automated,
      );
    if (!conversation || !message) {
      await pendingIndex().delete(key);
      continue;
    }
    ran += 1;
    await handOff(conversation, message, value.isNew, value.messageId);
  }
  return ran;
}
