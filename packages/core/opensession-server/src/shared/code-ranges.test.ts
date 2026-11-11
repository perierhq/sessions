import { describe, expect, test } from "bun:test";
import { codeRanges } from "./code-ranges";

function code(text: string): string[] {
  return codeRanges(text).map((r) => text.slice(r.start, r.end));
}

describe("codeRanges", () => {
  test("backtick and tilde fences, each closed by its own kind", () => {
    expect(code("a\n```\nx\n```\nb")).toEqual(["```\nx\n```"]);
    expect(code("a\n~~~\nx\n~~~\nb")).toEqual(["~~~\nx\n~~~"]);
    expect(code("~~~\n```\n~~~ b")).toEqual(["~~~\n```\n~~~"]);
  });

  test("an unclosed fence runs to the end", () => {
    expect(code("a ```\nx")).toEqual(["```\nx"]);
    expect(code("a ~~~\nx")).toEqual(["~~~\nx"]);
  });

  test("inline spans close on a run of the same length", () => {
    expect(code("a `x` b")).toEqual(["`x`"]);
    expect(code("a ``x`` b")).toEqual(["``x``"]);
    expect(code("a ``x `y` z`` b")).toEqual(["``x `y` z``"]);
    expect(code("a ``x` b")).toEqual([]);
  });

  test("an inline span stays on its line", () => {
    expect(code("a `x\ny` b")).toEqual([]);
  });

  test("spans inside a fence are part of the fence", () => {
    expect(code("```\n`x`\n```\n`y`")).toEqual(["```\n`x`\n```", "`y`"]);
  });
});
