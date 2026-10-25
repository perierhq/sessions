// Test fixture: an in-process IMAP server (hoodiecrow-imap) and SMTP server
// (smtp-server) on ephemeral ports, for the email transport tests. No Docker,
// no network beyond 127.0.0.1. Both accept `testuser` / `testpass`.
// Neither speaks TLS, which is allowed because they are on loopback:
// `imapServer` / `smtpServer` are ready server settings (`tls: "none"`),
// and an inbox using them needs `allowInternalHost: true`.
// Not on any live import chain (excluded from the side-effect scan).
import type { AddressInfo } from "node:net";
import { SMTPServer, type SMTPServerAddress } from "smtp-server";
import type { MailServerConfig } from "../../../shared/support";

export const MAIL_USER = "testuser";
export const MAIL_PASSWORD = "testpass";

export const DEFAULT_IMAP_PLUGINS = [
  "IDLE",
  "CONDSTORE",
  "UIDPLUS",
  "SPECIAL-USE",
  "MOVE",
  "ENABLE",
  "QRESYNC",
];

type FixtureServer = Omit<MailServerConfig, "passwordRef">;

export interface MailFixture {
  imapPort: number;
  smtpPort: number;
  /** Server settings for the fixture's IMAP server: loopback, no TLS. */
  imapServer: FixtureServer;
  /** The same for SMTP. */
  smtpServer: FixtureServer;
  /** The hoodiecrow server (it ships no types), for scripted handlers. */
  imap: any;
  /** Appends to `folder` (INBOX by default) and notifies IDLE sessions. */
  deliver(raw: string, folder?: string): void;
  sent: Array<{ envelope: { from: string; to: string[] }; raw: string }>;
  /** Answer for the next DATA command instead of 250; cleared once used. */
  smtpReply: { code: number; message: string } | null;
  /** Live IMAP connections. */
  connections(): number;
  /** SMTP connections opened so far, and the most open at once. */
  smtpConnections: { opened: number; maxLive: number };
  close(): Promise<void>;
}

function listen(
  server: { listen(port: number, host: string, cb: () => void): unknown },
  address: () => AddressInfo | string | null,
): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      server.listen(0, "127.0.0.1", () => {
        const info = address();
        if (info && typeof info === "object") resolve(info.port);
        else reject(new Error("mail fixture: no port"));
      });
    } catch (error) {
      reject(error);
    }
  });
}

const server = (port: number): FixtureServer => ({
  host: "127.0.0.1",
  port,
  tls: "none",
  user: MAIL_USER,
});

const addressOf = (value: SMTPServerAddress | false) =>
  value ? value.address : "";

export async function startMailFixture(
  opts: {
    plugins?: string[];
    folders?: Record<string, { "special-use"?: string }>;
  } = {},
): Promise<MailFixture> {
  // hoodiecrow is CommonJS without types.
  const hoodiecrow = require("hoodiecrow-imap");
  const folders: Record<string, unknown> = {
    Sent: { "special-use": "\\Sent", messages: [] },
  };
  for (const [name, extra] of Object.entries(opts.folders ?? {}))
    folders[name] = { ...extra, messages: [] };
  const imap = hoodiecrow({
    plugins: opts.plugins ?? DEFAULT_IMAP_PLUGINS,
    storage: {
      INBOX: { messages: [] },
      "": { separator: "/", folders },
    },
  });
  const imapPort = await listen(imap, () => imap.address());

  const sent: MailFixture["sent"] = [];
  const fixture: MailFixture = {
    imapPort,
    smtpPort: 0,
    imapServer: server(imapPort),
    smtpServer: server(0),
    imap,
    deliver(raw, folder = "INBOX") {
      imap.appendMessage(folder, [], new Date(), raw);
    },
    sent,
    smtpReply: null,
    connections: () => imap.connections.size,
    smtpConnections: { opened: 0, maxLive: 0 },
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => imap.close(() => resolve())),
        new Promise<void>((resolve) => smtp.close(() => resolve())),
      ]);
    },
  };

  let smtpLive = 0;
  const smtp = new SMTPServer({
    // A pooled client keeps a connection open; close() waits this long for
    // it (30 s by default) before dropping it.
    closeTimeout: 50,
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onConnect(_session, callback) {
      smtpLive++;
      fixture.smtpConnections.opened++;
      fixture.smtpConnections.maxLive = Math.max(
        fixture.smtpConnections.maxLive,
        smtpLive,
      );
      callback();
    },
    onClose() {
      smtpLive--;
    },
    onAuth(auth, _session, callback) {
      if (auth.username === MAIL_USER && auth.password === MAIL_PASSWORD)
        callback(null, { user: auth.username });
      else callback(new Error("Invalid username or password"));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const reply = fixture.smtpReply;
        if (reply) {
          fixture.smtpReply = null;
          const error = Object.assign(new Error(reply.message), {
            responseCode: reply.code,
          });
          callback(error);
          return;
        }
        sent.push({
          envelope: {
            from: addressOf(session.envelope.mailFrom),
            to: session.envelope.rcptTo.map((r) => r.address),
          },
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        callback();
      });
    },
  });
  try {
    fixture.smtpPort = await listen(smtp, () => smtp.server.address());
    fixture.smtpServer = server(fixture.smtpPort);
  } catch (error) {
    // The IMAP server is already listening: don't leak it.
    await new Promise<void>((resolve) => imap.close(() => resolve()));
    throw error;
  }
  return fixture;
}

/** A small RFC 5322 message for tests. Ids are given without `<>`. */
export function rawMail(input: {
  from: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  headers?: Record<string, string>;
}): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to ?? "help@acme.example.test"}`,
    `Subject: ${input.subject ?? "Help"}`,
    `Date: ${new Date().toUTCString()}`,
  ];
  if (input.messageId) lines.push(`Message-ID: <${input.messageId}>`);
  if (input.inReplyTo) lines.push(`In-Reply-To: <${input.inReplyTo}>`);
  if (input.references?.length)
    lines.push(
      `References: ${input.references.map((r) => `<${r}>`).join(" ")}`,
    );
  for (const [name, value] of Object.entries(input.headers ?? {}))
    lines.push(`${name}: ${value}`);
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text ?? "Hello",
    "",
  );
  return lines.join("\r\n");
}
