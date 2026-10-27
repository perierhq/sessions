import { getConfigAsync } from "./config";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectAccountIssues,
  selectedGithubCredentialIssues,
} from "./account-health";
import { markOauthRefused } from "./claude-accounts";

const originalConfig = process.env.OPENSESSION_CONFIG;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = originalConfig;
    await getConfigAsync();
  }
  globalThis.fetch = originalFetch;
});

describe("GitHub account health credential selection", () => {
  test("an unconfigured App makes no external request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-account-health-"));
    try {
      const config = join(dir, "config.json");
      writeFileSync(config, JSON.stringify({ integrations: { github: {} } }));
      process.env.OPENSESSION_CONFIG = config;
      await getConfigAsync();
      let requests = 0;
      globalThis.fetch = (async () => {
        requests += 1;
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch;

      expect(await selectedGithubCredentialIssues()).toEqual([]);
      expect(requests).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude account health", () => {
  test("names an account whose organization refuses OAuth", () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-account-health-"));
    const previous = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
    process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(dir, "accounts.json");
    try {
      writeFileSync(
        process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH,
        JSON.stringify({
          accounts: [
            {
              id: "acme-refused",
              name: "acme",
              token: "sk-ant-oat01-acme",
              createdAt: "2026-01-01T00:00:00.000Z",
              usageScope: "missing",
            },
          ],
        }),
      );
      expect(
        detectAccountIssues().filter((i) => i.key.startsWith("claude:")),
      ).toEqual([]);
      markOauthRefused("acme-refused");
      const issues = detectAccountIssues().filter((i) =>
        i.key.startsWith("claude:"),
      );
      expect(issues.map((i) => i.key)).toEqual([
        "claude:acme-refused:oauth-refused",
      ]);
      expect(issues[0].message).toContain(
        "its organization doesn't allow sign-in with OAuth",
      );
    } finally {
      if (previous === undefined)
        delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
      else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
