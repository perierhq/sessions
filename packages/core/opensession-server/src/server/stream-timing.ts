/**
 * Debug timing for the live stream and run start-up.
 *
 * Off by default. With `OPENSESSION_STREAM_TIMING=1` in the process
 * environment, each helper writes one `[stream-timing]` JSON line to stdout:
 *
 * - `model_message`: one line per assistant message, written at its
 *   message_end, with the request start, when the message started, every
 *   message_update's receive time (ms after the request start) and the end.
 * - `sse_response`: one line per streamed provider response, written when the
 *   body ends, with the time of the response headers, the first body byte
 *   and every raw body chunk (ms after the request started, byte length).
 * - `span`: a named start-up step (workspace, run-host launch, pi session
 *   setup) and how long it took.
 *
 * Comparing a message's `updates` with its response's `chunks` shows whether
 * deltas arrive in lumps from the provider or are held back after it.
 *
 * The flag is read on each call, never at import time.
 */

/** Cap on the samples one line keeps, so a runaway stream stays bounded. */
const MAX_SAMPLES = 4_000;

export function streamTimingEnabled(): boolean {
  return process.env.OPENSESSION_STREAM_TIMING === "1";
}

export function logStreamTiming(
  event: string,
  fields: Record<string, unknown>,
): void {
  if (!streamTimingEnabled()) return;
  try {
    console.log(
      `[stream-timing] ${JSON.stringify({ event, at: Date.now(), ...fields })}`,
    );
  } catch {}
}

/** Time a start-up step. Returns the function's result unchanged. */
export async function timeStreamSpan<T>(
  name: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!streamTimingEnabled()) return fn();
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    logStreamTiming("span", {
      name,
      ...fields,
      startedAt,
      ms: Date.now() - startedAt,
    });
  }
}

/** Collects one assistant message's update times. */
export class ModelMessageTiming {
  private readonly updates: Array<[number, string, number]> = [];
  private dropped = 0;

  constructor(
    private readonly requestStartedAt: number,
    private readonly startedAt: number = Date.now(),
  ) {}

  /** One message_update: its pi event type and delta length, if any. */
  update(type: string, deltaLength: number): void {
    if (this.updates.length >= MAX_SAMPLES) {
      this.dropped++;
      return;
    }
    this.updates.push([Date.now() - this.requestStartedAt, type, deltaLength]);
  }

  /** Write the message's line. */
  end(fields: Record<string, unknown>): void {
    const endedAt = Date.now();
    logStreamTiming("model_message", {
      ...fields,
      requestStartedAt: this.requestStartedAt,
      messageStartMs: this.startedAt - this.requestStartedAt,
      firstUpdateMs: this.updates[0]?.[0] ?? null,
      endMs: endedAt - this.requestStartedAt,
      updateCount: this.updates.length + this.dropped,
      // [ms after request start, assistantMessageEvent type, delta chars]
      updates: this.updates,
      ...(this.dropped ? { dropped: this.dropped } : {}),
    });
  }
}

type FetchLike = (input: any, init?: any) => Promise<Response>;

/**
 * A fetch that timestamps the raw body chunks of each response it returns.
 * Only for the debug flag: it re-wraps the body in a pull-through stream,
 * which costs one extra hop per chunk and nothing else.
 */
export function streamTimingFetch(inner: FetchLike, label: string): FetchLike {
  return async (input, init) => {
    const requestStartedAt = Date.now();
    const response = await inner(input, init);
    const headersMs = Date.now() - requestStartedAt;
    if (!response.body) return response;
    const chunks: Array<[number, number]> = [];
    let dropped = 0;
    let bytes = 0;
    const report = (outcome: string) =>
      logStreamTiming("sse_response", {
        label,
        status: response.status,
        requestStartedAt,
        headersMs,
        firstByteMs: chunks[0]?.[0] ?? null,
        endMs: Date.now() - requestStartedAt,
        outcome,
        bytes,
        chunkCount: chunks.length + dropped,
        // [ms after request start, bytes]
        chunks,
        ...(dropped ? { dropped } : {}),
      });
    const reader = response.body.getReader();
    let reported = false;
    const finish = (outcome: string) => {
      if (reported) return;
      reported = true;
      report(outcome);
    };
    const timed = new ReadableStream({
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          finish("error");
          controller.error(error);
          return;
        }
        if (next.done) {
          finish("end");
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (chunks.length < MAX_SAMPLES)
          chunks.push([Date.now() - requestStartedAt, next.value.byteLength]);
        else dropped++;
        controller.enqueue(next.value);
      },
      cancel(reason) {
        finish("cancel");
        return reader.cancel(reason);
      },
    });
    return new Response(timed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Step marks inside one start-up span; `end` writes one `span` line. */
export interface StreamTimingMarks {
  mark(step: string): void;
  end(fields?: Record<string, unknown>): void;
}

const NO_MARKS: StreamTimingMarks = { mark() {}, end() {} };

/**
 * Time the steps of one start-up span: each `mark(step)` records the ms since
 * the previous mark. A no-op unless the debug flag is on.
 */
export function streamTimingMarks(
  name: string,
  fields: Record<string, unknown>,
): StreamTimingMarks {
  if (!streamTimingEnabled()) return NO_MARKS;
  const startedAt = Date.now();
  let last = startedAt;
  const steps: Array<[string, number]> = [];
  let ended = false;
  return {
    mark(step) {
      const now = Date.now();
      steps.push([step, now - last]);
      last = now;
    },
    end(extra) {
      if (ended) return;
      ended = true;
      logStreamTiming("span", {
        name,
        ...fields,
        ...extra,
        startedAt,
        ms: Date.now() - startedAt,
        // [step, ms since the previous mark]
        steps,
      });
    },
  };
}
