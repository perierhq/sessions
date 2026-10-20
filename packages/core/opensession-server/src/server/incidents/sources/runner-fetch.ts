// http checks from a production Runner: `PinnedFetchDeps` over the Runner
// channel, so a signal sees what production sees (its egress IP, its TLS
// stack, its DNS). Names resolve on the Runner and the answer is checked
// here before anything is dialled; curl then connects only to those
// addresses (`resolve`). Every curl option, the URL, the headers and the
// body go to `curl --disable --config -` on stdin, so nothing of the request
// is in the Runner's argv, process list or audit log. Redirects come back
// unfollowed: `runHttpSource` walks them itself, so every hop passes the
// Runner guard and the cross-origin header drop.
//
// The guard allows private and loopback addresses on the signal's own host
// (the URL is set by a person and the Runner is the production host
// checking itself), refuses them on any other host a redirect leads to, and
// refuses cloud metadata endpoints always. A problem with the Runner itself
// (offline, not permitted, in maintenance, too old, gone mid-check, a curl
// older than 7.63 or one that cannot make the request) is a
// `RUNNER_UNAVAILABLE` or `RUNNER_OFFLINE` error: the check is unknown,
// never a failure of the service.
import { isIP } from "node:net";
import {
  type RunnerExecResult,
  execOnIncidentRunner,
  isRunnerConnected,
} from "../../runner-ws";
import { getRunner } from "../../runners";
import {
  embeddedIpv4,
  ipv6Hextets,
  isBlockedAddress,
} from "../../shared/network-address";
import {
  BlockedAddressError,
  type FetchTarget,
  type PinnedFetchDeps,
  type PinnedRequestInit,
  type PinnedResponse,
} from "../../shared/pinned-fetch";
import { productionRunOnProblem } from "../response/runners";
import { HTTP_DEFAULT_TIMEOUT_MS } from "./http";

/** The Runner channel returns at most 200 000 characters of output. */
export const RUNNER_BODY_CAP_BYTES = 150_000;
const STATUS_MARKER = "__SESSIONS_CURL__";
const EXEC_GRACE_MS = 5_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const MIN_REMAINING_MS = 1_000;
const STDERR_MAX = 200;

/** One curl, everything on stdin, its output cut on the Runner. The exit
 *  code is curl's, not head's. */
const CURL_COMMAND = `command curl --disable --config - | command head -c ${RUNNER_BODY_CAP_BYTES + 1}; exit "\${PIPESTATUS[0]}"`;

/** The config needs `%{stderr}` in write-out, new in curl 7.63.0. */
const CURL_VERSION_COMMAND = "command curl --version";
const MIN_CURL = { major: 7, minor: 63 };
/** Runners whose curl was new enough, asked once per Runner. A refusal is
 *  not remembered, so an updated curl counts at the next check. */
const curlChecked = new Set<string>();

export function __resetCurlVersionsForTest(): void {
  curlChecked.clear();
}

/** curl exits 1 (unsupported protocol), 2 (failed to start) and 4 (a
 *  feature not built in) say the Runner's curl cannot make the request,
 *  never that the service is down. */
const CURL_CANNOT = new Set([1, 2, 4]);

/** The host name arrives on stdin. getent on Linux, dscacheutil on macOS. */
const RESOLVE_COMMAND = [
  "IFS= read -r h || exit 2",
  'if command -v getent >/dev/null 2>&1; then getent ahosts "$h"',
  'elif command -v dscacheutil >/dev/null 2>&1; then dscacheutil -q host -a name "$h"',
  "else exit 127; fi",
].join("; ");

export interface RunnerFetchDeps {
  exec: (
    runnerId: string,
    command: string,
    opts: { timeoutMs: number; stdin: string; auditCommand: string },
  ) => Promise<RunnerExecResult>;
  runner: (
    id: string,
  ) => { name: string; label?: string; platform: string } | undefined;
  connected: (id: string) => boolean;
  /** Why the Runner may not run this project's checks now, checked before
   *  every request: it must still be one of the project's production
   *  Runners and reserved for incidents. */
  gate: (runnerId: string, project: string) => Promise<string | null>;
  now: () => number;
}

/** Whose check this is, and its one deadline for the whole redirect chain.
 *  `host` is the signal's own host: only it may be a private address. */
export interface RunnerNetOptions {
  repo: string;
  signalId?: string;
  host?: string;
  timeoutMs?: number;
}

