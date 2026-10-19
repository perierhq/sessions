import { expect, test } from "bun:test";
import type { SlackProgress } from "./progress";
import { applyTurnEvent } from "./turn-progress";

function recorder() {
  const calls: unknown[][] = [];
  const progress = {
    appendNarration: (text: string) => calls.push(["narration", text]),
    setTodos: (todos: unknown) => calls.push(["todos", todos]),
    setAction: (text: string, code?: string) =>
      calls.push(["action", text, code]),
  } as unknown as SlackProgress;
  return { calls, progress };
}

test("streamed text becomes the card's narration", () => {
  const { calls, progress } = recorder();
  applyTurnEvent(progress, { type: "text_chunk", text: "Looking at it" });
  expect(calls).toEqual([["narration", "Looking at it"]]);
});

test("engine tool names map onto the card's action line", () => {
  const { calls, progress } = recorder();
  applyTurnEvent(progress, {
    type: "tool_use",
    toolName: "bash",
    toolInput: { command: "bun test" },
  });
  applyTurnEvent(progress, {
    type: "tool_use",
    toolName: "tool_call",
    toolInput: { name: "acme_search" },
  });
  // The dispatcher's pre-rename name, as older transcripts replay it.
  applyTurnEvent(progress, {
    type: "tool_use",
    toolName: "mcp_call",
    toolInput: { name: "acme_lookup" },
  });
  applyTurnEvent(progress, {
    type: "tool_use",
    toolName: "edit",
    toolInput: { path: "src/app.ts" },
  });
  expect(calls).toEqual([
    ["action", "Running bun test", "bun test"],
    ["action", "Using acme_search", undefined],
    ["action", "Using acme_lookup", undefined],
    ["action", "Editing app.ts", undefined],
  ]);
});

test("a plan becomes the checklist and reads stay quiet", () => {
  const { calls, progress } = recorder();
  const todos = [{ content: "Fix it", status: "in_progress" }];
  applyTurnEvent(progress, {
    type: "tool_use",
    toolName: "todowrite",
    toolInput: { todos },
  });
  applyTurnEvent(progress, {
    type: "tool_use",
    toolName: "read",
    toolInput: { path: "a.ts" },
  });
  expect(calls).toEqual([["todos", todos]]);
});
