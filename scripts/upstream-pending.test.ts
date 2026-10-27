import { describe, expect, test } from "bun:test";
import { portedShas, skippedShas, stateOf } from "./upstream-pending";

describe("upstream-pending", () => {
  test("reads every Upstream trailer, full or short", () => {
    const log = [
      "Add a thing",
      "",
      "Upstream: tellahq/opensession@8a8996fa3",
      "Upstream: tellahq/opensession@c2d2b7b87aa3c1c2f1d3c0e2b9c8a7f6e5d4c3b2",
    ].join("\n");
    expect(portedShas(log)).toEqual([
      "8a8996fa3",
      "c2d2b7b87aa3c1c2f1d3c0e2b9c8a7f6e5d4c3b2",
    ]);
  });

  test("reads only the Skipped table's first column", () => {
    const doc = [
      "## Lanes",
      "| `core` | not a sha |",
      "| abcdef1234 | looks like a sha but is not in Skipped |",
      "## Skipped",
      "| Upstream sha | Subject | Why |",
      "| ------------ | ------- | --- |",
      "| `0123456789` | Something | Their accounts only |",
      "| fedcba98765 | Other | Contradicts a fork decision |",
      "## After",
      "| 1111111111 | x | y |",
    ].join("\n");
    expect(skippedShas(doc)).toEqual(["0123456789", "fedcba98765"]);
  });

  test("matches short and full shas both ways", () => {
    const full = "8a8996fa3c1c2f1d3c0e2b9c8a7f6e5d4c3b2a10";
    expect(stateOf(full, ["8a8996fa3"], [])).toBe("ported");
    expect(stateOf("8a8996fa3", [full], [])).toBe("ported");
    expect(stateOf(full, [], ["8a8996f"])).toBe("skipped");
    expect(stateOf(full, ["deadbeef1"], ["0123456"])).toBe("pending");
  });
});
