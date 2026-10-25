// The support tick: ends veto windows, retries sends that failed for a
// while, fails sends a restart interrupted, and retries pipeline hand-offs
// (ingest.ts). It reads only the `support-pending` work index, never the
// conversations at large: `veto:<id>` (a window's deadline), `send:<id>` (a
// send under way or waiting for its retry) and `triage:<id>` (ingest's).
// Reuses the incidents fix loop's deadline-in-record plus tick
// (incidents/response/coordinator.ts). Nothing runs at import.
import { isShuttingDown } from "../shutdown-state";
import { retryPendingInbound } from "./ingest";
import {
  INTERRUPTED_SEND,
  dropPendingKey,
  failInterruptedSend,
  isPendingSend,
  isPendingVeto,
  listPendingReplies,
  retrySend,
  sendDueVeto,
  sendingInProcess,
} from "./reply";
import { getConversation } from "./store";

export { INTERRUPTED_SEND };

export const SUPPORT_TICK_MS = 15_000;
/** A send with no retry time that started longer ago than this, and that no
 *  send in this process owns, was cut off by a restart. Longer than the
 *  SMTP connect and greeting time limits, so a live send in another
 *  process is never mistaken for one. */
export const INTERRUPTED_AFTER_MS = 2 * 60_000;
/** Sends one tick starts at most; the rest wait for the next tick. */
const SENDS_PER_TICK = 20;

export async function runSupportTick(now: number): Promise<{
  vetoSent: number;
  retried: number;
  interrupted: number;
  triaged: number;
}> {
  const out = { vetoSent: 0, retried: 0, interrupted: 0, triaged: 0 };
  let sends = 0;
  for (const { key, value } of await listPendingReplies()) {
    try {
      if (key.startsWith("veto:")) {
        if (!isPendingVeto(value)) {
          await dropPendingKey(key, "");
          continue;
        }
        if (value.deadline > now) continue;
        const c = await getConversation(value.conversationId);
        const d = c?.draft;
        if (!d || d.id !== value.draftId || d.state !== "veto") {
          await dropPendingKey(key, value.draftId);
          continue;
        }
        if (sends >= SENDS_PER_TICK) continue;
        sends++;
        const sent = await sendDueVeto(value.conversationId, d.id, now);
        if (sent.ok) out.vetoSent++;
        continue;
      }
      // send:<id>
      if (!isPendingSend(value)) {
        await dropPendingKey(key, "");
        continue;
      }
      if (sendingInProcess(value.conversationId)) continue;
      const c = await getConversation(value.conversationId);
      const d = c?.draft;
      if (!d || d.id !== value.draftId || d.state !== "sending") {
        // Written just before a claim that may still be on its way.
        if (now - value.startedAt > INTERRUPTED_AFTER_MS)
          await dropPendingKey(key, value.draftId);
        continue;
      }
      if (d.nextAttemptAt) {
        if (Date.parse(d.nextAttemptAt) > now || sends >= SENDS_PER_TICK)
          continue;
        sends++;
        out.retried++;
        await retrySend(value.conversationId, d.id, now);
        continue;
      }
      if (now - value.startedAt > INTERRUPTED_AFTER_MS)
        if (await failInterruptedSend(value.conversationId, d.id))
          out.interrupted++;
    } catch (error) {
      console.warn(
        `[support] tick: ${key.split(":")[0]} key failed:`,
        error instanceof Error ? error.name : typeof error,
      );
    }
  }
  out.triaged = await retryPendingInbound(now);
  return out;
}

declare global {
  var __supportTick: ReturnType<typeof setInterval> | undefined;
}

/** Idempotent; the interval is unref'd and skips a tick while the last one
 *  runs or the server shuts down. */
export function startSupportTick(): void {
  if (globalThis.__supportTick) return;
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || isShuttingDown()) return;
    ticking = true;
    runSupportTick(Date.now())
      .catch((error: unknown) => {
        console.error(
          "[support] tick failed:",
          error instanceof Error ? error.name : typeof error,
        );
      })
      .finally(() => {
        ticking = false;
      });
  }, SUPPORT_TICK_MS);
  timer.unref?.();
  globalThis.__supportTick = timer;
}
