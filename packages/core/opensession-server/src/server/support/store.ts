// Support conversations on the application catalog, the incident store's
// pattern: the document in `support-conversations` is the truth, updates run
// through the catalog's compare-and-swap, and change listeners hear about
// every committed change afterwards. Each commit rewrites the conversation's
// row in `support-index` (the list projection and the sweeps' work index).
// `support-message-ids` maps hashed Message-IDs and provider ids to their
// conversation, per inbox, for threading and dedupe.
import { randomUUIDv7 } from "bun";
import { createHash } from "node:crypto";
import {
  type ConversationStatus,
  MAX_DOC_BYTES,
  MAX_MESSAGES,
  type MailAddress,
  type SupportChannelKind,
  type SupportConversation,
  type SupportIndexRow,
  type SupportMessage,
} from "../../shared/support";
import { catalogDocuments } from "../catalog-documents";

const PREVIEW_CHARS = 160;

type Documents = ReturnType<typeof catalogDocuments>;

// Bound on first use, never at import: the catalog client is a live effect.
let conversationDocs: Documents | undefined;
let indexDocs: Documents | undefined;
let idDocs: Documents | undefined;
const conversations = () =>
  (conversationDocs ??= catalogDocuments("support-conversations"));
const indexRows = () => (indexDocs ??= catalogDocuments("support-index"));
const messageIdDocs = () =>
  (idDocs ??= catalogDocuments("support-message-ids"));

/** May be async; what it returns is never awaited by the write. */
export type ConversationListener = (
  next: SupportConversation | null,
  previous: SupportConversation | null,
) => void;

const listeners = new Set<ConversationListener>();

/** Highest revision whose index row this process wrote, so a late write
 *  never replaces a newer row. */
const indexedRevision = new Map<string, number>();
/** Conversations whose last index write failed; the next update retries. */
const staleIndex = new Set<string>();

export function onConversationChange(
  listener: ConversationListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Each listener on its own microtask: one that throws, rejects or never
 *  settles cannot fail the write. */
function notify(
  next: SupportConversation | null,
  previous: SupportConversation | null,
): void {
  for (const listener of [...listeners])
    void Promise.resolve()
      .then(() => listener(next, previous))
      .catch((error: unknown) => {
        console.warn(
          "[support] conversation listener failed:",
          error instanceof Error ? error.message : error,
        );
      });
}

function isConversationId(id: unknown): id is string {
  return (
    typeof id === "string" && id.length <= 256 && /^sc_[0-9a-f-]+$/i.test(id)
  );
}

function isConversationRecord(value: unknown): value is SupportConversation {
  const c = value as SupportConversation | null;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.id === "string" &&
    typeof c.inboxId === "string" &&
    typeof c.revision === "number" &&
    Array.isArray(c.messages)
  );
}

/** Keep the document under the catalog bound: drop the oldest messages past
 *  MAX_MESSAGES, then clear the oldest texts (never the newest message's)
 *  until the JSON fits MAX_DOC_BYTES. */
function fitDocument(c: SupportConversation): SupportConversation {
  const messages =
    c.messages.length > MAX_MESSAGES
      ? c.messages.slice(-MAX_MESSAGES)
      : [...c.messages];
  let bytes = Buffer.byteLength(JSON.stringify({ ...c, messages }));
  for (let i = 0; i < messages.length - 1 && bytes > MAX_DOC_BYTES; i++) {
    const m = messages[i]!;
    if (m.text === null) continue;
    bytes -= Buffer.byteLength(JSON.stringify(m.text)) - "null".length;
    messages[i] = { ...m, text: null };
  }
  return { ...c, messages };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The list row for a conversation. Pure. */
export function indexRowFor(c: SupportConversation): SupportIndexRow {
  const withText = c.messages.findLast((m) => m.text !== null);
  let unansweredSince: string | null = null;
  if (c.status !== "closed" && c.status !== "spam")
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i]!;
      if (m.direction === "out") break;
      if (!m.automated) unansweredSince = m.at;
    }
  let attachmentsExpireAt: string | null = null;
  for (const m of c.messages)
    for (const a of m.attachments)
      if (
        a.stored &&
        a.expiresAt &&
        (attachmentsExpireAt === null || a.expiresAt < attachmentsExpireAt)
      )
        attachmentsExpireAt = a.expiresAt;
  return {
    id: c.id,
    channel: c.channel,
    inboxId: c.inboxId,
    project: c.project,
    subject: c.subject,
    preview: withText ? collapse(withText.text!).slice(0, PREVIEW_CHARS) : "",
    customer: c.customer,
    status: c.status,
    owner: c.owner,
    lastMessageAt: c.lastMessageAt,
    closedAt: c.closedAt,
    draftState: c.draft?.state ?? null,
    vetoDeadline: c.draft?.vetoDeadline ?? null,
    sessionId: c.sessionId,
    unansweredSince,
    attachmentsExpireAt,
  };
}

