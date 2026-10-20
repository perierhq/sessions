// TLS expiry source: days until a host's certificate expires. Resolves the
// host first and refuses private addresses before any connection.
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
import type { ExpirySource, Observation } from "../../../shared/incidents";
import { isBlockedAddress } from "../../shared/network-address";
import type { SourceRun } from "./http";

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

async function resolveHost(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((entry) => entry.address);
}

/** Connect, read the peer certificate, disconnect. Trust is reported, not enforced. */
function probeCertificate(
  address: string,
  servername: string,
  port: number,
  timeoutMs: number,
): Promise<PeerCertificateInfo> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: address,
      port,
      servername,
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
    resolve?: (host: string) => Promise<string[]>;
    probe?: (
      address: string,
      servername: string,
      port: number,
      timeoutMs: number,
    ) => Promise<PeerCertificateInfo>;
  } = {},
): Promise<SourceRun> {
  const now = opts.now ?? Date.now;
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
    addresses = await (opts.resolve ?? resolveHost)(host);
  } catch (error) {
    return failure("fail", `Could not reach ${host}: ${errorMessage(error)}`);
  }
  if (!addresses.length)
    return failure("fail", `Could not reach ${host}: no addresses`);
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked)
    return failure(
      "unknown",
      `Refused: ${host} resolves to the private address ${blocked}`,
    );
  // Every address is vetted above; try them in order (a host may publish an
  // IPv6 address this machine cannot route).
  const probe = opts.probe ?? probeCertificate;
  let lastError: unknown;
  for (const address of addresses) {
    try {
      const info = await probe(address, host, port, TLS_TIMEOUT_MS);
      return { observations: [tlsObservation(info, host, port, now())] };
    } catch (error) {
      lastError = error;
    }
  }
  return failure("fail", `Could not reach ${host}: ${errorMessage(lastError)}`);
}
