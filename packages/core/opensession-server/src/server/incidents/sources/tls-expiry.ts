// TLS expiry source: days until a host's certificate expires. Resolves the
// host once through the shared resolve-and-check, refuses it if any address
// is private, and connects only to those checked addresses.
import { isIP } from "node:net";
import { connect } from "node:tls";
import type { ExpirySource, Observation } from "../../../shared/incidents";
import { isBlockedAddress } from "../../shared/network-address";
import {
  BlockedAddressError,
  type ResolveHost,
  resolvePinnedTarget,
  resolveWithDns,
} from "../../shared/pinned-fetch";
import { refusalDetail, type SourceRun } from "./http";

/** One deadline for the whole check: resolving and every address tried. */
export const TLS_TIMEOUT_MS = 10_000;

const DAY_MS = 86_400_000;
const DEFAULT_PORT = 443;

export interface PeerCertificateInfo {
  validTo: string;
  authorized: boolean;
  authorizationError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function tlsObservation(
  info: PeerCertificateInfo,
  host: string,
  port: number,
  now: number,
): Observation {
  const at = new Date(now).toISOString();
  const sourceUrl = `tls://${host}:${port}`;
  const expires = Date.parse(info.validTo);
  if (!Number.isFinite(expires))
    return {
      at,
      result: "fail",
      sourceUrl,
      detail: "Could not read the certificate expiry",
    };
  const value = Math.floor(((expires - now) / DAY_MS) * 10) / 10;
  if (!info.authorized)
    return {
      at,
      result: "fail",
      value,
      sourceUrl,
      detail: `Certificate rejected: ${info.authorizationError || "untrusted"}`,
    };
  return {
    at,
    result: "ok",
    value,
    sourceUrl,
    detail: `Certificate expires ${new Date(expires).toISOString().slice(0, 10)} (${value} days)`,
  };
}

/** Reject when `promise` has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      Math.max(0, ms),
    );
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Connect, read the peer certificate, disconnect. Trust is reported, not
 * enforced. `servername` (SNI) is left out for an IP literal host.
 */
function probeCertificate(
  address: string,
  servername: string | undefined,
  port: number,
  timeoutMs: number,
): Promise<PeerCertificateInfo> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: address,
      port,
      ...(servername === undefined ? {} : { servername }),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no TLS handshake within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      const info: PeerCertificateInfo = {
        validTo: certificate?.valid_to ?? "",
        authorized: socket.authorized,
      };
      if (socket.authorizationError)
        info.authorizationError = String(socket.authorizationError);
      socket.destroy();
      resolve(info);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

export async function runTlsExpirySource(
  source: ExpirySource,
  opts: {
    now?: () => number;
    /** The whole check's deadline; {@link TLS_TIMEOUT_MS} by default. */
    timeoutMs?: number;
    resolve?: ResolveHost;
    isBlocked?: (address: string) => boolean;
    probe?: (
      address: string,
      servername: string | undefined,
      port: number,
      timeoutMs: number,
    ) => Promise<PeerCertificateInfo>;
  } = {},
): Promise<SourceRun> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? TLS_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const port = source.port ?? DEFAULT_PORT;
  const host = source.host;
  const failure = (result: "fail" | "unknown", detail: string): SourceRun => ({
    observations: [
      {
        at: new Date(now()).toISOString(),
        result,
        detail,
        sourceUrl: `tls://${host}:${port}`,
      },
    ],
  });
  let addresses: string[];
  try {
    // The URL only carries the host through the shared check; the scheme
    // and port play no part in which addresses are allowed.
    const target = await withDeadline(
      resolvePinnedTarget(`https://${host}/`, {
        resolve: opts.resolve ?? resolveWithDns,
        isBlocked: opts.isBlocked ?? isBlockedAddress,
      }),
      timeoutMs,
    );
    addresses = target.addresses;
  } catch (error) {
    if (error instanceof BlockedAddressError)
      return failure("unknown", refusalDetail(error));
    return failure("fail", `Could not reach ${host}: ${errorMessage(error)}`);
  }
  // SNI carries host names only (RFC 6066), never an IP literal.
  const servername = isIP(host) ? undefined : host;
  // Only the addresses checked above are dialled; try them in order (a host may publish an
  // IPv6 address this machine cannot route) until the deadline.
  const probe = opts.probe ?? probeCertificate;
  let lastError: unknown = new Error(`no TLS handshake within ${timeoutMs} ms`);
  for (const address of addresses) {
    const left = deadline - now();
    if (left <= 0) break;
    try {
      const info = await probe(address, servername, port, left);
      return { observations: [tlsObservation(info, host, port, now())] };
    } catch (error) {
      lastError = error;
    }
  }
  return failure("fail", `Could not reach ${host}: ${errorMessage(lastError)}`);
}
