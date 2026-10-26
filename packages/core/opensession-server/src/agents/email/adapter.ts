// The email channel adapter for one inbox: IMAP in (imap-transport.ts, with
// its UID cursor in `support-cursors`), SMTP out (smtp-transport.ts, built
// on the first send) and the inbox's mailbox behaviour after a conversation
// is handled. The Task 0 SupportChannelAdapter seam; the only caller of
// `send` is sendDraft (support/reply.ts).
//
// Mailbox actions never fail a send or a status change: a failed one is
// logged (inbox id and error code only) and dropped. The adapter keeps the
// inbox config it was given; EmailAgent replaces it in place with update()
// for fields that need no new IMAP connection (a change to the address,
// the send limit or the SMTP server builds a new SMTP pool only), and
// builds a new adapter for the rest. Health is the IMAP connection's, with
// the last permanent SMTP error as its reason until a send works again.
// Nothing runs at import.

import type { ImapFlow } from "imapflow";
import type {
  InboxConfig,
  InboxHealth,
  SupportConversation,
} from "../../shared/support";
import { catalogDocuments } from "../../server/catalog-documents";
import {
  type InboundSink,
  type OutboundDraft,
  SendError,
  type SentReceipt,
  type SupportChannelAdapter,
} from "../../server/support/channel";
import {
  deleteInboxCursor,
  inboxCursorKey,
  inboxPassword,
  listInboxes,
} from "../../server/support/inboxes";
import {
  type ImapCursor,
  ImapTransport,
  type ImapTransportOptions,
} from "./imap-transport";
import { buildReply } from "./mime";
import { SmtpTransport, appendSentCopy } from "./smtp-transport";

type Which = "imap" | "smtp";

export interface EmailAdapterDeps {
  /** The inbox's password; defaults to its workspace secret. */
  password?: (which: Which) => Promise<string | undefined>;
  /** The other inboxes' addresses, never addressed by a reply; defaults
   *  to every other configured inbox. */
  otherInboxAddresses?: () => Promise<string[]>;
  /** IMAP timing (tests). */
  imap?: Pick<ImapTransportOptions, "autoIdleDelayMs" | "pollMs">;
}

/** The only folder read in v1. */
const FOLDER = "INBOX";
/** disconnect() waits this long for sends and Sent copies in flight, */
const SEND_WAIT_MS = 4_000;
/** and this long in all, under the integration shutdown limit. */
const DISCONNECT_LIMIT_MS = 8_000;

export const IMAP_PASSWORD_MISSING =
  "The IMAP password is missing. Enter it again in the inbox settings";
export const SMTP_PASSWORD_MISSING =
  "The SMTP password is missing. Enter it again in the inbox settings";
const NOT_CONNECTED = "The inbox is reconnecting. Trying again soon";
const WRONG_INBOX = "This draft belongs to another inbox";

// Bound on first use, never at import: the catalog client is a live effect.
let cursorDocs: ReturnType<typeof catalogDocuments> | undefined;
const cursors = () => (cursorDocs ??= catalogDocuments("support-cursors"));

/** The `support-cursors` key of an inbox's folder. */
export const cursorKey = inboxCursorKey;

function isCursor(value: unknown): value is ImapCursor {
  const c = value as ImapCursor | null;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.uidValidity === "string" &&
    typeof c.lastUid === "number" &&
    Number.isInteger(c.lastUid) &&
    c.lastUid >= 0
  );
}

export { deleteInboxCursor };

function log(inboxId: string, event: string, error?: unknown): void {
  const e = error as { code?: unknown; name?: unknown } | null | undefined;
  console.warn(`[email] ${event}`, {
    inboxId,
    ...(error !== undefined
      ? { error: String(e?.code ?? e?.name ?? "error") }
      : {}),
  });
}

/** UIDs of the conversation's messages read from the mailbox as it is now
 *  (mail in, and our own mail "replied outside Sessions"): provider ids
 *  `imap:<uidvalidity>:<uid>` from another UIDVALIDITY name other mail and
 *  are skipped. */
function uidsOf(c: SupportConversation, uidValidity: string): number[] {
  const prefix = `imap:${uidValidity}:`;
  const uids = new Set<number>();
  for (const m of c.messages) {
    if (!m.providerId?.startsWith(prefix)) continue;
    const uid = Number(m.providerId.slice(prefix.length));
    if (Number.isInteger(uid) && uid > 0) uids.add(uid);
  }
  return [...uids].sort((a, b) => a - b);
}

/** The server path of `folder` ("Sessions/Done": "/" separates levels),
 *  created when missing. A server with a personal namespace prefix
 *  ("INBOX.") keeps it under that prefix. */
export async function ensureFolder(
  client: Pick<ImapFlow, "list" | "mailboxCreate" | "namespace">,
  folder: string,
): Promise<string> {
  const segments = folder.split("/").filter(Boolean);
  const prefix = client.namespace?.prefix ?? "";
  const find = async () =>
    (await client.list()).find((f) => {
      const joined = segments.join(f.delimiter || "/");
      return (
        f.path === folder || f.path === joined || f.path === prefix + joined
      );
    });
  const existing = await find();
  if (existing) return existing.path;
  try {
    // An array is joined with the server's delimiter, under its namespace.
    const made = await client.mailboxCreate(segments);
    return made?.path ?? folder;
  } catch (error) {
    // Made by another client since the list, or named in a way the first
    // look missed: the server's list decides.
    const again = await find();
    if (again) return again.path;
    throw error;
  }
}

