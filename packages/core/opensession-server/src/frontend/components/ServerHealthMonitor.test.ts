import { expect, test } from "bun:test";
import { leftoverReachText } from "./ServerHealthMonitor";

test("says which leftovers the reaper stops and which it leaves running", () => {
  expect(leftoverReachText({ reaper: 3, manual: 0 })).toBe(
    "The lifecycle reaper stops these within minutes.",
  );
  expect(leftoverReachText({ reaper: 0, manual: 1 })).toBe(
    "The lifecycle reaper leaves it running (another instance's, or without this instance's label or a readable start time); stop it by hand.",
  );
  expect(leftoverReachText({ reaper: 2, manual: 3 })).toBe(
    "The lifecycle reaper stops 2 within minutes. It leaves 3 running (another instance's, or without this instance's label or a readable start time); stop those by hand.",
  );
});
