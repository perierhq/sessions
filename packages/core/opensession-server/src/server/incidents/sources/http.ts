// HTTP signal source: one check with manual redirects through the SSRF guard,
// a body cap, optional body expectations and JSON mapping. Never throws:
// every failure becomes an observation. A provider's status page that cannot
// be read is `unknown`, never an outage.
import type {
  HttpSource,
  Observation,
  ObservationResult,
} from "../../../shared/incidents";
import { compileSafeRegex } from "../../shared/safe-regex";
import { redactUrl } from "../../shared/redact";
import { assertFetchableUrl } from "../../web-fetch";
import { mapJson } from "../json-mapping";
import { isSecretHeader, redactSecretQuery } from "../signal-validation";

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
  fetchImpl?: typeof fetch;
  assertUrl?: (raw: string) => Promise<URL>;
  now?: () => number;
}

export interface HttpPreview {
  status?: number;
  finalUrl?: string;
  contentType?: string;
  latencyMs?: number;
  bodyHead: string;
  bodyTruncated: boolean;
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

/** A URL as it may leave the server: no userinfo, no secret query values. */
export function redactOutputUrl(raw: string): string {
  return redactSecretQuery(redactUrl(raw));
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

/** Read at most `cap` bytes; `over` when the body is longer. */
async function readCapped(
  response: Response,
  cap: number,
): Promise<{ text: string; over: boolean }> {
  if (!response.body) return { text: "", over: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - total));
      total = cap;
      over = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    over,
  };
}

export async function runHttpSource(
  source: HttpSource,
  opts: SourceRunOptions = {},
): Promise<SourceRun> {
  const now = opts.now ?? Date.now;
  const assertUrl = opts.assertUrl ?? assertFetchableUrl;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = source.timeoutMs ?? HTTP_DEFAULT_TIMEOUT_MS;
  const started = now();
  const at = new Date(started).toISOString();
  const sourceUrl = redactOutputUrl(source.url);
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
    detail,
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
    let response: Response | undefined;
    let finalUrl: URL | undefined;
    for (let redirects = 0; ; redirects++) {
      let target: URL;
      try {
        target = withoutUserinfo(await assertUrl(current));
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith("Refusing"))
          throw new RunStop("unknown", `Refused: ${message}`);
        throw new RunStop(
          failed,
          `Could not reach ${hostOf(current)}: ${message}`,
        );
      }
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
      let hop: Response;
      try {
        hop = await fetchImpl(target, {
          method,
          headers: [...headers.values()],
          body,
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw timedOut();
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
      await hop.body?.cancel().catch(() => {});
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
    // Without a mapping or a body expectation only the preview reads the
    // body, so a long one is cut short rather than judged.
    const needsBody = !!source.json || !!source.expectBody;
    let read: { text: string; over: boolean };
    try {
      read =
        method === "HEAD"
          ? { text: "", over: false }
          : await readCapped(
              response,
              needsBody ? HTTP_BODY_CAP_BYTES : PREVIEW_READ_BYTES,
            );
    } catch (error) {
      if (signal.aborted) throw timedOut();
      throw new RunStop(
        failed,
        `Could not reach ${finalUrl.hostname}: ${errorMessage(error)}`,
      );
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    preview = {
      status: response.status,
      finalUrl: redactOutputUrl(finalUrl.href),
      contentType,
      latencyMs,
      bodyHead: read.text.slice(0, PREVIEW_BODY_CHARS),
      bodyTruncated: read.over || read.text.length > PREVIEW_BODY_CHARS,
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
    if (JSON.stringify(doc).length <= PREVIEW_JSON_CHARS) preview.json = doc;
    const outcome = mapJson(doc, source.json);
    preview.matches = outcome.matches;
    const main = observe(
      outcome.result ?? "ok",
      outcome.detail || httpDetail,
      outcome.value ?? latencyMs,
    );
    const lanes = outcome.lanes.map((lane): Observation => ({
      at,
      result: lane.result,
      ...(lane.value === undefined ? {} : { value: lane.value }),
      detail: lane.detail,
      sourceUrl,
      lane: lane.lane,
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