const SMTP_FIELDS = ["host", "port", "tls", "user", "passwordRef"] as const;

/** Whether `next` sends through a different SMTP pool: the address (EHLO
 *  name and sender), the send limit (the pool's rate), internal hosts or
 *  the SMTP server. */
function smtpChanged(current: InboxConfig, next: InboxConfig): boolean {
  return (
    current.address !== next.address ||
    current.sendLimitPerMinute !== next.sendLimitPerMinute ||
    current.allowInternalHost !== next.allowInternalHost ||
    SMTP_FIELDS.some((f) => current.smtp[f] !== next.smtp[f])
  );
}

/** Waits for `work`, at most `ms`; never throws. */
async function settleWithin(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
}

export class EmailChannelAdapter implements SupportChannelAdapter {
  readonly channel = "email" as const;
  readonly inboxId: string;
  private inbox: InboxConfig;
  private readonly password: (which: Which) => Promise<string | undefined>;
  private readonly otherInboxAddresses: () => Promise<string[]>;
  private readonly imapTiming: EmailAdapterDeps["imap"];
  private imap: ImapTransport | null = null;
  private smtp: Promise<SmtpTransport> | null = null;
  private closed = false;
  private idle: InboxHealth;
  private sink: InboundSink | null = null;
  /** The last permanent send error, until a send works or the SMTP pool
   *  is rebuilt. */
  private smtpError: string | null = null;
  /** Sends and Sent copies in flight. */
  private readonly sends = new Set<Promise<unknown>>();
  private readonly copies = new Set<Promise<unknown>>();

  constructor(inbox: InboxConfig, deps: EmailAdapterDeps = {}) {
    this.inbox = inbox;
    this.inboxId = inbox.id;
    this.password =
      deps.password ?? ((which) => inboxPassword(this.inbox, which));
    this.otherInboxAddresses =
      deps.otherInboxAddresses ??
      (async () =>
        (await listInboxes())
          .filter((i) => i.id !== this.inboxId)
          .map((i) => i.address));
    this.imapTiming = deps.imap;
    this.idle = this.offHealth();
  }

  private offHealth(reason: string | null = null): InboxHealth {
    return {
      state: reason ? "paused" : "off",
      since: new Date().toISOString(),
      reason,
      retryAt: null,
      lastMessageAt: null,
    };
  }

  /** The config this adapter acts on. */
  config(): InboxConfig {
    return this.inbox;
  }

  /** Takes fields that need no new IMAP connection (label, Sent copy,
   *  folders, handling, and the SMTP side: a new address, send limit or
   *  SMTP server builds a new SMTP pool on the next send); EmailAgent
   *  reconnects for the rest. */
  update(inbox: InboxConfig): void {
    if (inbox.id !== this.inboxId) return;
    const previous = this.inbox;
    this.inbox = inbox;
    if (smtpChanged(previous, inbox)) this.rebuildSmtp();
  }

  /** The next send opens a new SMTP pool (a new SMTP password); the old
   *  one closes once the sends in flight settle. */
  rebuildSmtp(): void {
    const old = this.smtp;
    this.smtp = null;
    this.smtpError = null;
    if (!old) return;
    const inFlight = Promise.allSettled([...this.sends]);
    void inFlight
      .then(() => old)
      .then(
        (transport) => transport.close(),
        () => undefined,
      );
  }

  /** Resolves after the first IMAP connect attempt settled. Without an
   *  IMAP password the inbox pauses and nothing connects. */
  async connect(sink: InboundSink): Promise<void> {
    if (this.imap || this.closed) return;
    this.sink = sink;
    const password = await this.password("imap");
    if (this.imap || this.closed) return;
    if (!password) {
      this.idle = this.offHealth(IMAP_PASSWORD_MISSING);
      return;
    }
    const key = cursorKey(this.inboxId);
    this.imap = new ImapTransport({
      inbox: this.inbox,
      password,
      sink,
      loadCursor: async () => {
        const value = await cursors().get(key);
        return isCursor(value) ? value : null;
      },
      saveCursor: async (cursor) => {
        await cursors().set(key, cursor);
      },
      onHealth: () => undefined,
      ...this.imapTiming,
    });
    await this.imap.start();
  }

  /** Tries IMAP again after a pause with no retry planned (someone saved
   *  or tested the inbox): one login. Does nothing while connected,
   *  backing off or after disconnect. */
  async resume(): Promise<void> {
    if (this.closed) return;
    if (this.imap) return this.imap.resume();
    // Paused before connecting (no IMAP password): read it again.
    if (this.sink && this.idle.state === "paused") {
      this.idle = this.offHealth();
      await this.connect(this.sink);
    }
  }

