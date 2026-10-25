// Wire types for support channels (email today, Plain and webhooks later),
// shared by the server and the frontend: inbound messages from a transport,
// stored conversations and drafts, inbox configuration and its views, the
// Support list rows and the CloudEvent published for each customer message.
// Types, constant lists and small pure helpers only.

import { type AutonomyLevel, DEFAULT_VETO_MS } from "./incident-response";

export type SupportChannelKind = "email" | "plain" | (string & {});

/** `address` is trimmed and lowercased. */
export interface MailAddress {
  name: string | null;
  address: string;
}

/** RFC 5322 threading keys: ids without `<>`, domain part lowercased. */
export interface ThreadKeys {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

export interface AttachmentMeta {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  stored: boolean;
  expiresAt: string | null;
}

/** What a transport hands to ingest. Untrusted throughout. */
export interface InboundMessage {
  inboxId: string;
  channel: SupportChannelKind;
  /** email: `imap:<uidvalidity>:<uid>` */
  providerId: string;
  receivedAt: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  /** text/plain, else HTML rendered as text; at most MAX_TEXT_CHARS. */
  text: string;
  keys: ThreadKeys;
  /** Lowercased names to values, only: auto-submitted, precedence, list-id,
   *  list-unsubscribe, x-autoreply, x-auto-response-suppress, return-path,
   *  authentication-results. */
  loopHeaders: Record<string, string>;
  attachments: Array<AttachmentMeta & { content?: Uint8Array }>;
  /** Source over MAX_SOURCE_BYTES: headers only. */
  oversize?: true;
  /** The body couldn't be parsed: headers only, with a stub text. */
  unreadable?: true;
}

export type SupportActor =
  | { kind: "customer" }
  | { kind: "agent"; sessionId: string }
  | { kind: "person"; name: string }
  | { kind: "sessions" };

export interface SupportMessage {
  id: string;
  direction: "in" | "out";
  at: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  /** Inbound only, when the message had a Reply-To: where a reply goes. */
  replyTo?: MailAddress[];
  subject: string;
  /** null once retention removed it. */
  text: string | null;
  keys: ThreadKeys;
  providerId: string | null;
  attachments: AttachmentMeta[];
  sentBy?: SupportActor;
  draftId?: string;
  automated?: true;
  /** Inbound only. Set by ingest from headers; a send to this message needs
   *  a person when either is true. */
  trust?: { replyToDiffers: boolean; authFailed: boolean };
}

export const TRIAGE_ROUTES = ["spam", "simple", "work"] as const;
export type TriageRoute = (typeof TRIAGE_ROUTES)[number];

export const SUPPORT_TOPICS = [
  "refund",
  "account-deletion",
  "legal",
  "angry-customer",
] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export interface TriageVerdict {
  route: TriageRoute;
  reason: string;
  /** null = unknown (classifier failed): every send needs a person. */
  topics: SupportTopic[] | null;
  bug: boolean;
  at: string;
  failed?: true;
}

export const DRAFT_STATES = [
  "needs-person",
  "veto",
  "sending",
  "sent",
  "discarded",
  "failed",
] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export interface SupportDraft {
  id: string;
  text: string;
  author: SupportActor;
  createdAt: string;
  state: DraftState;
  /** Why this state, shown in the reply box. */
  rule: string;
  vetoDeadline: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Our Message-ID, fixed at draft time. */
  messageId: string;
  decidedBy: SupportActor | null;
}

export type ConversationStatus = "open" | "waiting" | "closed" | "spam";

export interface SupportConversation {
  /** `sc_<uuidv7>` */
  id: string;
  channel: SupportChannelKind;
  inboxId: string;
  project: string;
  subject: string;
  customer: MailAddress;
  status: ConversationStatus;
  owner: string | null;
  createdAt: string;
  lastMessageAt: string;
  closedAt: string | null;
  triage: TriageVerdict | null;
  sessionId: string | null;
  fixSessionId: string | null;
  /** At most MAX_MESSAGES; the oldest are dropped from the document and
   *  kept nowhere else. */
  messages: SupportMessage[];
  /** At most one live draft. */
  draft: SupportDraft | null;
  /** Times of automatic sends within the last hour. */
  autoSends: string[];
  moves: Array<{
    at: string;
    from: string;
    to: string;
    by: SupportActor;
    reason: string;
  }>;
  issue: { repo: string; number: number; url: string } | null;
  pendingIssue: {
    title: string;
    body: string;
    requestedBy: SupportActor;
  } | null;
  events: Array<{
    at: string;
    kind: string;
    actor: SupportActor;
    detail: string;
  }>;
  revision: number;
}

/** One row of `support-index`: the list projection and the sweeps' work index. */
export interface SupportIndexRow {
  id: string;
  channel: SupportChannelKind;
  inboxId: string;
  project: string;
  subject: string;
  preview: string;
  customer: MailAddress;
  status: ConversationStatus;
  owner: string | null;
  lastMessageAt: string;
  closedAt: string | null;
  draftState: DraftState | null;
  vetoDeadline: string | null;
  sessionId: string | null;
  unansweredSince: string | null;
  /** Earliest stored attachment expiry, for the retention sweep. */
  attachmentsExpireAt: string | null;
}

export const MAILBOX_BEHAVIOURS = ["untouched", "mark-read", "move"] as const;
export type MailboxBehaviour = (typeof MAILBOX_BEHAVIOURS)[number];

export const BUG_HANDLING = ["off", "issue", "issue-and-agent"] as const;
export type BugHandling = (typeof BUG_HANDLING)[number];

export interface InboxRetention {
  conversationDays: number;
  attachmentDays: number;
}

/** How a mail server connection is protected:
 *  - `implicit`: TLS from the first byte (IMAP 993, SMTP 465).
 *  - `starttls`: plain connect, then STARTTLS, which is required: a server
 *    that doesn't offer it is refused before the password is sent
 *    (imapflow `doSTARTTLS: true`, nodemailer `requireTLS: true`).
 *  - `none`: no TLS at all (imapflow `doSTARTTLS: false`, nodemailer
 *    `ignoreTLS: true`); only for a server on this machine, such as a
 *    local mail bridge. */
export const MAIL_TLS_MODES = ["implicit", "starttls", "none"] as const;
export type MailTlsMode = (typeof MAIL_TLS_MODES)[number];

const DEFAULT_MAIL_PORTS: Record<
  "imap" | "smtp",
  Record<MailTlsMode, number>
> = {
  imap: { implicit: 993, starttls: 143, none: 143 },
  smtp: { implicit: 465, starttls: 587, none: 587 },
};

/** The usual port for a server and TLS mode, for forms. */
export function defaultMailPort(
  which: "imap" | "smtp",
  tls: MailTlsMode,
): number {
  return DEFAULT_MAIL_PORTS[which][tls];
}

export interface MailServerConfig {
  host: string;
  port: number;
  tls: MailTlsMode;
  user: string;
  /** Opaque workspace-secrets ref; never the password itself. */
  passwordRef: string | null;
}

export interface InboxConfig {
  /** `inb_<uuidv7>` */
  id: string;
  label: string;
  address: string;
  channel: "email";
  enabled: boolean;
  project: string;
  moveLock: "agent" | "people";
  autonomy: AutonomyLevel;
  vetoMs: number;
  neverWithoutAPerson: SupportTopic[];
  bugHandling: BugHandling;
  mailbox: MailboxBehaviour;
  folders: { done: string; spam: string };
  copyToSent: boolean;
  retention: InboxRetention;
  owner: string;
  sendLimitPerMinute: number;
  /** Whether the mail servers may be on loopback, a private network or the
   *  tailnet. Link-local and cloud metadata addresses are never allowed.
   *  Only the instance owner may turn it on. */
  allowInternalHost: boolean;
  imap: MailServerConfig;
  smtp: MailServerConfig;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  revision: number;
}

export type InboxHealthState =
  | "off"
  | "connecting"
  | "live"
  | "polling"
  | "backing-off"
  | "paused";

export interface InboxHealth {
  state: InboxHealthState;
  since: string;
  reason: string | null;
  retryAt: string | null;
  lastMessageAt: string | null;
}

type ServerView = Omit<MailServerConfig, "passwordRef"> & {
  hasPassword: boolean;
};
export type InboxView = Omit<InboxConfig, "imap" | "smtp"> & {
  imap: ServerView;
  smtp: ServerView;
  health: InboxHealth;
};

type ServerPatch = Partial<Omit<MailServerConfig, "passwordRef">> & {
  password?: string;
};
export type InboxPatch = { expectedRevision: number } & Partial<
  Omit<
    InboxConfig,
    | "id"
    | "channel"
    | "imap"
    | "smtp"
    | "createdAt"
    | "createdBy"
    | "updatedAt"
    | "updatedBy"
    | "revision"
  >
> & { imap?: ServerPatch; smtp?: ServerPatch };

/** One row of the Support list, any channel. */
export interface SupportListItem {
  /** supportItemId(channel, providerId) */
  id: string;
  channel: SupportChannelKind;
  title: string;
  preview: string;
  customer: { name: string | null; email: string | null };
  priority: number | null;
  status: string | null;
  at: string | null;
  inbox: { id: string; label: string } | null;
  project: string | null;
  draftState: DraftState | null;
  vetoDeadline: string | null;
  sessionId: string | null;
}

/** GET /api/support/conversations/:id. Attachment bytes come from a separate route. */
export interface SupportConversationView {
  conversation: SupportConversation;
  inbox: Pick<
    InboxConfig,
    "id" | "label" | "address" | "autonomy" | "moveLock" | "bugHandling"
  > | null;
}

export const SUPPORT_EVENT_KEY = "support:message_received";
export const SUPPORT_EVENT_TYPE = "support.message.received";

/** CloudEvents 1.0. `data` carries ids, subject and customer, never the body. */
export interface SupportCloudEvent {
  specversion: "1.0";
  type: typeof SUPPORT_EVENT_TYPE;
  /** `sessions/support/<inboxId>` */
  source: string;
  id: string;
  time: string;
  datacontenttype: "application/json";
  data: {
    conversationId: string;
    inboxId: string;
    channel: SupportChannelKind;
    project: string;
    messageId: string;
    subject: string;
    customer: string;
    isNewConversation: boolean;
  };
}

export const DEFAULT_SUPPORT_AUTONOMY: AutonomyLevel = "propose";
export const DEFAULT_NEVER_WITHOUT_A_PERSON: SupportTopic[] = [
  ...SUPPORT_TOPICS,
];
export const DEFAULT_RETENTION: InboxRetention = {
  conversationDays: 180,
  attachmentDays: 30,
};
export const DEFAULT_SEND_LIMIT_PER_MINUTE = 30;
export const DEFAULT_FOLDERS = {
  done: "Sessions/Done",
  spam: "Sessions/Spam",
} as const;
export const AUTO_SENDS_PER_HOUR = 3;
export const MAX_MESSAGES = 500;
/** Per message. */
export const MAX_TEXT_CHARS = 50_000;
/** Under the catalog's 4 MB value limit. */
export const MAX_DOC_BYTES = 3 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const IMAP_POLL_MS = 300_000;
export const BACKOFF_MIN_MS = 30_000;
export const BACKOFF_MAX_MS = 900_000;

export function normalizeAddress(raw: {
  name?: string | null;
  address?: string | null;
}): MailAddress | null {
  const address = raw.address?.trim().toLowerCase();
  if (!address) return null;
  const name = raw.name?.trim();
  return { name: name ? name : null, address };
}

/** Strips `<>`, trims, lowercases the domain part; null when empty or no `@`. */
export function normalizeMessageId(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  let id = raw.trim();
  if (id.startsWith("<")) id = id.slice(1);
  if (id.endsWith(">")) id = id.slice(0, -1);
  id = id.trim();
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  return `${id.slice(0, at)}@${id.slice(at + 1).toLowerCase()}`;
}

export function supportItemId(
  channel: SupportChannelKind,
  providerId: string,
): string {
  return `${channel}:${providerId}`;
}

export function parseSupportItemId(
  raw: string,
): { channel: SupportChannelKind; id: string } | null {
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) return null;
  return { channel: raw.slice(0, colon), id: raw.slice(colon + 1) };
}

