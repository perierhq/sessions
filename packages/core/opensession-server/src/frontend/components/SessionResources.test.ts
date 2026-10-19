import { expect, test } from "bun:test";
import { sessionResourceSummary } from "./SessionResources";

test("summarises what runs in a fixed order with counted nouns", () => {
  expect(
    sessionResourceSummary([
      { kind: "unit", id: "unit:a", label: "a" },
      { kind: "container", id: "container:b", label: "b" },
      { kind: "container", id: "container:c", label: "c" },
      { kind: "portal", id: "portal:web", label: "web" },
      { kind: "setup", id: "setup:1", label: "bun install" },
    ]),
  ).toBe("1 Portal · 2 containers · 1 background process · 1 setup");
  expect(sessionResourceSummary([])).toBe("");
});
