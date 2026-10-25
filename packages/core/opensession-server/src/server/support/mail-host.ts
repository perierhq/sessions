// Which mail server addresses an inbox may connect to, checked at connect
// time by the IMAP and SMTP transports and by the inbox form's Test button.
// Public addresses are allowed. Link-local, cloud metadata and reserved
// addresses are never allowed. Loopback, private (RFC 1918, IPv6 unique
// local) and tailnet (CGNAT 100.64/10) addresses are allowed only when the
// inbox has `allowInternalHost`.
//
// The host name is resolved once and every address it has is checked
// (the resolve-and-pin pattern of shared/pinned-fetch.ts): the caller then
// dials the checked address and keeps the name for TLS SNI and certificate
// checks, so a name can't be re-resolved to somewhere else in between.
// Refusals carry one fixed message, never the address or the port, so the
// Test button can't be used to map a network. Nothing runs at import.
import { isIP } from "node:net";
import {
  embeddedIpv4,
  ipv6Hextets,
  isBlockedAddress,
} from "../shared/network-address";
import type { MailTlsMode } from "../../shared/support";
import { type ResolveHost, resolveWithDns } from "../shared/pinned-fetch";

export const MAIL_HOST_REFUSED = "This mail server address isn't allowed";
export const MAIL_TLS_NONE_REFUSED =
  "A mail server without TLS must be on this machine";

/** A mail server address the inbox may not connect to. Its message is
 *  MAIL_HOST_REFUSED, or MAIL_TLS_NONE_REFUSED for no TLS off this
 *  machine; never the address. */
export class MailHostRefusedError extends Error {
  readonly code = "EMAILHOSTREFUSED";
  constructor(message = MAIL_HOST_REFUSED) {
    super(message);
    this.name = "MailHostRefusedError";
  }
}

export type MailAddressClass = "public" | "internal" | "refused";

export interface MailHostPolicy {
  allowInternalHost: boolean;
  /** `none` also requires the address to be loopback. */
  tls?: MailTlsMode;
}

/** Where to connect: `address` is the only one to dial; `servername` is the
 *  name for TLS (undefined for an IP literal, as SNI carries names only). */
export interface MailHostTarget {
  host: string;
  address: string;
  servername: string | undefined;
  loopback: boolean;
}

/** Metadata services by name; their addresses are refused anyway. */
const METADATA_NAMES =
  /^(metadata|metadata\.google\.internal|metadata\.goog|instance-data|instance-data\.ec2\.internal)$/;

/** Cloud metadata addresses inside ranges otherwise counted as internal:
 *  Alibaba Cloud (CGNAT) and AWS over IPv6 (unique local). */
const METADATA_ADDRESSES = new Set(["100.100.100.200"]);
const AWS_METADATA_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

const bare = (address: string) =>
  address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;

function internalIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127)
  );
}

/** What kind of address `ip` is for a mail server. Anything that isn't an
 *  IP literal is refused: resolve names first. */
export function classifyMailAddress(ip: string): MailAddressClass {
  const value = bare(ip);
  const family = isIP(value);
  if (!family) return "refused";
  let v4 = family === 4 ? value : undefined;
  if (family === 6) {
    const h = ipv6Hextets(value)!;
    if (h.every((group, i) => group === AWS_METADATA_V6[i])) return "refused";
    // ::1 only; the rest of ::/96 is unspecified or deprecated.
    if (h.slice(0, 7).every((group) => group === 0) && h[7] === 1)
      return "internal";
    v4 = embeddedIpv4(value);
    // fc00::/7 unique local.
    if (!v4 && (h[0]! & 0xfe00) === 0xfc00) return "internal";
  }
  if (v4 !== undefined) {
    if (METADATA_ADDRESSES.has(v4)) return "refused";
    if (internalIpv4(v4)) return "internal";
  }
  return isBlockedAddress(value) ? "refused" : "public";
}

/** Whether `ip` is this machine (127/8 or ::1, also IPv4-mapped). */
export function isLoopbackAddress(ip: string): boolean {
  const value = bare(ip);
  const h = isIP(value) === 6 ? ipv6Hextets(value) : undefined;
  if (h && h.slice(0, 7).every((group) => group === 0) && h[7] === 1)
    return true;
  const v4 = isIP(value) === 4 ? value : embeddedIpv4(value);
  return v4 !== undefined && v4.split(".")[0] === "127";
}

/** Whether `none` (no TLS) may be saved for `host`: `localhost` or a
 *  loopback literal. A connect checks the resolved address again. */
export function noTlsHostAllowed(host: string): boolean {
  const name = bare(host).replace(/\.+$/, "");
  return name === "localhost" || (isIP(name) !== 0 && isLoopbackAddress(name));
}

/** Whether a host literal (no resolution) may be saved on an inbox: a name
 *  passes here and is checked when it is resolved. */
export function mailHostLiteralAllowed(
  host: string,
  policy: MailHostPolicy,
): boolean {
  const name = bare(host).replace(/\.+$/, "");
  if (METADATA_NAMES.test(name)) return false;
  if (!isIP(name)) return true;
  const kind = classifyMailAddress(name);
  return kind === "public" || (kind === "internal" && policy.allowInternalHost);
}

let resolverOverride: ResolveHost | undefined;

/** Replace DNS for the transports (tests); undefined restores it. */
export function __setMailHostResolverForTest(
  resolve: ResolveHost | undefined,
): void {
  resolverOverride = resolve;
}

/** Resolves `host`, checks every address it has, and returns the one to
 *  dial (IPv4 first). Throws MailHostRefusedError when any address isn't
 *  allowed; a name that doesn't resolve throws an ENOTFOUND error. */
export async function resolveMailHost(
  host: string,
  policy: MailHostPolicy,
  resolve: ResolveHost = resolverOverride ?? resolveWithDns,
): Promise<MailHostTarget> {
  const name = bare(host).replace(/\.+$/, "");
  if (!name || METADATA_NAMES.test(name)) throw new MailHostRefusedError();
  const literal = isIP(name) !== 0;
  const addresses = literal ? [name] : await resolve(name);
  if (!addresses.length)
    throw Object.assign(new Error("The mail server name doesn't resolve"), {
      code: "ENOTFOUND",
    });
  for (const address of addresses) {
    const kind = classifyMailAddress(address);
    if (
      kind === "refused" ||
      (kind === "internal" && !policy.allowInternalHost)
    )
      throw new MailHostRefusedError();
  }
  const address =
    addresses.find((a) => isIP(bare(a)) === 4) ?? bare(addresses[0]!);
  const loopback = isLoopbackAddress(address);
  if (policy.tls === "none" && !addresses.every(isLoopbackAddress))
    throw new MailHostRefusedError(MAIL_TLS_NONE_REFUSED);
  return {
    host: name,
    address: bare(address),
    servername: literal ? undefined : name,
    loopback,
  };
}
