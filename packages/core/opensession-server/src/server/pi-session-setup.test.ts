/**
 * The in-memory pi settings a turn runs with: cache warming off, SSE for
 * ChatGPT OAuth, and a supervisor session's longer compaction tail, read
 * back through pi's own SettingsManager.
 */
import { describe, expect, test } from "bun:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  piSessionSettings,
  SUPERVISOR_KEEP_RECENT_TOKENS,
} from "./pi-session-setup";

function compaction(input: { usesOpenaiOAuth: boolean; supervisor: boolean }) {
  return SettingsManager.inMemory(
    piSessionSettings(input),
  ).getCompactionSettings();
}

describe("piSessionSettings", () => {
  test("a supervisor session keeps 40000 recent tokens and pi's other defaults", () => {
    const supervisor = compaction({ usesOpenaiOAuth: false, supervisor: true });
    const plain = compaction({ usesOpenaiOAuth: false, supervisor: false });
    expect(SUPERVISOR_KEEP_RECENT_TOKENS).toBe(40_000);
    expect(supervisor).toEqual({
      ...plain,
      keepRecentTokens: SUPERVISOR_KEEP_RECENT_TOKENS,
    });
    expect(plain.keepRecentTokens).toBe(20_000);
    expect(supervisor.reserveTokens).toBe(plain.reserveTokens);
    expect(supervisor.enabled).toBe(true);
  });

  test("any other session leaves compaction to pi", () => {
    expect(
      piSessionSettings({ usesOpenaiOAuth: false, supervisor: false }),
    ).toEqual({
      cacheWarming: "off",
    });
    expect(
      piSessionSettings({ usesOpenaiOAuth: true, supervisor: false }),
    ).toEqual({
      cacheWarming: "off",
      transport: "sse",
    });
  });

  test("the setup builds its settings here, from the run's supervisor flag", async () => {
    const source = await Bun.file(
      new URL("./pi-session-setup.ts", import.meta.url),
    ).text();
    expect(source).toMatch(
      /sdk\.SettingsManager\.inMemory\(\s*piSessionSettings\(\{\s*usesOpenaiOAuth: binding\.usesOpenaiOAuth,\s*supervisor: opts\.supervisor === true,/,
    );
  });
});
