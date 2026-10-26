// Ingest: the InboundSink every support channel hands mail to. It dedupes
// (provider id, a sender-qualified Message-ID or a fallback key for mail
// without one, then the bare Message-ID), threads (RFC 5322 keys within one
// inbox, and only for a sender already in the conversation), stores the
// message and its attachments, then hands the message to the pipeline
// (triage, routing) in the background. The result resolves only after the
// message is durable, so a transport may advance its cursor.
//
// Write order, so a crash at any point is repaired by the transport offering
// the message again: a new conversation remembers its ids under a generated
// id first, then writes its pending key, then the document; a reply is
// appended first (deduped inside the update), then its pending key, then its
// ids. A re-offer that finds the message already in the document repairs the
// ids and the pending key and resolves "duplicate".
//
// The CloudEvent is published after the pipeline (triage) settled, and only
// when the conversation is not spam: once per hand-off that succeeded.
//
// A pipeline hand-off that fails leaves its `triage:<conversationId>` key in
// the `support-pending` work index; the tick retries it with backoff, at most
// MAX_ATTEMPTS times. Nothing runs at import.
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
  ownMailAddresses,
} from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";
import { deleteAttachmentFile, saveAttachment } from "./attachments";
import { publishSupportEvent, supportCloudEvent } from "./events";
import { getInbox } from "./inboxes";
import { isAutomatedMail } from "./loops";
import {
  createConversation,
  getConversation,
  newConversationId,
  lookupMessageIds,
  lookupProviderId,
  rememberMessageIds,
  updateConversation,
} from "./store";
import { findConversation, threadCandidates } from "./threading";

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
/** Pipeline runs per pending key, the first included, before Sessions gives
 *  up and leaves the conversation to a person. */
const MAX_ATTEMPTS = 8;
/** Pending keys one tick starts at most. */
const RETRY_BATCH = 10;
/** A pipeline run longer than this counts as failed (B2's sink limit). */
const PIPELINE_TIMEOUT_MS = 120_000;
let pipelineTimeoutMs = PIPELINE_TIMEOUT_MS;

/** Shorten the pipeline time limit (tests); undefined restores it. */
export function __setPipelineTimeoutForTest(ms: number | undefined): void {
  pipelineTimeoutMs = ms ?? PIPELINE_TIMEOUT_MS;
}

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

/** What a log line may say about an error: its code or name, never a
 *  message that could quote mail. */
function errorLabel(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" || typeof code === "number"
      ? `${error.name} ${code}`
      : error.name;
  }
  return typeof error;
}

