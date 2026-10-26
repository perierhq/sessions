import { expect, test } from "bun:test";
import { suggestionLine } from "./suggestions";

test("a suggestion's line counts its sources", () => {
  expect(suggestionLine({ sources: [] })).toBe("No sources");
  expect(suggestionLine({ sources: ["mail:a@example.test"] })).toBe("1 source");
  expect(
    suggestionLine({ sources: ["mail:a@example.test", "mail:b@example.test"] }),
  ).toBe("2 sources");
});

test("a suggestion with a check note says it rests on older replies", () => {
  expect(
    suggestionLine({
      sources: ["mail:a@example.test"],
      check: { reason: "release v1.4.0", since: "2026-10-20" },
    }),
  ).toBe("1 source · Built from replies older than release v1.4.0");
});

test("a note already phrased that way isn't repeated", () => {
  expect(
    suggestionLine({
      sources: [],
      check: {
        reason: "Built from replies older than docs/export.md",
        since: "2026-10-20",
      },
    }),
  ).toBe("No sources · Built from replies older than docs/export.md");
});
