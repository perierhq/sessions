// The one reply path. Every customer-facing send goes through here: an
// agent's or a person's draft is decided by policy.ts (decideReply), then
// waits for a person, waits out a veto window, or goes out through the
// conversation's channel adapter. `deliver` below is the only caller of a
// channel adapter's `send` in the codebase (reply.test.ts guards it), and
// every attempt writes one audit row: `support.reply` when it went out,
// `support.reply.failed` when it didn't. Rows carry a digest of the text,
// never the text or an address.
//
// Reuses the incidents pattern of a deadline in the record plus a tick
// (incidents/response/coordinator.ts): a veto window or a send waiting for
// its retry leaves a key in the `support-pending` work index
// (`veto:<conversationId>`, `send:<conversationId>:<draftId>`), written
// before the
// conversation changes, and tick.ts reads only those keys. A send claims
// its draft with the catalog's compare-and-swap (state `sending`), so two
// callers never send one draft twice; a send that a restart interrupted is
// failed by the tick, never resent blindly.
//
// A draft is pinned to its target when its send is decided: the message
// mime.ts `replyTarget` answers and its one address (draft.answersMessageId
// + draft.to); the mail goes only there. Trust is checked on that message.
// Every later send of the draft (a person's, a veto's end, a retry) first
// compares the pin with the conversation's current target: a newer target
// sends the draft back to a person, re-pinned, so nobody's reply is
// redirected by mail that came after they decided. An automatic retry
// also runs the policy again. Nothing runs at import.
import { randomUUIDv7 } from "bun";
import { buildReply, newMessageId, replyTarget } from "../../agents/email/mime";
import {
  MAX_TEXT_CHARS,
  type InboxConfig,
  type MailAddress,
  type SupportActor,
  type SupportConversation,
  type SupportDraft,
  type SupportMessage,
  normalizeMessageId,
  ownMailAddresses,
} from "../../shared/support";
import { digest } from "../audit";
import { catalogDocuments } from "../catalog-documents";
import { supportAudit } from "./audit-sink";
import {
  INTERRUPTED_SEND,
  SendError,
  type SentReceipt,
  channelAdapterFor,
} from "./channel";
import { getInbox, listInboxes } from "./inboxes";
import { type ReplyDecision, RULES, decideReply } from "./policy";
import {
  getConversation,
  rememberMessageIds,
  updateConversation,
} from "./store";

type Failure = { ok: false; status: 400 | 404 | 409 | 502; error: string };
export type Result<T> = ({ ok: true } & T) | Failure;

const HOUR_MS = 3_600_000;
/** Waits before the 2nd, 3rd (and, were there one, 4th) attempt. */
export const SEND_BACKOFF_MS = [60_000, 300_000, 900_000] as const;
/** Attempts before a transient failure fails the draft. */
export const MAX_SEND_ATTEMPTS = 3;

export { INTERRUPTED_SEND };
const NOT_CONNECTED = "The inbox isn't connected";
const INBOX_REMOVED = "The inbox was removed";
const SEND_FAILED = "Couldn't send the message";
const SMTP_NO_PIN = "Open the reply again to check who it goes to";

const SESSIONS: SupportActor = { kind: "sessions" };

// ── The work index ───────────────────────────────────────────────────────

let pendingDocs: ReturnType<typeof catalogDocuments> | undefined;
const pending = () => (pendingDocs ??= catalogDocuments("support-pending"));

export interface PendingVeto {
  conversationId: string;
  draftId: string;
  /** Epoch ms. */
  deadline: number;
}

export interface PendingSend {
  conversationId: string;
  draftId: string;
  /** Epoch ms when the current attempt started. */
  startedAt: number;
  edited?: boolean;
}

export const vetoKey = (conversationId: string) => `veto:${conversationId}`;
/** One per draft, so a new draft never replaces a live send's key. */
export const sendKey = (conversationId: string, draftId: string) =>
  `send:${conversationId}:${draftId}`;

/** A `sending` draft that started longer ago than this, and that no send in
 *  this process owns, was cut off by a restart. Longer than the SMTP
 *  connect and greeting time limits, so a live send in another process is
 *  never mistaken for one. */
export const INTERRUPTED_AFTER_MS = 2 * 60_000;

