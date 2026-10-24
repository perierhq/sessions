import { describe, expect, test } from "bun:test";
import type { SandboxConnectionInfo } from "../api/automations";
import { waitForConnection } from "./connect";

const conn = (state: SandboxConnectionInfo["state"]) =>
  // SAFETY: waitForConnection reads only provider and state.
  ({ provider: "daytona", state }) as SandboxConnectionInfo;

describe("waitForConnection", () => {
  test("looks again while the check runs, and returns the result", async () => {
    const answers = [conn("checking"), conn("ready")];
    let sleeps = 0;
    const out = await waitForConnection(
      "daytona",
      { connections: [conn("checking")] },
      {
        fetch: async () => ({ connections: [answers.shift()!] }),
        sleep: async () => {
          sleeps++;
        },
      },
    );
    expect(out?.state).toBe("ready");
    expect(sleeps).toBe(2);
  });

  test("a failed check is a result too", async () => {
    const out = await waitForConnection(
      "daytona",
      { connections: [conn("needs_attention")] },
      { fetch: async () => ({ connections: [] }), sleep: async () => {} },
    );
    expect(out?.state).toBe("needs_attention");
  });

  test("gives up, saying so, when the check never finishes", async () => {
    const out = await waitForConnection(
      "daytona",
      { connections: [conn("checking")] },
      {
        fetch: async () => ({ connections: [conn("checking")] }),
        sleep: async () => {},
        attempts: 3,
      },
    );
    expect(out).toBeNull();
  });
});
