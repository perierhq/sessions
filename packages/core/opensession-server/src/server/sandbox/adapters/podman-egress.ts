/**
 * podman-egress — the network policy of a "This machine (container)"
 * Sandbox: an nftables table installed from the host into the pod's network
 * namespace before the workload starts (docs/self-hosting-sandboxes.md).
 *
 * The workload has no capabilities, so it cannot change the table. The
 * table allows the public internet and refuses everything that leads back
 * to this host or its networks:
 *  - IPv6 entirely (the namespace has none; belt and braces);
 *  - the callback address on any port but the callback port (it is often
 *    this host's own public IP, where sshd and other listeners also live);
 *  - DNS to anything but the configured resolvers (pasta's forwarder at
 *    169.254.1.1 would hand queries to the host's resolver);
 *  - private, loopback, CGNAT/tailnet, link-local/metadata, multicast and
 *    reserved IPv4 ranges, every address on a host interface, and the
 *    operator's extra host addresses (ones that reach this host without
 *    being on an interface, e.g. a NAT'd public IP).
 * Every refusal is `icmpx admin-prohibited`: a blocked connect fails with
 * "No route to host", which the isolation self-test tells apart from a
 * closed port ("Connection refused").
 *
 * A stopped pod's namespace is destroyed with its rules, so the provider
 * installs and verifies the table on every start. Verification lists the
 * namespace's whole ruleset as JSON and compares it, without handles and
 * counter values, to what the input must produce. Any mismatch is a
 * failure; nothing here falls back to an open network.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isIpv4, type PodmanRunner } from "./podman-cli";

export interface EgressInput {
  /** The public callback origin: its IPv4 addresses and TCP port. */
  callback: { addresses: string[]; port: number };
  /** Addresses on this host's interfaces (IPv6 entries are ignored). */
  hostAddresses: string[];
  /** Operator-configured addresses that reach this host but are on none of
   *  its interfaces (a NAT'd public IP, a load balancer in front of it).
   *  Refused like `hostAddresses`; IPv6 entries are ignored. */
  extraHostAddresses?: string[];
  /** The only resolvers DNS may reach. */
  dns: string[];
}

export const EGRESS_TABLE = "opensession";

/** IPv4 space a Sandbox never reaches: "this network", RFC 1918, CGNAT (and
 *  so every tailnet address), loopback, link-local (cloud metadata, pasta's
 *  DNS forwarder and guest mapping), IETF protocol assignments, benchmarking,
 *  multicast and reserved. */
export const BLOCKED_IPV4_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

/** Whether an IPv4 address falls in BLOCKED_IPV4_RANGES. */
export function ipv4InBlockedRange(ip: string): boolean {
  if (!isIpv4(ip)) throw new Error(`not an IPv4 address: ${ip}`);
  const value = ipv4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some((range) => {
    const [base, len] = range.split("/");
    const bits = Number(len);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (ipv4ToInt(base!) & mask) >>> 0;
  });
}

function isIpv6(value: string): boolean {
  return value.includes(":");
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

interface EgressPlan {
  callbacks: string[];
  port: number;
  hostAddresses: string[];
  resolvers: string[];
}

/** Validate the input and reduce it to what the table holds. Throws on
 *  anything that would widen the policy. */
function egressPlan(i: EgressInput): EgressPlan {
  const port = i.callback.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`invalid callback port: ${port}`);
  const callbacks = uniq(i.callback.addresses.filter((a) => !isIpv6(a)));
  if (!callbacks.length)
    throw new Error("callback base URL has no IPv4 address");
  for (const address of callbacks) {
    if (!isIpv4(address))
      throw new Error(`invalid callback address: ${address}`);
    if (ipv4InBlockedRange(address))
      throw new Error(
        `callback base URL resolves to a private or host address (${address}); ` +
          "This machine (container) needs a public callback origin",
      );
  }
  const interfaceV4 = i.hostAddresses.filter((a) => !isIpv6(a));
  for (const address of interfaceV4)
    if (!isIpv4(address)) throw new Error(`invalid host address: ${address}`);
  const extraV4 = (i.extraHostAddresses ?? []).filter((a) => !isIpv6(a));
  for (const address of extraV4)
    if (!isIpv4(address))
      throw new Error(`invalid extra host address: ${address}`);
  const hostV4 = [...interfaceV4, ...extraV4];
  if (!i.dns.length) throw new Error("egress policy needs a DNS resolver");
  for (const resolver of i.dns) {
    if (!isIpv4(resolver))
      throw new Error(`DNS resolver must be IPv4: ${resolver}`);
    if (ipv4InBlockedRange(resolver) || hostV4.includes(resolver))
      throw new Error(
        `DNS resolver ${resolver} is a private or host address; use a public resolver`,
      );
  }
  return {
    callbacks,
    port,
    // The callback's own address joins the host set: after its port is
    // allowed, every other port on it is refused.
    hostAddresses: uniq([...hostV4, ...callbacks]),
    resolvers: uniq(i.dns),
  };
}