export function isPendingVeto(value: unknown): value is PendingVeto {
  const v = value as PendingVeto | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.conversationId === "string" &&
    typeof v.draftId === "string" &&
    typeof v.deadline === "number"
  );
}

export function isPendingSend(value: unknown): value is PendingSend {
  const v = value as PendingSend | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.conversationId === "string" &&
    typeof v.draftId === "string" &&
    typeof v.startedAt === "number"
  );
}

/** The reply keys of the work index (tick.ts). */
export async function listPendingReplies(): Promise<
  Array<{ key: string; value: unknown }>
> {
  return (await pending().list()).filter(
    ({ key }) => key.startsWith("veto:") || key.startsWith("send:"),
  );
}

/** Deletes `key` when it still stands for `draftId` (or is unreadable). */
export async function dropPendingKey(
  key: string,
  draftId: string,
): Promise<void> {
  await pending().update(key, (value) => {
    const v = value as { draftId?: unknown } | null;
    if (
      value !== null &&
      typeof v?.draftId === "string" &&
      v.draftId !== draftId
    )
      return value;
    return null;
  });
}

// ── In-process state ─────────────────────────────────────────────────────

/** Conversations whose send runs in this process now. A restart empties it,
 *  which is how the tick tells an interrupted send from a slow one. */
const inFlight = new Set<string>();

export function sendingInProcess(conversationId: string): boolean {
  return inFlight.has(conversationId);
}

/** Forget in-process state, as a restart would (tests). */
export function __resetReplyStateForTest(): void {
  inFlight.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();
const fail = (status: Failure["status"], error: string): Failure => ({
  ok: false,
  status,
  error,
});

/** Display name, for rules ("Stopped by Ada"). */
function actorLabel(actor: SupportActor): string {
  return actor.kind === "person" ? actor.name : actor.kind;
}

/** Who acted, for audit rows: the signed-in login (else the name) and
 *  the display name. */
function auditActor(actor: SupportActor): { by: string; byName?: string } {
  if (actor.kind !== "person") return { by: actor.kind };
  return { by: actor.login || actor.name, byName: actor.name };
}

/** A person stopped or discarded the last draft (or a stop carried over
 *  to the agent's next one), or its send may have gone out: the agent's
 *  next draft waits for a person until one acts. */
function heldByPerson(d: SupportDraft | null): boolean {
  if (!d) return false;
  if (d.state === "failed") return d.lastError === INTERRUPTED_SEND;
  if (d.state === "discarded") return d.decidedBy?.kind === "person";
  if (d.state === "needs-person")
    return d.decidedBy?.kind === "person" || d.rule === RULES.personStopped;
  return false;
}

/** Trimmed text, or why it can't be sent. */
function replyText(raw: unknown): string | Failure {
  if (typeof raw !== "string" || !raw.trim())
    return fail(400, "Write a reply first");
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_TEXT_CHARS)
    return fail(400, `A reply can be at most ${MAX_TEXT_CHARS} characters`);
  return text;
}

async function otherInboxAddresses(inbox: InboxConfig): Promise<string[]> {
  return (await listInboxes())
    .filter((i) => i.id !== inbox.id)
    .map((i) => i.address);
}

/** Where a reply goes and what it answers, as pinned on a draft. */
export interface ReplyPin {
  answersMessageId: string | null;
  to: MailAddress[];
}

/** The conversation's target now (mime.ts replyTarget). */
export function currentPin(
  c: SupportConversation,
  own: readonly string[],
): ReplyPin {
  const { message, to } = replyTarget(c, own);
  return { answersMessageId: message?.id ?? null, to };
}

/** Whether `d` is pinned to `pin`. A draft from before pinning never is. */
function pinnedTo(d: SupportDraft, pin: ReplyPin): boolean {
  if (d.to === undefined || d.answersMessageId === undefined) return false;
  if ((d.answersMessageId ?? null) !== pin.answersMessageId) return false;
  const key = (list: MailAddress[]) =>
    list.map((a) => a.address.toLowerCase()).join(",");
  return key(d.to) === key(pin.to);
}

/** The trust the policy checks, of a pinned target: of the message it
 *  answers. A reply that would go somewhere its sender didn't write from (a
 *  Reply-To, or no person's message at all) counts as `replyToDiffers`. */
