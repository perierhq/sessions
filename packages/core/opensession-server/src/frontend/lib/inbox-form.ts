// The inbox form's state and what it sends: a new inbox (`NewInboxInput`),
// a patch of only what changed (`InboxPatch`), the body of a connection
// test, and the words for an inbox's health and a test's result. Pure.
//
// Passwords are never shown back: the fields start empty, and an empty
// field means "keep the stored password", so a patch only carries one the
// person typed.
import { DEFAULT_VETO_MS } from "../../shared/incident-response";
import {
  DEFAULT_NEVER_WITHOUT_A_PERSON,
  DEFAULT_RETENTION,
  DEFAULT_SEND_LIMIT_PER_MINUTE,
  DEFAULT_SUPPORT_AUTONOMY,
  type InboxDraftStats,
  type InboxHealth,
  type InboxPatch,
  type InboxTestBody,
  type InboxTestResult,
  type InboxView,
  MAIL_TLS_MODES,
  type MailTlsMode,
  type MailboxBehaviour,
  type NewInboxInput,
  SUPPORT_AUTONOMY,
  SUPPORT_TOPICS,
  type SupportAutonomy,
  type SupportTopic,
  defaultMailPort,
  noTlsHostAllowed,
  smtpSavesSentItself,
} from "../../shared/support";
import { SUPPORT_AUTONOMY_COPY } from "../../shared/support-copy";

const MINUTE_MS = 60_000;
const DEFAULT_VETO_MINUTES = DEFAULT_VETO_MS / MINUTE_MS;

export type MailServerKind = "imap" | "smtp";

export interface ServerForm {
  host: string;
  port: string;
  tls: MailTlsMode;
  user: string;
  /** Empty keeps the stored password. */
  password: string;
}

export interface InboxFormState {
  label: string;
  address: string;
  project: string;
  /** "" on a new inbox: the server makes whoever connects it the owner. */
  owner: string;
  enabled: boolean;
  autonomy: SupportAutonomy;
  /** Routine only: a routine reply waits `vetoMinutes` so someone can stop
   *  it. Off sends right away (only the instance owner may choose that). */
  routineWaits: boolean;
  vetoMinutes: string;
  neverWithoutAPerson: SupportTopic[];
  mailbox: MailboxBehaviour;
  /** null: the default for the SMTP host (off where it saves Sent itself). */
  copyToSent: boolean | null;
  /** The person set the Sent switch, so a new SMTP host keeps it. */
  copyToSentTouched: boolean;
  sendLimitPerMinute: string;
  conversationDays: string;
  attachmentDays: string;
  allowInternalHost: boolean;
  imap: ServerForm;
  smtp: ServerForm;
}

const SERVER_NAMES: Record<MailServerKind, string> = {
  imap: "IMAP",
  smtp: "SMTP",
};
const SERVERS: MailServerKind[] = ["imap", "smtp"];

function emptyServer(which: MailServerKind): ServerForm {
  return {
    host: "",
    port: String(defaultMailPort(which, "implicit")),
    tls: "implicit",
    user: "",
    password: "",
  };
}

export function emptyInboxForm(project: string, owner: string): InboxFormState {
  return {
    label: "",
    address: "",
    project,
    owner,
    enabled: true,
    autonomy: DEFAULT_SUPPORT_AUTONOMY,
    routineWaits: true,
    vetoMinutes: String(DEFAULT_VETO_MINUTES),
    neverWithoutAPerson: [...DEFAULT_NEVER_WITHOUT_A_PERSON],
    mailbox: "untouched",
    copyToSent: null,
    copyToSentTouched: false,
    sendLimitPerMinute: String(DEFAULT_SEND_LIMIT_PER_MINUTE),
    conversationDays: String(DEFAULT_RETENTION.conversationDays),
    attachmentDays: String(DEFAULT_RETENTION.attachmentDays),
    allowInternalHost: false,
    imap: emptyServer("imap"),
    smtp: emptyServer("smtp"),
  };
}

const serverForm = (server: InboxView["imap"]): ServerForm => ({
  host: server.host,
  port: String(server.port),
  tls: server.tls,
  user: server.user,
  password: "",
});

