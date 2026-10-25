// The email channel adapter for one inbox: IMAP in (imap-transport.ts, with
// its UID cursor in `support-cursors`), SMTP out (smtp-transport.ts, built
// on the first send) and the inbox's mailbox behaviour after a conversation
// is handled. The Task 0 SupportChannelAdapter seam; the only caller of
// `send` is sendDraft (support/reply.ts).
//
// Mailbox actions never fail a send or a status change: a failed one is
// logged (inbox id and error code only) and dropped. The adapter keeps the
// inbox config it was given; EmailAgent replaces it in place with update()
// for fields that need no new connection, and builds a new adapter for the
// rest. Nothing runs at import.

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
import { inboxPassword, listInboxes } from "../../server/support/inboxes";
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
/** disconnect() waits this long for Sent copies still being appended. */
const COPY_WAIT_MS = 5_000;

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
export const cursorKey = (inboxId: string, folder = FOLDER) =>
  `${inboxId}:${folder}`;

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

/** Drops an inbox's cursor (the inbox was removed). */
export async function deleteInboxCursor(inboxId: string): Promise<void> {
  await cursors().delete(cursorKey(inboxId));
}

function log(inboxId: string, event: string, error?: unknown): void {
  const e = error as { code?: unknown; name?: unknown } | null | undefined;
  console.warn(`[email] ${event}`, {
    inboxId,
    ...(error !== undefined
      ? { error: String(e?.code ?? e?.name ?? "error") }
      : {}),
  });
}

/** UIDs of the conversation's inbound messages in the mailbox as it is
 *  now: provider ids `imap:<uidvalidity>:<uid>` from another UIDVALIDITY
 *  name other mail and are skipped. */
function uidsOf(c: SupportConversation, uidValidity: string): number[] {
  const prefix = `imap:${uidValidity}:`;
  const uids = new Set<number>();
  for (const m of c.messages) {
    if (m.direction !== "in" || !m.providerId?.startsWith(prefix)) continue;
    const uid = Number(m.providerId.slice(prefix.length));
    if (Number.isInteger(uid) && uid > 0) uids.add(uid);
  }
  return [...uids].sort((a, b) => a - b);
}

/** The server path of `folder` ("Sessions/Done": "/" separates levels),
 *  created when missing. */
async function ensureFolder(client: ImapFlow, folder: string): Promise<string> {
  const segments = folder.split("/").filter(Boolean);
  const existing = (await client.list()).find(
    (f) => f.path === folder || f.path === segments.join(f.delimiter || "/"),
  );
  if (existing) return existing.path;
  // An array is joined with the server's delimiter, under its namespace.
  const made = await client.mailboxCreate(segments);
  return made?.path ?? folder;
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
  /** Sent copies still being appended. */
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

  /** Takes fields that need no new connection (label, Sent copy, folders,
   *  handling); EmailAgent reconnects for the rest. */
  update(inbox: InboxConfig): void {
    if (inbox.id === this.inboxId) this.inbox = inbox;
  }

  /** Resolves after the first IMAP connect attempt settled. Without an
   *  IMAP password the inbox pauses and nothing connects. */
  async connect(sink: InboundSink): Promise<void> {
    if (this.imap || this.closed) return;
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

  /** Waits for Sent copies (bounded), logs out, closes the SMTP pool. The
   *  adapter can't connect again; EmailAgent builds a new one. */
  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.copies.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.copies]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, COPY_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    const imap = this.imap;
    const smtp = this.smtp;
    this.imap = null;
    this.smtp = null;
    this.idle = this.offHealth();
    await imap?.stop();
    if (smtp) (await smtp.catch(() => null))?.close();
  }

  health(): InboxHealth {
    return this.imap ? this.imap.health() : { ...this.idle };
  }

  private smtpTransport(): Promise<SmtpTransport> {
    this.smtp ??= (async () => {
      const password = await this.password("smtp");
      if (!password) throw new SendError(SMTP_PASSWORD_MISSING, true);
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
    const inbox = this.inbox;
    const mail = buildReply(
      { ...out, inbox },
      await this.otherInboxAddresses().catch(() => []),
    );
    const smtp = await this.smtpTransport();
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
        if (!open || open.path !== FOLDER || open.readOnly) return;
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
