/**
 * Errors already logged, with their stack, where they happened. A failure
 * that is logged and then rethrown (a sandbox that would not launch) reached
 * the journal twice, once per catcher, each with a full stack trace. The
 * first catcher marks what it rethrows; later catchers log the message only.
 */
const reportedErrors = new WeakSet<object>();

/** Mark `error` as logged; returns it, for `throw reported(new Error(…))`. */
export function reported<E extends Error>(error: E): E {
  reportedErrors.add(error);
  return error;
}

export function alreadyReported(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && reportedErrors.has(error)
  );
}

/** What a later catcher logs for `error`: its message when it was already
 *  logged, else the error itself. */
export function logDetail(error: unknown): unknown {
  return alreadyReported(error) ? (error as Error).message : error;
}
