// HTTP signal source: one check with manual redirects through the SSRF guard,
// a body cap, optional body expectations and JSON mapping. Never throws:
// every failure becomes an observation.
import type {
  HttpSource,
  Observation,
  ObservationResult,
} from "../../../shared/incidents";
import { compileSafeRegex } from "../../shared/safe-regex";
import { redactUrl } from "../../shared/redact";
import { assertFetchableUrl } from "../../web-fetch";
import { mapJson } from "../json-mapping";
import { isSecretHeader } from "../signal-validation";

export const HTTP_BODY_CAP_BYTES = 1_048_576;
export const HTTP_DEFAULT_TIMEOUT_MS = 10_000;
export const HTTP_MAX_REDIRECTS = 5;
export const SIGNAL_USER_AGENT = "opensession-signals/1";

const PREVIEW_BODY_CHARS = 4000;
const PREVIEW_JSON_CHARS = 65_536;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

function errorMessage(error: unknown): string {
  return redactUrl(error instanceof Error ? error.message : String(error));
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return redactUrl(raw);
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

/** Read at most the cap; `over` when the body is longer. */
async function readCapped(
  response: Response,
): Promise<{ text: string; over: boolean }> {
  if (!response.body) return { text: "", over: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > HTTP_BODY_CAP_BYTES) {
      chunks.push(value.subarray(0, HTTP_BODY_CAP_BYTES - total));
      total = HTTP_BODY_CAP_BYTES;
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
  const sourceUrl = redactUrl(source.url);
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
    new RunStop("fail", `No response within ${timeoutMs} ms`);
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
          "fail",
          `Could not reach ${hostOf(current)}: ${message}`,
        );
      }
      if (previousOrigin !== undefined && target.origin !== previousOrigin) {
        // Credentials stay with the origin they were configured for.
        const kept = new Map<string, [string, string]>();
        for (const [key, entry] of headers)
          if (!isSecretHeader(entry[0])) kept.set(key, entry);
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
          "fail",
          `Could not reach ${target.hostname}: ${errorMessage(error)}`,
        );
      }
      const location = hop.headers.get("location");
      if (!REDIRECT_STATUSES.has(hop.status) || !location) {
        response = hop;
        finalUrl = target;
        break;
      }
      await hop.body?.cancel().catch(() => {});
      if (redirects >= HTTP_MAX_REDIRECTS)
        throw new RunStop("fail", "Too many redirects");
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new RunStop("fail", "Redirect to an invalid URL");
      }
      if (hop.status === 303 && method !== "HEAD") {
        method = "GET";
        body = undefined;
      }
      previousOrigin = target.origin;
      current = next.href;
    }

    const contentType = response.headers.get("content-type") ?? "";
    let read: { text: string; over: boolean };
    try {
      read =
        method === "HEAD"
          ? { text: "", over: false }
          : await readCapped(response);
    } catch (error) {
      if (signal.aborted) throw timedOut();
      throw new RunStop(
        "fail",
        `Could not reach ${finalUrl.hostname}: ${errorMessage(error)}`,
      );
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    preview = {
      status: response.status,
      finalUrl: redactUrl(finalUrl.href),
      contentType,
      latencyMs,
      bodyHead: read.text.slice(0, PREVIEW_BODY_CHARS),
      bodyTruncated: read.over || read.text.length > PREVIEW_BODY_CHARS,
    };
    if (read.over) throw new RunStop("fail", "Response over 1 MB");

    const status = response.status;
    if (!statusExpected(status, source.expectStatus))
      return {
        observations: [
          observe(
            "fail",
            `HTTP ${status} (expected ${expectedText(source.expectStatus)})`,
            latencyMs,
          ),
        ],
        preview,
      };
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
          observe(
            opts.provider ? "unknown" : "fail",
            `Response was not JSON (${type})`,
            latencyMs,
          ),
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
              "fail",
              `Could not reach ${hostOf(source.url)}: ${errorMessage(error)}`,
            );
    return {
      observations: [observe(stop.result, stop.detail)],
      ...(preview ? { preview } : {}),
    };
  }
}
