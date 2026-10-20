// http checks from a production Runner: the `send` half of `PinnedFetchDeps`
// as one curl per hop on the Runner, so a signal sees what production sees
// (its egress IP, its TLS stack, its DNS). Redirects come back unfollowed:
// `runHttpSource` walks them itself, so every hop passes the Runner guard and
// the cross-origin header drop. The guard allows private and loopback
// addresses (the URL is admin-set and the Runner is the production host
// checking itself) and refuses cloud metadata endpoints.
import { execOnRunner, isRunnerConnected } from "../../runner-ws";
import type { RunnerExecResult } from "../../runner-ws";
import { getRunner } from "../../runners";
import type {
  FetchTarget,
  PinnedFetchDeps,
  PinnedRequestInit,
  PinnedResponse,
} from "../../shared/pinned-fetch";
import { HTTP_DEFAULT_TIMEOUT_MS } from "./http";

/** The Runner channel returns at most 200 000 characters of output. */
export const RUNNER_BODY_CAP_BYTES = 150_000;
const STATUS_MARKER = "\n__SESSIONS_CURL__";
const EXEC_GRACE_MS = 5_000;
const MIN_REMAINING_MS = 1_000;
const STDERR_MAX = 200;

export interface RunnerFetchDeps {
  exec: (
    runnerId: string,
    command: string,
    opts: { timeoutMs: number },
  ) => Promise<RunnerExecResult>;
  runner: (id: string) => { name: string; platform: string } | undefined;
  connected: (id: string) => boolean;
  now: () => number;
}

/** Who the check runs for, and its one deadline for the whole redirect
 *  chain. `repo` and `user` are what the Runner's command permission is
 *  checked against. */
export interface RunnerNetOptions {
  repo?: string;
  user?: string;
  timeoutMs?: number;
}

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "100.100.100.200",
  "metadata.google.internal",
]);

export function runnerCheckBlocked(addressOrName: string): boolean {
  const name = addressOrName
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  return METADATA_HOSTS.has(name);
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

function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

function bodyText(body: PinnedRequestInit["body"]): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new TextDecoder().decode(body);
}

function curlCommand(
  target: FetchTarget,
  init: PinnedRequestInit,
  maxTimeS: number,
): string {
  const parts = [
    "curl --silent --show-error --include --proto =http,https --max-redirs 0",
    `--max-time ${maxTimeS}`,
    `--max-filesize ${RUNNER_BODY_CAP_BYTES}`,
    `--request ${shellQuote(init.method ?? "GET")}`,
    // curl asks for the encodings it can undo and decodes the body: the
    // Runner channel carries text, so compressed bytes would not survive.
    "--compressed",
  ];
  for (const [name, value] of Object.entries(init.headers ?? {}))
    if (name.toLowerCase() !== "accept-encoding")
      parts.push(`--header ${shellQuote(`${name}: ${value}`)}`);
  const body = bodyText(init.body);
  if (body !== undefined) parts.push(`--data-binary ${shellQuote(body)}`);
  parts.push(`--write-out ${shellQuote(`${STATUS_MARKER}%{http_code}`)}`);
  parts.push(`-- ${shellQuote(target.url.toString())}`);
  return parts.join(" ");
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

function parseCurlOutput(stdout: string, maxBodyBytes: number): PinnedResponse {
  const at = stdout.lastIndexOf(STATUS_MARKER);
  if (at === -1) throw new Error("The Runner returned no response");
  const status = Number(stdout.slice(at + STATUS_MARKER.length).trim());
  let raw = stdout.slice(0, at);
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
  const code = Number.isInteger(status) && status > 0 ? status : lineStatus;
  if (!Number.isInteger(code) || code < 100 || code > 599)
    throw new Error("The Runner returned no HTTP status");
  const bytes = new TextEncoder().encode(block ? block.rest : "");
  const truncated = bytes.length > maxBodyBytes;
  return {
    status: code,
    headers,
    body: truncated ? bytes.slice(0, maxBodyBytes) : bytes,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function runnerNet(
  runnerId: string,
  deps: Partial<RunnerFetchDeps> = {},
  opts: RunnerNetOptions = {},
): PinnedFetchDeps {
  const d: RunnerFetchDeps = {
    exec:
      deps.exec ??
      ((id, command, o) =>
        execOnRunner(id, command, {
          timeoutMs: o.timeoutMs,
          repo: opts.repo,
          user: opts.user,
        })),
    runner: deps.runner ?? getRunner,
    connected: deps.connected ?? isRunnerConnected,
    now: deps.now ?? Date.now,
  };
  // The caller's single deadline for every hop, counted from now: an
  // AbortSignal does not say when it will fire.
  const deadline = d.now() + (opts.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS);
  return {
    // The Runner resolves the name itself, as production does.
    resolve: async (host) => [host],
    isBlocked: runnerCheckBlocked,
    send: async (target, init, isBlocked) => {
      if (isBlocked(target.host))
        throw new Error(`Refusing to fetch ${target.host} from a Runner`);
      const runner = d.runner(runnerId);
      if (!runner || !d.connected(runnerId))
        throw offline(runner?.name ?? runnerId);
      if (runner.platform === "win32")
        throw new Error("Runner-targeted checks need a macOS or Linux Runner");
      if (init.signal.aborted) throw timeoutError();
      const remaining = Math.max(MIN_REMAINING_MS, deadline - d.now());
      const command = curlCommand(target, init, Math.ceil(remaining / 1000));
      const result = await d.exec(runnerId, command, {
        timeoutMs: remaining + EXEC_GRACE_MS,
      });
      if (result.timedOut || result.code === 28) throw timeoutError();
      if (result.code === 63)
        throw Object.assign(
          new Error(`Response over ${RUNNER_BODY_CAP_BYTES / 1000} KB`),
          { code: "BODY_TOO_LARGE", limitKb: RUNNER_BODY_CAP_BYTES / 1000 },
        );
      if (result.code !== 0) {
        const line = result.stderr
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean);
        throw new Error(
          line ? line.slice(0, STDERR_MAX) : `curl exited ${result.code}`,
        );
      }
      return parseCurlOutput(result.stdout, init.maxBodyBytes);
    },
  };
}
