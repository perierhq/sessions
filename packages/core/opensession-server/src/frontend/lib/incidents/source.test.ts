import { expect, test } from "bun:test";
import type { ToolRef } from "../../../shared/findings";
import { findQuote, sourceEntries } from "./source";

const ref: ToolRef = {
  type: "tool",
  sessionId: "os-inv",
  useId: "toolu_1",
  resultId: "tr-toolu_1",
  tool: "Bash",
  at: "2026-10-27T12:05:00.000Z",
  provenance: { kind: "shell" },
};

test("the cited call and result become the transcript's own entries", () => {
  const { entry, result } = sourceEntries(
    ref,
    { content: "$ curl api.example.test", toolInput: { command: "curl" } },
    { content: "HTTP 503" },
  );
  expect(entry).toMatchObject({
    id: "toolu_1",
    type: "tool_use",
    toolName: "Bash",
    toolInput: { command: "curl" },
  });
  expect(result).toMatchObject({
    id: "tr-toolu_1",
    type: "tool_result",
    toolUseId: "toolu_1",
    content: "HTTP 503",
  });
});

test("the quote lands on the innermost element that holds it", () => {
  type Fake = { textContent: string; children: Fake[] };
  const line: Fake = { textContent: "ERROR acme db timeout", children: [] };
  const well: Fake = {
    textContent: "INFO start\nERROR acme db timeout",
    children: [{ textContent: "INFO start", children: [] }, line],
  };
  const root: Fake = { textContent: well.textContent, children: [well] };
  expect(findQuote(root, ["  ", "ERROR acme db timeout"])).toBe(line);
  expect(findQuote(root, ["missing"])).toBeNull();
});
