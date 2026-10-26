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

/**
 * Every top-level JSON object in `text`, tolerating prose around them. One
 * linear pass matches braces, skipping string contents inside objects; each
 * balanced top-level span that parses as an object is kept. Braces in prose
 * that never balance swallow what follows, which reads as no answer.
 */
function topLevelJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth > 0) continue;
      try {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          objects.push(parsed as Record<string, unknown>);
      } catch {
        // prose in braces, not an answer
      }
    }
  }
  return objects;
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
    // Never log the answer, only its length: it can echo customer text.
    const answers = topLevelJsonObjects(text).filter((o) => "route" in o);
    if (answers.length !== 1) {
      console.error(
        `[route-classifier] ${input.label} returned ${answers.length ? "more than one" : "no"} JSON answer (${text.length} chars)`,
      );
      return null;
    }
    const raw = answers[0]!;
    const route = raw.route;
    if (typeof route !== "string" || !input.routes.includes(route as R)) {
      console.error(
        `[route-classifier] ${input.label} returned an unknown route (${text.length} chars)`,
      );
      return null;
    }
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
