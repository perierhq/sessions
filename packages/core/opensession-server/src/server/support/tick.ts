// The support tick: ends veto windows, retries sends that failed for a
// while, fails sends a restart interrupted, and retries pipeline hand-offs
// (ingest.ts). It reads only the `support-pending` work index, never the
// conversations at large: `veto:<id>` (a window's deadline),
// `send:<id>:<draftId>` (a send under way or waiting for its retry) and `triage:<id>` (ingest's).
// Reuses the incidents fix loop's deadline-in-record plus tick
// (incidents/response/coordinator.ts). Nothing runs at import.
import { activeIntegrations } from "../integrations/load";
import { isShuttingDown } from "../shutdown-state";
import { retryPendingInbound } from "./ingest";
import {
  INTERRUPTED_AFTER_MS,
  INTERRUPTED_SEND,
  dropPendingKey,
  failInterruptedSend,
  isPendingSend,
  isPendingVeto,
  listPendingReplies,
  reconcileVetoKey,
  retrySend,
  sendDueVeto,
  sendingInProcess,
} from "./reply";
import { getConversation } from "./store";

export { INTERRUPTED_AFTER_MS, INTERRUPTED_SEND };

export const SUPPORT_TICK_MS = 15_000;
/** Sends one tick starts at most; the rest wait for the next tick. */
const SENDS_PER_TICK = 20;
/** Wall time after which a tick starts no more sends (those running
 *  finish); under the tick interval, so ticks don't pile up. */
export const TICK_SEND_BUDGET_MS = 10_000;

type SendJob = () => Promise<void>;

export async function runSupportTick(now: number): Promise<{
  vetoSent: number;
  retried: number;
  interrupted: number;
  triaged: number;
}> {
  const out = { vetoSent: 0, retried: 0, interrupted: 0, triaged: 0 };
  const started = performance.now();
  /** Due sends by inbox: one at a time per inbox (its SMTP connection),
   *  inboxes in parallel. */
  const jobs = new Map<string, SendJob[]>();
  let sends = 0;
  const queue = (inboxId: string, job: SendJob) => {
    if (sends >= SENDS_PER_TICK) return;
    sends++;
    const list = jobs.get(inboxId) ?? [];
    list.push(job);
    jobs.set(inboxId, list);
  };
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
        if (!c || !d || d.id !== value.draftId || d.state !== "veto") {
          // The key names another draft, or none: match it to the draft.
          await reconcileVetoKey(value.conversationId);
          continue;
        }
        queue(c.inboxId, async () => {
          const sent = await sendDueVeto(c.id, d.id, now);
          if (sent.ok) out.vetoSent++;
        });
        continue;
      }
      // send:<conversationId>:<draftId>
      if (!isPendingSend(value)) {
        await dropPendingKey(key, "");
        continue;
      }
      if (sendingInProcess(value.conversationId)) continue;
      const c = await getConversation(value.conversationId);
      const d = c?.draft;
      if (!c || !d || d.id !== value.draftId || d.state !== "sending") {
        // Written just before a claim that may still be on its way.
        if (now - value.startedAt > INTERRUPTED_AFTER_MS)
          await dropPendingKey(key, value.draftId);
        continue;
      }
      if (d.nextAttemptAt) {
        if (Date.parse(d.nextAttemptAt) > now) continue;
        queue(c.inboxId, async () => {
          out.retried++;
          await retrySend(c.id, d.id, now);
        });
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
  await Promise.all(
    [...jobs.values()].map(async (list) => {
      for (const job of list) {
        if (performance.now() - started > TICK_SEND_BUDGET_MS) return;
        await job().catch((error: unknown) => {
          console.warn(
            "[support] tick: send failed:",
            error instanceof Error ? error.name : typeof error,
          );
        });
      }
    }),
  );
  out.triaged = await retryPendingInbound(now);
  return out;
}

/** Whether email support is on (the "email" integration is active, as the
 *  Inboxes page's `enabled`). */
export function emailSupportOn(): boolean {
  return activeIntegrations().some((spec) => spec.id === "email");
}

declare global {
  var __supportTick: ReturnType<typeof setInterval> | undefined;
}

/** Idempotent, and nothing while email support is off; the interval is
 *  unref'd and skips a tick while the last one runs or the server shuts
 *  down. */
export function startSupportTick(): void {
  if (globalThis.__supportTick || !emailSupportOn()) return;
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