const REJECT = "reject with icmpx admin-prohibited";

/**
 * The nft script for a namespace. It starts by creating and deleting the
 * table, so applying it again replaces the previous table atomically.
 */
export function podmanEgressRuleset(i: EgressInput): string {
  const plan = egressPlan(i);
  const callbackRules = plan.callbacks.flatMap((address) => [
    `\t\tip daddr ${address} tcp dport ${plan.port} counter accept`,
    `\t\tip daddr ${address} counter ${REJECT}`,
  ]);
  return [
    `table inet ${EGRESS_TABLE}`,
    `delete table inet ${EGRESS_TABLE}`,
    `table inet ${EGRESS_TABLE} {`,
    "\tset blocked4 {",
    "\t\ttype ipv4_addr",
    "\t\tflags interval",
    `\t\telements = { ${BLOCKED_IPV4_RANGES.join(", ")} }`,
    "\t}",
    "\tset hostaddrs4 {",
    "\t\ttype ipv4_addr",
    `\t\telements = { ${plan.hostAddresses.join(", ")} }`,
    "\t}",
    "\tset resolvers4 {",
    "\t\ttype ipv4_addr",
    `\t\telements = { ${plan.resolvers.join(", ")} }`,
    "\t}",
    "\tchain output {",
    "\t\ttype filter hook output priority filter; policy accept;",
    '\t\toif "lo" accept',
    `\t\tmeta nfproto ipv6 counter ${REJECT}`,
    ...callbackRules,
    "\t\tmeta l4proto { tcp, udp } th dport 53 ip daddr @resolvers4 counter accept",
    `\t\tmeta l4proto { tcp, udp } th dport 53 counter ${REJECT}`,
    `\t\tip daddr @blocked4 counter ${REJECT}`,
    `\t\tip daddr @hostaddrs4 counter ${REJECT}`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

/** IPv4 and IPv6 addresses on this host's interfaces, loopback included. */
export function localInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries || [])
    .map((entry) => entry.address);
}

async function lookupIpv4(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true, family: 4 });
  return results.map((r) => r.address);
}

/** The egress input for a callback origin, resolved now (addresses change,
 *  so this runs on every start). */
export async function resolveEgressInput(
  callbackBaseUrl: string,
  dns: string[],
  lookup: (host: string) => Promise<string[]> = lookupIpv4,
  hostAddresses: () => string[] = localInterfaceAddresses,
  /** The operator's extra host addresses (sandbox.json). */
  extraHostAddresses: string[] = [],
): Promise<EgressInput> {
  const url = new URL(callbackBaseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`callback base URL must be http(s): ${callbackBaseUrl}`);
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIpv4(host) || isIpv6(host) ? [host] : await lookup(host);
  return {
    callback: { addresses, port },
    hostAddresses: hostAddresses(),
    ...(extraHostAddresses.length ? { extraHostAddresses } : {}),
    dns,
  };
}

// ── Install and verify ───────────────────────────────────────────────────────

function failure(
  what: string,
  result: { stderr: string; stdout: string; exitCode: number },
): Error {
  const detail = (result.stderr || result.stdout).trim().slice(0, 400);
  return new Error(`${what}: ${detail || `exit ${result.exitCode}`}`);
}

const NETNS_PATH = /^\/[A-Za-z0-9_./-]+$/;

function assertNetnsPath(path: string, what: string): string {
  if (!NETNS_PATH.test(path) || path.split("/").includes(".."))
    throw new Error(`${what}: no network namespace (is it running?)`);
  return path;
}

/** The network namespace file of a running infra container. */
export async function infraNetnsPath(
  run: PodmanRunner,
  infra: string,
): Promise<string> {
  const result = await run([
    "container",
    "inspect",
    "--format",
    "{{.NetworkSettings.SandboxKey}}",
    infra,
  ]);
  if (result.exitCode !== 0) throw failure(`inspect ${infra}`, result);
  return assertNetnsPath(result.stdout.trim(), infra);
}

