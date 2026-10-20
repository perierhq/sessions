// HTTP requests an incident agent sends through its granted egress route:
// Sessions' own network with the pinned, SSRF-guarded fetch ("server"), curl
// on a paired Runner, which is production's own egress ("runner"), or an HTTP
// proxy that may carry a borrowed Proxy-Authorization ("proxy"). Only the
// listed hosts are reachable, redirects are returned and never followed,
// only a few harmless headers are forwarded, and the audit keeps the host and
// path only: never the query, headers or body. Never throws.
import type { ResolvedEgress } from "../../../shared/incident-access";
import { isBlockedAddress } from "../../shared/network-address";
import {
  type PinnedFetchDeps,
  pinnedHttpRequest,
  resolvePinnedTarget,
  resolveWithDns,
  untilAborted,
} from "../../shared/pinned-fetch";
import {
  incidentGrantFor,
  incidentGrantHeaders,
  scrubCredentialSecrets,
} from "../../keychain";
import { readCapped } from "../../keychain-broker";
import { execOnRunner, isRunnerConnected } from "../../runner-ws";
import { shellQuote } from "../../sandbox/adapters/bootstrap";
import { assertFetchableUrl } from "../../web-fetch";
import { refusalDetail } from "../sources/http";
import { freshGrantedCredential } from "./credentials";
import { type IncidentToolContext, toolAudit } from "./tool-context";

export const EGRESS_READ_CAP_BYTES = 1_048_576;
export const EGRESS_RETURN_CHARS = 65_536;
export const EGRESS_MAX_BODY_CHARS = 16_384;
export const EGRESS_FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "if-none-match",
  "if-modified-since",
];
const EGRESS_DEFAULT_TIMEOUT_S = 15;
const EGRESS_MAX_TIMEOUT_S = 30;
const MARKER = "__EGRESS__ ";
const LOCATION_MARKER = "\n__EGRESS_LOCATION__ ";

export interface EgressInput {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutSeconds?: number;
}

export type EgressResult =
  | {
      ok: true;
      route: "server" | "runner" | "proxy";
      status: number;
      contentType?: string;
      location?: string;
      latencyMs: number;
      body: string;
      truncated: boolean;
      droppedHeaders: string[];
    }
  | { ok: false; error: string };

export interface ProxyHeadersInput {
  sessionId: string;
  incidentId: string;
  credentialId: string;
  /** The proxy's hostname. */
  host: string;
  /** The proxied request's method and target path. */
  method: string;
  path: string;
}
type ProxyHeaders = (
  input: ProxyHeadersInput,
) =>
  | Record<string, string>
  | { error: string }
  | Promise<Record<string, string> | { error: string }>;

export interface EgressDeps {
  /** The server route's pinned fetch seams. */
  net?: Partial<PinnedFetchDeps>;
  /** The proxy route only. */
  fetchImpl?: typeof fetch;
  /** The proxy route only: the address check on the proxy and the target. */
  assertUrl?: (raw: string) => Promise<URL>;
  exec?: typeof execOnRunner;
  connected?: (id: string) => boolean;
  proxyHeaders?: ProxyHeaders;
}

const defaultNet: PinnedFetchDeps = {
  resolve: resolveWithDns,
  isBlocked: isBlockedAddress,
  send: (target, init, isBlocked) => pinnedHttpRequest(target, init, isBlocked),
};

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