export function formFromInbox(view: InboxView): InboxFormState {
  return {
    label: view.label,
    address: view.address,
    project: view.project,
    owner: view.owner,
    enabled: view.enabled,
    autonomy: view.autonomy,
    routineWaits: view.vetoMs !== null,
    vetoMinutes: String(
      Math.round((view.vetoMs ?? DEFAULT_VETO_MS) / MINUTE_MS),
    ),
    neverWithoutAPerson: [...view.neverWithoutAPerson],
    mailbox: view.mailbox,
    copyToSent: view.copyToSent,
    copyToSentTouched: false,
    sendLimitPerMinute: String(view.sendLimitPerMinute),
    conversationDays: String(view.retention.conversationDays),
    attachmentDays: String(view.retention.attachmentDays),
    allowInternalHost: view.allowInternalHost,
    imap: serverForm(view.imap),
    smtp: serverForm(view.smtp),
  };
}

/** `form` with one server's fields changed. A new SMTP host decides the
 *  Sent copy again (as the store does), unless the person set the switch. */
export function setServerField(
  form: InboxFormState,
  which: MailServerKind,
  patch: Partial<ServerForm>,
): InboxFormState {
  const next = { ...form, [which]: { ...form[which], ...patch } };
  if (
    which === "smtp" &&
    patch.host !== undefined &&
    patch.host !== form.smtp.host &&
    !form.copyToSentTouched
  )
    next.copyToSent = null;
  return next;
}

/** The security modes the form offers: no TLS only for a server on this
 *  machine, or when it is what the inbox has (so it still reads). */
export function tlsChoices(
  host: string,
  current: MailTlsMode | null,
): MailTlsMode[] {
  return MAIL_TLS_MODES.filter(
    (tls) => tls !== "none" || current === "none" || noTlsHostAllowed(host),
  );
}

/** What the "Save a copy in Sent" switch shows. */
export function effectiveCopyToSent(form: InboxFormState): boolean {
  return form.copyToSent ?? !smtpSavesSentItself(form.smtp.host);
}

/** A whole number typed into a field, or NaN. */
const whole = (value: string): number =>
  /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;

const inRange = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

/** Topics in the shared order, so two selections compare equal. */
const topics = (list: SupportTopic[]) =>
  SUPPORT_TOPICS.filter((topic) => list.includes(topic));

/** Why the form can't be sent yet, or null. The server checks again and
 *  has the last word; these are the mistakes worth catching before. */
export function inboxFormError(
  form: InboxFormState,
  saved: InboxView | null,
): string | null {
  if (!form.label.trim()) return "Name shown to customers is required";
  if (!/^[^\s@]+@[^\s@]+$/.test(form.address.trim()))
    return "Address must be an email address like help@example.test";
  if (!form.project) return "Add a repository first";
  for (const which of SERVERS) {
    const name = SERVER_NAMES[which];
    const server = form[which];
    if (!server.host.trim()) return `${name} server is required`;
    if (!inRange(whole(server.port), 1, 65_535))
      return `${name} port must be a whole number from 1 to 65535`;
    if (server.tls === "none" && !noTlsHostAllowed(server.host))
      return `${name} security can be none only for a server on this machine`;
    if (!server.user.trim()) return `${name} user name is required`;
  }
  for (const which of SERVERS) {
    if (form[which].password) continue;
    if (!saved) return `${SERVER_NAMES[which]} password is required`;
    if (serverMoved(saved[which], form[which]))
      return `Enter the ${SERVER_NAMES[which]} password again for the changed server`;
  }
  if (
    form.autonomy === "routine" &&
    form.routineWaits &&
    !inRange(whole(form.vetoMinutes), 1, 1440)
  )
    return "Wait before sending must be from 1 to 1440 minutes";
  if (!inRange(whole(form.sendLimitPerMinute), 1, 120))
    return "Send limit must be from 1 to 120 a minute";
  const conversation = whole(form.conversationDays);
  const attachment = whole(form.attachmentDays);
  if (!inRange(conversation, 1, 36_500))
    return "Keep conversations for a whole number of days";
  if (!inRange(attachment, 1, 36_500))
    return "Keep attachments for a whole number of days";
  if (attachment > conversation)
    return "Attachments can't be kept longer than conversations";
  return null;
}

const serverInput = (server: ServerForm) => ({
  host: server.host.trim(),
  port: whole(server.port),
  tls: server.tls,
  user: server.user.trim(),
});

