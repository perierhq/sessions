/**
 * A turn the server refuses to set up for a reason that waiting cannot
 * change: the session's policy, its sandbox settings, its repository or an
 * incident agent's access. Retrying the same queued message on a timer only
 * repeats the refusal, so the queue drain reports it once, keeps the message
 * queued and holds the queue until something new arrives (run-session.ts
 * holdRefusedQueue).
 *
 * Transient failures (a busy kernel, a provider that did not answer) stay
 * plain errors and keep the drain watcher's backoff.
 */
export class RunSetupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunSetupRefusedError";
  }
}

export function isRunSetupRefusal(error: unknown): error is Error {
  return error instanceof RunSetupRefusedError;
}
