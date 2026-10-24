import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import { activeThought, livePhaseStatus, phaseElapsed } from "./live-phase";

function entry(
  id: string,
  type: TranscriptEntry["type"],
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    id,
    type,
    content: id,
    timestamp: "2026-10-24T19:13:05Z",
    ...extra,
  };
}

const thought = entry("think", "assistant", {
  content: "I should verify the security changes.",
  isReasoning: true,
});
const bash = entry("bash", "tool_use", { toolName: "Bash" });
const note = entry("note", "assistant", { content: "Rebased. Checking." });

describe("activeThought", () => {
  test("a live rail ending on a thought is thinking", () => {
    expect(activeThought([bash, thought], true, null)).toBe(thought);
  });

  test("a later tool call ends the thought, even with nothing after it", () => {
    expect(activeThought([thought, bash], true, null)).toBeUndefined();
    expect(activeThought([thought, note, bash], true, null)).toBeUndefined();
  });

  test("narration after the thought means the model moved on", () => {
    expect(activeThought([thought, note], true, null)).toBeUndefined();
  });

  test("with phases known, only an open model request thinks", () => {
    expect(activeThought([bash, thought], true, "model")).toBe(thought);
    expect(activeThought([bash, thought], true, "tool")).toBeUndefined();
    expect(activeThought([bash, thought], true, "idle")).toBeUndefined();
  });

  test("a settled rail never thinks", () => {
    expect(activeThought([bash, thought], false, "model")).toBeUndefined();
  });

  test("a legacy bold heading counts as a thought", () => {
    const heading = entry("heading", "assistant", {
      content: "**Checking the tests**",
    });
    expect(activeThought([bash, heading], true, null)).toBe(heading);
  });
});

describe("livePhaseStatus", () => {
  const since = Date.parse("2026-10-24T19:13:39Z");

  test("a model request reads Thinking and shimmers", () => {
    expect(livePhaseStatus({ phase: "model", since }, since + 5_000)).toEqual({
      label: "Thinking",
      elapsed: null,
      shimmer: true,
    });
  });

  test("a tool names what it runs and how long it has run, without shimmer", () => {
    const phase = {
      phase: "tool" as const,
      since,
      tool: { id: "t1", name: "Bash", summary: "pnpm install && tsc" },
    };
    expect(livePhaseStatus(phase, since + 41_000)).toEqual({
      label: "Running pnpm install && tsc",
      elapsed: "41s",
      shimmer: false,
    });
    expect(livePhaseStatus(phase, since + 42_000)?.elapsed).toBe("42s");
  });

  test("a tool without a summary falls back to its name", () => {
    const phase = {
      phase: "tool" as const,
      since,
      tool: { id: "t1", name: "Bash", summary: "  " },
    };
    expect(livePhaseStatus(phase, since)?.label).toBe("Running Bash");
  });

  test("parallel tools name the latest and count the rest", () => {
    const phase = {
      phase: "tool" as const,
      since,
      toolCount: 2,
      tool: { id: "t2", name: "Bash", summary: "pnpm install && tsc" },
    };
    expect(livePhaseStatus(phase, since)?.label).toBe(
      "Running pnpm install && tsc and 1 more",
    );
  });

  test("idle and unknown say nothing beyond the generic row", () => {
    expect(livePhaseStatus({ phase: "idle", since }, since)).toBeNull();
    expect(livePhaseStatus(null, since)).toBeNull();
  });
});

describe("phaseElapsed", () => {
  test("keeps seconds past a minute and never goes negative", () => {
    expect(phaseElapsed(0, 0)).toBe("0s");
    expect(phaseElapsed(10_000, 0)).toBe("0s");
    expect(phaseElapsed(0, 65_000)).toBe("1m 05s");
    expect(phaseElapsed(0, 3_725_000)).toBe("1h 02m");
  });
});