const SMTP_HOSTS_THAT_SAVE_SENT = new Set([
  "smtp.gmail.com",
  "smtp.office365.com",
  "smtp-mail.outlook.com",
]);

/** Hosts that put SMTP-submitted mail in Sent themselves; an IMAP copy
 *  would be a duplicate. */
export function smtpSavesSentItself(host: string): boolean {
  return SMTP_HOSTS_THAT_SAVE_SENT.has(host.trim().toLowerCase());
}

export function defaultInboxConfig(input: {
  id: string;
  label: string;
  address: string;
  project: string;
  owner: string;
  createdBy: string;
  now: string;
  imap: MailServerConfig;
  smtp: MailServerConfig;
}): InboxConfig {
  return {
    id: input.id,
    label: input.label,
    address: input.address,
    channel: "email",
    enabled: true,
    project: input.project,
    moveLock: "agent",
    autonomy: DEFAULT_SUPPORT_AUTONOMY,
    vetoMs: DEFAULT_VETO_MS,
    neverWithoutAPerson: [...DEFAULT_NEVER_WITHOUT_A_PERSON],
    bugHandling: "off",
    mailbox: "untouched",
    folders: { ...DEFAULT_FOLDERS },
    copyToSent: !smtpSavesSentItself(input.smtp.host),
    retention: { ...DEFAULT_RETENTION },
    owner: input.owner,
    sendLimitPerMinute: DEFAULT_SEND_LIMIT_PER_MINUTE,
    allowInternalHost: false,
    imap: { ...input.imap },
    smtp: { ...input.smtp },
    createdAt: input.now,
    createdBy: input.createdBy,
    updatedAt: input.now,
    updatedBy: input.createdBy,
    revision: 0,
  };
}
