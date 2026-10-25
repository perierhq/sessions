/**
 * One tool-less small-model call that picks a route for a piece of untrusted
 * text. Grew out of the Plain ticket router (agents/plain/ticket-router.ts),
 * which still owns its prompt and config; support triage
 * (server/support/triage.ts) uses the same call with its own routes.
 *
 * Fail-open by design: a timeout, an answer without JSON or an unknown route
 * returns null and the caller picks its safe default. It never throws.
 */
import { oneShot } from "./one-shot";

/** The small model routing runs on. */
export const ROUTE_CLASSIFIER_MODEL =
  process.env.PLAIN_SPAM_CHECK_MODEL || "claude-haiku-5-5";

/** Longest content the classifier sees. */
export const ROUTE_CLASSIFIER_MAX_CHARS = 8000;

export interface RouteClassifierInput<R extends string> {
  /** Already wrapped by the caller; cut to 8000 characters here. */
  content: string;
  /** Prompt; `contract` is appended after a blank line. */
  system: string;
  /** The JSON output contract, appended by code so prompt edits can't break parsing. */
  contract: string;
  routes: readonly R[];
  /** oneShot label for usage accounting. */
  label: string;
  /** Default: ROUTE_CLASSIFIER_MODEL. */
  model?: string;
}

export interface RouteClassification<R extends string> {
  route: R;
  reason: string;
  raw: Record<string, unknown>;
}

type OneShotFn = (
  prompt: string,
  opts: { system: string; model: string; label: string },
) => Promise<string | null>;

let oneShotOverride: OneShotFn | null = null;

export function __setRouteClassifierOneShotForTest(fn: OneShotFn | null): void {
  oneShotOverride = fn;
}

/** The first JSON object in `text`, tolerating prose around it. */
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // Try the widest candidate first (nested arrays and objects), then shrink
  // to each earlier closing brace.
  for (let end = text.lastIndexOf("}"); end > start;) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // try a shorter candidate
    }
    end = text.lastIndexOf("}", end - 1);
  }
  return null;
}

/** Route `content`. null when no verdict could be reached. Never throws. */
export async function classifyRoute<R extends string>(
  input: RouteClassifierInput<R>,
): Promise<RouteClassification<R> | null> {
  try {
    const run: OneShotFn = oneShotOverride ?? oneShot;
    // Untrusted text: the one-shot is tool-less by construction, so the
    // content can only influence the classification, never act.
    const text = await run(input.content.slice(0, ROUTE_CLASSIFIER_MAX_CHARS), {
      system: `${input.system}\n\n${input.contract}`,
      model: input.model ?? ROUTE_CLASSIFIER_MODEL,
      label: input.label,
    });
    if (!text) return null;
    const raw = firstJsonObject(text);
    if (!raw) {
      // Never log the answer: it can echo customer text.
      console.error(
        `[route-classifier] ${input.label} returned no JSON (${text.length} chars)`,
      );
      return null;
    }
    const route = raw.route;
    if (typeof route !== "string" || !input.routes.includes(route as R))
      return null;
    return {
      route: route as R,
      reason: typeof raw.reason === "string" ? raw.reason : "",
      raw,
    };
  } catch (e) {
    console.error(`[route-classifier] ${input.label} failed:`, e);
    return null;
  }
}
