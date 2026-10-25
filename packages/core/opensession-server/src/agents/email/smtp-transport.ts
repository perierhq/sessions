// SMTP out for one inbox: one pooled nodemailer connection
// (`maxConnections: 1`) with the inbox's send limit, a Sent copy over the
// inbox's IMAP connection, and the inbox form's Test login.
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
import { SendError } from "../../server/support/channel";
import {
  MAIL_HOST_REFUSED,
  MAIL_TLS_NONE_REFUSED,
  type MailHostPolicy,
  MailHostRefusedError,
  resolveMailHost,
} from "../../server/support/mail-host";
import type { ImapTransport } from "./imap-transport";
import { type OutgoingMail, composeRaw } from "./mime";

const CONNECT_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 120_000;
const MINUTE_MS = 60_000;

type Server = Omit<MailServerConfig, "passwordRef">;

const COPY = {
  auth: "The mail server refused the login",
  tls: "The mail server didn't offer a secure connection",
  network: "Can't reach the mail server",
  timeout: "The mail server didn't answer in time",
  other: "Couldn't send the message",
};

function field(err: unknown, name: string): unknown {
  return err && typeof err === "object"
    ? (err as Record<string, unknown>)[name]
    : undefined;
}

/** 4xx, connection and timeout errors → transient; 5xx, auth, envelope,
 *  TLS and refused-address errors → permanent. Anything unknown is
 *  transient (the caller's retries are bounded). */
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
    code === "ETLS" ||
    /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/.test(code)
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
  if (code === "ETIMEDOUT") return new SendError(COPY.timeout, false);
  if (
    code === "ECONNECTION" ||
    code === "ESOCKET" ||
    code === "EDNS" ||
    /^(ECONN|EHOST|ENET|ENOTFOUND|EAI_|EPIPE)/.test(code)
  )
    return new SendError(COPY.network, false);
  return new SendError(COPY.other, false);
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
      pinnedSocket(server, policy).then(
        (connection) => callback(null, { connection }),
        (err: Error) => callback(err),
      );
    },
  };
}

export class SmtpTransport {
  private readonly transporter;

  constructor(opts: {
    inbox: InboxConfig;
    password: string;
    rateDeltaMs?: number;
  }) {
    const { inbox } = opts;
    this.transporter = createTransport({
      pool: true,
      maxConnections: 1,
      rateLimit: Math.max(1, inbox.sendLimitPerMinute),
      rateDelta: opts.rateDeltaMs ?? MINUTE_MS,
      ...connectionOptions(
        inbox.smtp,
        opts.password,
        { allowInternalHost: inbox.allowInternalHost },
        domainOf(inbox.address),
      ),
    } as Parameters<typeof createTransport>[0] & { pool: true });
  }

  /** Throws SendError. `raw` is what went out, for the Sent copy. */
  async send(
    mail: OutgoingMail,
  ): Promise<{ messageId: string; accepted: string[]; raw: Uint8Array }> {
    let raw: Uint8Array;
    try {
      raw = await composeRaw(mail);
    } catch {
      throw new SendError("Couldn't build the message", true);
    }
    try {
      const info = await this.transporter.sendMail({
        envelope: {
          from: mail.from.address,
          to: mail.to.map((a) => a.address),
        },
        raw: Buffer.from(raw),
      });
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

/** Appends `raw` to the \Sent special-use folder, else `folderHint`, else
 *  "Sent", marked seen. False on any failure (logged, without the text). */
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
 *  Never returns the password or the server's text. */
export async function testSmtpLogin(
  server: Server,
  password: string,
  policy: MailHostPolicy,
): Promise<{ ok: true } | { ok: false; permanent: boolean; error: string }> {
  let transporter: ReturnType<typeof createTransport> | null = null;
  try {
    transporter = createTransport(
      connectionOptions(server, password, policy, domainOf(server.user)),
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