const METADATA_NAMES = new Set(["metadata", "metadata.google.internal"]);
const METADATA_V4 = new Set([
  "168.63.129.16", // Azure wire server
  "192.0.0.192", // Oracle Cloud
  "100.100.100.200", // Alibaba Cloud
]);

function bareName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0]!
    .replace(/\.+$/, "");
}

function metadataV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  // 169.254.0.0/16: link-local, where AWS, GCP, Azure, DigitalOcean and
  // others serve instance metadata and credentials.
  return (a === 169 && b === 254) || METADATA_V4.has(address);
}

/** Cloud metadata endpoints, in every form an address can take. */
export function runnerCheckBlocked(addressOrName: string): boolean {
  const name = bareName(addressOrName);
  if (METADATA_NAMES.has(name)) return true;
  const family = isIP(name);
  if (family === 4) return metadataV4(name);
  if (family !== 6) return false;
  const v4 = embeddedIpv4(name);
  if (v4 && metadataV4(v4)) return true;
  const h = ipv6Hextets(name);
  if (!h) return false;
  // fd00:ec2::/64 holds AWS's IPv6 metadata (::254), DNS (::253) and
  // time sync (::123); fe80::/10 is link-local.
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && h[2] === 0 && h[3] === 0)
    return true;
  return (h[0]! & 0xffc0) === 0xfe80;
}

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function offline(runnerName: string): Error {
  return Object.assign(new Error("Runner offline"), {
    code: "RUNNER_OFFLINE",
    runnerName,
  });
}

function runnerProblem(detail: string): Error {
  return Object.assign(new Error(detail), { code: "RUNNER_UNAVAILABLE" });
}

function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

function bodyText(body: PinnedRequestInit["body"]): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new TextDecoder().decode(body);
}

/** A value in a curl config file: double-quoted, with its escapes. */
function configString(value: string): string {
  if (value.includes("\u0000"))
    throw new Error("The request contains a NUL character");
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\v/g, "\\v")}"`;
}

const GLOB_CHARS = /[{}[\]]/;

/** A host name curl could read as a glob or a list of hosts. */
function refuseGlobHost(host: string): void {
  if (GLOB_CHARS.test(host.replace(/^\[([0-9a-f:.]+)\]$/i, "$1")))
    throw new BlockedAddressError(
      "Refusing to fetch a host name with glob characters",
    );
}

function sameHost(a: string, b: string | undefined): boolean {
  return b !== undefined && bareName(a) === bareName(b);
}

function curlConfig(
  target: FetchTarget,
  init: PinnedRequestInit,
  maxTimeS: number,
): string {
  const method = (init.method ?? "GET").toUpperCase();
  const lines = [
    "globoff",
    "silent",
    "show-error",
    "include",
    "suppress-connect-headers",
    // curl asks for the encodings it can undo and decodes the body: the
    // Runner channel carries text, so compressed bytes would not survive.
    "compressed",
    `proto = ${configString("=http,https")}`,
    `proto-redir = ${configString("=http,https")}`,
    "max-redirs = 0",
    `max-time = ${maxTimeS}`,
    // A proxy would resolve the name again, past the checked addresses.
    `noproxy = ${configString("*")}`,
    // HEAD with --request would wait for a body that never comes.
    method === "HEAD" ? "head" : `request = ${configString(method)}`,
    `url = ${configString(target.url.toString())}`,
  ];
  if (!isIP(target.host)) {
    const port =
      target.url.port || (target.url.protocol === "https:" ? "443" : "80");
    const addresses = target.addresses.map((a) =>
      isIP(a) === 6 ? `[${a}]` : a,
    );
    lines.push(
      `resolve = ${configString(`${target.host}:${port}:${addresses.join(",")}`)}`,
    );
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (name.toLowerCase() === "accept-encoding") continue;
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value))
      throw new Error(
        `Header ${name.replace(/[\r\n]/g, " ")} has a line break`,
      );
    lines.push(`header = ${configString(`${name}: ${value}`)}`);
  }
  // data-raw: an `@` at the start is text, never a file on the Runner.
  const body = bodyText(init.body);
  if (body !== undefined) lines.push(`data-raw = ${configString(body)}`);
  // The status goes to stderr, where a response body cannot fake it and a
  // cut body cannot lose it.
  lines.push(
    `write-out = ${configString(`%{stderr}\n${STATUS_MARKER}%{http_code}\n`)}`,
  );
  return `${lines.join("\n")}\n`;
}

