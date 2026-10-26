/**
 * Requeue for automation runs the host refused to start.
 *
 * A run-host admission refusal (host-admission.ts) means nothing ran: no
 * engine, no journal. The run is retried in the same session after a backoff
 * instead of being recorded as a failure that waits for the next schedule
 * (a nightly job would otherwise skip a whole day).
 */
import {
  isRunHostAdmissionRefusal,
  runHostAdmissionRetryDelayMs,
} from "./host-admission";

/** Launches per run, the first one included. With the 2, 4, 8 and 16 minute
 *  waits between them, a run keeps trying for about half an hour. */
export const MAX_AUTOMATION_LAUNCH_ATTEMPTS = 5;

/** The retry for a failed launch, or undefined when it should not be retried.
 *  `attempt` is the launch that just failed (1 for the first). */
export function automationLaunchRetry(
  errorMessage: string,
  attempt: number,
):
  | {
      delayMs: number;
      nextAttempt: number;
      /** The failure as the ledger and transcript show it. */
      error: string;
    }
  | undefined {
  if (!isRunHostAdmissionRefusal(errorMessage)) return undefined;
  if (attempt >= MAX_AUTOMATION_LAUNCH_ATTEMPTS) return undefined;
  const delayMs = runHostAdmissionRetryDelayMs(attempt);
  const nextAttempt = attempt + 1;
  return {
    delayMs,
    nextAttempt,
    error: `${errorMessage.replace(/\.$/, "")}. Retrying in ${Math.round(delayMs / 60_000)} min (attempt ${nextAttempt} of ${MAX_AUTOMATION_LAUNCH_ATTEMPTS}).`,
  };
}