function pinTrust(
  c: SupportConversation,
  pin: ReplyPin,
): NonNullable<SupportMessage["trust"]> {
  const message = pin.answersMessageId
    ? c.messages.find((m) => m.id === pin.answersMessageId)
    : undefined;
  const to = pin.to[0];
  if (!message || !to)
    return { replyToDiffers: true, authFailed: false, authVerified: false };
  return {
    replyToDiffers:
      message.trust?.replyToDiffers === true ||
      to.address.toLowerCase() !== message.from.address.toLowerCase(),
    authFailed: message.trust?.authFailed === true,
    authVerified: message.trust?.authVerified === true,
  };
}

/** The trust the policy checks for a reply decided now: of the message
 *  replyTarget answers (see pinTrust). */
export function answeredTrust(
  c: SupportConversation,
  own: readonly string[],
): NonNullable<SupportMessage["trust"]> {
  return pinTrust(c, currentPin(c, own));
}

function autoSendsSince(c: SupportConversation, now: number): number {
  return c.autoSends.filter((at) => {
    const t = Date.parse(at);
    return t > now - HOUR_MS && t <= now;
  }).length;
}

/** decideReply for `author` on `c` answering `pin`. A removed inbox counts
 *  as off. */
function decide(
  c: SupportConversation,
  author: SupportActor,
  inbox: InboxConfig | null,
  pin: ReplyPin,
  now: number,
): ReplyDecision {
  return decideReply({
    author,
    inbox: inbox ?? {
      enabled: false,
      autonomy: "watch",
      vetoMs: 0,
      neverWithoutAPerson: [],
    },
    triage: c.triage,
    autoSendsLastHour: autoSendsSince(c, now),
    now,
    lastInboundTrust: pinTrust(c, pin),
    status: c.status,
    personStoppedLast: heldByPerson(c.draft),
  });
}

async function context(c: SupportConversation) {
  const inbox = await getInbox(c.inboxId);
  const others = inbox ? await otherInboxAddresses(inbox) : [];
  const own = inbox ? ownMailAddresses(inbox, others) : [];
  return { inbox, others, own };
}

// ── Propose ──────────────────────────────────────────────────────────────

/** Agent or person writes a draft; replaces a live draft that is not
 *  `sending`. Applies decideReply; a `send` decision continues into the
 *  send with by = { kind: "sessions" } (agent) or the person. */
export async function proposeDraft(
  conversationId: string,
  text: string,
  author: SupportActor,
  now = Date.now(),
): Promise<Result<{ draft: SupportDraft }>> {
  const result = await propose(conversationId, text, author, now);
  return result.ok ? { ok: true, draft: result.draft } : result;
}

/** A person's reply: sent at once (rule 1), replacing any waiting draft.
 *  `person` is the display name, or the actor with the signed-in login. */
export async function replyAsPerson(
  conversationId: string,
  text: string,
  person: string | { name: string; login?: string },
): Promise<Result<{ message: SupportMessage }>> {
  const actor: SupportActor =
    typeof person === "string"
      ? { kind: "person", name: person }
      : {
          kind: "person",
          name: person.name,
          ...(person.login ? { login: person.login } : {}),
        };
  if (!actor.name.trim()) return fail(400, "Sign in to reply");
  const result = await propose(conversationId, text, actor);
  if (!result.ok) return result;
  if (!result.message)
    return fail(409, result.draft.rule || "The reply was not sent");
  return { ok: true, message: result.message };
}

async function propose(
  conversationId: string,
  rawText: string,
  author: SupportActor,
  now = Date.now(),
): Promise<
  { ok: true; draft: SupportDraft; message: SupportMessage | null } | Failure