/** The first blank line ends a header block. */
function splitHead(raw: string): { head: string; rest: string } | null {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf === -1 && lf === -1) return null;
  if (lf === -1 || (crlf !== -1 && crlf < lf))
    return { head: raw.slice(0, crlf), rest: raw.slice(crlf + 4) };
  return { head: raw.slice(0, lf), rest: raw.slice(lf + 2) };
}

function markerStatus(stderr: string): number | undefined {
  const all = [...stderr.matchAll(new RegExp(`${STATUS_MARKER}(\\d{3})`, "g"))];
  const code = Number(all.at(-1)?.[1]);
  return Number.isInteger(code) && code > 0 ? code : undefined;
}

function curlError(stderr: string): string | undefined {
  return stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith(STATUS_MARKER))
    ?.slice(0, STDERR_MAX);
}

function parseCurlOutput(
  stdout: string,
  stderr: string,
  maxBodyBytes: number,
  cut: boolean,
): PinnedResponse {
  let raw = stdout;
  let block = splitHead(raw);
  // Interim 1xx answers come first with their own header block.
  while (block && /^HTTP\/\S+\s+1\d\d\b/.test(block.head)) {
    raw = block.rest;
    block = splitHead(raw);
  }
  const headers = new Headers();
  const head = block ? block.head : raw;
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      // A header name or value fetch will not accept is dropped.
    }
  }
  const lineStatus = Number(/^HTTP\/\S+\s+(\d{3})/.exec(head)?.[1]);
  const code = markerStatus(stderr) ?? lineStatus;
  if (!Number.isInteger(code) || code < 100 || code > 599)
    throw new Error("The Runner returned no HTTP status");
  const bytes = new TextEncoder().encode(block ? block.rest : "");
  const truncated = cut || bytes.length > maxBodyBytes;
  return {
    status: code,
    headers,
    body: bytes.length > maxBodyBytes ? bytes.slice(0, maxBodyBytes) : bytes,
    ...(truncated ? { truncated: true } : {}),
  };
}

function resolvedAddresses(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/))
    for (const token of line.trim().split(/\s+/))
      if (isIP(token) && !out.includes(token)) out.push(token);
  return out;
}

