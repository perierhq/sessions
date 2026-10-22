/**
 * podman-selftest — proves, from inside a running "This machine (container)"
 * workload, that its isolation holds (docs/self-hosting-sandboxes.md). It
 * runs at qualification (full) and on every ensure and wake (the network
 * half), after the egress firewall is verified and before any workspace
 * command.
 *
 * One shell script in the container probes every target and prints one
 * `name<TAB>got` row each. Expectations:
 *  - `filtered`: the egress firewall must refuse the connect (EHOSTUNREACH
 *    from `icmpx admin-prohibited`), so a closed port is not enough. For
 *    addresses that leave the namespace: tailnet, metadata, pasta's DNS
 *    forwarder and guest mapping, the callback address on another port.
 *  - `blocked`: anything but open. For loopback and the host's own
 *    interface addresses, which pasta may copy into the namespace (so a
 *    connect there reaches the sandbox itself and is refused).
 *  - `reachable`: the public internet, DNS and the callback origin work.
 *  - `absent`: host paths and host names the container must not see.
 *  - `equal`: process facts (no capabilities, no new privileges, uid 1000).
 * A missing row, an exec that fails or times out, or an unknown answer is a
 * failure. The script is built only from validated addresses, ports, URLs,
 * host names and paths, each quoted.
 */

import { createConnection } from "node:net";
import { shellQuoteWord, type RemoteDriver } from "./bootstrap";
import { isIpv4 } from "./podman-cli";

export type IsolationKind = "tcp" | "http" | "dns" | "file" | "proc";
export type IsolationExpect =
  | "filtered"
  | "blocked"
  | "reachable"
  | "absent"
  | "equal";

export interface IsolationTarget {
  name: string;
  kind: IsolationKind;
  /** tcp `ip:port`, http URL, dns host name, file path, proc field. */
  target: string;
  expect: IsolationExpect;
  /** The value an `equal` target must report. */
  value?: string;
}

export interface IsolationResult {
  name: string;
  expect: IsolationExpect;
  got: string;
  pass: boolean;
}

export interface IsolationTargetOptions {
  callbackBaseUrl: string;
  /** The callback origin's IPv4 addresses (resolved for the egress rules). */
  callbackAddresses?: string[];
  /** Addresses on this host's interfaces. */
  hostAddresses: string[];
  /** This host's tailnet addresses. */
  tailnetAddresses: string[];
  /** The gateway's private app port. */
  appPort: number;
  /** Other ports this host listens on locally (the ingress listener). */
  loopbackPorts?: number[];
  /** Host paths the container must not see (the state directory). */
  hostPaths?: string[];
  /** Include the file and process checks (qualification). */
  full: boolean;
}

/** Link-local and resolver addresses that reach a host or cloud service
 *  from a pasta namespace when nothing blocks them. */
const FIXED_FILTERED: [string, number][] = [
  ["169.254.169.254", 80], // cloud metadata
  ["169.254.1.1", 53], // pasta's DNS forwarder (forwards to the host resolver)
  ["169.254.1.2", 22], // podman's default guest-to-host mapping
  ["100.100.100.100", 53], // tailnet DNS
];
const FIXED_ABSENT_PATHS = ["/etc/opensession", "/run/user"];
const WORKLOAD_UID = "1000";

function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`invalid port: ${port}`);
  return port;
}

function checkIpv4(address: string): string {
  if (!isIpv4(address)) throw new Error(`invalid IPv4 address: ${address}`);
  return address;
}

function checkUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`self-test URL must be http(s): ${raw}`);
  if (/[\s\0'"\\`$]/.test(url.href))
    throw new Error(`self-test URL has unsafe characters: ${raw}`);
  return url.href;
}

function checkPath(path: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.split("/").includes(".."))
    throw new Error(`invalid self-test path: ${path}`);
  return path;
}

function urlPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isLoopback(address: string): boolean {
  return address.startsWith("127.");
}

function tcp(
  address: string,
  port: number,
  expect: IsolationExpect,
): IsolationTarget {
  const target = `${checkIpv4(address)}:${checkPort(port)}`;
  return { name: `tcp:${target}`, kind: "tcp", target, expect };
}