> {
  const text = replyText(rawText);
  if (typeof text !== "string") return text;
  const current = await getConversation(conversationId);
  if (!current) return fail(404, "Conversation not found");
  if (current.draft?.state === "sending")
    return fail(409, "A reply is being sent");
  const { inbox, others, own } = await context(current);
  const draftId = `sd_${randomUUIDv7()}`;
  const messageId = newMessageId(inbox?.address ?? "");

  // The work index first, from the decision on what we just read: a crash
  // after it leaves a key the tick drops, never a window nobody ends.
  const provisional = decide(
    current,
    author,
    inbox,
    currentPin(current, own),
    now,
  );
  if (provisional.kind === "veto")
    await pending().update<PendingVeto>(vetoKey(conversationId), () => ({
      conversationId,
      draftId,
      deadline: Date.parse(provisional.deadline),
    }));
  if (provisional.kind === "send")
    await pending().update<PendingSend>(sendKey(conversationId, draftId), () => ({
      conversationId,
      draftId,
      startedAt: now,
    }));

  let failure: Failure | null = null;
  let draft: SupportDraft | null = null;
  const committed = await updateConversation(conversationId, (c) => {
    failure = null;
    draft = null;
    if (c.draft?.state === "sending") {
      failure = fail(409, "A reply is being sent");
      return null;
    }
    const pin = currentPin(c, own);
    const decision = decide(c, author, inbox, pin, now);
    if (decision.kind === "send" && provisional.kind !== "send") {
      // Decided differently than the work index was written for: hold.
      failure = fail(409, "The conversation changed; try again");
      return null;
    }
    draft = {
      id: draftId,
      text,
      author,
      createdAt: iso(now),
      state: decision.kind === "send" ? "sending" : decision.kind,
      rule: decision.rule,
      vetoDeadline: decision.kind === "veto" ? decision.deadline : null,
      attempts: decision.kind === "send" ? 1 : 0,
      nextAttemptAt: null,
      lastError: null,
      messageId,
      decidedBy:
        decision.kind === "send"
          ? author.kind === "person"
            ? author
            : SESSIONS
          : null,
      answersMessageId: pin.answersMessageId,
      to: pin.to,
      attemptStartedAt: decision.kind === "send" ? iso(now) : null,
    };
    return { ...c, draft };
  });
  const written = draft as SupportDraft | null;
  if (provisional.kind === "send" && written?.state !== "sending")
    await dropPendingKey(sendKey(conversationId, draftId), draftId).catch(() => {});
  await reconcileVetoKey(conversationId);
  if (!committed || !written)
    return failure ?? fail(404, "Conversation not found");
  if (written.state !== "sending")
    return { ok: true, draft: written, message: null };
  const sent = await deliver(committed, written, inbox, others, {
    edited: false,
    now,
  });
  if (!sent.ok) return sent;
  return {
    ok: true,
    draft: { ...written, state: "sent" },
    message: sent.message,
  };
}

/** Makes the conversation's veto key match its draft: the key of a draft
 *  in its veto window, no key otherwise. Failures are logged; the tick
 *  drops keys that name no veto. */
async function reconcileVetoKey(conversationId: string): Promise<void> {
  try {
    const d = (await getConversation(conversationId))?.draft;
    const live = d?.state === "veto" && d.vetoDeadline ? d : null;
    await pending().update<PendingVeto>(vetoKey(conversationId), (value) => {
      if (!live) return null;
      if (isPendingVeto(value) && value.draftId === live.id) return value;
      return {
        conversationId,
        draftId: live.id,
        deadline: Date.parse(live.vetoDeadline!),
      };
    });
  } catch (error) {
    console.warn("[support] veto key not updated:", errorName(error));
  }
}

// ── Send ─────────────────────────────────────────────────────────────────

/** The only caller of adapter.send in the codebase. */
export async function sendDraft(
  conversationId: string,
  draftId: string,
  by: SupportActor,
  edit?: { text: string },
): Promise<Result<{ message: SupportMessage }>> {
  return claimAndDeliver(conversationId, draftId, by, {
    mode: "claim",
    now: Date.now(),
    ...(edit ? { edit } : {}),
  });
}

/** A veto draft whose window ended, sent by Sessions (tick.ts). Policy is
 *  checked again first: a draft the inbox would no longer send goes to a
 *  person instead. */
export async function sendDueVeto(
  conversationId: string,
  draftId: string,
  now: number,
): Promise<Result<{ message: SupportMessage }>> {
  return claimAndDeliver(conversationId, draftId, SESSIONS, {
    mode: "claim",
    now,
  });
}

/** The next attempt of a send whose retry is due (tick.ts). */
export async function retrySend(
  conversationId: string,
  draftId: string,
  now: number,
): Promise<Result<{ message: SupportMessage }>> {
  return claimAndDeliver(conversationId, draftId, SESSIONS, {
    mode: "retry",
    now,
  });
}