function clampTimeout(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds))
    return EGRESS_DEFAULT_TIMEOUT_S;
  return Math.min(EGRESS_MAX_TIMEOUT_S, Math.max(1, Math.round(seconds)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The proxy credential's grant, minted at the mode the agent's freshly
 *  resolved access names, then its injection headers. */
async function defaultProxyHeaders(
  ctx: IncidentToolContext,
  input: ProxyHeadersInput,
): Promise<Record<string, string> | { error: string }> {
  const fresh = await freshGrantedCredential(ctx, input.credentialId);
  if ("error" in fresh) return { error: fresh.error };
  const { access, credential } = fresh;
  const grant = await incidentGrantFor({
    credentialId: credential.credential,
    sessionId: input.sessionId,
    mode: credential.mode,
    incident: {
      incidentId: ctx.binding.incidentId,
      role: ctx.binding.role,
      project: access.project,
      signalId: access.signalId,
    },
    purpose: "Egress through the granted proxy",
  });
  if ("error" in grant) return { error: grant.error };
  return incidentGrantHeaders(input);
}

function textOf(
  bytes: Uint8Array,
  cut: boolean,
  credentialIds: string[],
): { body: string; truncated: boolean } {
  const text = scrubCredentialSecrets(
    new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    credentialIds,
  );
  return {
    body: text.slice(0, EGRESS_RETURN_CHARS),
    truncated: cut || text.length > EGRESS_RETURN_CHARS,
  };
}

export async function egressFetch(
  ctx: IncidentToolContext,
  input: EgressInput,
  deps: EgressDeps = {},
): Promise<EgressResult> {
  try {
    return await egressFetchInner(ctx, input, deps);
  } catch (error) {
    return fail(`Egress failed: ${messageOf(error)}`);
  }
}

async function egressFetchInner(
  ctx: IncidentToolContext,
  input: EgressInput,
  deps: EgressDeps,
): Promise<EgressResult> {
  const egress: ResolvedEgress | null = ctx.access.egress;
  let host: string | undefined;
  const deny = (reason: string): Fail => {
    toolAudit(ctx, "incident_egress_denied", {
      ...(host ? { host } : {}),
      reason,
    });
    return fail(reason);
  };
  if (!egress) return deny("This agent has no egress route");
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return deny("Not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return deny("Only http and https URLs");
  host = url.hostname.toLowerCase();
  if (url.username || url.password)
    return deny("Credentials do not go in the URL");
  if (!egress.hosts.map((h) => h.toLowerCase()).includes(host))
    return deny(`${host} is not on this agent's egress list`);
  const method = input.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && method !== "POST")
    return deny("Only GET, HEAD and POST");
  if (input.body !== undefined && method !== "POST")
    return deny("A body needs POST");
  if (input.body !== undefined && input.body.length > EGRESS_MAX_BODY_CHARS)
    return deny("Body too long");
  const headers: Record<string, string> = {};
  const droppedHeaders: string[] = [];
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!EGRESS_FORWARDED_HEADERS.includes(name.toLowerCase())) {
      droppedHeaders.push(name);
      continue;
    }
    if (typeof value !== "string" || /[\0\r\n]/.test(value))
      return deny("Header values cannot contain line breaks");
    headers[name] = value;
  }
  const timeout = clampTimeout(input.timeoutSeconds);
  const path = url.pathname;
  const credentialIds = ctx.access.credentials.map((c) => c.credential);
  const started = Date.now();
  const where =
    egress.route === "runner"
      ? { runner_id: egress.runner }
      : egress.route === "proxy"
        ? { proxy_host: hostOf(egress.proxyUrl) }
        : {};
  const audit = (fields: { status?: number; error?: string }) =>
    toolAudit(ctx, "incident_egress_fetch", {
      route: egress.route,
      ...where,
      method,
      host,
      path,
      ...fields,
      duration_ms: Date.now() - started,
    });
  const failed = (error: string): Fail => {
    audit({ error: error.slice(0, 300) });
    return fail(error);
  };
  const ok = (r: {
    status: number;
    contentType?: string | null;
    location?: string | null;
    latencyMs: number;
    body: string;
    truncated: boolean;
  }): EgressResult => {
    audit({ status: r.status });
    return {
      ok: true,
      route: egress.route,
      status: r.status,
      ...(r.contentType ? { contentType: r.contentType } : {}),
      ...(r.location ? { location: r.location } : {}),
      latencyMs: r.latencyMs,
      body: r.body,
      truncated: r.truncated,
      droppedHeaders,
    };
  };

  if (egress.route === "server") {
    const net: PinnedFetchDeps = { ...defaultNet, ...deps.net };
    const signal = AbortSignal.timeout(timeout * 1000);
    let target: Awaited<ReturnType<typeof resolvePinnedTarget>>;
    try {
      target = await untilAborted(resolvePinnedTarget(url.href, net), signal);
    } catch (error) {
      return failed(refusalDetail(error));
    }
    try {
      const res = await net.send(
        target,
        {
          method,
          headers,
          ...(input.body !== undefined ? { body: input.body } : {}),
          signal,
          maxBodyBytes: EGRESS_READ_CAP_BYTES,
          overflow: "truncate",
        },
        net.isBlocked,
      );
      const text = textOf(res.body, res.truncated === true, credentialIds);
      return ok({
        status: res.status,
        contentType: res.headers.get("content-type"),
        location: res.headers.get("location"),
        latencyMs: Date.now() - started,
        ...text,
      });
    } catch (error) {
      if (signal.aborted) return failed(`Timed out after ${timeout}s`);
      return failed(`Request failed: ${messageOf(error)}`);
    }
  }

  if (egress.route === "proxy") {
    const assertUrl = deps.assertUrl ?? assertFetchableUrl;
    const proxyUrl = egress.proxyUrl ?? "";
    let proxy: URL;
    try {
      proxy = await assertUrl(proxyUrl);
      await assertUrl(url.href);
    } catch (error) {
      return failed(refusalDetail(error));
    }
    if (proxy.username || proxy.password)
      return failed("Credentials do not go in the proxy URL");
    let proxyHeaders: Record<string, string> = {};
    if (egress.proxyCredential) {
      const input2: ProxyHeadersInput = {
        sessionId: ctx.sessionId,
        incidentId: ctx.binding.incidentId,
        credentialId: egress.proxyCredential,
        host: proxy.hostname.toLowerCase(),
        method,
        path,
      };
      const got = await (deps.proxyHeaders
        ? deps.proxyHeaders(input2)
        : defaultProxyHeaders(ctx, input2));
      if ("error" in got && typeof got.error === "string")
        return failed(got.error);
      proxyHeaders = got as Record<string, string>;
      // Any other header would be forwarded by the proxy to the target.
      if (
        Object.keys(proxyHeaders).some(
          (name) => name.toLowerCase() !== "proxy-authorization",
        )
      )
        return failed("The proxy credential must inject Proxy-Authorization");
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const signal = AbortSignal.timeout(timeout * 1000);
    try {
      const res = await fetchImpl(url.href, {
        method,
        headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
        redirect: "manual",
        signal,
        // The object form keeps the proxy secret out of the URL.
        proxy: { url: proxy.href, headers: proxyHeaders },
      } as RequestInit);
      const read =
        method === "HEAD"
          ? { bytes: new Uint8Array(), cut: false }
          : await readCapped(res, EGRESS_READ_CAP_BYTES);
      const text = textOf(read.bytes, read.cut, credentialIds);
      return ok({
        status: res.status,
        contentType: res.headers.get("content-type"),
        location: res.headers.get("location"),
        latencyMs: Date.now() - started,
        ...text,
      });
    } catch (error) {
      if (signal.aborted) return failed(`Timed out after ${timeout}s`);
      return failed(`Request failed: ${messageOf(error)}`);
    }
  }

  // Runner: curl on the paired Runner, production's own network.
  const runnerId = egress.runner ?? "";
  const runnerName = egress.runnerName ?? runnerId;
  const connected = deps.connected ?? isRunnerConnected;
  if (!runnerId || !connected(runnerId))
    return failed(`${runnerName} is offline`);
  // -q must come first: it stops curl reading a .curlrc on the Runner.
  // --globoff keeps [] and {} in the URL literal, and --data-raw never reads
  // a body that starts with @ as a file name.
  const argv = [
    "curl",
    "-q",
    "--globoff",
    "--silent",
    "--show-error",
    "--max-time",
    String(timeout),
    "--max-redirs",
    "0",
    "--proto",
    "=http,https",
    "--noproxy",
    "*",
    "--max-filesize",
    String(EGRESS_READ_CAP_BYTES),
    "--request",
    method,
    ...Object.entries(headers).flatMap(([name, value]) => [
      "--header",
      `${name}: ${value}`,
    ]),
    ...(input.body !== undefined ? ["--data-raw", input.body] : []),
    "--write-out",
    `\n${MARKER}%{http_code} %{time_total} %{content_type}${LOCATION_MARKER}%{redirect_url}`,
    "--url",
    url.href,
  ];
  const exec = deps.exec ?? execOnRunner;
  let result: Awaited<ReturnType<typeof execOnRunner>>;
  try {
    result = await exec(runnerId, shellQuote(argv), {
      timeoutMs: timeout * 1000 + 5000,
      sessionId: ctx.sessionId,
      aws: false,
    });
  } catch (error) {
    return failed(`Could not run on ${runnerName}: ${messageOf(error)}`);
  }
  let stdout = result.stdout ?? "";
  let location: string | undefined;
  const loc = stdout.lastIndexOf(LOCATION_MARKER);
  if (loc >= 0 && !stdout.slice(loc + LOCATION_MARKER.length).includes("\n")) {
    location = stdout.slice(loc + LOCATION_MARKER.length).trim() || undefined;
    stdout = stdout.slice(0, loc);
  }
  const at = stdout.lastIndexOf(`\n${MARKER}`);
  const markerAt = at >= 0 ? at + 1 : stdout.startsWith(MARKER) ? 0 : -1;
  if (result.code !== 0 || markerAt < 0)
    return failed(
      `curl on ${runnerName} failed (exit ${result.code}): ${(result.stderr ?? "").slice(0, 300)}`,
    );
  const [status, seconds, ...type] = stdout
    .slice(markerAt + MARKER.length)
    .trim()
    .split(" ");
  const body = stdout.slice(0, Math.max(0, markerAt - 1));
  const text = textOf(new TextEncoder().encode(body), false, credentialIds);
  return ok({
    status: Number(status) || 0,
    contentType: type.join(" ") || undefined,
    location,
    latencyMs: Math.round(Number(seconds) * 1000) || 0,
    ...text,
  });
}

function hostOf(raw: string | undefined): string {
  try {
    return raw ? new URL(raw).hostname : "";
  } catch {
    return "";
  }
}
