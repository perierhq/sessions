import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionSpeed } from "@tellahq/opensession-protocol/session";
import type { RunAgentOpts } from "./agent-runner";
import type { AnthropicRateLimitSnapshot } from "./anthropic-rate-limit";
import { audit } from "./audit";
import { pickClaudeAccount } from "./claude-account-pick";
import {
  markExhausted as markClaudeExhausted,
  type ClaudeAccount,
} from "./claude-accounts";
import { markCodexExhausted, type CodexAccount } from "./codex-accounts";
import { readModelProviderConfig } from "./model-providers";
import { maskOpenaiAccount, pickOpenaiAccount } from "./openai-auth";
import {
  supportsOpenaiUltrafast,
  ULTRAFAST_CHATGPT_PLAN,
} from "./openai-service-tier";
import {
  isPiSideRequestUsageLimit,
  isPiUsageLimitShape,
} from "./pi-usage-limit";
import {
  rememberNativeClaudeAccount,
  type PiRuntimeAccountEvidence,
} from "./pi-runtime-binding";
import type { StreamEvent, TurnUsage } from "./run-events";
import { usageLimitResetAt } from "./runner-shared";
import {
  markXaiExhausted,
  maskXaiAccount,
  pickXaiAccount,
  type XaiAccount,
} from "./xai-accounts";
import { XAI_OAUTH_PROVIDER } from "./xai-provider-id";

/** One pool account as the runner's walk sees it, whichever pool it came from. */
export interface PoolAccountRef {
  id: string;
  name: string;
  masked: string;
  pool: "openai" | typeof XAI_OAUTH_PROVIDER | "claude";
  /** How the pool reads in logs: "codex", "SuperGrok" or "Claude". */
  label: string;
}

export function codexPoolRef(account: CodexAccount): PoolAccountRef {
  return {
    id: account.id,
    name: account.name,
    masked: maskOpenaiAccount(account),
    pool: "openai",
    label: "codex",
  };
}

export function xaiPoolRef(account: XaiAccount): PoolAccountRef {
  return {
    id: account.id,
    name: account.name,
    masked: maskXaiAccount(account),
    pool: XAI_OAUTH_PROVIDER,
    label: "SuperGrok",
  };
}

/** A Claude pool account serving a native-transport pi/anthropic turn. */
export function claudePoolRef(account: ClaudeAccount): PoolAccountRef {
  return {
    id: account.id,
    name: account.name,
    masked: `${account.name} (${account.id.slice(0, 8)}, claude)`,
    pool: "claude",
    label: "Claude",
  };
}

/** The pool account a binding's evidence names, picked or sidelineable. */
export function evidencePoolRef(
  evidence: PiRuntimeAccountEvidence,
  which: "picked" | "sidelineable",
): PoolAccountRef | undefined {
  const openai =
    which === "picked" ? evidence.pickedOpenai : evidence.sidelineableOpenai;
  if (openai) return codexPoolRef(openai);
  const xai =
    which === "picked" ? evidence.pickedXai : evidence.sidelineableXai;
  if (xai) return xaiPoolRef(xai);
  const claude =
    which === "picked" ? evidence.pickedClaude : evidence.sidelineableClaude;
  return claude ? claudePoolRef(claude) : undefined;
}

/** State carried ACROSS the attempts of one logical pi turn. */
export interface PiAccountWalk {
  /** Provider account ids this turn has already burned, fed into the picker
   *  so a replay lands somewhere new. The sideline alone cannot drive this:
   *  it is shared cross-engine with previous runner, and some refusals deliberately
   *  do not set it (local admission control that frees within the hour). */
  excluded: Set<string>;
  /** Set by an attempt that wants to be replayed on another account. */
  rotate: boolean;
  /** The first attempt's user-line uuid, reused by every replay so the
   *  transcript row upserts instead of duplicating the person's message. */
  promptEntryId?: string;
  /** Resume completed messages and tool results instead of replaying the prompt. */
  continuation?: AgentSession["sessionManager"];
  /** This turn already moved off an account over a native 429 that was not
   *  the subscription's limit. Such a rotation happens at most once. */
  throttleRotated?: boolean;
  cancelled?: boolean;
}

/** Bookkeeping can repeat, but output or tool activity requires continuing the
 * native conversation rather than replaying the original prompt. */
export function piStreamEventRequiresAccountContinuation(
  event: Pick<StreamEvent, "type">,
): boolean {
  // A phase says what the run is doing, not that it produced anything: a
  // request that opens and then fails still rotates freely.
  return (
    event.type !== "init" &&
    event.type !== "usage_snapshot" &&
    event.type !== "phase"
  );
}

