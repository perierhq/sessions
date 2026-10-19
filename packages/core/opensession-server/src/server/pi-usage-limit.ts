import {
  isClaudeSubscriptionError,
  isClaudeUsageLimitError,
  isCodexUsageLimitError,
} from "./runner-shared";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";
import { xaiOutdatedClientHint } from "./xai-oauth";

/** Raw codex error codes that can surface in a pi/openai error before pi's
 *  friendly "You have hit your ChatGPT usage limit…" message is built — cheap
 *  insurance on top of isCodexUsageLimitError's message matching. Quota
 *  shapes are provider-spelled (insufficient_quota / "exceeded your current
 *  quota"), never a bare `quota` alternation: this classifier also sees
 *  non-provider throws in the catch, and infrastructure errors like
 *  "EDQUOT: disk quota exceeded" must not read as account exhaustion. The
 *  placeholder-refresh failure ("OAuth refresh failed for openai-codex")
 *  is included: pi refreshes only inside the final 5 minutes of the access
 *  token, so that failure means "this account can't serve until the codex
 *  CLI refreshes it" — dry-pool semantics. */
const CODEX_USAGE_LIMIT_CODE_SHAPES =
  /usage_limit_reached|usage_not_included|rate_limit_exceeded|insufficient_quota|usage_quota|exceeded your current quota|GoUsageLimitError|FreeUsageLimitError|OAuth refresh failed for openai-codex/i;

/** SuperGrok shapes: the cli-chat-proxy's quota and rate-limit answers, plus
 *  a rejected or unrefreshable token ("this account can't serve until someone
 *  signs in again" is dry-pool semantics for the walk). Never a bare `quota`:
 *  infrastructure errors like EDQUOT must not read as exhaustion. */
const XAI_USAGE_LIMIT_SHAPES =
  /\b429\b|too many requests|rate[ _-]?limit|usage[ _-]?limit|insufficient_quota|exceeded your (?:current )?quota|credits? (?:exhausted|depleted|limit)|out of credits|\b401\b|authentication rejected|invalid_grant|token refresh failed|no usable SuperGrok|no SuperGrok accounts|not currently usable/i;

/** Provider-aware usage-limit classification for terminal errors — "this
 *  model's pool can't serve right now", which is exactly what
 *  usageLimitExhausted tells agent-runner's fallback walk.
 *
 *  Anthropic runs talk to Anthropic directly through pi's own provider on a
 *  Claude pool token. They match the standard Claude limit messages, a 429,
 *  and the pool picker's exhaustion refusals (claude-account-pick.ts). 529 /
 *  overloaded_error is transient overload, not exhaustion: it goes through
 *  pi's own retry instead of sidelining a healthy account. A 429 is read
 *  through Anthropic's unified rate-limit header when one came with it
 *  (`anthropicUnifiedStatus`): only "rejected" is the subscription's own
 *  limit; any other status is a transient throttle for pi's retry. Without
 *  the header a 429 still counts as a limit.
 *
 *  OpenAI runs match the codex classifier shared with the previous runner
 *  engine (isCodexUsageLimitError) plus the raw code shapes, never the Claude
 *  pool's refusal wording. Third-party providers share the Anthropic shapes,
 *  except that an overload there still counts as exhaustion and moves the
 *  turn to the next model. Exported for the classifier tests. */
export function isPiUsageLimitShape(
  message: string,
  providerID: string,
  /** `anthropic-ratelimit-unified-status` of the 429 this message reports,
   *  when the response carried one. */
  anthropicUnifiedStatus?: string,
): boolean {
  if (providerID === "openai") {
    return (
      isCodexUsageLimitError(message) ||
      CODEX_USAGE_LIMIT_CODE_SHAPES.test(message)
    );
  }
  if (providerID === XAI_OAUTH_PROVIDER) {
    return XAI_USAGE_LIMIT_SHAPES.test(message);
  }
  const anthropic = providerID === "anthropic";
  if (
    anthropic &&
    anthropicUnifiedStatus !== undefined &&
    anthropicUnifiedStatus !== "rejected" &&
    /\b429\b/.test(message)
  )
    return false;
  if (
    isClaudeUsageLimitError(message, true) ||
    isClaudeSubscriptionError(message)
  )
    return true;
  const s = message.toLowerCase();
  return (
    (!anthropic && (s.includes("overloaded_error") || /\b529\b/.test(s))) ||
    /\b429\b/.test(s) ||
    // A dry designation (pickClaudeAccount).
    s.includes("no designated bridge account") ||
    // An exhausted pool (not the empty-pool config error, which deliberately
    // says "no Claude accounts configured").
    s.includes("no usable claude account")
  );
}

/** Terminal error text for a pi run, with an actionable hint appended when
 *  the SuperGrok proxy rejected our pinned Grok client version. Exported for
 *  tests. */
export function piErrorContent(message: string, providerID: string): string {
  const hint =
    providerID === XAI_OAUTH_PROVIDER ? xaiOutdatedClientHint(message) : null;
  return hint ? `pi: ${message}\n\n${hint}` : `pi: ${message}`;
}