/** POST body for a new inbox. Call after `inboxFormError` says null. */
export function newInboxFromForm(form: InboxFormState): NewInboxInput {
  const input: NewInboxInput = {
    label: form.label.trim(),
    address: form.address.trim().toLowerCase(),
    project: form.project,
    enabled: form.enabled,
    autonomy: form.autonomy,
    neverWithoutAPerson: topics(form.neverWithoutAPerson),
    mailbox: form.mailbox,
    sendLimitPerMinute: whole(form.sendLimitPerMinute),
    retention: {
      conversationDays: whole(form.conversationDays),
      attachmentDays: whole(form.attachmentDays),
    },
    imap: { ...serverInput(form.imap), password: form.imap.password },
    smtp: { ...serverInput(form.smtp), password: form.smtp.password },
  };
  if (form.autonomy === "routine") input.vetoMs = routineVetoMs(form);
  if (form.owner) input.owner = form.owner;
  if (form.allowInternalHost) input.allowInternalHost = true;
  if (form.copyToSent !== null) input.copyToSent = form.copyToSent;
  return input;
}

/** The veto window a routine inbox saves: the minutes as ms, or null when
 *  routine replies send right away. */
function routineVetoMs(form: InboxFormState): number | null {
  return form.routineWaits ? whole(form.vetoMinutes) * MINUTE_MS : null;
}

/** Whether a server's host, port, security or user differs from the
 *  saved one: the stored password won't be sent there. */
export function serverMoved(
  saved: InboxView["imap"],
  form: ServerForm,
): boolean {
  const next = serverInput(form);
  return (
    next.host !== saved.host ||
    next.port !== saved.port ||
    next.tls !== saved.tls ||
    next.user !== saved.user
  );
}

/** The server fields that differ from the saved ones, plus a typed
 *  password; null when nothing changed. */
function serverPatch(
  saved: InboxView["imap"],
  form: ServerForm,
): NonNullable<InboxPatch["imap"]> | null {
  const next = serverInput(form);
  const patch: NonNullable<InboxPatch["imap"]> = {};
  if (next.host !== saved.host) patch.host = next.host;
  if (next.port !== saved.port) patch.port = next.port;
  if (next.tls !== saved.tls) patch.tls = next.tls;
  if (next.user !== saved.user) patch.user = next.user;
  if (form.password) patch.password = form.password;
  return Object.keys(patch).length ? patch : null;
}

/** Only what changed, against the revision the form was opened at. Call
 *  after `inboxFormError` says null. */
export function patchFromForm(
  view: InboxView,
  form: InboxFormState,
): InboxPatch {
  const patch: InboxPatch = { expectedRevision: view.revision };
  const label = form.label.trim();
  if (label !== view.label) patch.label = label;
  const address = form.address.trim().toLowerCase();
  if (address !== view.address) patch.address = address;
  if (form.project !== view.project) patch.project = form.project;
  if (form.owner && form.owner !== view.owner) patch.owner = form.owner;
  if (form.enabled !== view.enabled) patch.enabled = form.enabled;
  if (form.autonomy !== view.autonomy) patch.autonomy = form.autonomy;
  if (form.autonomy === "routine") {
    const vetoMs = routineVetoMs(form);
    if (vetoMs !== view.vetoMs) patch.vetoMs = vetoMs;
  }
  const never = topics(form.neverWithoutAPerson);
  if (never.join() !== topics(view.neverWithoutAPerson).join())
    patch.neverWithoutAPerson = never;
  if (form.mailbox !== view.mailbox) patch.mailbox = form.mailbox;
  if (form.copyToSent !== null && form.copyToSent !== view.copyToSent)
    patch.copyToSent = form.copyToSent;
  const limit = whole(form.sendLimitPerMinute);
  if (limit !== view.sendLimitPerMinute) patch.sendLimitPerMinute = limit;
  const retention = {
    conversationDays: whole(form.conversationDays),
    attachmentDays: whole(form.attachmentDays),
  };
  if (
    retention.conversationDays !== view.retention.conversationDays ||
    retention.attachmentDays !== view.retention.attachmentDays
  )
    patch.retention = retention;
  if (form.allowInternalHost !== view.allowInternalHost)
    patch.allowInternalHost = form.allowInternalHost;
  for (const which of SERVERS) {
    const server = serverPatch(view[which], form[which]);
    if (server) patch[which] = server;
  }
  return patch;
}

/** Whether the form holds edits Save would send. */
export function formChanged(view: InboxView, form: InboxFormState): boolean {
  return Object.keys(patchFromForm(view, form)).length > 1;
}

/** What Test connection sends: a saved inbox by id, with any server the
 *  person changed as typed; a new inbox's servers with their passwords. */
