import { describe, expect, test } from "bun:test";
import { machineChoices } from "./new-session-machine";

describe("machineChoices", () => {
  test("this machine is marked the default when nothing else is", () => {
    expect(
      machineChoices({ ready: ["daytona"], selected: "", defaultId: "" }),
    ).toEqual([
      { id: "", available: true, isDefault: true },
      { id: "daytona", available: true, isDefault: false },
    ]);
  });

  test("a provider default is marked, and an unready selection stays listed", () => {
    expect(
      machineChoices({ ready: ["daytona"], selected: "box", defaultId: "box" }),
    ).toEqual([
      { id: "", available: true, isDefault: false },
      { id: "daytona", available: true, isDefault: false },
      { id: "box", available: false, isDefault: true },
    ]);
  });
});
