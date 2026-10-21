// HTTP signal source: one check with manual redirects, a body cap, optional
// body expectations and JSON mapping. Every hop is resolved once, refused if
// any address is private, and dialled only at the checked addresses (shared
// pinned transport), so a DNS answer that changes between check and connect
// cannot move the request. Never throws: every failure becomes an
// observation. A provider's status page that cannot be read is `unknown`,
// never an outage.
import type {
  HttpSource,
  Observation,
  ObservationResult,
} from "../../../shared/incidents";
import { compileSafeRegex } from "../../shared/safe-regex";
import { redactUrl } from "../../shared/redact";
import { isBlockedAddress } from "../../shared/network-address";
import {
  BlockedAddressError,
  type PinnedFetchDeps,
  type PinnedResponse,
  pinnedHttpRequest,
  resolvePinnedTarget,
  resolveWithDns,
  untilAborted,
} from "../../shared/pinned-fetch";
import { mapJson } from "../json-mapping";
import {
  REDACTED,
  isSecretHeader,
  redactSecretQuery,
  sourceSecretValues,
} from "../signal-validation";

export const HTTP_BODY_CAP_BYTES = 1_048_576;
export const HTTP_DEFAULT_TIMEOUT_MS = 10_000;
export const HTTP_MAX_REDIRECTS = 5;
export const SIGNAL_USER_AGENT = "opensession-signals/1";

const PREVIEW_BODY_CHARS = 4000;
/** Bytes read when only the preview needs the body (4000 chars of UTF-8). */
const PREVIEW_READ_BYTES = 16_384;
const PREVIEW_JSON_CHARS = 65_536;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers that describe a request body; they go when the body goes. */
const BODY_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "content-language",
  "content-location",
]);

export interface SourceRunOptions {
  /** A provider's unreadable status page is `unknown`, never an outage. */
  provider?: boolean;
  /** Resolution, address policy and transport. Tests swap them; production
   *  uses DNS, the shared private-address policy and node:http(s). */
  net?: Partial<PinnedFetchDeps>;
  now?: () => number;
}

export interface HttpPreview {
  status?: number;
  finalUrl?: string;
  contentType?: string;
  latencyMs?: number;
  bodyHead: string;
  bodyTruncated: boolean;
  /** The body came in an encoding that cannot be decoded: `bodyHead` is
   *  its raw bytes. */
  undecodable?: true;
  json?: unknown;
  matches?: Record<string, unknown[]>;
}

export interface SourceRun {
  observations: Observation[];
  preview?: HttpPreview;
}

class RunStop extends Error {
  constructor(
    readonly result: ObservationResult,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** Shorter parts of a secret (a credential after its scheme, a Basic
 *  password) are too common to scrub on their own. */
const MIN_SECRET_PART_CHARS = 4;

function decodeBasic(credential: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(credential)) return undefined;
  const decoded = Buffer.from(credential, "base64").toString("utf8");
  const bare = (b64: string) => b64.replace(/=+$/, "");
  // Only a credential that is base64 of text.
  return bare(Buffer.from(decoded, "utf8").toString("base64")) ===
    bare(credential)
    ? decoded
    : undefined;
}

/**
 * Every form a secret the check sends could come back in: as sent,
 * URL-encoded, JSON-escaped; for a `<scheme> <credential>` header also the
 * credential, and for Basic the `user:pass` it encodes and the password.
 * Longest first, so a longer form is scrubbed before a part of it.
 */
export function secretForms(values: string[]): string[] {
  const out = new Set<string>();
  const add = (value: string, part = false) => {
    if (!value || (part && value.length < MIN_SECRET_PART_CHARS)) return;
    const encoded = encodeURIComponent(value);
    out.add(value);
    out.add(encoded);
    out.add(encoded.replace(/%20/g, "+"));
    out.add(JSON.stringify(value).slice(1, -1));
  };
  for (const value of values) {
    add(value);
    const scheme = /^([A-Za-z][\w-]*)\s+(\S.*)$/.exec(value);
    if (!scheme) continue;
    add(scheme[2]!, true);
    if (scheme[1]!.toLowerCase() !== "basic") continue;
    const decoded = decodeBasic(scheme[2]!);
    if (decoded === undefined) continue;
    add(decoded, true);
    const colon = decoded.indexOf(":");
    if (colon >= 0) add(decoded.slice(colon + 1), true);
  }
  out.delete(REDACTED);
  return [...out].sort((a, b) => b.length - a.length);
}

/** `text` with every secret form replaced by {@link REDACTED}. */
export function scrubText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets)
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
}

