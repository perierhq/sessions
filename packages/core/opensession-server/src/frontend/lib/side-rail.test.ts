import { describe, expect, test } from "bun:test";
import { bindSideRail, SIDE_RAIL_CLASS, wantsSideRail } from "./side-rail";

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

describe("bindSideRail", () => {
  function fakeRoot() {
    const classes = new Set<string>();
    return {
      classes,
      classList: {
        toggle(token: string, force?: boolean) {
          const on = force ?? !classes.has(token);
          if (on) classes.add(token);
          else classes.delete(token);
          return on;
        },
      },
    };
  }

  test("turns on when the insets arrive after boot, with no resize", () => {
    // iOS can report a standalone app's insets only after its first layout.
    let insets = { right: 0, left: 0 };
    let notify = () => {};
    const root = fakeRoot();
    bindSideRail(
      () => insets,
      root,
      (onChange) => {
        notify = onChange;
        return () => {};
      },
    );
    expect(root.classes.has(SIDE_RAIL_CLASS)).toBe(false);
    insets = { right: 84, left: 0 };
    notify();
    expect(root.classes.has(SIDE_RAIL_CLASS)).toBe(true);
    insets = { right: 59, left: 59 };
    notify();
    expect(root.classes.has(SIDE_RAIL_CLASS)).toBe(false);
  });
});
