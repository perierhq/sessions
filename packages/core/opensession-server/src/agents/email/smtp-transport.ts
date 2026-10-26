// SMTP out for one inbox: one pooled nodemailer connection
// (`maxConnections: 1`) with the inbox's send limit, a Sent copy over the
// inbox's IMAP connection, and the inbox form's Test login. At most
// `sendLimitPerMinute` sends wait at once (more are refused as busy), each
// has an overall time limit, and a message whose connection drops is never
// sent again by nodemailer (`maxRequeues: 0`): the server may have taken
// it, so the caller decides.
//
// Every connection dials the address server/support/mail-host.ts checked
// (resolve-and-pin, through nodemailer's `getSocket`), keeping the name for
// TLS SNI and the certificate check. TLS mode: implicit → `secure`;
// starttls → `requireTLS` (no AUTH before the upgrade); none → `ignoreTLS`,
// loopback only. Errors leave as SendError with fixed copy: never the
// server's text, which can carry addresses. Retries are the caller's (the
// support tick); nothing runs at import.

import { connect, type Socket } from "node:net";
import { createTransport } from "nodemailer";
import type { MailServerConfig, InboxConfig } from "../../shared/support";
import { INTERRUPTED_SEND, SendError } from "../../server/support/channel";
import {
  MAIL_HOST_REFUSED,
  MAIL_TLS_NONE_REFUSED,
  type MailHostPolicy,
  MailHostRefusedError,
  mailTlsOptions,
  resolveMailHost,
} from "../../server/support/mail-host";
import type { ImapTransport } from "./imap-transport";
import { type OutgoingMail, composeRaw } from "./mime";

const CONNECT_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 120_000;
const MINUTE_MS = 60_000;

type Server = Omit<MailServerConfig, "passwordRef">;

/** No usable address to reply to (permanent). */
export const SMTP_NO_RECIPIENT = "No address to reply to";
/** More sends waiting than the inbox's per-minute limit (transient). */
export const SMTP_SEND_BUSY =
  "Too many messages are waiting to send; trying again soon";
/** The server refused the inbox address as the sender for this login
 *  (Microsoft 365 5.7.60 and similar); permanent. */
export const SMTP_SEND_AS_REFUSED =
  "This account can't send as the inbox address";

/** Send-as refusals by enhanced status code or well-known wording. Matched
 *  against the server's text, which is never shown. */
const SEND_AS =
  /\b5\.7\.60\b|SendAsDenied|not owned by (?:the )?user|(?:not (?:allowed|authori[sz]ed|permitted)|no permission) to send (?:mail )?as\b/i;

const COPY = {
  auth: "The mail server refused the login",
  tls: "The mail server didn't offer a secure connection",
  network: "Can't reach the mail server",
  timeout: "The mail server didn't answer in time",
};

function field(err: unknown, name: string): unknown {
  return err && typeof err === "object"
    ? (err as Record<string, unknown>)[name]
    : undefined;
}

/** Timeouts of the phases before any command (nodemailer's
 *  `timeoutType`): connecting, the greeting, the TLS upgrade. */