const sameAddress = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const domainOf = (address: string) =>
  address
    .slice(address.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();

/** Relaxed alignment (RFC 7489 3.1), approximated without a public-suffix
 *  list: the same domain, or one a subdomain of the other. */
function aligned(domain: string, fromDomain: string): boolean {
  if (!domain.includes(".") || !fromDomain) return false;
  return (
    domain === fromDomain ||
    fromDomain.endsWith(`.${domain}`) ||
    domain.endsWith(`.${fromDomain}`)
  );
}

/** Whether the receiving server's Authentication-Results (RFC 8601) show
 *  positive authentication for `fromAddress`: dmarc=pass (for the From
 *  domain when it names one), or dkim=pass / spf=pass for a domain aligned
 *  with it. Only the topmost header counts, the one the receiving server
 *  added (`results` holds the headers in order, one per line); lower ones
 *  may come from the sender. Comments are ignored. Missing = false. */
export function mailAuthVerified(
  results: string,
  fromAddress: string,
): boolean {
  const top = (results.split("\n")[0] ?? "")
    .replace(/\([^()]*\)/g, " ")
    .toLowerCase();
  const from = domainOf(fromAddress);
  // The first item is the server's id; each other one is
  // `method=result prop=value ...`.
  for (const item of top.split(";").slice(1)) {
    const words = item.trim().split(/\s+/);
    const [method, result] = (words[0] ?? "").split("=");
    if (result !== "pass") continue;
    const props = new Map<string, string>();
    for (const w of words.slice(1)) {
      const at = w.indexOf("=");
      if (at > 0) props.set(w.slice(0, at), w.slice(at + 1));
    }
    if (method === "dmarc") {
      const header = props.get("header.from");
      if (!header || aligned(domainOf(header), from)) return true;
    } else if (method === "dkim") {
      const d = props.get("header.d") ?? props.get("header.i");
      if (d && aligned(domainOf(d), from)) return true;
    } else if (method === "spf") {
      const d = props.get("smtp.mailfrom") ?? props.get("smtp.helo");
      if (d && aligned(domainOf(d), from)) return true;
    }
  }
  return false;
}

/** replyToDiffers: a reply would go somewhere the sender didn't write
 *  from: more than one Reply-To, or one that isn't the From address.
 *  authVerified: see mailAuthVerified. */
function trustOf(m: InboundMessage): NonNullable<SupportMessage["trust"]> {
  const replyToDiffers =
    m.replyTo.length > 1 ||
    m.replyTo.some((r) => !sameAddress(r.address, m.from.address));
  const header = m.loopHeaders["authentication-results"] ?? "";
  const results = header.toLowerCase();
  const failed = (method: string) =>
    new RegExp(`(^|[\\s;])${method}\\s*=\\s*fail\\b`).test(results);
  const authFailed = failed("dmarc") || (failed("spf") && failed("dkim"));
  const authVerified = !authFailed && mailAuthVerified(header, m.from.address);
  return { replyToDiffers, authFailed, authVerified };
}

/** Our own sending addresses: the inbox address and its logins. */
const ownAddresses = (inbox: InboxConfig): string[] => ownMailAddresses(inbox);

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
        errorLabel(error),
      );
      out.push(meta);
    }
  }
  return out;
}

