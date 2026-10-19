/**
 * The Claude pool pick for pi/anthropic/* turns, worded for the runner.
 *
 * resolveAccount (claude-accounts.ts) owns the ordered policy (pin, sticky,
 * designated, pool) and the owner gate, and hands back a structured refusal.
 * This module adds the two things the runner needs on top:
 *
 * - The designation: model-providers.json may name the only pool accounts
 *   allowed to serve Claude turns (`bridge.accounts`, or the legacy top-level
 *   `bridgeAccountIds`). It applies only while that file says
 *   `"enabled": true`, as it always has. The key names predate this module
 *   and stay as they are so existing config files keep working.
 * - The refusal wording. isPiUsageLimitShape (pi-runner.ts) and the one-shot
 *   fallback (one-shot.ts) classify a refusal by substring: "no designated
 *   bridge account" and "no usable claude account" read as exhaustion, "no
 *   Claude accounts configured" as a config problem. Keep every string below
 *   byte-identical; existing sessions and tests match on them.
 */
import {
  resolveAccount,
  type ClaudeAccount,
  type PickReason,
} from "./claude-accounts";
import { readModelProviderConfig } from "./model-providers";

/** Pool accounts designated to serve Claude turns, in preference order.
 *  Empty means the whole pool serves. */
export function designatedClaudeAccountIds(): string[] {
  const cfg = readModelProviderConfig();
  return cfg?.enabled ? cfg.bridgeAccountIds || [] : [];
}

/** What a turn asks the Claude pool for. A pin never widens serving beyond
 *  what the designation allows. */
export interface ClaudeAccountRequest {
  accountId?: string;
  /** Strict pin: never fall back to the other eligible accounts. */
  accountStrict?: boolean;
  /** Run user, for the pool pick's personal-account preference (same identity
   *  matching as pickAccount everywhere else). */
  user?: string;
  /** Allow extra-usage credits when judging the pin/walk usability. */
  usageCredits?: boolean;
  /** Accounts this turn already burned, skipped on every path. Drives the
   *  runner's account walk (see resolveAccount's excludeIds). */
  excludeIds?: readonly string[];
  /** The account that last served this session, preferred over the
   *  least-used pick while it is usable, so a session keeps its prompt cache
   *  and signed thinking on one subscription. */
  stickyId?: string;
  /** Judge eligibility without consuming the pool's round-robin turn: the
   *  account walk's probe for "is there another account", so the turn that
   *  then binds lands on the account the probe announced. */
  peek?: boolean;
}

/** Pick the Claude pool account to serve a turn (utilization-gated).
 *
 *  Two modes:
 *  - Designated: when model-providers.json designates accounts, ONLY those
 *    may serve (walked in order).
 *  - Pool (the default): pickAccount over the whole claude-accounts pool,
 *    with the same personal-first/user routing as every other run.
 *
 *  A pin is tried first; with accountStrict the walk never widens past it.
 *  Another user's personal subscription never serves, on any path. The
 *  ordered policy and that owner gate both live in resolveAccount; this only
 *  renders its refusals. */
export function pickClaudeAccount(
  model: string | undefined,
  request?: ClaudeAccountRequest,
  /** Receives which step of the policy produced the account, for audits. */
  out?: { reason?: PickReason },
): ClaudeAccount | { error: string } {
  const ids = designatedClaudeAccountIds();
  const resolved = resolveAccount({
    user: request?.user,
    model,
    pinnedId: request?.accountId,
    strictPin: request?.accountStrict,
    stickyId: request?.stickyId,
    designatedIds: ids,
    allowExtraUsage: request?.usageCredits,
    excludeIds: request?.excludeIds,
    recordPick: !request?.peek,
  });
  if ("account" in resolved) {
    if (out) out.reason = resolved.reason;
    return resolved.account;
  }
  const refusal = resolved.refusal;
  if (refusal.kind === "pin-not-designated") {
    // Config error, deliberately NOT exhaustion-shaped: hopping models would
    // not fix a pin that names a non-designated account.
    return {
      error:
        `pinned account "${refusal.pinName}" is not a designated bridge account ` +
        "(bridgeAccountIds is set, so only those ids may serve bridge traffic) — " +
        "strict pin, refusing to widen",
    };
  }
  if (refusal.kind === "pin-unusable") {
    return ids.length
      ? {
          error:
            `no designated bridge account is currently usable (pinned "${refusal.pinName}" is ` +
            "exhausted or disabled; strict pin — not widening to the other designated accounts)",
        }
      : {
          error:
            `no usable Claude account (pinned "${refusal.pinName}" is exhausted, disabled or ` +
            "unknown; strict pin — not widening to the pool)",
        };
  }
  if (refusal.kind === "designated-dry") {
    return {
      error: `no designated bridge account is currently usable (tried: ${refusal.tried})`,
    };
  }
  if (refusal.kind === "none-configured") {
    // Deliberately NOT usage-limit-shaped: an empty pool is a config problem,
    // and hopping models would not fix it.
    return {
      error: "no Claude accounts configured (add one in Settings → Providers)",
    };
  }
  return {
    error: "no usable Claude account in the pool (all exhausted or sidelined)",
  };
}