const SETUP_TIMEOUTS = new Set([
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);
/** System codes that mean the connection was never made. */
const NO_CONNECTION =
  /^(ECONNREFUSED|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_)/;

/** Whether a failure without an SMTP answer certainly came before the
 *  message was on its way: no connection was made (our pinned dial, DNS,
 *  a refused or unreachable address) or a setup phase timed out. */
function beforeData(err: unknown): boolean {
  if (field(err, "beforeData") === true) return true;
  const code = String(field(err, "code") ?? "");
  if (code === "EDNS") return true;
  if (
    code === "ETIMEDOUT" &&
    SETUP_TIMEOUTS.has(String(field(err, "timeoutType") ?? ""))
  )
    return true;
  return (
    NO_CONNECTION.test(String(field(err, "originalCode") ?? "")) ||
    NO_CONNECTION.test(code)
  );
}

/** An SMTP answer of 4xx (the server said it did not take the message, at
 *  whatever command) and failures certainly before DATA (see beforeData)
 *  → transient; 5xx, auth, envelope, TLS and refused-address errors →
 *  permanent. Anything else — a timeout or broken connection with no
 *  answer, which may come after the server took the message — is
 *  INTERRUPTED_SEND: permanent, never sent again on its own. */
export function classifySmtpError(err: unknown): SendError {
  if (err instanceof SendError) return err;
  const code = String(field(err, "code") ?? "");
  const response = Number(field(err, "responseCode"));
  if (code === "EMAILHOSTREFUSED")
    return new SendError(
      err instanceof Error && err.message === MAIL_TLS_NONE_REFUSED
        ? MAIL_TLS_NONE_REFUSED
        : MAIL_HOST_REFUSED,
      true,
    );
  if (code === "EAUTH") return new SendError(COPY.auth, true);
  if (
    response >= 500 &&
    response < 600 &&
    SEND_AS.test(String(field(err, "response") ?? ""))
  )
    return new SendError(SMTP_SEND_AS_REFUSED, true);
  // nodemailer wraps a failed handshake as ESOCKET and keeps the TLS code
  // in `originalCode`.
  const tlsCode = String(field(err, "originalCode") ?? code);
  if (
    code === "ETLS" ||
    /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(
      tlsCode,
    )
  )
    return new SendError(COPY.tls, true);
  if (response >= 500 && response < 600)
    return new SendError(
      `The mail server refused the message (${response})`,
      true,
    );
  if (response >= 400 && response < 500)
    return new SendError(
      `The mail server deferred the message (${response})`,
      false,
    );
  if (code === "EENVELOPE" || code === "EMESSAGE")
    return new SendError("The mail server refused the message", true);
  if (beforeData(err))
    return new SendError(
      code === "ETIMEDOUT" ? COPY.timeout : COPY.network,
      false,
    );
  return new SendError(INTERRUPTED_SEND, true);
}

/** Opens a TCP connection to the checked address of `server.host`. */
async function pinnedSocket(
  server: Server,
  policy: MailHostPolicy,
): Promise<Socket> {
  const target = await resolveMailHost(server.host, {
    ...policy,
    tls: server.tls,
  });
  if (server.tls === "none" && !target.loopback)
    throw new MailHostRefusedError(MAIL_TLS_NONE_REFUSED);
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: target.address, port: server.port });
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(
          Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }),
        ),
      CONNECT_TIMEOUT_MS,
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

function tlsOptions(server: Server) {
  switch (server.tls) {
    case "implicit":
      return { secure: true };
    case "starttls":
      return { secure: false, requireTLS: true };
    case "none":
      return { secure: false, ignoreTLS: true };
    default:
      throw new MailHostRefusedError(MAIL_TLS_NONE_REFUSED);
  }
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Connection options shared by the pool and the Test login. `name` is the
 *  EHLO name: the sending domain, not this machine's host name. */
function connectionOptions(
  server: Server,
  password: string,
  policy: MailHostPolicy,
  ehloName: string,
) {
  return {
    host: server.host,
    port: server.port,
    ...tlsOptions(server),
    ...(server.user ? { auth: { user: server.user, pass: password } } : {}),
    name: ehloName || "localhost",
    tls: mailTlsOptions(),
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    getSocket(
      _options: unknown,
      callback: (err: Error | null, socket?: { connection: Socket }) => void,
    ) {
      // No connection yet, so nothing was sent: safe to try again.
      pinnedSocket(server, policy).then(
        (connection) => callback(null, { connection }),
        (err: Error) => callback(Object.assign(err, { beforeData: true })),
      );
    },
  };
}

/** The EHLO name: the inbox address's domain, else the login's when it is
 *  an address. */
const ehloFor = (inboxAddress: string, user: string) =>
  domainOf(inboxAddress) || domainOf(user);

/** `work`, or an ETIMEDOUT rejection after `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("send timed out"), { code: "ETIMEDOUT" }),
        ),
      ms,
    );
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export class SmtpTransport {
  private readonly transporter;
  private readonly limit: number;
  private readonly rateDeltaMs: number;
  private readonly sendTimeoutMs: number;
  private inFlight = 0;

  /** `sendTimeoutMs` defaults to one send-limit window plus the connect
   *  and socket timeouts: past it, nodemailer would have failed anyway. */
  constructor(opts: {
    inbox: InboxConfig;
    password: string;
    rateDeltaMs?: number;
    sendTimeoutMs?: number;
  }) {
    const { inbox } = opts;
    this.limit = Math.max(1, inbox.sendLimitPerMinute);
    this.rateDeltaMs = opts.rateDeltaMs ?? MINUTE_MS;
    this.sendTimeoutMs =
      opts.sendTimeoutMs ??
      this.rateDeltaMs + CONNECT_TIMEOUT_MS + SOCKET_TIMEOUT_MS;
    this.transporter = createTransport({
      pool: true,
      maxConnections: 1,
      // A dropped connection after DATA may have delivered the message:
      // never resend it here (the caller's retry is visible and bounded).
      maxRequeues: 0,
      rateLimit: this.limit,
      rateDelta: this.rateDeltaMs,
      ...connectionOptions(
        inbox.smtp,
        opts.password,
        { allowInternalHost: inbox.allowInternalHost },
        ehloFor(inbox.address, inbox.smtp.user),
      ),
    } as Parameters<typeof createTransport>[0] & { pool: true });
  }

  /** Throws SendError: SMTP_NO_RECIPIENT (permanent) for an empty `to`,
   *  SMTP_SEND_BUSY (transient, retryAfterMs = one window) when the
   *  inbox's per-minute limit of sends is already waiting. `raw` is what
   *  went out, for the Sent copy. */
  async send(
    mail: OutgoingMail,
  ): Promise<{ messageId: string; accepted: string[]; raw: Uint8Array }> {
    if (!mail.to.length) throw new SendError(SMTP_NO_RECIPIENT, true);
    if (this.inFlight >= this.limit)
      throw new SendError(SMTP_SEND_BUSY, false, this.rateDeltaMs);
    // Counted from here until nodemailer settles, not until the time
    // limit: a send that timed out still holds its place in the pool.
    this.inFlight++;
    const release = () => {
      this.inFlight--;
    };
    let raw: Uint8Array;
    try {
      raw = await composeRaw(mail);
    } catch {
      release();
      throw new SendError("Couldn't build the message", true);
    }
    const sending = this.transporter.sendMail({
      envelope: {
        from: mail.from.address,
        to: mail.to.map((a) => a.address),
      },
      raw: Buffer.from(raw),
    });
    sending.then(release, release);
    try {
      const info = await within(sending, this.sendTimeoutMs);
      const list = (info.accepted ?? []) as Array<string | { address: string }>;
      const accepted = list.map((a) => (typeof a === "string" ? a : a.address));
      return { messageId: mail.messageId, accepted, raw };
    } catch (err) {
      throw classifySmtpError(err);
    }
  }

  close(): void {
    this.transporter.close();
  }
}