/** The network namespace the running workload process actually holds. */
export async function workloadNetnsPath(
  run: PodmanRunner,
  workload: string,
): Promise<string> {
  const result = await run([
    "container",
    "inspect",
    "--format",
    "{{.State.Pid}}",
    workload,
  ]);
  if (result.exitCode !== 0) throw failure(`inspect ${workload}`, result);
  const pid = result.stdout.trim();
  if (!/^[1-9]\d*$/.test(pid))
    throw new Error(`${workload}: not running (pid ${pid || "none"})`);
  return `/proc/${pid}/ns/net`;
}

/**
 * The bash script every nft call runs inside `podman unshare`. nft must not
 * write straight to the gateway: Bun hands a child a unix socket as stdout
 * and stderr, and on SELinux hosts nft runs as `iptables_t`, which may not
 * write to the gateway's socket. The write fails silently (the denial is
 * dontaudit) and nft still exits 0, so a listing comes back empty and an
 * error message is lost. Here nft's stdout and stderr are pipes made inside
 * the user namespace, and `cat` (which keeps podman's domain) copies them
 * out: nft's stdout leaves through fd 3 to the outer pipe, its stderr through
 * the inner pipe to bash's stderr. Both pipelines are waited for, so nothing
 * is cut short, and `pipefail` keeps nft's (or nsenter's) exit status. The
 * namespace path is `$1` and the nft arguments are `$2…`, passed as argv and
 * never spliced into the script. stdin reaches nft untouched (`nft -f -`).
 */
export const NFT_PIPE_SCRIPT =
  'set -o pipefail; { nsenter --net="$1" nft "${@:2}" 2>&1 >&3 3>&- | cat >&2 3>&-; } 3>&1 | cat';

/** `nft` inside a namespace, as the rootless user's user-namespace root. */
function nftArgs(netns: string, args: string[]): string[] {
  return ["unshare", "/bin/bash", "-c", NFT_PIPE_SCRIPT, "bash", netns, ...args];
}

/**
 * An nft JSON listing of a namespace. A clean exit with nothing printed is
 * its own error: nft lists at least its metainfo, so its output never
 * reached this process.
 */
async function nftListing(
  run: PodmanRunner,
  netns: string,
  args: string[],
  what: string,
): Promise<string> {
  const result = await run(nftArgs(netns, args));
  if (result.exitCode !== 0) throw failure(what, result);
  if (!result.stdout.trim())
    throw new Error(
      `${what}: nft exited 0 but printed nothing; its output did not reach the gateway (an SELinux policy that stops nft writing to the caller's stdout does this)`,
    );
  return result.stdout;
}

/** Install the ruleset into the infra container's namespace. Returns the
 *  namespace path it was installed into. */
export async function installEgressRules(
  run: PodmanRunner,
  infra: string,
  ruleset: string,
): Promise<string> {
  const netns = await infraNetnsPath(run, infra);
  const result = await run(nftArgs(netns, ["-f", "-"]), { stdin: ruleset });
  if (result.exitCode !== 0) throw failure("install egress rules", result);
  return netns;
}

// ── Normalised listing ───────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop what changes between listings of the same rules: handles, counter
 *  values, and set element order. */
function stripVolatile(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!isRecord(value)) return value;
  const out: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "handle") continue;
    if (key === "counter") {
      out.counter = null;
      continue;
    }
    out[key] = stripVolatile(value[key]!);
  }
  return out;
}

function setElement(value: Json): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && isRecord(value.prefix)) {
    const { addr, len } = value.prefix;
    return `${String(addr)}/${String(len)}`;
  }
  return JSON.stringify(stripVolatile(value));
}

/**
 * `nft -j list ruleset` reduced to one comparable line per object. Throws
 * on output that is not nft JSON.
 */
