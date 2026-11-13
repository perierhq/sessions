import { describe, expect, test } from "bun:test";
import { hasUnsafeTextChars, pushSafeText } from "./safe-text";

describe("safe text", () => {
  test("pushSafeText keeps one visible line", () => {
    expect(pushSafeText("  a\n\tb\u2028c  ")).toBe("a b c");
    expect(pushSafeText("pay\u202Egnp.exe\u2066x\u2069\u200E\u061C")).toBe(
      "paygnp.exex",
    );
    expect(pushSafeText("bell\u0007 del\u007f c1\u0085")).toBe("bell del c1");
  });

  test("hasUnsafeTextChars matches the same class", () => {
    for (const ch of [
      "\u0000",
      "\n",
      "\u007f",
      "\u009f",
      "\u061C",
      "\u200E",
      "\u200F",
      "\u202A",
      "\u202E",
      "\u2066",
      "\u2069",
      "\u2028",
      "\u2029",
    ]) {
      expect(hasUnsafeTextChars(`a${ch}b`)).toBe(true);
      expect(hasUnsafeTextChars(pushSafeText(`a${ch}b`))).toBe(false);
    }
    expect(hasUnsafeTextChars("Zażółć — ✓ 😀")).toBe(false);
  });
});