/** The Message-ID of a raw message we composed, without `<>`. */
function rawMessageId(raw: Uint8Array): string | null {
  const text = new TextDecoder().decode(raw.subarray(0, 64 * 1024));
  const head = text.slice(0, text.search(/\r?\n\r?\n/) >>> 0);
  return /^Message-ID:[ \t]*<([^<>\s]+)>/im.exec(head)?.[1] ?? null;
}

/** Whether a message with `messageId` is in `path` already. Selects
 *  `path` read-only, then puts the connection back on the mailbox it had
 *  (INBOX, for the live transport). A failed search counts as absent. */
async function alreadyIn(
  client: Parameters<Parameters<ImapTransport["withClient"]>[0]>[0],
  path: string,
  messageId: string,
): Promise<boolean> {
  const previous =
    client.mailbox && typeof client.mailbox === "object"
      ? { path: client.mailbox.path, readOnly: client.mailbox.readOnly }
      : null;
  try {
    await client.mailboxOpen(path, { readOnly: true });
    const found = await client.search(
      { header: { "message-id": `<${messageId}>` } },
      { uid: true },
    );
    return Array.isArray(found) && found.length > 0;
  } catch {
    return false;
  } finally {
    if (previous && previous.path !== path)
      await client.mailboxOpen(previous.path, {
        readOnly: previous.readOnly,
      });
  }
}

/** Appends `raw` to the \Sent special-use folder, else `folderHint`, else
 *  "Sent", marked seen, unless a message with its Message-ID is there
 *  already (a retry after a lost answer, or the server saved it itself).
 *  False on any failure (logged, without the text). */
export async function appendSentCopy(
  imap: ImapTransport,
  raw: Uint8Array,
  folderHint: string | null,
): Promise<boolean> {
  try {
    await imap.withClient(async (client) => {
      const folders = await client.list();
      const path =
        folders.find((f) => f.specialUse === "\\Sent")?.path ??
        folderHint ??
        "Sent";
      const messageId = rawMessageId(raw);
      if (messageId && (await alreadyIn(client, path, messageId))) return;
      await client.append(path, Buffer.from(raw), ["\\Seen"]);
    });
    return true;
  } catch (err) {
    console.warn("[email] sent copy failed", {
      error: String(field(err, "code") ?? (err as Error)?.name ?? "error"),
    });
    return false;
  }
}

/** One login for the inbox form's Test button (`transporter.verify()`).
 *  `inboxAddress` names the EHLO domain (else the login's, when it is an
 *  address). Never returns the password or the server's text. */
export async function testSmtpLogin(
  server: Server,
  password: string,
  policy: MailHostPolicy,
  inboxAddress = "",
): Promise<{ ok: true } | { ok: false; permanent: boolean; error: string }> {
  let transporter: ReturnType<typeof createTransport> | null = null;
  try {
    transporter = createTransport(
      connectionOptions(
        server,
        password,
        policy,
        ehloFor(inboxAddress, server.user),
      ),
    );
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    const error = classifySmtpError(err);
    return { ok: false, permanent: error.permanent, error: error.message };
  } finally {
    transporter?.close();
  }
}
