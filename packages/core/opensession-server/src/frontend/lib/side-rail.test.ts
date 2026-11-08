import { describe, expect, test } from "bun:test";
import { wantsSideRail } from "./side-rail";

describe("wantsSideRail", () => {
  test("a deep one-sided right inset is a status column", () => {
    expect(wantsSideRail({ right: 84, left: 0 })).toBe(true);
  });

  test("a phone on its side insets both edges alike, so no rail", () => {
    expect(wantsSideRail({ right: 59, left: 59 })).toBe(false);
    expect(wantsSideRail({ right: 84, left: 59 })).toBe(false);
  });

  test("a shallow inset cannot hold a control", () => {
    expect(wantsSideRail({ right: 24, left: 0 })).toBe(false);
  });
});