async function claimAndDeliver(
  conversationId: string,
  draftId: string,
  by: SupportActor,
  opts: { mode: "claim" | "retry"; now: number; edit?: { text: string } },
): Promise<Result<{ message: SupportMessage }>> {
  const { now } = opts;
  let editText: string | null = null;
  if (opts.edit) {
    const text = replyText(opts.edit.text);
    if (typeof text !== "string") return text;
    editText = text;
  }
  if (by.kind !== "person" && by.kind !== "sessions")
    return fail(409, "Only a person can send this reply");
  const current = await getConversation(conversationId);
  if (!current) return fail(404, "Conversation not found");
  if (current.draft?.id !== draftId)
    return current.messages.some((m) => m.draftId === draftId)
      ? fail(409, "This reply was already sent")
      : fail(404, "Draft not found");
  const { inbox, others, own } = await context(current);

  // The work index first (see the header); the claim below decides.
  const key = sendKey(conversationId, draftId);
  await pending().update<PendingSend>(key, (value) =>
    isPendingSend(value) && value.draftId === draftId
      ? value
      : { conversationId, draftId, startedAt: now },
  );

  let failure: Failure | null = null;
  let claimed: SupportDraft | null = null;
  let edited = false;
  const committed = await updateConversation(conversationId, (c) => {
    failure = null;
    claimed = null;
    edited = false;
    const d = c.draft;
    if (!d || d.id !== draftId) {
      failure = c.messages.some((m) => m.draftId === draftId)
        ? fail(409, "This reply was already sent")
        : fail(404, "Draft not found");
      return null;
    }
    let attempts = d.attempts + 1;
    let decidedBy: SupportActor = by;
    let rule = d.rule;
    const pin = currentPin(c, own);
    /** Back to a person, re-pinned to the target as it is now. */
    const toPerson = (why: string) => {
      failure = fail(409, why);
      return {
        ...c,
        draft: {
          ...d,
          state: "needs-person" as const,
          rule: why,
          vetoDeadline: null,
          nextAttemptAt: null,
          answersMessageId: pin.answersMessageId,
          to: pin.to,
        },
      };
    };
    if (opts.mode === "retry") {
      if (
        d.state !== "sending" ||
        !d.nextAttemptAt ||
        Date.parse(d.nextAttemptAt) > now
      ) {
        failure = fail(409, "No retry is due");
        return null;
      }
      decidedBy = d.decidedBy ?? by;
      if (!pinnedTo(d, pin)) return toPerson(RULES.newerMessage);
      if (decidedBy.kind !== "person") {
        // An automatic send: the policy must still let it go.
        const decision = decide(c, d.author, inbox, pin, now);
        if (decision.kind === "needs-person") return toPerson(decision.rule);
      }
    } else {
      switch (d.state) {
        case "sending":
          failure = fail(409, "This reply is already being sent");
          return null;
        case "sent":
          failure = fail(409, "This reply was already sent");
          return null;
        case "discarded":
          failure = fail(409, "This draft was discarded");
          return null;
        case "needs-person":
        case "failed":
          if (by.kind !== "person") {
            failure = fail(409, "Only a person can send this reply");
            return null;
          }
          if (d.state === "failed") attempts = 1;
          if (!pinnedTo(d, pin)) return toPerson(RULES.newerMessage);
          break;
        case "veto":
          if (by.kind === "sessions") {
            if (!d.vetoDeadline || Date.parse(d.vetoDeadline) > now) {
              failure = fail(409, "The veto window is still open");
              return null;
            }
            if (!pinnedTo(d, pin)) return toPerson(RULES.newerMessage);
            const decision = decide(c, d.author, inbox, pin, now);
            if (decision.kind === "needs-person") return toPerson(decision.rule);
          } else if (!pinnedTo(d, pin)) return toPerson(RULES.newerMessage);
          break;
        default:
          failure = fail(409, "This draft can't be sent");
          return null;
      }
      if (by.kind === "person") rule = `Sent by ${by.name}`;
    }
    if (editText !== null && editText !== d.text) edited = true;
    claimed = {
      ...d,
      text: editText ?? d.text,
      state: "sending",
      rule,
      vetoDeadline: null,
      attempts,
      nextAttemptAt: null,
      lastError: null,
      decidedBy,
      attemptStartedAt: iso(now),
    };
    return { ...c, draft: claimed };
  });
  const draft = claimed as SupportDraft | null;
  if (!committed || !draft) {
    await dropUnclaimed(conversationId, key, draftId);
    // A veto the policy now holds waits for a person: no key.
    await reconcileVetoKey(conversationId);
    return failure ?? fail(404, "Conversation not found");
  }
  // This attempt's start, for the tick's interrupted-send check.
  await pending().update<PendingSend>(key, () => ({
    conversationId,
    draftId,
    startedAt: now,
    edited,
  }));
  return deliver(committed, draft, inbox, others, { edited, now });
}