  /** Lets sends and Sent copies in flight finish (bounded), then logs out
   *  and closes the SMTP pool together; at most DISCONNECT_LIMIT_MS in all.
   *  The adapter can't connect again; EmailAgent builds a new one. */
  async disconnect(): Promise<void> {
    if (this.closed && !this.imap && !this.smtp) return;
    this.closed = true;
    const started = Date.now();
    if (this.sends.size || this.copies.size)
      await settleWithin(
        Promise.allSettled([...this.sends, ...this.copies]),
        SEND_WAIT_MS,
      );
    const imap = this.imap;
    const smtp = this.smtp;
    this.imap = null;
    this.smtp = null;
    this.idle = this.offHealth();
    await settleWithin(
      Promise.allSettled([
        imap?.stop(),
        smtp?.then((transport) => transport.close()),
      ]),
      DISCONNECT_LIMIT_MS - (Date.now() - started),
    );
  }

  bringIn(days: number): Promise<number> {
    if (this.closed || !this.imap)
      return Promise.reject(new Error("The inbox is not connected"));
    return this.imap.bringIn(days);
  }

  health(): InboxHealth {
    const health = this.imap ? this.imap.health() : { ...this.idle };
    if (!this.smtpError) return health;
    const sending = `Sending failed: ${this.smtpError}`;
    return {
      ...health,
      reason: health.reason ? `${health.reason}. ${sending}` : sending,
    };
  }

  private smtpTransport(): Promise<SmtpTransport> {
    this.smtp ??= (async () => {
      const password = await this.password("smtp");
      if (!password) throw new SendError(SMTP_PASSWORD_MISSING, true);
      // Closed while the password was read: no pool nobody closes.
      if (this.closed) throw new SendError(NOT_CONNECTED, false);
      return new SmtpTransport({ inbox: this.inbox, password });
    })();
    // A missing password is asked for again on the next send.
    const pending = this.smtp;
    pending.catch(() => {
      if (this.smtp === pending) this.smtp = null;
    });
    return pending;
  }

  /** buildReply → SMTP. Throws SendError. When the inbox keeps a Sent
   *  copy it is appended in the background over the IMAP connection: the
   *  receipt returns as soon as the server took the message, and a failed
   *  copy never fails the send. */
  async send(out: OutboundDraft): Promise<SentReceipt> {
    if (this.closed) throw new SendError(NOT_CONNECTED, false);
    if (out.inbox.id !== this.inboxId) throw new SendError(WRONG_INBOX, true);
    const sending = this.sendNow(out);
    const tracked = sending.then(
      () => undefined,
      () => undefined,
    );
    this.sends.add(tracked);
    void tracked.finally(() => this.sends.delete(tracked));
    try {
      const receipt = await sending;
      this.smtpError = null;
      return receipt;
    } catch (error) {
      if (
        error instanceof SendError &&
        error.permanent &&
        error.message !== NOT_CONNECTED
      )
        this.smtpError = error.message;
      throw error;
    }
  }

  private async sendNow(out: OutboundDraft): Promise<SentReceipt> {
    const inbox = this.inbox;
    const others = await this.otherInboxAddresses().catch(() => []);
    if (this.closed) throw new SendError(NOT_CONNECTED, false);
    const mail = buildReply({ ...out, inbox }, others);
    const smtp = await this.smtpTransport();
    if (this.closed) throw new SendError(NOT_CONNECTED, false);
    const { messageId, raw } = await smtp.send(mail);
    const sentAt = new Date().toISOString();
    const imap = this.imap;
    if (inbox.copyToSent && imap) {
      const copy = appendSentCopy(imap, raw, null).finally(() => {
        this.copies.delete(copy);
      });
      this.copies.add(copy);
    }
    return { messageId, providerId: null, sentAt };
  }

  /** The inbox's mailbox behaviour for a handled or spam conversation:
   *  untouched does nothing; mark-read adds \Seen; move files the messages
   *  in folders.done / folders.spam (created when missing). Only the
   *  conversation's inbound messages from the current UIDVALIDITY. */
  async mark(
    conversation: SupportConversation,
    state: "handled" | "spam",
  ): Promise<void> {
    const { mailbox, folders } = this.inbox;
    if (mailbox === "untouched") return;
    const imap = this.imap;
    if (!imap) {
      log(this.inboxId, "mailbox action skipped, not connected");
      return;
    }
    try {
      await imap.withClient(async (client) => {
        const open = client.mailbox;
        if (!open || open.path !== FOLDER || open.readOnly) {
          log(this.inboxId, "mailbox action skipped, mailbox read-only");
          return;
        }
        const uids = uidsOf(conversation, String(open.uidValidity));
        if (!uids.length) return;
        const range = uids.join(",");
        if (mailbox === "mark-read") {
          await client.messageFlagsAdd(range, ["\\Seen"], { uid: true });
          return;
        }
        const path = await ensureFolder(
          client,
          state === "spam" ? folders.spam : folders.done,
        );
        await client.messageMove(range, path, { uid: true });
      });
    } catch (error) {
      log(this.inboxId, "mailbox action failed", error);
    }
  }
}