/** One attempt's usage on top of the turn's earlier attempts. */
export function addAttemptUsage(
  prior: TurnUsage | undefined,
  usage: TurnUsage,
): TurnUsage {
  return {
    ...usage,
    inputTokens: (prior?.inputTokens || 0) + usage.inputTokens,
    outputTokens: (prior?.outputTokens || 0) + usage.outputTokens,
    cacheReadTokens: (prior?.cacheReadTokens || 0) + usage.cacheReadTokens,
    cacheCreationTokens:
      (prior?.cacheCreationTokens || 0) + usage.cacheCreationTokens,
    costUsd: (prior?.costUsd || 0) + (usage.costUsd || 0),
  };
}

/** Run attempts until one finishes without asking to rotate, carrying the
 *  walk and cumulative usage across them (see runPi). */
export async function* runPiAccountWalk(
  attempt: (walk: PiAccountWalk) => AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  const walk: PiAccountWalk = { excluded: new Set(), rotate: false };
  let priorUsage: TurnUsage | undefined;
  for (;;) {
    walk.rotate = false;
    let latestUsage = priorUsage;
    for await (const event of attempt(walk)) {
      if (event.usage) {
        latestUsage = addAttemptUsage(priorUsage, event.usage);
        yield { ...event, usage: latestUsage };
      } else if (
        priorUsage &&
        (event.type === "error" || event.type === "done")
      ) {
        yield { ...event, usage: priorUsage };
      } else {
        yield event;
      }
    }
    if (!walk.rotate || walk.cancelled) return;
    priorUsage = latestUsage;
  }
}

/** What one attempt's account state is built from. */
export interface PiAttemptAccountsInit {
  walk: PiAccountWalk;
  providerID: string;
  modelID: string;
  opts: Pick<RunAgentOpts, "accountId" | "accountStrict" | "usageCredits">;
  accountUser: string | undefined;
  affinity: string;
  claudeSessionKey: string | undefined;
  speed: SessionSpeed;
  auditBase: Record<string, unknown>;
}

/** One attempt's pool account: which one serves it, what the provider last
 *  said about its limits, and the decision to rotate off it. Closures read
 *  the fields at call time, so a binding that lands late is still seen. */
export class PiAttemptAccounts {
  // The latest Anthropic response's unified rate-limit headers
  // (anthropic-rate-limit.ts). Kept per attempt: each attempt binds
  // its own account.
  rateLimit: AnthropicRateLimitSnapshot | undefined;
  // Pool-backed providers only (pi/openai: Codex pool, pi/xai-oauth: SuperGrok
  // pool, pi/anthropic on the native transport: Claude pool): the picked
  // account — visible to the catch/terminal paths so the account walk can
  // rotate off it. Set as soon as the pick succeeds, BEFORE the seed and
  // refresh-window checks, because those two failures are exactly the ones
  // worth trying another account for.
  pickedAccount: PoolAccountRef | undefined;
  // The same account, but only once it is genuinely serving this turn. The
  // SIDELINE keys on this rather than on the pick: markCodexExhausted benches
  // an account for hours, cross-engine, shared with previous runner, and a local
  // auth.json we could not read (or a token inside pi's refresh window) is a
  // fault of this box, not a verdict on the account's usage. Rotating off it
  // is right; benching it globally is not.
  sidelineableAccount: PoolAccountRef | undefined;
  // Why the Claude pool had no other account, when the walk asked and it had
  // none. Lets the terminal say the pool is dry instead of echoing one
  // account's limit as if nothing else had been tried.
  claudePoolRefusal: string | undefined;
  private readonly walk: PiAccountWalk;
  private readonly providerID: string;
  private readonly modelID: string;
  private readonly opts: PiAttemptAccountsInit["opts"];
  private readonly accountUser: string | undefined;
  private readonly affinity: string;
  private readonly claudeSessionKey: string | undefined;
  private readonly speed: SessionSpeed;
  private readonly auditBase: Record<string, unknown>;

  constructor(init: PiAttemptAccountsInit) {
    this.walk = init.walk;
    this.providerID = init.providerID;
    this.modelID = init.modelID;
    this.opts = init.opts;
    this.accountUser = init.accountUser;
    this.affinity = init.affinity;
    this.claudeSessionKey = init.claudeSessionKey;
    this.speed = init.speed;
    this.auditBase = init.auditBase;
  }

  /** The binding's account evidence: what it picked and what may be benched. */
  onEvidence(evidence: PiRuntimeAccountEvidence): void {
    this.pickedAccount = evidencePoolRef(evidence, "picked");
    this.sidelineableAccount = evidencePoolRef(evidence, "sidelineable");
  }

  /** The rate-limit headers of the 429 that just failed, if that is what the
   *  latest response was. */
  limit429(): AnthropicRateLimitSnapshot | undefined {
    return this.rateLimit?.httpStatus === 429 ? this.rateLimit : undefined;
  }

  isUsageLimit(message: string): boolean {
    return isPiUsageLimitShape(
      message,
      this.providerID,
      this.limit429()?.unifiedStatus,
    );
  }