/** After a refused claim: drop the send key unless a send of the draft is
 *  really under way (the draft is `sending`). */
async function dropUnclaimed(
  conversationId: string,
  key: string,
  draftId: string,
): Promise<void> {
  const c = await getConversation(conversationId);
  if (c?.draft?.id === draftId && c.draft.state === "sending") return;
  await dropPendingKey(key, draftId).catch(() => {});
}

/** Sends a claimed (`sending`) draft through the conversation's adapter and
 *  records the outcome: the out message, or a retry time, or the failure.
 *  Every attempt writes one audit row. */
async function deliver(
  c: SupportConversation,
  draft: SupportDraft,
  inbox: InboxConfig | null,
  otherInboxes: string[],
  opts: { edited: boolean; now: number },
): Promise<Result<{ message: SupportMessage }>> {
  const by = draft.decidedBy ?? SESSIONS;
  if (!inbox)
    return failed(c, draft, new SendError(INBOX_REMOVED, true), opts.now);
  // Only a pinned draft goes out (see the header).
  if (draft.to === undefined || draft.answersMessageId === undefined)
    return failed(c, draft, new SendError(SMTP_NO_PIN, true), opts.now);
  inFlight.add(c.id);
  try {
    return await deliverInFlight(c, draft, inbox, otherInboxes, by, opts);
  } finally {
    // Only once the outcome is recorded: until then the tick must not
    // take this send for one a restart cut off.
    inFlight.delete(c.id);
  }
}

async function deliverInFlight(
  c: SupportConversation,
  draft: SupportDraft,
  inbox: InboxConfig,
  otherInboxes: string[],
  by: SupportActor,
  opts: { edited: boolean; now: number },
): Promise<Result<{ message: SupportMessage }>> {
  const adapter = channelAdapterFor(c.inboxId);
  // Our id first: a reply to it threads here even if we crash after the
  // send. Nothing went out yet when this fails, so it may be retried.
  try {
    await rememberMessageIds(c.inboxId, c.id, [draft.messageId], []);
  } catch (error) {
    console.warn("[support] message id not stored:", errorName(error));
    return failed(c, draft, new SendError(SEND_FAILED, false), opts.now);
  }
  if (!adapter)
    return failed(c, draft, new SendError(NOT_CONNECTED, false), opts.now);
  const sent = await attempt(() =>
    adapter.send({ conversation: c, draft, inbox }),
  );
  if (!sent.ok) return failed(c, draft, sent.error, opts.now);
  const receipt = sent.receipt;

  const mail =
    c.channel === "email"
      ? buildReply({ conversation: c, draft, inbox }, otherInboxes)
      : null;
  const ourId = normalizeMessageId(receipt.messageId) ?? receipt.messageId;
  const message: SupportMessage = {
    id: `sm_${randomUUIDv7()}`,
    direction: "out",
    at: receipt.sentAt,
    from: { name: inbox.label, address: inbox.address },
    to: mail?.to ?? draft.to ?? [],
    cc: [],
    subject: mail?.subject ?? c.subject,
    text: draft.text,
    keys: {
      messageId: ourId,
      ...(ourId !== receipt.messageId
        ? { rawMessageId: receipt.messageId }
        : {}),
      inReplyTo: normalizeMessageId(mail?.inReplyTo) ?? null,
      references: (mail?.references ?? []).flatMap(
        (id) => normalizeMessageId(id) ?? [],
      ),
    },
    providerId: receipt.providerId,
    attachments: [],
    sentBy: by,
    draftId: draft.id,
  };
  const automatic = by.kind === "sessions";
  const updated = await updateConversation(c.id, (x) => ({
    ...x,
    messages: [...x.messages, message],
    draft: x.draft?.id === draft.id ? null : x.draft,
    // A reply never takes a conversation out of spam.
    status: x.status === "spam" ? "spam" : "waiting",
    lastMessageAt: message.at > x.lastMessageAt ? message.at : x.lastMessageAt,
    autoSends: automatic ? [...x.autoSends, message.at] : x.autoSends,
  }));
  await Promise.allSettled([
    ourId !== draft.messageId
      ? rememberMessageIds(c.inboxId, c.id, [ourId], [])
      : Promise.resolve(),
    dropPendingKey(sendKey(c.id, draft.id), draft.id),
    reconcileVetoKey(c.id),
  ]);
  if (inbox.mailbox !== "untouched" && adapter?.mark && updated)
    await adapter.mark(updated, "handled").catch((error: unknown) => {
      console.warn("[support] marking the mailbox failed:", errorName(error));
    });
  await audit({
    type: "support.reply",
    conversationId: c.id,
    inboxId: c.inboxId,
    channel: c.channel,
    draftId: draft.id,
    author: draft.author.kind,
    ...auditActor(by),
    rule: draft.rule,
    edited: opts.edited,
    attempt: draft.attempts,
    textDigest: digest(draft.text),
    messageId: ourId,
  });
  return { ok: true, message };
}

