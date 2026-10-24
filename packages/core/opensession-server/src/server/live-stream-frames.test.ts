import { expect, test } from "bun:test";
import { recoveredEventOpensLiveTurn } from "./live-stream-frames";

test("an adopted run's live turn opens on its first phase", () => {
  // A gateway restart adopts a run mid-tool: the first event it relays is
  // often the phase. The synthetic stream_start must go out before it, or
  // the stream_start that a later event triggers resets the phase.
  expect(
    recoveredEventOpensLiveTurn({ type: "phase", phase: "tool", since: 1 }),
  ).toBe(true);
  expect(
    recoveredEventOpensLiveTurn({ type: "phase", phase: "model", since: 1 }),
  ).toBe(true);
  for (const type of [
    "init",
    "text_chunk",
    "tool_call_start",
    "tool_use",
    "tool_result",
  ] as const)
    expect(recoveredEventOpensLiveTurn({ type })).toBe(true);
  // The turn's end and bookkeeping never open one.
  expect(
    recoveredEventOpensLiveTurn({ type: "phase", phase: "idle", since: 1 }),
  ).toBe(false);
  for (const type of ["usage_snapshot", "done", "discard"] as const)
    expect(recoveredEventOpensLiveTurn({ type })).toBe(false);
});
