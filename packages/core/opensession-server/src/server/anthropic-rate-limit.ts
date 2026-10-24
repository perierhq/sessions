/**
 * Anthropic's unified (subscription) rate-limit headers, for pi/anthropic/*
 * turns on a Claude pool token.
 *
 * On a Claude subscription token every response carries
 * `anthropic-ratelimit-unified-status` ("allowed", "allowed_warning" or
 * "rejected") and `anthropic-ratelimit-unified-reset` (Unix seconds). A 429
 * whose status is "rejected" is the subscription's own limit; any other 429
 * is a transient throttle that pi's retry should ride out. Claude Code reads
 * the same two headers the same way.
 *
 * pi-ai cannot hand these to the runner. Its error text for a failed request
 * is only `429 {body}` (utils/error-body.js, formatProviderError), and
 * `onResponse` fires only after a request succeeded
 * (api/anthropic-messages.js, after retryProviderRequest), so it never sees a
 * 429. Every request does go through the `fetch` in its stream options,
 * which pi passes to the Anthropic client. The runner wraps that fetch and
 * reads the headers there.
 */

import { streamTimingEnabled, streamTimingFetch } from "./stream-timing";

/** What the latest Anthropic response said about the account's limit. */
export interface AnthropicRateLimitSnapshot {
  /** HTTP status of the response. */
  httpStatus: number;
  /** `anthropic-ratelimit-unified-status`, lower-cased; absent when the
   *  response did not carry it. */
  unifiedStatus?: string;
  /** When the limit resets (epoch ms), from `anthropic-ratelimit-unified-reset`
   *  or else `retry-after`. Only set when it lies in the future and at most
   *  14 days out, so a mis-parse can never bench an account for long. */
  resetAt?: number;
}

const MAX_RESET_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

type HeaderSource = Headers | Record<string, string | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** A reset header as epoch ms: Unix seconds (or ms), or a date string. */
function parseResetHeader(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    // Unix seconds; a value this large is already milliseconds.
    return n > 1e12 ? n : n * 1000;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}

/** `retry-after`: delay in seconds, or an HTTP date. */
function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return now + Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}

/** Read the unified rate-limit headers off one response. */
export function readAnthropicRateLimit(
  httpStatus: number,
  headers: HeaderSource,
  now: number = Date.now(),
): AnthropicRateLimitSnapshot {
  const unifiedStatus =
    header(headers, "anthropic-ratelimit-unified-status")
      ?.trim()
      .toLowerCase() || undefined;
  // Range-check each candidate on its own, so an unusable unified reset
  // (past, or too far out) still falls back to retry-after.
  const inRange = (at: number | undefined) =>
    at !== undefined && at > now && at - now <= MAX_RESET_AHEAD_MS
      ? at
      : undefined;
  const resetAt =
    inRange(
      parseResetHeader(header(headers, "anthropic-ratelimit-unified-reset")),
    ) ?? inRange(parseRetryAfter(header(headers, "retry-after"), now));
  return {
    httpStatus,
    ...(unifiedStatus ? { unifiedStatus } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/** A reset time in the shape Claude's own limit messages use ("Oct 22,
 *  9:30am (UTC)"), which usageLimitResetAt and describeUsageLimitReset
 *  read back. */
export function formatAnthropicReset(at: number): string {
  const d = new Date(at);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hour24 = d.getUTCHours();
  const hour = hour24 % 12 || 12;
  const minutes = d.getUTCMinutes();
  const time = minutes
    ? `${hour}:${String(minutes).padStart(2, "0")}`
    : `${hour}`;
  return `${month} ${d.getUTCDate()}, ${time}${hour24 < 12 ? "am" : "pm"} (UTC)`;
}

export type FetchLike = (input: any, init?: any) => Promise<Response>;
type StreamFunction = (
  model: any,
  context: any,
  options?: any,
) => unknown | Promise<unknown>;

/**
 * Record the rate-limit headers of every Anthropic response a pi agent
 * receives, including failed ones. Wraps the agent's stream function so each
 * request's options carry a fetch that reports the response before handing
 * it back unchanged. Another provider's requests pass through untouched. A
 * caller-supplied fetch is kept and wrapped, and the global fetch is looked
 * up per request.
 *
 * Every request the agent makes passes through here, not only the turn's
 * own: pi's compaction, branch summaries and prompt-cache warming also
 * update the record. That is harmless only because the runner classifies a
 * failure from the record right after the failing request, and keeps cache
 * warming off (`cacheWarming: "off"` in pi-runner.ts). Turning warming on
 * would let a warm-up response overwrite the 429 the classifier reads.
 */
export function enableAnthropicRateLimitCapture(
  agent: { streamFunction?: StreamFunction },
  record: (snapshot: AnthropicRateLimitSnapshot) => void,
): void {
  const base = agent.streamFunction;
  if (typeof base !== "function") return;
  agent.streamFunction = (model, context, options) => {
    if ((model as { provider?: unknown } | undefined)?.provider !== "anthropic")
      return base(model, context, options);
    const inner = (options as { fetch?: FetchLike } | undefined)?.fetch;
    const recorded = anthropicRateLimitFetch(inner, record);
    // Debug only (OPENSESSION_STREAM_TIMING=1): timestamp the raw SSE body.
    const fetch = streamTimingEnabled()
      ? streamTimingFetch(recorded, "anthropic")
      : recorded;
    return base(model, context, { ...options, fetch });
  };
}

/** A fetch that records each response's rate-limit headers before handing
 *  it back unchanged. `inner` is kept when given; the global fetch is
 *  looked up per request otherwise. */
export function anthropicRateLimitFetch(
  inner: FetchLike | undefined,
  record: (snapshot: AnthropicRateLimitSnapshot) => void,
): FetchLike {
  return async (input, init) => {
    const response = await (inner ?? (globalThis.fetch as FetchLike))(
      input,
      init,
    );
    try {
      record(readAnthropicRateLimit(response.status, response.headers));
    } catch {}
    return response;
  };
}
