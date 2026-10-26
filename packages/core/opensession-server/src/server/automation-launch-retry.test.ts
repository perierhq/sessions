import { describe, expect, test } from "bun:test";
import {
  automationLaunchRetry,
  MAX_AUTOMATION_LAUNCH_ATTEMPTS,
} from "./automation-launch-retry";

const refusal =
  "Run host launch refused: not enough free memory: 1266 MiB free, 2171 MiB needed";

describe("automation runs the host had no room for", () => {
  test("are requeued with growing backoff and say so", () => {
    const first = automationLaunchRetry(refusal, 1);
    expect(first).toEqual({
      delayMs: 2 * 60_000,
      nextAttempt: 2,
      error: `${refusal}. Retrying in 2 min (attempt 2 of ${MAX_AUTOMATION_LAUNCH_ATTEMPTS}).`,
    });
    expect(automationLaunchRetry(refusal, 3)?.delayMs).toBe(8 * 60_000);
  });

  test("stop after the last attempt", () => {
    expect(
      automationLaunchRetry(refusal, MAX_AUTOMATION_LAUNCH_ATTEMPTS),
    ).toBeUndefined();
  });

  test("other failures are not retried", () => {
    expect(automationLaunchRetry("pi: 400 bad request", 1)).toBeUndefined();
  });

  test("the automation runner requeues refused launches", async () => {
    const source = await Bun.file(
      new URL("./automations.ts", import.meta.url),
    ).text();
    expect(source).toContain("automationLaunchRetry(");
    expect(source).toContain("scheduleAutomationLaunchRetry(");
  });
});