/** A cut text can end in the start of a secret: redact that too. */
function scrubCutEnd(text: string, secrets: string[]): string {
  for (const secret of secrets)
    for (
      let k = Math.min(secret.length - 1, text.length);
      k >= MIN_SECRET_PART_CHARS;
      k--
    )
      if (text.endsWith(secret.slice(0, k)))
        return text.slice(0, text.length - k) + REDACTED;
  return text;
}

/** Strings (and object keys) anywhere in `value`, scrubbed. */
export function scrubValue<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  if (typeof value === "string") return scrubText(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((item) => scrubValue(item, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        scrubText(key, secrets),
        scrubValue(item, secrets),
      ]),
    ) as T;
  return value;
}

/** A URL as it may leave the server: no userinfo, no secret query values. */
export function redactOutputUrl(raw: string): string {
  return redactSecretQuery(redactUrl(raw));
}

const defaultNet: PinnedFetchDeps = {
  resolve: resolveWithDns,
  isBlocked: isBlockedAddress,
  send: (target, init, isBlocked) => pinnedHttpRequest(target, init, isBlocked),
};

/** An address-policy refusal as a short detail: `Refused: <why>`. */
export function refusalDetail(error: unknown): string {
  const message = errorMessage(error);
  const resolved =
    /^Refusing to fetch (.+): it resolves to the private address (.+)$/.exec(
      message,
    );
  if (resolved)
    return resolved[1] === resolved[2]
      ? `Refused: ${resolved[2]} is a private address`
      : `Refused: ${resolved[1]} resolves to the private address ${resolved[2]}`;
  const name = /^Refusing to fetch a private name: (.+)$/.exec(message);
  if (name) return `Refused: ${name[1]} is a private name`;
  const connect = /^Refusing to connect to the private address (.+)$/.exec(
    message,
  );
  if (connect) return `Refused: ${connect[1]} is a private address`;
  return `Refused: ${message}`;
}

function isRefusal(error: unknown): boolean {
  return (
    error instanceof BlockedAddressError ||
    (error instanceof Error && error.message.startsWith("Refusing"))
  );
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

/** Errors a Runner transport (`runner-fetch.ts`) throws from `net.resolve`
 *  or `net.send`: an offline or otherwise unusable Runner says nothing
 *  about the service, a body over the Runner's cap is a failure like any
 *  other size failure. */
function transportStop(
  error: unknown,
  failed: ObservationResult,
): RunStop | null {
  const e = error as {
    code?: unknown;
    runnerName?: unknown;
    limitKb?: unknown;
  };
  if (typeof error !== "object" || error === null) return null;
  if (e.code === "RUNNER_OFFLINE")
    return new RunStop("unknown", `Runner offline: ${String(e.runnerName)}`);
  // Anything else wrong with the Runner says nothing about the service.
  if (e.code === "RUNNER_UNAVAILABLE")
    return new RunStop("unknown", errorMessage(error));
  if (e.code === "BODY_TOO_LARGE")
    return new RunStop(failed, `Response over ${String(e.limitKb)} KB`);
  return null;
}

function errorMessage(error: unknown): string {
  return redactOutputUrl(
    error instanceof Error ? error.message : String(error),
  );
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return redactOutputUrl(raw);
  }
}

function withoutUserinfo(url: URL): URL {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  return copy;
}

/** Defaults first; configured headers override them case-insensitively. */
function initialHeaders(source: HttpSource): Map<string, [string, string]> {
  const headers = new Map<string, [string, string]>([
    ["user-agent", ["user-agent", SIGNAL_USER_AGENT]],
    ["accept", ["accept", "application/json, text/plain;q=0.9, */*;q=0.5"]],
  ]);
  for (const [name, value] of Object.entries(source.headers ?? {}))
    headers.set(name.toLowerCase(), [name, value]);
  return headers;
}

