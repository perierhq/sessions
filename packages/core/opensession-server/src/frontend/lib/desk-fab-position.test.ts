import { describe, expect, test } from "bun:test";

import { calculateDeskFabPosition } from "./desk-fab-position";

describe("calculateDeskFabPosition", () => {
  test("uses the bottom-right corner when the composer leaves room", () => {
    expect(
      calculateDeskFabPosition(
        { right: 1300.625, top: 818.75 },
        { width: 2074, height: 938 },
      ),
    ).toEqual({ left: 2012, bottom: 18 });
  });

  test("moves above a composer that reaches the viewport edge", () => {
    expect(
      calculateDeskFabPosition(
        { right: 863, top: 818.75 },
        { width: 900, height: 938 },
      ),
    ).toEqual({ left: 819, bottom: 129.25 });
  });

  test("returns to the corner when the viewport widens again", () => {
    const anchor = { right: 1300.625, top: 818.75 };
    const narrow = calculateDeskFabPosition(anchor, {
      width: 1320,
      height: 938,
    });
    const wide = calculateDeskFabPosition(anchor, {
      width: 2074,
      height: 938,
    });

    expect(narrow).toEqual({ left: 1256.625, bottom: 129.25 });
    expect(wide).toEqual({ left: 2012, bottom: 18 });
  });

  test("rests in the safe area's corner, not the window's", () => {
    expect(
      calculateDeskFabPosition(
        { right: 500, top: 780 },
        { width: 951, height: 902 },
        { right: 30, bottom: 20 },
      ),
    ).toEqual({ left: 859, bottom: 38 });
  });

  test("moves above the composer when the room beside it is a side inset", () => {
    // A phone on its side: the gap beside the composer is the notch's inset.
    expect(
      calculateDeskFabPosition(
        { right: 777, top: 264 },
        { width: 844, height: 390 },
        { right: 47, bottom: 21 },
      ),
    ).toEqual({ left: 733, bottom: 136 });
  });
});