/** The probes for one sandbox, read from the host's current addresses. */
export function isolationTargets(o: IsolationTargetOptions): IsolationTarget[] {
  const callback = new URL(checkUrl(o.callbackBaseUrl));
  const callbackPort = urlPort(callback);
  const appPort = checkPort(o.appPort);
  const targets: IsolationTarget[] = [];
  const seen = new Set<string>();
  const add = (t: IsolationTarget) => {
    if (seen.has(t.name)) return;
    seen.add(t.name);
    targets.push(t);
  };

  for (const port of [appPort, ...(o.loopbackPorts ?? [])])
    add(tcp("127.0.0.1", port, "blocked"));
  const tailnet = new Set(o.tailnetAddresses);
  for (const address of o.hostAddresses) {
    if (address.includes(":") || isLoopback(address) || tailnet.has(address))
      continue;
    add(tcp(address, 22, "blocked"));
    add(tcp(address, appPort, "blocked"));
  }
  for (const address of o.tailnetAddresses)
    if (!address.includes(":")) add(tcp(address, appPort, "filtered"));
  if (callbackPort !== 22)
    for (const address of o.callbackAddresses ?? [])
      if (!address.includes(":")) add(tcp(address, 22, "filtered"));
  for (const [address, port] of FIXED_FILTERED)
    add(tcp(address, port, "filtered"));

  add({
    name: "dns:github.com",
    kind: "dns",
    target: "github.com",
    expect: "reachable",
  });
  add({
    name: "dns:host.containers.internal",
    kind: "dns",
    target: "host.containers.internal",
    expect: "absent",
  });
  add({
    name: "http:https://github.com/",
    kind: "http",
    target: "https://github.com/",
    expect: "reachable",
  });
  add({
    name: "callback",
    kind: "http",
    target: callback.href,
    expect: "reachable",
  });

  if (o.full) {
    for (const path of [...FIXED_ABSENT_PATHS, ...(o.hostPaths ?? [])])
      add({
        name: `file:${checkPath(path)}`,
        kind: "file",
        target: path,
        expect: "absent",
      });
    add({
      name: "proc:CapEff",
      kind: "proc",
      target: "CapEff",
      expect: "equal",
      value: "0000000000000000",
    });
    add({
      name: "proc:NoNewPrivs",
      kind: "proc",
      target: "NoNewPrivs",
      expect: "equal",
      value: "1",
    });
    add({
      name: "proc:uid",
      kind: "proc",
      target: "uid",
      expect: "equal",
      value: WORKLOAD_UID,
    });
  }
  return targets;
}

// ── The in-container script ──────────────────────────────────────────────────

/** The probe script runs in a fresh `/bin/bash` with an empty environment
 *  (no BASH_ENV, no caller PATH) and calls every tool by absolute path. */
const RESTART = "exec /usr/bin/env -i /bin/bash --noprofile --norc -c";

const PRELUDE = [
  "PATH=/usr/sbin:/usr/bin:/sbin:/bin; hash -r",
  "set +e",
  "probe_tcp() {",
  '  local out rc; out=$(/usr/bin/timeout 3 /bin/bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1); rc=$?',
  "  if [ $rc -eq 0 ]; then echo open; elif [ $rc -eq 124 ]; then echo timeout",
  '  else case "$out" in',
  '    *"No route to host"*) echo unreachable ;;',
  '    *"Network is unreachable"*) echo nonet ;;',
  '    *"Connection refused"*) echo refused ;;',
  "    *) echo error ;;",
  "  esac; fi",
  "}",
  "probe_http() {",
  "  local code; code=$(/usr/bin/curl -sS -o /dev/null -m 5 -w '%{http_code}' \"$1\" 2>/dev/null)",
  '  case "$code" in ""|000) echo failed ;; *) echo "http:$code" ;; esac',
  "}",
  "probe_dns() {",
  '  if /usr/bin/timeout 5 /usr/bin/getent ahostsv4 "$1" >/dev/null 2>&1; then echo resolved; else echo unresolved; fi',
  "}",
  "probe_file() {",
  '  if [ -e "$1" ] || [ -L "$1" ]; then echo present; else echo absent; fi',
  "}",
  "probe_proc() {",
  '  if [ "$1" = uid ]; then /usr/bin/id -u; return; fi',
  '  /usr/bin/awk -v k="$1:" \'$1 == k { print $2; found = 1 } END { if (!found) print "none" }\' /proc/self/status',
  "}",
];

const NAME = /^[A-Za-z0-9:._/@-]+$/;