export function testBodyFromForm(
  form: InboxFormState,
  view: InboxView | null,
): InboxTestBody {
  if (!view) {
    const body: InboxTestBody = {
      address: form.address.trim().toLowerCase(),
      imap: { ...serverInput(form.imap), password: form.imap.password },
      smtp: { ...serverInput(form.smtp), password: form.smtp.password },
    };
    if (form.allowInternalHost) body.allowInternalHost = true;
    return body;
  }
  const body: InboxTestBody = { inboxId: view.id };
  if (form.allowInternalHost && !view.allowInternalHost)
    body.allowInternalHost = true;
  for (const which of SERVERS) {
    if (!serverPatch(view[which], form[which])) continue;
    const server: NonNullable<InboxTestBody["imap"]> = serverInput(form[which]);
    if (form[which].password) server.password = form[which].password;
    body[which] = server;
  }
  return body;
}

/** The status line under an inbox's name in the list. */
export function inboxStatusLine(inbox: InboxView, locale?: string): string {
  if (!inbox.enabled) return "Turned off";
  if (inbox.health.state === "off") return "Not connected yet";
  return healthLine(inbox.health, locale);
}

/** The health line under an inbox's name. */
export function healthLine(health: InboxHealth, locale?: string): string {
  switch (health.state) {
    case "live":
      return "Connected";
    case "polling":
      return "Checking mail every 5 minutes";
    case "connecting":
      return "Connecting";
    case "backing-off": {
      if (!health.retryAt) return "Reconnecting";
      const clock = new Date(health.retryAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return `Reconnecting at ${clock}`;
    }
    case "paused":
      return health.reason ? `Paused: ${health.reason}` : "Paused";
    default:
      return "Off";
  }
}

export interface TestResultLines {
  imap: string;
  smtp: string;
}

/** The two lines a connection test shows. */
export function testResultLines(result: InboxTestResult): TestResultLines {
  const imap = result.imap.ok
    ? result.imap.idle
      ? "IMAP: Connected. Supports instant delivery (IDLE)"
      : "IMAP: Connected. No instant delivery, so Sessions checks every 5 minutes"
    : `IMAP: ${result.imap.error}`;
  const smtp = result.smtp.ok
    ? "SMTP: Connected"
    : `SMTP: ${result.smtp.error}`;
  return { imap, smtp };
}

/** Whether to warn that routine replies can carry what its connectors
 *  return (prompt injection through connector output). */
export function showsConnectorWarning(
  autonomy: SupportAutonomy,
  projectHasSupportConnectors: boolean,
): boolean {
  return projectHasSupportConnectors && autonomy === "routine";
}

/** The autonomy choices in the form, each with its one line. */
export const AUTONOMY_CHOICES: ReadonlyArray<{
  value: SupportAutonomy;
  label: string;
  description: string;
}> = SUPPORT_AUTONOMY.map((value) => ({
  value,
  ...SUPPORT_AUTONOMY_COPY[value],
}));

/** An autonomy's name, as the form's choice reads. */
export function autonomyLabel(value: SupportAutonomy): string {
  return AUTONOMY_CHOICES.find((c) => c.value === value)?.label ?? value;
}

/** "12 of 15 drafts sent unchanged in the last 30 days": how often the
 *  agent's drafts went out as written, next to the autonomy choice. */
export function draftStatsLine(stats: InboxDraftStats): string {
  const total = stats.sentUnchanged + stats.sentEdited + stats.discarded;
  if (total === 0) return `No drafts in the last ${stats.days} days`;
  const noun = total === 1 ? "draft" : "drafts";
  return `${stats.sentUnchanged} of ${total} ${noun} sent unchanged in the last ${stats.days} days`;
}

/** Why the "Wait before sending" switch can't be turned off: sending
 *  right away is the instance owner's call. null when it can. */
export function routineWaitLocked(
  form: InboxFormState,
  saved: InboxView | null,
  isInstanceOwner: boolean,
): string | null {
  if (isInstanceOwner) return null;
  // Already sending right away (the owner chose it): it stays as it is.
  if (saved?.autonomy === "routine" && saved.vetoMs === null) return null;
  return form.routineWaits
    ? "Only the instance owner can let routine replies send right away"
    : null;
}

/** "Deleted 2 conversations, 1 session and 3 attachments". */
export function forgetSummary(result: {
  conversations: number;
  sessions: number;
  attachments: number;
}): string {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return `Deleted ${count(result.conversations, "conversation")}, ${count(result.sessions, "session")} and ${count(result.attachments, "attachment")}`;
}
