import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  streamTimingFetch,
  streamTimingMarks,
  timeStreamSpan,
} from "./stream-timing";

afterEach(() => {
  delete process.env.OPENSESSION_STREAM_TIMING;
});

function timingLines(log: ReturnType<typeof spyOn>) {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith("[stream-timing] "))
    .map((line: string) => JSON.parse(line.slice("[stream-timing] ".length)));
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("stream timing", () => {
  test("off by default: spans and marks write nothing", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await timeStreamSpan("workspace", {}, async () => 7)).toBe(7);
      const marks = streamTimingMarks("pi_setup", {});
      marks.mark("resources");
      marks.end();
      expect(timingLines(log)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  test("the fetch wrapper passes the body through and logs its chunks", async () => {
    process.env.OPENSESSION_STREAM_TIMING = "1";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const fetch = streamTimingFetch(
        async () => sseResponse(["event: a\n\n", "event: b\n\n"]),
        "anthropic",
      );
      const response = await fetch("https://example.test/v1/messages");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toBe("event: a\n\nevent: b\n\n");
      const [line] = timingLines(log);
      expect(line).toMatchObject({
        event: "sse_response",
        label: "anthropic",
        status: 200,
        outcome: "end",
        bytes: 20,
        chunkCount: 2,
      });
      expect(line.chunks.map((chunk: number[]) => chunk[1])).toEqual([10, 10]);
    } finally {
      log.mockRestore();
    }
  });

  test("marks report each step once the span ends", () => {
    process.env.OPENSESSION_STREAM_TIMING = "1";
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const marks = streamTimingMarks("pi_setup", { sessionId: "s1" });
      marks.mark("resources");
      marks.mark("create_session");
      marks.end();
      marks.end();
      const lines = timingLines(log);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "span", name: "pi_setup" });
      expect(lines[0].steps.map((step: unknown[]) => step[0])).toEqual([
        "resources",
        "create_session",
      ]);
    } finally {
      log.mockRestore();
    }
  });
});