function probeCall(t: IsolationTarget): string {
  if (!NAME.test(t.name)) throw new Error(`invalid self-test name: ${t.name}`);
  switch (t.kind) {
    case "tcp": {
      const match = /^([0-9.]+):(\d+)$/.exec(t.target);
      if (!match) throw new Error(`invalid tcp target: ${t.target}`);
      return `probe_tcp ${checkIpv4(match[1]!)} ${checkPort(Number(match[2]))}`;
    }
    case "http":
      return `probe_http ${shellQuoteWord(checkUrl(t.target))}`;
    case "dns":
      if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t.target))
        throw new Error(`invalid dns target: ${t.target}`);
      return `probe_dns ${t.target}`;
    case "file":
      return `probe_file ${shellQuoteWord(checkPath(t.target))}`;
    case "proc":
      if (!/^[A-Za-z]+$/.test(t.target))
        throw new Error(`invalid proc target: ${t.target}`);
      return `probe_proc ${t.target}`;
  }
}

/** The script that prints one `name<TAB>got` row per target. */
export function isolationScript(targets: IsolationTarget[]): string {
  const lines = targets.map(
    (t) => `printf '%s\\t%s\\n' ${shellQuoteWord(t.name)} "$(${probeCall(t)})"`,
  );
  const inner = [...PRELUDE, ...lines, ""].join("\n");
  return `${RESTART} ${shellQuoteWord(inner)}\n`;
}

function passes(t: IsolationTarget, got: string): boolean {
  switch (t.expect) {
    case "filtered":
      return got === "unreachable";
    case "blocked":
      return ["unreachable", "refused", "timeout", "nonet"].includes(got);
    case "reachable":
      return t.kind === "dns" ? got === "resolved" : /^http:\d{3}$/.test(got);
    case "absent":
      return t.kind === "dns" ? got === "unresolved" : got === "absent";
    case "equal":
      return t.value !== undefined && got === t.value;
  }
}

function selfTestTimeoutMs(targets: IsolationTarget[]): number {
  let seconds = 15;
  for (const t of targets)
    seconds +=
      t.kind === "tcp" ? 4 : t.kind === "http" || t.kind === "dns" ? 6 : 1;
  return seconds * 1000;
}

/**
 * Run every probe in one exec. `ok` only when each target reported exactly
 * once and as expected.
 */
export async function runIsolationSelfTest(
  driver: RemoteDriver,
  targets: IsolationTarget[],
): Promise<{ ok: boolean; results: IsolationResult[] }> {
  const names = new Set<string>();
  for (const t of targets) {
    if (names.has(t.name))
      throw new Error(`duplicate self-test target ${t.name}`);
    names.add(t.name);
  }
  const script = isolationScript(targets);
  let stdout = "";
  let failure = "";
  let threw = false;
  try {
    const result = await driver.exec(script, {
      timeoutMs: selfTestTimeoutMs(targets),
    });
    stdout = result.stdout;
    if (result.exitCode !== 0)
      failure = `exit ${result.exitCode}: ${(result.stderr || "").trim().slice(0, 200)}`;
  } catch (err) {
    threw = true;
    failure = err instanceof Error ? err.message : String(err);
  }

  const answers = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    answers.set(name, [
      ...(answers.get(name) ?? []),
      line.slice(tab + 1).trim(),
    ]);
  }
  const results = targets.map((t): IsolationResult => {
    const got = answers.get(t.name) ?? [];
    if (got.length === 1)
      return {
        name: t.name,
        expect: t.expect,
        got: got[0]!,
        pass: passes(t, got[0]!),
      };
    const missing = got.length ? `duplicate (${got.join(", ")})` : "missing";
    return {
      name: t.name,
      expect: t.expect,
      got: threw
        ? `error: ${failure}`
        : failure && !got.length
          ? `missing (${failure})`
          : missing,
      pass: false,
    };
  });
  return {
    ok: results.length > 0 && results.every((r) => r.pass),
    results,
  };
}

// ── Host control ─────────────────────────────────────────────────────────────

/** Whether this host itself can open a TCP connection (3 s). */
export function hostTcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 3000 });
    const done = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Probe each TCP target from the host first. A `blocked` target the host
 * cannot reach proves nothing and is dropped; `filtered` targets stay (the
 * firewall must refuse them whether or not anything listens). Both kinds of
 * dead target are reported.
 */
export async function hostControlCheck(
  targets: IsolationTarget[],
  probe: (host: string, port: number) => Promise<boolean> = hostTcpProbe,
): Promise<{ targets: IsolationTarget[]; notLiveOnHost: IsolationTarget[] }> {
  const live = await Promise.all(
    targets.map(async (t) => {
      if (t.kind !== "tcp") return true;
      const [host, port] = t.target.split(":");
      return probe(host!, Number(port));
    }),
  );
  const notLiveOnHost = targets.filter((_, i) => !live[i]);
  return {
    targets: targets.filter((t, i) => live[i] || t.expect !== "blocked"),
    notLiveOnHost,
  };
}
