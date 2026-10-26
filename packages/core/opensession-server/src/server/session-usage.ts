/**
 * A session's cumulative token and cost totals, and how one run's usage is
 * folded into them.
 *
 * Interactive turns fold usage in run-session.ts and session-create.ts. Runs
 * without that event loop (GitHub reviews, automations) wrap their engine
 * stream in `withRunUsageRecorded`, so every run kind records what it spent,
 * whichever provider served it.
 */
import { contextWindowFor } from "./models";
import type { StreamEvent, TurnUsage } from "./run-events";
import { updateSessionFile } from "./session-cache";
import type { NativeSessionFile, SessionUsage } from "./types";
import { broadcastToSession } from "./ws-hub";

/**
 * Fold a completed run's usage into a session's cumulative totals. Cost and
 * token counts accumulate; context size (contextTokens/contextWindow) reflects
 * the latest turn rather than a sum — it's the current window fill, not lifetime
 * throughput.
 */
export function foldSessionUsage(
  prev: SessionUsage | undefined,
  turn: TurnUsage,
  model?: string | null,
): SessionUsage {
  const base: SessionUsage = prev ?? {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
    turns: 0,
    updatedAt: "",
  };
  return {
    costUsd: base.costUsd + (turn.costUsd ?? 0),
    inputTokens: base.inputTokens + turn.inputTokens,
    outputTokens: base.outputTokens + turn.outputTokens,
    cacheReadTokens: base.cacheReadTokens + turn.cacheReadTokens,
    cacheCreationTokens: base.cacheCreationTokens + turn.cacheCreationTokens,
    contextTokens: turn.contextTokens || base.contextTokens,
    contextWindow: contextWindowFor(model) || base.contextWindow,
    turns: base.turns + 1,
    updatedAt: new Date().toISOString(),
  };
}

/** The session file with one run's terminal usage folded in. `runId` makes the
 *  fold idempotent: a run already folded under that id is left alone, so a
 *  restart between the write and the journal cleanup cannot count it twice. */
export function foldRunUsageInto(
  data: Partial<NativeSessionFile>,
  event: Pick<StreamEvent, "model" | "usage">,
  runId?: string,
): { data: Partial<NativeSessionFile>; usage: SessionUsage | undefined } {
  if (!event.usage) return { data, usage: data.usage };
  if (runId && data.usageRunId === runId) return { data, usage: data.usage };
  const usage = foldSessionUsage(
    data.usage,
    event.usage,
    event.model || data.model,
  );
  return {
    data: {
      ...data,
      usage,
      ...(runId ? { usageRunId: runId } : {}),
      lastActivity: new Date().toISOString(),
    },
    usage,
  };
}

/** Fold one run's terminal usage into the session file and show it live. */
export async function persistRunUsage(
  sessionId: string,
  event: Pick<StreamEvent, "model" | "usage">,
  runId?: string,
): Promise<void> {
  if (!event.usage) return;
  let usage: SessionUsage | undefined;
  await updateSessionFile(sessionId, (data) => {
    const folded = foldRunUsageInto(data, event, runId);
    usage = folded.usage;
    return folded.data as NativeSessionFile;
  });
  if (usage)
    broadcastToSession(sessionId, {
      type: "usage_update",
      sessionId,
      usage,
    });
}

/**
 * Pass a run's events through unchanged and save its terminal usage (the
 * run-cumulative total on `done` or `error`) before the terminal reaches the
 * caller. A failed write is logged, never thrown: losing a cost figure must
 * not fail the run.
 */
export async function* withRunUsageRecorded(
  sessionId: string,
  events: AsyncIterable<StreamEvent>,
  opts: {
    runId?: string;
    persist?: (
      sessionId: string,
      event: StreamEvent,
      runId?: string,
    ) => Promise<void>;
    log?: (message: string, error: unknown) => void;
  } = {},
): AsyncGenerator<StreamEvent> {
  const persist = opts.persist ?? persistRunUsage;
  const log = opts.log ?? ((m, e) => console.error(m, e));
  let recorded = false;
  for await (const event of events) {
    if (
      !recorded &&
      event.usage &&
      (event.type === "done" || event.type === "error")
    ) {
      recorded = true;
      try {
        await persist(sessionId, event, opts.runId);
      } catch (error) {
        log(`[usage] could not save run usage for ${sessionId}:`, error);
      }
    }
    yield event;
  }
}