/** Removes files saved for a message that was not recorded after all. */
async function discardSaved(
  conversationId: string,
  saved: AttachmentMeta[],
): Promise<void> {
  for (const a of saved)
    if (a.stored)
      await deleteAttachmentFile(conversationId, a.id).catch((error: unknown) =>
        console.warn(
          `[support] attachment ${a.id} not removed:`,
          errorLabel(error),
        ),
      );
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
  // Machine mail and our own side never reopen a conversation.
  if (message.automated || message.direction === "out") return next;
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

/** The ids a message is deduped by besides its provider id. With a
 *  Message-ID: the id, and the id qualified by its sender (the key a reused
 *  id from another sender is told apart by). Without one: a key from what
 *  every copy of the same mail keeps (sender, date, subject and size). */
function dedupeIds(
  m: InboundMessage,
  from: string,
): { qualified: string; all: string[] } {
  const id = m.keys.messageId;
  if (id) {
    const qualified = `${id}\0${from}`;
    return { qualified, all: [id, qualified] };
  }
  const size =
    m.text.length +
    m.attachments.reduce(
      (n, a) => n + (a.content?.byteLength ?? a.sizeBytes),
      0,
    );
  const qualified = [
    "\0no-message-id",
    from,
    m.receivedAt,
    m.subject,
    String(size),
  ].join("\0");
  return { qualified, all: [qualified] };
}

/** The same mail already in a conversation: same provider id, or the same
 *  Message-ID from the same sender. */
function sameMessage(x: SupportMessage, m: SupportMessage): boolean {
  if (x.providerId !== null && x.providerId === m.providerId) return true;
  return (
    m.keys.messageId !== null &&
    x.keys.messageId === m.keys.messageId &&
    sameAddress(x.from.address, m.from.address)
  );
}

/** The team member (roster email or Linear email) an address belongs to, by
 *  first name, or null. */
async function staffName(address: string): Promise<string | null> {
  if (!address.includes("@")) return null;
  // Lazy: user-mappings reads the configured roster at import.
  const { isTrustedUser, teammatesNamed } =
    await import("../shared/user-mappings");
  if (!isTrustedUser(address)) return null;
  const [member] = teammatesNamed(address);
  return member?.name.trim().split(/\s+/)[0] || address;
}

/** Whether these keys answer mail we sent in `c` (a bounce of our reply). */
function answersOurs(
  c: SupportConversation,
  keys: InboundMessage["keys"],
): boolean {
  const ids = new Set(threadCandidates(keys));
  if (c.draft && ids.has(c.draft.messageId)) return true;
  return c.messages.some(
    (x) =>
      x.direction === "out" &&
      x.keys.messageId !== null &&
      ids.has(x.keys.messageId),
  );
}

type ConversationEvent = SupportConversation["events"][number];

interface Offer {
  inbox: InboxConfig;
  providerId: string;
  message: SupportMessage;
  attachments: Array<{ meta: AttachmentMeta; content?: Uint8Array }>;
  ids: string[];
  /** Customer mail the pipeline should see (not ours, machine or unread). */
  handsOff: boolean;
  events: ConversationEvent[];
}

export async function ingestInbound(
  m: InboundMessage,
): Promise<"stored" | "duplicate" | "ignored"> {
  const inbox = await getInbox(m.inboxId);
  if (!inbox || !inbox.enabled) return "ignored";

  const from: MailAddress = normalizeAddress(m.from) ?? {
    name: m.from.name,
    address: "",
  };
  const ids = dedupeIds(m, from.address);

  // A key pointing at a conversation that does not exist is the crash
  // between remembering a new conversation's ids and creating it: the
  // conversation is created under that id now.
  let reuseId: string | null = null;
  const byProvider = await lookupProviderId(inbox.id, m.providerId);
  if (byProvider) {
    const c = await getConversation(byProvider);
    if (c?.messages.some((x) => x.providerId === m.providerId))
      return "duplicate";
    if (!c) reuseId = byProvider;
  }
  const byQualified = (await lookupMessageIds(inbox.id, [ids.qualified])).get(
    ids.qualified,
  );
  if (byQualified) {
    if (await getConversation(byQualified)) return "duplicate";
    reuseId ??= byQualified;
  }
  const ownId = m.keys.messageId;
  if (ownId && (await isDuplicateMessageId(inbox, ownId, from.address)))
    return "duplicate";

  const trust = trustOf(m);
  const automated = isAutomatedMail(
    m,
    ownAddresses(inbox),
    inbox.address,
  ).automated;
  // Our side: the inbox's own addresses and the team's. A sender that fails
  // authentication is not trusted to be either and stays customer mail.
  const own =
    !trust.authFailed &&
    ownAddresses(inbox).some((a) => sameAddress(a, from.address));
  const staff = own || trust.authFailed ? null : await staffName(from.address);
  const ours = own || staff !== null;

  const threadId = await findConversation(inbox.id, m.keys);
  let thread = threadId ? await getConversation(threadId) : null;
  if (
    thread &&
    !ours &&
    !isParticipant(thread, from.address) &&
    !(automated && answersOurs(thread, m.keys))
  )
    thread = null;
  // Our own mail that answers nothing here is not a customer conversation.
  if (ours && !thread) return "ignored";

  const attachments = attachmentMetas(m);
  const message: SupportMessage = {
    id: `sm_${randomUUIDv7()}`,
    direction: ours ? "out" : "in",
    at: m.receivedAt,
    from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    text: textOf(m),
    keys: m.keys,
    providerId: m.providerId,
    attachments: attachments.map((a) => a.meta),
  };
  if (!ours) {
    message.trust = trust;
    const replyTo = m.replyTo.flatMap((a) => normalizeAddress(a) ?? []);
    if (replyTo.length) message.replyTo = replyTo;
  }
  if (staff) message.sentBy = { kind: "person", name: staff };
  if (automated) message.automated = true;

  const events: ConversationEvent[] = [];
  if (ours)
    events.push({
      at: message.at,
      kind: "replied-outside",
      actor: { kind: "person", name: staff ?? from.name ?? from.address },
      detail: "Replied outside Sessions",
    });
  else if (m.unreadable && !automated)
    events.push({
      at: message.at,
      kind: "needs-person",
      actor: { kind: "sessions" },
      detail: "This message couldn't be read, so it waits for a person",
    });

  const offer: Offer = {
    inbox,
    providerId: m.providerId,
    message,
    attachments,
    ids: ids.all,
    handsOff: !ours && !automated && !m.unreadable,
    events,
  };
  let result = thread ? await appendTo(thread.id, offer) : null;
  if (!result) {
    // The thread was deleted meanwhile; our side never starts one.
    if (ours) return "ignored";
    result = await createNew(offer, m, reuseId, automated);
  }
  return result;
}

/** Appends to an existing conversation; null when it is gone. The same mail
 *  already in it (stored before a crash) is not added again: its ids and
 *  pending key are repaired and it resolves "duplicate". */
async function appendTo(
  conversationId: string,
  offer: Offer,
): Promise<"stored" | "duplicate" | null> {
  const { inbox, message } = offer;
  // Bytes first: the append then records them as stored.
  const saved = await saveAttachments(conversationId, offer.attachments, inbox);
  let existing: SupportMessage | undefined;
  const c = await updateConversation(conversationId, (current) => {
    existing = current.messages.find((x) => sameMessage(x, message));
    if (existing) return null;
    const next = appendMessage(current, { ...message, attachments: saved });
    if (offer.events.length) next.events = [...next.events, ...offer.events];
    return next;
  });
  if (!c || existing) await discardSaved(conversationId, saved);
  if (!c) return null;
  const stored =
    existing ?? c.messages.find((x) => x.id === message.id) ?? message;
  // Replies to spam stay with spam: no pipeline, no event.
  const handsOff = offer.handsOff && c.status !== "spam";
  // A repaired message that opened the conversation and was never triaged
  // still counts as new.
  const isNew =
    existing !== undefined &&
    c.messages[0]?.id === existing.id &&
    c.triage === null;
  // The pending key before the ids: once the ids are remembered a re-offer
  // is a duplicate, so the hand-off must already be recorded.
  const merged = handsOff ? await markPending(c.id, stored.id, isNew) : null;
  await rememberMessageIds(inbox.id, c.id, offer.ids, [offer.providerId]);
  if (merged) void handOff(c, stored, merged.isNew);
  return existing ? "duplicate" : "stored";
}

/** Starts a conversation. Its id comes first and its ids are remembered
 *  under it before anything else, so a crash part way is finished by the
 *  next offer under the same id. */
async function createNew(
  offer: Offer,
  m: InboundMessage,
  reuseId: string | null,
  automated: boolean,
): Promise<"stored" | "duplicate"> {
  const { inbox, message } = offer;
  const id = reuseId ?? newConversationId();
  await rememberMessageIds(inbox.id, id, offer.ids, [offer.providerId]);
  const merged = offer.handsOff
    ? await markPending(id, message.id, true)
    : null;
  const saved = await saveAttachments(id, offer.attachments, inbox);
  const now = new Date().toISOString();
  const c = await createConversation({
    id,
    channel: m.channel,
    inboxId: inbox.id,
    project: inbox.project,
    subject: m.subject,
    customer: message.from,
    // The inbox's owner until a person reassigns it (support/actions.ts).
    owner: inbox.owner || null,
    first: { ...message, attachments: saved },
    now,
    // Machine mail that answers nothing of ours is filed, not left open.
    ...(automated ? { status: "closed" as const } : {}),
    events: offer.events,
  });
  const stored = c.messages.find((x) => x.id === message.id);
  if (!stored) {
    // The id was taken after all: add the mail to that conversation.
    await discardSaved(id, saved);
    return (await appendTo(c.id, offer)) ?? "stored";
  }
  if (merged) void handOff(c, stored, merged.isNew);
  return "stored";
}

/** Records (or merges into) the conversation's pending hand-off and
 *  resolves to the merged entry: isNew stays true while any message it
 *  stands for started the conversation. */
async function markPending(
  conversationId: string,
  messageId: string,
  isNew: boolean,
): Promise<PendingInbound> {
  const next = (value: unknown): PendingInbound => ({
    conversationId,
    messageId,
    isNew: isNew || (isPending(value) && value.isNew),
    attempts: isPending(value) ? value.attempts : 0,
    nextAttemptAt: Date.now() + FIRST_RETRY_MS,
  });
  const merged = await pendingIndex().update<PendingInbound>(
    pendingKey(conversationId),
    next,
  );
  return merged ?? next(null);
}

class PipelineTimeout extends Error {
  override name = "PipelineTimeout";
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A run that settles after the limit must not surface as unhandled.
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PipelineTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The CloudEvent, once the pipeline (triage) settled: not for spam. */
async function publishAfterTriage(
  conversationId: string,
  message: SupportMessage,
  isNew: boolean,
): Promise<void> {
  try {
    const c = await getConversation(conversationId);
    if (!c || c.status === "spam" || c.triage?.route === "spam") return;
    await publishSupportEvent(supportCloudEvent(c, message, isNew));
  } catch (error) {
    console.warn(
      `[support] event for ${conversationId} not published:`,
      errorLabel(error),
    );
  }
}

/** Runs the pipeline for one pending key; never rejects. On success the
 *  event is published and the key goes, unless a newer message replaced it
 *  meanwhile. On failure it is pushed back with backoff, and dropped with a
 *  conversation event after MAX_ATTEMPTS. */
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
    try {
      // Fresh: the hand-off before this one may have triaged it.
      const current = await getConversation(conversation.id);
      if (!current) {
        await pendingIndex().delete(key);
        return;
      }
      if (current.status === "spam") {
        await settlePending(key, pendingMessageId, true);
        return;
      }
      let ok = false;
      try {
        await withTimeout(
          Promise.resolve().then(() => p.onInbound(current, message, isNew)),
          pipelineTimeoutMs,
        );
        ok = true;
      } catch (error) {
        console.warn(
          `[support] pipeline failed for ${conversation.id}:`,
          errorLabel(error),
        );
      }
      if (ok) await publishAfterTriage(conversation.id, message, isNew);
      await settlePending(key, pendingMessageId, ok);
    } catch (error) {
      console.warn(
        `[support] pending key ${key} not settled:`,
        errorLabel(error),
      );
    }
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
  const outcome: { gaveUp: string | null } = { gaveUp: null };
  await pendingIndex().update<PendingInbound>(key, (value) => {
    outcome.gaveUp = null;
    // Gone or malformed: nothing to keep.
    if (!isPending(value)) return null;
    // A newer message took the key over; it settles itself.
    if (value.messageId !== messageId) return value;
    if (ok) return null;
    const attempts = value.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      outcome.gaveUp = value.conversationId;
      return null;
    }
    return {
      ...value,
      attempts,
      nextAttemptAt:
        Date.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (attempts - 1)),
    };
  });
  if (outcome.gaveUp)
    await updateConversation(outcome.gaveUp, (c) => ({
      ...c,
      events: [
        ...c.events,
        {
          at: new Date().toISOString(),
          kind: "handoff-failed",
          actor: { kind: "sessions" },
          detail: "Couldn't hand this to the agent",
        },
      ],
    }));
}