  /** isUsageLimit for a web tool's side request: a 429 without a
   *  "rejected" unified status is a throttle, not the account's limit. */
  isSideRequestUsageLimit(message: string): boolean {
    return isPiSideRequestUsageLimit(
      message,
      this.providerID,
      this.limit429()?.unifiedStatus,
    );
  }

  /** Bench the account serving this turn, when one is. */
  sideline(message: string): void {
    const account = this.sidelineableAccount;
    if (!account) return;
    if (account.pool === "openai") markCodexExhausted(account.id, this.modelID);
    else if (account.pool === "claude")
      // Bench it until the reset the account named, when it named one:
      // Anthropic's unified reset header on the 429, else a reset in the
      // limit message.
      markClaudeExhausted(
        account.id,
        this.modelID,
        this.limit429()?.resetAt ?? usageLimitResetAt(message),
      );
    else markXaiExhausted(account.id, this.modelID);
  }

  /** Another account in the same pool that could serve this turn, or
   *  undefined when the pool is dry. Both ChatGPT OAuth and standard OpenAI
   *  API-key accounts are executable. A STRICT pin never rotates: excluding
   *  the pinned id would make the picker skip its pin branch and widen into
   *  the pool, which is the one thing a hard pin exists to prevent. */
  next(): PoolAccountRef | undefined {
    const { walk, opts, accountUser, affinity, speed } = this;
    const pickedAccount = this.pickedAccount;
    if (!pickedAccount) return undefined;
    if (opts.accountStrict && opts.accountId) return undefined;
    const excluded = new Set([...walk.excluded, pickedAccount.id]);
    if (pickedAccount.pool === "claude") {
      // A peek: this only asks whether another account can serve. Recording
      // the pick here would spend the pool's round-robin turn, and the next
      // attempt's own pick would then land on a different account than the
      // one announced. takeAccountRotation hands the probed account to the
      // next attempt instead.
      const next = pickClaudeAccount(this.modelID, {
        user: accountUser,
        accountId: opts.accountId,
        accountStrict: opts.accountStrict,
        usageCredits: opts.usageCredits,
        excludeIds: [...excluded],
        peek: true,
      });
      if ("error" in next) {
        this.claudePoolRefusal = next.error;
        return undefined;
      }
      return claudePoolRef(next);
    }
    if (pickedAccount.pool === "openai") {
      const next = pickOpenaiAccount(
        this.modelID,
        readModelProviderConfig()?.openaiAccounts,
        affinity,
        undefined,
        accountUser,
        opts.accountId,
        opts.accountStrict,
        excluded,
        speed === "ultrafast" && supportsOpenaiUltrafast(this.modelID)
          ? ULTRAFAST_CHATGPT_PLAN
          : undefined,
      );
      return "error" in next ? undefined : codexPoolRef(next);
    }
    const next = pickXaiAccount({
      model: this.modelID,
      sessionKey: affinity,
      user: accountUser,
      pinnedId: opts.accountId,
      strict: opts.accountStrict,
      restrictIds: readModelProviderConfig()?.xaiAccounts,
      exclude: excluded,
    });
    return "error" in next ? undefined : xaiPoolRef(next);
  }

  /** Decide the rotation, or return false and let the caller surface the
   *  failure. Records the burn and audits the switch; the caller closes the
   *  attempt's audit, and runPi resumes or replays the attempt on the next
   *  account. It never sidelines: the caller decides that. After streamed
   *  output it needs the live session's manager to continue from. */
  rotate(args: {
    errorText: string;
    why: string;
    sawStreamedOutput: boolean;
    sessionManager: AgentSession["sessionManager"] | undefined;
  }): boolean {
    const { why, sawStreamedOutput, sessionManager } = args;
    const { walk } = this;
    this.claudePoolRefusal = undefined;
    const pickedAccount = this.pickedAccount;
    if (!pickedAccount || (sawStreamedOutput && !sessionManager)) return false;
    const next = this.next();
    if (!next) return false;
    console.warn(
      `[pi-runner] ${why} on ${pickedAccount.label} account "${pickedAccount.name}" ` +
        `(${this.modelID}): retrying this turn on "${next.name}"`,
    );
    audit({
      ...this.auditBase,
      direction: "out",
      kind: "account_switch",
      account: pickedAccount.masked,
      account_switch_to: next.masked,
    });
    if (sawStreamedOutput) walk.continuation = sessionManager;
    // The native Claude binding prefers the session's remembered account:
    // make that the one just announced, so the next attempt binds to it and
    // the session stays there afterwards.
    if (next.pool === "claude")
      rememberNativeClaudeAccount(
        this.accountUser,
        this.claudeSessionKey,
        next.id,
      );
    walk.excluded.add(pickedAccount.id);
    walk.rotate = true;
    return true;
  }
}