function expectedText(expectStatus: number[] | undefined): string {
  return expectStatus?.length ? expectStatus.join(", ") : "2xx";
}

function statusExpected(status: number, expectStatus?: number[]): boolean {
  return expectStatus?.length
    ? expectStatus.includes(status)
    : status >= 200 && status <= 299;
}

export async function runHttpSource(
  source: HttpSource,
  opts: SourceRunOptions = {},
): Promise<SourceRun> {
  const now = opts.now ?? Date.now;
  const net: PinnedFetchDeps = { ...defaultNet, ...opts.net };
  const timeoutMs = source.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS;
  const started = now();
  const at = new Date(started).toISOString();
  const sourceUrl = redactOutputUrl(source.url);
  // A server may echo what it was sent: no detail or preview carries it.
  const secrets = secretForms(sourceSecretValues(source));
  // Transport, status and size failures of a provider's status page say
  // nothing about the provider: they are unknown, never an outage.
  const failed: ObservationResult = opts.provider ? "unknown" : "fail";
  const observe = (
    result: ObservationResult,
    detail: string,
    value?: number,
  ): Observation => ({
    at,
    result,
    ...(value === undefined ? {} : { value }),
    detail: scrubText(detail, secrets),
    sourceUrl,
  });

  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () =>
    new RunStop(failed, `No response within ${timeoutMs} ms`);
  let preview: HttpPreview | undefined;
  try {
    let method = source.method ?? "GET";
    let body = method === "POST" ? source.body : undefined;
    let headers = initialHeaders(source);
    let current = source.url;
    let previousOrigin: string | undefined;
    // Without a mapping or a body expectation only the preview reads the
    // body, so a long one is cut short rather than judged.
    const needsBody = !!source.json || !!source.expectBody;
    let response: PinnedResponse | undefined;
    let finalUrl: URL | undefined;
    for (let redirects = 0; ; redirects++) {
      // One resolution per hop: the addresses checked here are the only
      // ones this hop may dial.
      let pinned: Awaited<ReturnType<typeof resolvePinnedTarget>>;
      try {
        pinned = await untilAborted(resolvePinnedTarget(current, net), signal);
      } catch (error) {
        if (signal.aborted) throw timedOut();
        if (isRefusal(error))
          throw new RunStop("unknown", refusalDetail(error));
        const transport = transportStop(error, failed);
        if (transport) throw transport;
        throw new RunStop(
          failed,
          `Could not reach ${hostOf(current)}: ${errorMessage(error)}`,
        );
      }
      const target = withoutUserinfo(pinned.url);
      if (previousOrigin !== undefined && target.origin !== previousOrigin) {
        // Credentials and the request body stay with the origin they were
        // configured for; another origin gets a plain GET (HEAD stays HEAD).
        const crossOriginBody = body !== undefined || method === "POST";
        if (crossOriginBody) {
          method = "GET";
          body = undefined;
        }
        const kept = new Map<string, [string, string]>();
        for (const [key, entry] of headers)
          if (
            !isSecretHeader(entry[0]) &&
            !(crossOriginBody && BODY_HEADERS.has(key))
          )
            kept.set(key, entry);
        headers = kept;
      }
      let hop: PinnedResponse;
      try {
        hop = await untilAborted(
          net.send(
            { ...pinned, url: target },
            {
              method,
              headers: Object.fromEntries(headers.values()),
              body,
              signal,
              maxBodyBytes: needsBody
                ? HTTP_BODY_CAP_BYTES
                : PREVIEW_READ_BYTES,
              overflow: "truncate",
            },
            net.isBlocked,
          ),
          signal,
        );
      } catch (error) {
        if (signal.aborted || isTimeout(error)) throw timedOut();
        if (isRefusal(error))
          throw new RunStop("unknown", refusalDetail(error));
        const transport = transportStop(error, failed);
        if (transport) throw transport;
        throw new RunStop(
          failed,
          `Could not reach ${target.hostname}: ${errorMessage(error)}`,
        );
      }
      const location = hop.headers.get("location");
      if (
        !REDIRECT_STATUSES.has(hop.status) ||
        !location ||
        // An expected 3xx is the answer itself.
        source.expectStatus?.includes(hop.status)
      ) {
        response = hop;
        finalUrl = target;
        break;
      }
      if (redirects >= HTTP_MAX_REDIRECTS)
        throw new RunStop(failed, "Too many redirects");
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new RunStop(failed, "Redirect to an invalid URL");
      }
      // As browsers do: 303 always, and 301/302 after a POST, become a GET.
      if (
        (hop.status === 303 && method !== "HEAD") ||
        ((hop.status === 301 || hop.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        for (const key of BODY_HEADERS) headers.delete(key);
      }
      previousOrigin = target.origin;
      current = next.href;
    }

    const contentType = response.headers.get("content-type") ?? "";
    // The transport read the body up to the cap, then stopped.
    const read = {
      text: new TextDecoder("utf-8", { fatal: false }).decode(response.body),
      over: response.truncated === true,
    };
    const latencyMs = Math.max(0, Math.round(now() - started));
    const shown = scrubText(read.text, secrets);
    const cut = read.over || shown.length > PREVIEW_BODY_CHARS;
    const head = shown.slice(0, PREVIEW_BODY_CHARS);
    preview = {
      status: response.status,
      finalUrl: scrubText(redactOutputUrl(finalUrl.href), secrets),
      contentType,
      latencyMs,
      bodyHead: cut ? scrubCutEnd(head, secrets) : head,
      bodyTruncated: cut,
      ...(response.undecodable ? { undecodable: true as const } : {}),
    };
    const status = response.status;
    if (!statusExpected(status, source.expectStatus))
      return {
        observations: [
          observe(
            failed,
            `HTTP ${status} (expected ${expectedText(source.expectStatus)})`,
            latencyMs,
          ),
        ],
        preview,
      };
    if (response.undecodable && needsBody) {
      const encoding = response.headers.get("content-encoding") ?? "";
      throw new RunStop(
        failed,
        `Response body is in an encoding that cannot be read (${encoding.trim() || "unknown"})`,
      );
    }
    if (read.over && needsBody) throw new RunStop(failed, "Response over 1 MB");
    const contains = source.expectBody?.contains;
    if (contains !== undefined && !read.text.includes(contains))
      return {
        observations: [
          observe("fail", `Response did not contain "${contains}"`, latencyMs),
        ],
        preview,
      };
    const regex = source.expectBody?.regex;
    if (regex !== undefined) {
      let matched: boolean;
      try {
        matched = compileSafeRegex(regex).test(read.text);
      } catch (error) {
        return {
          observations: [
            observe("fail", `Invalid regex: ${errorMessage(error)}`, latencyMs),
          ],
          preview,
        };
      }
      if (!matched)
        return {
          observations: [
            observe("fail", `Response did not match /${regex}/`, latencyMs),
          ],
          preview,
        };
    }

    const httpDetail = `HTTP ${status} in ${latencyMs} ms`;
    if (!source.json)
      return { observations: [observe("ok", httpDetail, latencyMs)], preview };

    let doc: unknown;
    try {
      doc = JSON.parse(read.text);
    } catch {
      const type = contentType.split(";")[0]!.trim() || "no content type";
      return {
        observations: [
          observe(failed, `Response was not JSON (${type})`, latencyMs),
        ],
        preview,
      };
    }
    if (JSON.stringify(doc).length <= PREVIEW_JSON_CHARS)
      preview.json = scrubValue(doc, secrets);
    const outcome = mapJson(doc, source.json);
    preview.matches = scrubValue(outcome.matches, secrets);
    const main = observe(
      outcome.result ?? "ok",
      outcome.detail || httpDetail,
      outcome.value ?? latencyMs,
    );
    const lanes = outcome.lanes.map((lane): Observation => ({
      at,
      result: lane.result,
      ...(lane.value === undefined ? {} : { value: lane.value }),
      detail: scrubText(lane.detail, secrets),
      sourceUrl,
      lane: scrubText(lane.lane, secrets),
    }));
    return { observations: [main, ...lanes], preview };
  } catch (error) {
    const stop =
      error instanceof RunStop
        ? error
        : signal.aborted
          ? timedOut()
          : new RunStop(
              failed,
              `Could not reach ${hostOf(source.url)}: ${errorMessage(error)}`,
            );
    return {
      observations: [observe(stop.result, stop.detail)],
      ...(preview ? { preview } : {}),
    };
  }
}
