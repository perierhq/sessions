// Reconnect pacing for the IMAP transport: full-jitter exponential backoff
// between BACKOFF_MIN_MS and BACKOFF_MAX_MS, and a classification of
// connection errors into the reasons an inbox shows. Auth failures are
// their own kind because the transport never retries them on a timer
// (providers lock accounts after repeated bad logins). Pure.

import { BACKOFF_MAX_MS, BACKOFF_MIN_MS } from "../../shared/support";
import { MAIL_HOST_REFUSED } from "../../server/support/mail-host";

export type PauseKind =
  | "auth"
  | "throttled"
  | "too-many-connections"
  | "alert"
  | "network"
  | "protocol"
  | "address";

export const PAUSE_COPY: Record<PauseKind, string> = {
  auth: "The mail server refused the password. Save a new one to reconnect",
  throttled: "The mail server asked to slow down. Retrying later",
  "too-many-connections":
    "The mail server has too many open connections for this account. Retrying later",
  alert: "The mail server sent an alert. Retrying later",
  network: "Can't reach the mail server. Retrying later",
  protocol: "The mail server gave an unexpected answer. Retrying later",
  address: MAIL_HOST_REFUSED,
};

/** Full jitter: random() * min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2^attempt),
 *  never below BACKOFF_MIN_MS or retryAfterMs. */
export function nextBackoffMs(
  attempt: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 30);
  const window = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** exponent);
  const jittered = Math.floor(random() * window);
  return Math.max(jittered, BACKOFF_MIN_MS, retryAfterMs ?? 0);
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectTLS",
  "ClosedAfterConnectText",
  "PollFailed",
  "ProxyError",
  "EPROXY",
]);

const TOO_MANY_CONNECTIONS =
  /too many (simultaneous |concurrent |open )?connections|maximum number of connections|connection limit/i;

function field(err: unknown, name: string): unknown {
  return err && typeof err === "object"
    ? (err as Record<string, unknown>)[name]
    : undefined;
}

function text(err: unknown, name: string): string {
  const value = field(err, name);
  return typeof value === "string" ? value : "";
}

/** Only server response text and codes are read; never the executed
 *  command, which holds the LOGIN arguments. */
export function classifyImapError(err: unknown): {
  kind: PauseKind;
  message: string;
  retryAfterMs?: number;
} {
  const code = text(err, "code");
  const responseCode = text(err, "serverResponseCode").toUpperCase();
  const haystack = [
    text(err, "responseText"),
    text(err, "response"),
    err instanceof Error ? err.message : "",
  ].join(" ");
  const throttleReset = field(err, "throttleReset");

  // The address policy (server/support/mail-host.ts) refused the server
  // before any connection: nothing to retry until the inbox changes.
  if (code === "EMAILHOSTREFUSED")
    return { kind: "address", message: PAUSE_COPY.address };

  if (
    typeof throttleReset === "number" ||
    code === "ETHROTTLE" ||
    responseCode === "THROTTLED" ||
    /\[THROTTLED\]|request is throttled/i.test(haystack)
  ) {
    return {
      kind: "throttled",
      message: PAUSE_COPY.throttled,
      ...(typeof throttleReset === "number" && throttleReset > 0
        ? { retryAfterMs: throttleReset }
        : {}),
    };
  }
  if (TOO_MANY_CONNECTIONS.test(haystack))
    return {
      kind: "too-many-connections",
      message: PAUSE_COPY["too-many-connections"],
    };
  // A server that is down or broken refuses LOGIN too; that says nothing
  // about the password (RFC 5530).
  if (
    responseCode === "UNAVAILABLE" ||
    responseCode === "SERVERBUG" ||
    /\[(UNAVAILABLE|SERVERBUG)\]/i.test(haystack)
  )
    return { kind: "network", message: PAUSE_COPY.network };
  if (field(err, "authenticationFailed") === true)
    return { kind: "auth", message: PAUSE_COPY.auth };
  // A refusal with an ALERT needs a person (Gmail: "Application-specific
  // password required"); retrying it on a timer risks a lockout.
  const status = text(err, "responseStatus").toUpperCase();
  if ((status === "NO" || status === "BAD") && responseCode === "ALERT")
    return { kind: "auth", message: PAUSE_COPY.auth };
  if (/\[ALERT\]/i.test(haystack) || responseCode === "ALERT")
    return { kind: "alert", message: PAUSE_COPY.alert };
  if (NETWORK_CODES.has(code) || field(err, "syscall") !== undefined)
    return { kind: "network", message: PAUSE_COPY.network };
  return { kind: "protocol", message: PAUSE_COPY.protocol };
}