/** Runs the adapter's send. */
async function attempt(
  send: () => Promise<SentReceipt>,
): Promise<{ ok: true; receipt: SentReceipt } | { ok: false; error: unknown }> {
  try {
    return { ok: true, receipt: await send() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Records a failed attempt: transient → still `sending` with the next
 *  attempt's time; permanent, or the last attempt → `failed`. Anything an
 *  adapter throws that is not a SendError may have gone out: failed as
 *  INTERRUPTED_SEND, never retried. */
async function failed(
  c: SupportConversation,
  draft: SupportDraft,
  error: unknown,
  now: number,
): Promise<Failure> {
  const err =
    error instanceof SendError ? error : new SendError(INTERRUPTED_SEND, true);
  if (!(error instanceof SendError))
    console.warn("[support] send failed:", errorName(error));
  const permanent = err.permanent || draft.attempts >= MAX_SEND_ATTEMPTS;
  const wait = Math.max(
    SEND_BACKOFF_MS[Math.min(draft.attempts, SEND_BACKOFF_MS.length) - 1] ??
      SEND_BACKOFF_MS[0],
    err.retryAfterMs ?? 0,
  );
  const nextAttemptAt = permanent ? null : iso(now + wait);
  await updateConversation(c.id, (x) =>
    x.draft?.id === draft.id && x.draft.state === "sending"
      ? {
          ...x,
          draft: {
            ...x.draft,
            state: permanent ? "failed" : "sending",
            nextAttemptAt,
            lastError: err.message,
          },
        }
      : null,
  );
  if (permanent) await dropPendingKey(sendKey(c.id, draft.id), draft.id).catch(() => {});
  await audit({
    type: "support.reply.failed",
    conversationId: c.id,
    inboxId: c.inboxId,
    channel: c.channel,
    draftId: draft.id,
    author: draft.author.kind,
    ...auditActor(draft.decidedBy ?? SESSIONS),
    attempt: draft.attempts,
    permanent,
    error: err.message,
    nextAttemptAt,
    textDigest: digest(draft.text),
  });
  return fail(
    502,
    permanent ? err.message : `${err.message}. Sessions tries again soon`,
  );
}

/** A `sending` draft no process is sending any more (a restart cut it off):
 *  `failed`, never resent automatically (tick.ts). */
export async function failInterruptedSend(
  conversationId: string,
  draftId: string,
): Promise<boolean> {
  let changed = false;
  let draft: SupportDraft | null = null;
  const c = await updateConversation(conversationId, (x) => {
    changed = false;
    const d = x.draft;
    if (!d || d.id !== draftId || d.state !== "sending" || d.nextAttemptAt)
      return null;
    changed = true;
    draft = { ...d, state: "failed", lastError: INTERRUPTED_SEND };
    return { ...x, draft };
  });
  await dropPendingKey(sendKey(conversationId, draftId), draftId).catch(() => {});
  const d = draft as SupportDraft | null;
  if (!changed || !c || !d) return false;
  await audit({
    type: "support.reply.failed",
    conversationId,
    inboxId: c.inboxId,
    channel: c.channel,
    draftId,
    author: d.author.kind,
    ...auditActor(d.decidedBy ?? SESSIONS),
    attempt: d.attempts,
    permanent: true,
    interrupted: true,
    error: INTERRUPTED_SEND,
    textDigest: digest(d.text),
  });
  return true;
}

// ── Discard and stop ─────────────────────────────────────────────────────

/** Whether a person may discard a `sending` draft: no send of it runs in
 *  this process, and it waits for its retry or its attempt started longer
 *  ago than INTERRUPTED_AFTER_MS (a restart cut it off). */
function discardableSend(
  conversationId: string,
  d: SupportDraft,
  now: number,
): boolean {
  if (inFlight.has(conversationId)) return false;
  if (d.nextAttemptAt) return true;
  const started = Date.parse(d.attemptStartedAt ?? d.createdAt);
  return Number.isFinite(started) && now - started > INTERRUPTED_AFTER_MS;
}

/** A person drops a draft that is waiting (for a person or a veto window),
 *  failed, or a send that waits for its retry or was cut off. */
export async function discardDraft(
  conversationId: string,
  draftId: string,
  by: SupportActor,
  now = Date.now(),
): Promise<Result<{}>> {
  const result = await settleDraft(conversationId, draftId, by, (d) => {
    if (
      d.state !== "needs-person" &&
      d.state !== "veto" &&
      d.state !== "failed" &&
      !(d.state === "sending" && discardableSend(conversationId, d, now))
    )
      return fail(409, "This draft can't be discarded now");
    return {
      ...d,
      state: "discarded",
      rule: `Discarded by ${actorLabel(by)}`,
      vetoDeadline: null,
      nextAttemptAt: null,
      decidedBy: by,
    };
  });
  if (!result.ok) return result;
  await dropPendingKey(sendKey(conversationId, draftId), draftId).catch(
    () => {},
  );
  await auditSettled("support.reply.discarded", conversationId, result.draft, by);
  return { ok: true };
}

/** A person stops a veto window: the draft waits for a person. */
export async function stopVeto(
  conversationId: string,
  draftId: string,
  by: SupportActor,
): Promise<Result<{ draft: SupportDraft }>> {
  const result = await settleDraft(conversationId, draftId, by, (d) => {
    if (d.state !== "veto") return fail(409, "No veto window is open");
    return {
      ...d,
      state: "needs-person",
      rule: `Stopped by ${actorLabel(by)}`,
      vetoDeadline: null,
      decidedBy: by,
    };
  });
  if (result.ok)
    await auditSettled("support.reply.stopped", conversationId, result.draft, by);
  return result;
}

async function auditSettled(
  type: "support.reply.stopped" | "support.reply.discarded",
  conversationId: string,
  draft: SupportDraft,
  by: SupportActor,
): Promise<void> {
  const c = await getConversation(conversationId).catch(() => null);
  await audit({
    type,
    conversationId,
    inboxId: c?.inboxId ?? null,
    channel: c?.channel ?? null,
    draftId: draft.id,
    author: draft.author.kind,
    ...auditActor(by),
    textDigest: digest(draft.text),
  });
}

async function settleDraft(
  conversationId: string,
  draftId: string,
  by: SupportActor,
  change: (d: SupportDraft) => SupportDraft | Failure,
): Promise<Result<{ draft: SupportDraft }>> {
  if (by.kind !== "person") return fail(409, "Only a person can do this");
  let failure: Failure | null = null;
  let next: SupportDraft | null = null;
  const committed = await updateConversation(conversationId, (c) => {
    failure = null;
    next = null;
    if (c.draft?.id !== draftId) {
      failure = c.messages.some((m) => m.draftId === draftId)
        ? fail(409, "This reply was already sent")
        : fail(404, "Draft not found");
      return null;
    }
    const result = change(c.draft);
    if ("ok" in result) {
      failure = result;
      return null;
    }
    next = result;
    return { ...c, draft: result };
  });
  const draft = next as SupportDraft | null;
  if (!committed || !draft)
    return failure ?? fail(404, "Conversation not found");
  await reconcileVetoKey(conversationId);
  return { ok: true, draft };
}

// ── Audit ────────────────────────────────────────────────────────────────

function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name} ${code}` : error.name;
  }
  return typeof error;
}

/** Durable before the caller reports the outcome; a failing audit write is
 *  logged, never turned into a failed send (the mail went out). */
async function audit(event: Record<string, unknown>): Promise<void> {
  try {
    await supportAudit(event);
  } catch (error) {
    console.error("[support] audit write failed:", errorName(error));
  }
}