export function runnerNet(
  runnerId: string,
  deps: Partial<RunnerFetchDeps> = {},
  opts: RunnerNetOptions,
): PinnedFetchDeps {
  const label = `incident http check${opts.signalId ? ` ${opts.signalId}` : ""}`;
  const d: RunnerFetchDeps = {
    exec:
      deps.exec ??
      ((id, command, o) =>
        execOnIncidentRunner(id, command, {
          repo: opts.repo,
          stdin: o.stdin,
          auditCommand: o.auditCommand,
          timeoutMs: o.timeoutMs,
        })),
    runner: deps.runner ?? getRunner,
    connected: deps.connected ?? isRunnerConnected,
    gate: deps.gate ?? productionRunOnProblem,
    now: deps.now ?? Date.now,
  };
  // The caller's single deadline for every hop, counted from now: an
  // AbortSignal does not say when it will fire.
  const deadline = d.now() + (opts.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS);

  /** The Runner, or why this check cannot use it. */
  const usable = async (): Promise<string> => {
    const runner = d.runner(runnerId);
    if (!runner || !d.connected(runnerId))
      throw offline(runner ? runner.label || runner.name : runnerId);
    const name = runner.label || runner.name;
    if (runner.platform === "win32")
      throw runnerProblem(
        "Runner-targeted checks need a macOS or Linux Runner",
      );
    const refused = await d.gate(runnerId, opts.repo);
    if (refused) throw runnerProblem(refused);
    return name;
  };

  /** One command on the Runner; anything wrong with the Runner itself is
   *  a Runner problem. */
  const run = async (
    name: string,
    command: string,
    stdin: string,
    timeoutMs: number,
  ): Promise<RunnerExecResult> => {
    let result: RunnerExecResult;
    try {
      result = await d.exec(runnerId, command, {
        timeoutMs,
        stdin,
        auditCommand: label,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === "RUNNER_UNAVAILABLE")
        throw runnerProblem((error as Error).message);
      throw runnerProblem(
        `Runner ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.timedOut)
      throw runnerProblem(`Runner ${name} did not answer in time`);
    if (result.code === -1)
      throw runnerProblem(`Runner ${name} disconnected during the check`);
    return result;
  };

  /** Time left for a step that takes at most `cap` ms. */
  const left = (cap: number): number =>
    Math.max(MIN_REMAINING_MS, Math.min(cap, deadline - d.now()));

  /** The Runner's curl understands the config (`%{stderr}`), or why not. */
  const checkCurl = async (name: string): Promise<void> => {
    if (curlChecked.has(runnerId)) return;
    const result = await run(
      name,
      CURL_VERSION_COMMAND,
      "",
      left(RESOLVE_TIMEOUT_MS),
    );
    if (result.code === 127 || result.code === 126)
      throw runnerProblem(`curl is not installed on Runner ${name}`);
    const version = /^curl (\d+)\.(\d+)(?:\.(\d+))?/m.exec(result.stdout);
    if (result.code !== 0 || !version)
      throw runnerProblem(
        `Runner ${name} did not report a curl version. Update curl on the Runner`,
      );
    const major = Number(version[1]);
    const minor = Number(version[2]);
    if (
      major < MIN_CURL.major ||
      (major === MIN_CURL.major && minor < MIN_CURL.minor)
    )
      throw runnerProblem(
        `Runner ${name} has curl ${version[1]}.${version[2]}.${version[3] ?? "0"}; incident checks need ${MIN_CURL.major}.${MIN_CURL.minor} or newer. Update curl on the Runner`,
      );
    curlChecked.add(runnerId);
  };

  return {
    resolve: async (host) => {
      refuseGlobHost(host);
      if (runnerCheckBlocked(host))
        throw new BlockedAddressError(
          `Refusing to fetch a private name: ${host}`,
        );
      const name = await usable();
      const result = await run(
        name,
        RESOLVE_COMMAND,
        `${host}\n`,
        left(RESOLVE_TIMEOUT_MS),
      );
      if (result.code === 127 || result.code === 126)
        throw runnerProblem(
          `Runner ${name} cannot resolve names (no getent or dscacheutil)`,
        );
      const addresses =
        result.code === 0 ? resolvedAddresses(result.stdout) : [];
      if (!addresses.length) throw new Error(`Could not resolve ${host}`);
      return addresses;
    },
    isBlocked: runnerCheckBlocked,
    send: async (target, init, isBlocked) => {
      refuseGlobHost(target.url.hostname);
      refuseGlobHost(target.host);
      if (isBlocked(target.host))
        throw new Error(`Refusing to fetch ${target.host} from a Runner`);
      for (const address of target.addresses) {
        if (isBlocked(address))
          throw new BlockedAddressError(
            `Refusing to connect to the private address ${address}`,
          );
        // A redirect chooses its own target: only the signal's own host
        // may be a private address.
        if (!sameHost(target.host, opts.host) && isBlockedAddress(address))
          throw new BlockedAddressError(
            `Refusing to fetch ${target.host}: it resolves to the private address ${address}`,
          );
      }
      const name = await usable();
      if (init.signal.aborted) throw timeoutError();
      await checkCurl(name);
      if (init.signal.aborted) throw timeoutError();
      const remaining = Math.max(MIN_REMAINING_MS, deadline - d.now());
      const config = curlConfig(target, init, Math.ceil(remaining / 1000));
      const result = await run(
        name,
        CURL_COMMAND,
        config,
        remaining + EXEC_GRACE_MS,
      );
      if (result.code === 127 || result.code === 126)
        throw runnerProblem(`curl is not installed on Runner ${name}`);
      if (result.code === 28) throw timeoutError();
      if (CURL_CANNOT.has(result.code)) {
        const line = curlError(result.stderr);
        throw runnerProblem(
          line
            ? `curl on Runner ${name} cannot make this request: ${line}`
            : `curl on Runner ${name} cannot make this request (exit ${result.code})`,
        );
      }
      // head stopped reading at the cap: curl could not write (23) or the
      // pipe killed it (128 + SIGPIPE).
      const cut =
        result.code === 23 ||
        result.code === 141 ||
        Buffer.byteLength(result.stdout) > RUNNER_BODY_CAP_BYTES;
      if (result.code !== 0 && !cut) {
        const line = curlError(result.stderr);
        throw new Error(line ?? `curl exited ${result.code}`);
      }
      if (cut && init.maxBodyBytes > RUNNER_BODY_CAP_BYTES)
        throw Object.assign(
          new Error(`Response over ${RUNNER_BODY_CAP_BYTES / 1000} KB`),
          { code: "BODY_TOO_LARGE", limitKb: RUNNER_BODY_CAP_BYTES / 1000 },
        );
      return parseCurlOutput(
        result.stdout,
        result.stderr,
        init.maxBodyBytes,
        cut,
      );
    },
  };
}