export function normalizeNftListing(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("nft listing is not JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.nftables))
    throw new Error("nft listing has no nftables array");
  const lines: string[] = [];
  for (const item of parsed.nftables) {
    if (!isRecord(item)) throw new Error("nft listing has a non-object entry");
    const [kind, ...rest] = Object.keys(item);
    if (!kind || rest.length) throw new Error("nft listing entry is malformed");
    if (kind === "metainfo") continue;
    const body = item[kind];
    if (!isRecord(body)) throw new Error(`nft listing ${kind} is malformed`);
    if (kind === "table") {
      // A `dormant` table is listed but filters nothing.
      const flags = Array.isArray(body.flags) ? body.flags.join(",") : "";
      lines.push(
        `table ${String(body.family)} ${String(body.name)} flags=${flags}`,
      );
    } else if (kind === "set") {
      const elems = Array.isArray(body.elem) ? body.elem.map(setElement) : [];
      const flags = Array.isArray(body.flags) ? body.flags.join(",") : "";
      lines.push(
        `set ${String(body.family)} ${String(body.table)} ${String(body.name)} ` +
          `type=${JSON.stringify(body.type)} flags=${flags} ` +
          `elem=${elems.sort().join(",")}`,
      );
    } else if (kind === "chain") {
      lines.push(
        `chain ${String(body.family)} ${String(body.table)} ${String(body.name)} ` +
          `type=${String(body.type)} hook=${String(body.hook)} ` +
          `prio=${String(body.prio)} policy=${String(body.policy)}`,
      );
    } else if (kind === "rule") {
      lines.push(
        `rule ${String(body.family)} ${String(body.table)} ${String(body.chain)} ` +
          JSON.stringify(stripVolatile(body.expr ?? null)),
      );
    } else {
      lines.push(`${kind} ${JSON.stringify(stripVolatile(body))}`);
    }
  }
  return lines;
}

// The expressions nft 1.0 lists for the rules podmanEgressRuleset writes.

const match = (left: Json, right: Json): Json => ({
  match: { left, op: "==", right },
});
const payload = (protocol: string, field: string): Json => ({
  payload: { field, protocol },
});
const meta = (key: string): Json => ({ meta: { key } });
const counter: Json = { counter: null };
const accept: Json = { accept: null };
const reject: Json = { reject: { expr: "admin-prohibited", type: "icmpx" } };
const l4tcpudp = match(meta("l4proto"), { set: ["tcp", "udp"] });

/** What normalizeNftListing must return for the namespace's whole ruleset. */
export function expectedEgressListing(i: EgressInput): string[] {
  const plan = egressPlan(i);
  const t = `inet ${EGRESS_TABLE}`;
  const rule = (expr: Json[]): string =>
    `rule ${t} output ${JSON.stringify(stripVolatile(expr))}`;
  const set = (name: string, flags: string, elems: string[]): string =>
    `set ${t} ${name} type="ipv4_addr" flags=${flags} elem=${[...elems].sort().join(",")}`;
  return [
    `table ${t} flags=`,
    set("blocked4", "interval", [...BLOCKED_IPV4_RANGES]),
    set("hostaddrs4", "", plan.hostAddresses),
    set("resolvers4", "", plan.resolvers),
    `chain ${t} output type=filter hook=output prio=0 policy=accept`,
    rule([match(meta("oif"), "lo"), accept]),
    rule([match(meta("nfproto"), "ipv6"), counter, reject]),
    ...plan.callbacks.flatMap((address) => [
      rule([
        match(payload("ip", "daddr"), address),
        match(payload("tcp", "dport"), plan.port),
        counter,
        accept,
      ]),
      rule([match(payload("ip", "daddr"), address), counter, reject]),
    ]),
    rule([
      l4tcpudp,
      match(payload("th", "dport"), 53),
      match(payload("ip", "daddr"), "@resolvers4"),
      counter,
      accept,
    ]),
    rule([l4tcpudp, match(payload("th", "dport"), 53), counter, reject]),
    rule([match(payload("ip", "daddr"), "@blocked4"), counter, reject]),
    rule([match(payload("ip", "daddr"), "@hostaddrs4"), counter, reject]),
  ];
}

/**
 * Prove a namespace holds exactly the input's table and nothing else.
 * Rejects with the differing lines.
 */
export async function verifyEgressRulesAt(
  run: PodmanRunner,
  netns: string,
  input: EgressInput,
): Promise<void> {
  const expected = expectedEgressListing(input);
  assertNetnsPath(netns, "verify egress rules");
  const actual = normalizeNftListing(
    await nftListing(
      run,
      netns,
      ["-j", "list", "ruleset"],
      "list egress rules",
    ),
  );
  const missing = expected.filter((line) => !actual.includes(line));
  const extra = actual.filter((line) => !expected.includes(line));
  const ordered =
    actual.length === expected.length &&
    actual.every((line, index) => line === expected[index]);
  if (missing.length || extra.length || !ordered) {
    const detail = [
      ...missing.map((line) => `missing ${line}`),
      ...extra.map((line) => `unexpected ${line}`),
      ...(missing.length || extra.length ? [] : ["rules out of order"]),
    ];
    throw new Error(
      `egress rules in ${netns} do not match the policy:\n${detail.join("\n").slice(0, 2000)}`,
    );
  }
}

/** Verify the infra container's namespace. */
export async function verifyEgressRules(
  run: PodmanRunner,
  infra: string,
  input: EgressInput,
): Promise<void> {
  await verifyEgressRulesAt(run, await infraNetnsPath(run, infra), input);
}

// ── Counters ─────────────────────────────────────────────────────────────────

/** A reject rule in the egress chain, named by what it matches. */
export type EgressRuleKey =
  | "ipv6"
  | `callback-reject:${string}`
  | "dns-reject"
  | "blocked4"
  | "hostaddrs4";

/**
 * The reject rule an IPv4 TCP connect to `address:port` from the namespace
 * must hit, following the chain's order, or undefined when the policy
 * allows it.
 */
export function egressRuleFor(
  input: EgressInput,
  address: string,
  port: number,
): EgressRuleKey | undefined {
  const plan = egressPlan(input);
  if (!isIpv4(address)) throw new Error(`invalid IPv4 address: ${address}`);
  if (plan.callbacks.includes(address))
    return port === plan.port ? undefined : `callback-reject:${address}`;
  if (port === 53)
    return plan.resolvers.includes(address) ? undefined : "dns-reject";
  if (ipv4InBlockedRange(address)) return "blocked4";
  if (plan.hostAddresses.includes(address)) return "hostaddrs4";
  return undefined;
}

function ruleKey(expr: Json[]): EgressRuleKey | undefined {
  for (const item of expr) {
    if (!isRecord(item) || !isRecord(item.match)) continue;
    const { left, right } = item.match;
    if (!isRecord(left)) continue;
    if (isRecord(left.meta) && left.meta.key === "nfproto" && right === "ipv6")
      return "ipv6";
    if (
      isRecord(left.payload) &&
      left.payload.field === "dport" &&
      right === 53
    )
      return "dns-reject";
    if (
      isRecord(left.payload) &&
      left.payload.field === "daddr" &&
      typeof right === "string"
    ) {
      if (right === "@blocked4") return "blocked4";
      if (right === "@hostaddrs4") return "hostaddrs4";
      if (isIpv4(right)) return `callback-reject:${right}`;
    }
  }
  return undefined;
}

/**
 * The packet counter of every reject rule in a namespace's egress table,
 * read from the host. Throws when nft fails or a reject rule has no counter.
 */
export async function readEgressCounters(
  run: PodmanRunner,
  netns: string,
): Promise<Map<EgressRuleKey, number>> {
  assertNetnsPath(netns, "read egress counters");
  const listing = await nftListing(
    run,
    netns,
    ["-j", "list", "table", "inet", EGRESS_TABLE],
    "list egress counters",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(listing);
  } catch {
    throw new Error("nft listing is not JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.nftables))
    throw new Error("nft listing has no nftables array");
  const counters = new Map<EgressRuleKey, number>();
  for (const item of parsed.nftables) {
    if (!isRecord(item) || !isRecord(item.rule)) continue;
    const expr = item.rule.expr;
    if (!Array.isArray(expr)) continue;
    if (!expr.some((e) => isRecord(e) && "reject" in e)) continue;
    const key = ruleKey(expr);
    if (!key) continue;
    const found = expr.find((e) => isRecord(e) && isRecord(e.counter));
    const packets =
      found && isRecord(found) && isRecord(found.counter)
        ? found.counter.packets
        : undefined;
    if (typeof packets !== "number")
      throw new Error(`egress rule ${key} has no counter`);
    counters.set(key, packets);
  }
  return counters;
}

/** What the isolation self-test needs to prove its refusals came from this
 *  namespace's table (runIsolationSelfTest's `counters`). */
export function egressCounterProof(
  run: PodmanRunner,
  netns: string,
  input: EgressInput,
): {
  read(): Promise<Map<string, number>>;
  ruleFor(address: string, port: number): string | undefined;
} {
  return {
    read: () => readEgressCounters(run, netns),
    ruleFor: (address, port) => egressRuleFor(input, address, port),
  };
}
