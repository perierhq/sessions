import { isIP } from "net";

/** Strip brackets and an IPv6 zone id (`fe80::1%eth0`), and lowercase. */
function bareAddress(address: string): string {
  return (address || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!;
}

/** The eight 16-bit groups of a valid IPv6 address, including forms with a
 * dotted IPv4 tail (`::ffff:127.0.0.1`). Undefined for anything else. */
export function ipv6Hextets(address: string): number[] | undefined {
  const value = bareAddress(address);
  if (isIP(value) !== 6) return undefined;
  let text = value;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const octets = last.split(".").map(Number);
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    text = text.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`; `64:ff9b::1.2.3.4` leaves `64:ff9b::`;
    // `1:2:3:4:5:6:1.2.3.4` leaves `1:2:3:4:5:6:`.
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const parse = (part: string): number[] =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const want = 8 - tail.length;
  let groups: number[];
  const gap = text.indexOf("::");
  if (gap >= 0) {
    const head = parse(text.slice(0, gap));
    const rest = parse(text.slice(gap + 2));
    groups = [
      ...head,
      ...Array(want - head.length - rest.length).fill(0),
      ...rest,
    ];
  } else {
    groups = parse(text);
  }
  groups.push(...tail);
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
    ? groups
    : undefined;
}

function dotted(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The IPv4 address an IPv6 address carries, when it carries one:
 * IPv4-mapped `::ffff:0:0/96`, IPv4-translated `::ffff:0:0:0/96`,
 * IPv4-compatible `::/96`, NAT64 well-known `64:ff9b::/96`, and 6to4
 * `2002::/16`. Any of these can reach the embedded IPv4 host, so it is the
 * address that matters. */
export function embeddedIpv4(address: string): string | undefined {
  const h = ipv6Hextets(address);
  if (!h) return undefined;
  const zero = (from: number, to: number) =>
    h.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && h[5] === 0xffff) return dotted(h[6]!, h[7]!);
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return dotted(h[6]!, h[7]!);
  if (zero(0, 6)) return dotted(h[6]!, h[7]!);
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6))
    return dotted(h[6]!, h[7]!);
  if (h[0] === 0x2002) return dotted(h[1]!, h[2]!);
  return undefined;
}

/** Normalize IPv4-mapped addresses (dotted or hex) and the ordinary
 * IPv4:port form used by Runner callers. Other IPv6 carries several colons
 * and remains untouched. */
export function normalizeAddress(address: string): string {
  let ip = (address || "").trim();
  const bare = bareAddress(ip);
  const h = isIP(bare) === 6 ? ipv6Hextets(bare) : undefined;
  if (h && h.slice(0, 5).every((group) => group === 0) && h[5] === 0xffff)
    return dotted(h[6]!, h[7]!);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const lastColon = ip.lastIndexOf(":");
  if (lastColon > 0 && ip.indexOf(":") === lastColon)
    ip = ip.slice(0, lastColon);
  return ip;
}

export function isTailnetIpv4(address: string): boolean {
  const octets = normalizeAddress(address).split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    ) &&
    octets[0] === 100 &&
    octets[1]! >= 64 &&
    octets[1]! <= 127
  );
}

function isBlockedIpv4(value: string): boolean {
  const [a, b, c] = value.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 192.0.0.0/24 IETF protocol assignments (includes NAT64/DS-Lite
  // translator addresses) and 198.18.0.0/15 benchmarking.
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (isTailnetIpv4(value)) return true;
  if (a! >= 224) return true;
  return false;
}

/** RFC1918 + loopback + link-local (cloud metadata) + CGNAT/tailnet +
 * IETF-reserved and benchmarking + multicast/reserved, and the IPv6
 * equivalents. An IPv6 address that embeds an IPv4 address (see
 * `embeddedIpv4`) is judged by that IPv4 address. Anything that is not an IP
 * literal returns false: resolve names first.
 *
 * This is the one list of addresses nothing may reach on an untrusted
 * caller's behalf. Callers that deliberately allow tailnet peers check
 * `isTailnetIpv4` themselves and never consult this. */
export function isBlockedAddress(ip: string): boolean {
  const value = bareAddress(ip);
  if (isIP(value) === 4) return isBlockedIpv4(value);
  const h = ipv6Hextets(value);
  if (!h) return false;
  // ::/96: unspecified, loopback, and the deprecated IPv4-compatible form.
  // Nothing legitimate lives here, and a translator may route any of it to
  // the embedded IPv4 host unchecked, so the whole range is refused.
  if (h.slice(0, 6).every((group) => group === 0)) return true;
  const v4 = embeddedIpv4(value);
  if (v4) return isBlockedIpv4(v4);
  // NAT64 local-use 64:ff9b:1::/48 (RFC 8215): a site-local translator.
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;
  // Teredo 2001::/32: tunnels to an IPv4 relay and client.
  if (h[0] === 0x2001 && h[1] === 0) return true;
  // fe80::/10 link-local and fec0::/10 site-local.
  if ((h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xffc0) === 0xfec0) return true;
  // fc00::/7 unique-local.
  if ((h[0]! & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast.
  if ((h[0]! & 0xff00) === 0xff00) return true;
  return false;
}