/** Starts the due pipeline hand-offs, at most RETRY_BATCH, side by side
 *  (each key stays in order through `inFlight`), and resolves to how many
 *  ran once they settled. Keys whose conversation is gone are dropped. With
 *  no pipeline installed the keys wait. Called by the support tick. */
export async function retryPendingInbound(now: number): Promise<number> {
  if (!pipeline) return 0;
  const due: Array<{ key: string; value: PendingInbound }> = [];
  for (const { key, value } of await pendingIndex().list()) {
    if (!key.startsWith("triage:") || inFlight.has(key)) continue;
    if (!isPending(value)) {
      await pendingIndex().delete(key);
      continue;
    }
    if (value.nextAttemptAt > now) continue;
    due.push({ key, value });
    if (due.length >= RETRY_BATCH) break;
  }
  const runs = due.map(async ({ key, value }) => {
    const conversation = await getConversation(value.conversationId);
    const message =
      conversation?.messages.find((x) => x.id === value.messageId) ??
      conversation?.messages.findLast(
        (x) => x.direction === "in" && !x.automated,
      );
    if (!conversation || !message) {
      await pendingIndex().delete(key);
      return false;
    }
    await handOff(conversation, message, value.isNew, value.messageId);
    return true;
  });
  const settled = await Promise.allSettled(runs);
  return settled.filter((r) => r.status === "fulfilled" && r.value).length;
}
