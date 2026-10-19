import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ClaudeAccount } from "./claude-accounts";
import type { CodexAccount } from "./codex-accounts";
import { maskOpenaiAccount } from "./openai-auth";
import type { PiRuntimeAccountEvidence } from "./pi-runtime-binding";
import type { StreamEvent, TurnUsage } from "./run-events";
import { maskXaiAccount, type XaiAccount } from "./xai-accounts";
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
  return event.type !== "init" && event.type !== "usage_snapshot";
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