/** Written after the conversation commit; a failure is logged and retried
 *  by the next update, never thrown. */
async function writeIndexRow(c: SupportConversation): Promise<void> {
  try {
    let wrote = false;
    await indexRows().update(c.id, (value) => {
      wrote = false;
      if ((indexedRevision.get(c.id) ?? -1) > c.revision) return value;
      wrote = true;
      return indexRowFor(c);
    });
    if (wrote) indexedRevision.set(c.id, c.revision);
    staleIndex.delete(c.id);
  } catch (error) {
    staleIndex.add(c.id);
    console.warn(
      `[support] index row for ${c.id} not written:`,
      error instanceof Error ? error.message : error,
    );
  }
}

export async function getConversation(
  id: string,
): Promise<SupportConversation | null> {
  if (!isConversationId(id)) return null;
  const value = await conversations().get(id);
  return isConversationRecord(value) ? value : null;
}

export async function createConversation(init: {
  channel: SupportChannelKind;
  inboxId: string;
  project: string;
  subject: string;
  customer: MailAddress;
  owner: string | null;
  first: SupportMessage;
  now: string;
}): Promise<SupportConversation> {
  const conversation = fitDocument({
    id: `sc_${randomUUIDv7()}`,
    channel: init.channel,
    inboxId: init.inboxId,
    project: init.project,
    subject: init.subject,
    customer: init.customer,
    status: "open",
    owner: init.owner,
    createdAt: init.now,
    lastMessageAt: init.first.at,
    closedAt: null,
    triage: null,
    sessionId: null,
    fixSessionId: null,
    messages: [init.first],
    draft: null,
    autoSends: [],
    moves: [],
    issue: null,
    pendingIssue: null,
    events: [],
    revision: 0,
  });
  await conversations().set(conversation.id, conversation);
  await writeIndexRow(conversation);
  notify(conversation, null);
  return conversation;
}

/** CAS on `support-conversations`; `mutate` returns null for "no change".
 *  Bumps `revision`, rewrites the `support-index` row, notifies listeners.
 *  Resolves null for a conversation that does not exist. */
export async function updateConversation(
  id: string,
  mutate: (current: SupportConversation) => SupportConversation | null,
): Promise<SupportConversation | null> {
  if ((await getConversation(id)) === null) return null;
  let previous: SupportConversation | null = null;
  let changed = false;
  const committed = await conversations().update<SupportConversation>(
    id,
    (value) => {
      previous = null;
      changed = false;
      // Deleted meanwhile: leave it deleted.
      if (value === null) return null;
      if (!isConversationRecord(value))
        throw new Error(`Support conversation ${id} record is malformed`);
      previous = value;
      const next = mutate(structuredClone(value));
      if (next === null) return value;
      const fitted = fitDocument({
        ...next,
        id: value.id,
        revision: value.revision,
      });
      if (JSON.stringify(fitted) === JSON.stringify(value)) return value;
      changed = true;
      return { ...fitted, revision: value.revision + 1 };
    },
  );
  if (committed === null || previous === null) return null;
  if (!changed) {
    if (staleIndex.has(id)) await writeIndexRow(committed);
    return committed;
  }
  await writeIndexRow(committed);
  notify(committed, previous);
  return committed;
}

/** Deletes the conversation's message-id keys, its index row and then the
 *  document, so a crash part way leaves something a retry can find. */
export async function deleteConversation(id: string): Promise<boolean> {
  const current = await getConversation(id);
  if (!current) return false;
  await forgetMessageKeys(current);
  await indexRows().delete(id);
  indexedRevision.delete(id);
  staleIndex.delete(id);
  const existed = await conversations().delete(id);
  if (existed) notify(null, current);
  return existed;
}

