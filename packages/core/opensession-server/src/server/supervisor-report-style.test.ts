import { describe, expect, test } from "bun:test";
import { reportStyleInstruction } from "./supervisor-report-style";

describe("reportStyleInstruction", () => {
  test("each style shapes what is shown", () => {
    expect(reportStyleInstruction("bluf")).toContain(
      "BLUF: what is shown leads with the bottom line or the ask, then what supports it.",
    );
    expect(reportStyleInstruction("sbar")).toContain(
      "SBAR: what is shown is four short labelled parts: Situation, Background, Assessment, Recommendation.",
    );
    expect(reportStyleInstruction("plain")).toContain(
      "plain: no fixed shape; show what fits.",
    );
  });

  test("what Blob says stays conversational in every style", () => {
    for (const style of ["bluf", "sbar", "plain"]) {
      expect(reportStyleInstruction(style)).toContain(
        "What Blob says aloud stays conversational in every style",
      );
    }
  });

  test("anything unknown is the default, BLUF", () => {
    expect(reportStyleInstruction("memo")).toStartWith(
      "The owner's report style is BLUF",
    );
    expect(reportStyleInstruction(undefined)).toStartWith(
      "The owner's report style is BLUF",
    );
  });
});
