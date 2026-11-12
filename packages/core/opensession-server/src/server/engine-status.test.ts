import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { engineStatus } from "./engine-status";
import { __clearJsonFileCacheForTest } from "./shared/json-file-cache";

const original = process.env.OPENSESSION_PI_CONFIG;
let dir = "";
afterEach(() => {
  if (original === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = original;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("engine status", () => {
  test("reports a disabled Pi engine as the first blocker", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-status-"));
    const path = join(dir, "pi.json");
    writeFileSync(path, JSON.stringify({ enabled: false }));
    process.env.OPENSESSION_PI_CONFIG = path;
    const status = engineStatus();
    expect(status.piEnabled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.fixableInApp).toBe(true);
    expect(status.blocker).toContain("Pi engine");
  });

  test("Claude routed through Mainspring with a tested key needs no local Claude account", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-status-"));
    writeFileSync(join(dir, "pi.json"), JSON.stringify({ enabled: true }));
    process.env.OPENSESSION_PI_CONFIG = join(dir, "pi.json");
    const providersPath = join(dir, "model-providers.json");
    const previousProviders = process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
    const previousAccounts = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = providersPath;
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(dir, "claude.json");
    const write = (mainspring: Record<string, unknown>) => {
      writeFileSync(providersPath, JSON.stringify({ mainspring }));
      __clearJsonFileCacheForTest();
    };
    const base = {
      url: "https://mainspring.example.test",
      keyRef: "wssec-test",
      routeClaude: true,
    };
    try {
      write(base);
      const untested = engineStatus();
      expect(untested.provider).toBe("claude");
      expect(untested.claudeAccounts).toBe(0);
      expect(untested.blocker).toContain("No usable Claude accounts");
      write({
        ...base,
        models: {
          at: "2026-11-12T10:00:00.000Z",
          models: { "claude-sonnet-5-5": { id: "claude-sonnet-5-5" } },
        },
      });
      const tested = engineStatus();
      expect(tested.ready).toBe(true);
      expect(tested.blocker).toBeNull();
    } finally {
      if (previousProviders === undefined)
        delete process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG;
      else process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = previousProviders;
      if (previousAccounts === undefined)
        delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
      else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = previousAccounts;
      __clearJsonFileCacheForTest();
    }
  });
});