export async function listIndexRows(
  filter: {
    inboxId?: string;
    status?: ConversationStatus[];
    customerEmail?: string;
  } = {},
): Promise<SupportIndexRow[]> {
  const email = filter.customerEmail?.trim().toLowerCase();
  const out: SupportIndexRow[] = [];
  for (const { value } of await indexRows().list()) {
    const row = value as SupportIndexRow;
    if (!row || typeof row.id !== "string") continue;
    if (filter.inboxId !== undefined && row.inboxId !== filter.inboxId)
      continue;
    if (filter.status && !filter.status.includes(row.status)) continue;
    if (email !== undefined && row.customer.address.toLowerCase() !== email)
      continue;
    out.push(row);
  }
  out.sort(
    (a, b) =>
      b.lastMessageAt.localeCompare(a.lastMessageAt) ||
      b.id.localeCompare(a.id),
  );
  return out;
}

// ── Message-ID and provider id keys ─────────────────────────────────────

interface KeyRef {
  conversationId: string;
}

/** Every key `rememberMessageIds` wrote for one conversation, so deletion
 *  finds them even after their messages left the document. */
interface KeyList {
  inboxId: string;
  keys: string[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Hashed so keys never contain `/` or control characters (catalog key rule).
const messageKey = (inboxId: string, messageId: string) =>
  `m:${inboxId}:${hash(messageId)}`;
const providerKey = (inboxId: string, providerId: string) =>
  `p:${inboxId}:${hash(providerId)}`;
const keyListKey = (conversationId: string) => `c:${conversationId}`;

function isKeyRef(value: unknown): value is KeyRef {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as KeyRef).conversationId === "string"
  );
}

function isKeyList(value: unknown): value is KeyList {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as KeyList).keys)
  );
}

/** A key already pointing at another conversation keeps pointing there: a
 *  reused Message-ID never moves a thread. */
export async function rememberMessageIds(
  inboxId: string,
  conversationId: string,
  messageIds: string[],
  providerIds: string[],
): Promise<void> {
  const keys = [
    ...new Set([
      ...messageIds.map((id) => messageKey(inboxId, id)),
      ...providerIds.map((id) => providerKey(inboxId, id)),
    ]),
  ];
  if (!keys.length) return;
  // The list first: a crash after it leaves no key deletion cannot find.
  await messageIdDocs().update<KeyList>(keyListKey(conversationId), (value) => {
    const known = isKeyList(value) ? value.keys : [];
    const merged = [...new Set([...known, ...keys])];
    if (isKeyList(value) && merged.length === known.length) return value;
    return { inboxId, keys: merged };
  });
  await Promise.all(
    keys.map((key) =>
      messageIdDocs().update<KeyRef>(key, (value) =>
        isKeyRef(value) ? value : { conversationId },
      ),
    ),
  );
}

/** messageId → conversationId for the ids this inbox knows. */
export async function lookupMessageIds(
  inboxId: string,
  messageIds: string[],
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const id of messageIds) byKey.set(messageKey(inboxId, id), id);
  const found = new Map<string, string>();
  if (!byKey.size) return found;
  for (const { key, value } of await messageIdDocs().getMany([...byKey.keys()]))
    if (isKeyRef(value)) found.set(byKey.get(key)!, value.conversationId);
  return new Map(
    messageIds.filter((id) => found.has(id)).map((id) => [id, found.get(id)!]),
  );
}

export async function lookupProviderId(
  inboxId: string,
  providerId: string,
): Promise<string | null> {
  const value = await messageIdDocs().get(providerKey(inboxId, providerId));
  return isKeyRef(value) ? value.conversationId : null;
}

/** Removes the keys this conversation owns: the recorded list plus every
 *  id still in the document. Keys owned by another conversation stay. */
async function forgetMessageKeys(c: SupportConversation): Promise<void> {
  const listKey = keyListKey(c.id);
  const list = await messageIdDocs().get(listKey);
  const keys = new Set(isKeyList(list) ? list.keys : []);
  for (const m of c.messages) {
    if (m.keys.messageId) keys.add(messageKey(c.inboxId, m.keys.messageId));
    if (m.providerId) keys.add(providerKey(c.inboxId, m.providerId));
  }
  if (c.draft) keys.add(messageKey(c.inboxId, c.draft.messageId));
  const owned = (await messageIdDocs().getMany([...keys])).filter(
    ({ value }) => isKeyRef(value) && value.conversationId === c.id,
  );
  await Promise.all(
    owned.map(({ key }) =>
      messageIdDocs().update(key, (value) =>
        isKeyRef(value) && value.conversationId === c.id ? null : value,
      ),
    ),
  );
  if (list !== null) await messageIdDocs().delete(listKey);
}
