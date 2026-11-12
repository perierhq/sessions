// backgroundHeadroom asks the source that serves a route; the local Claude
// source reads the account store, the shared usage file and the sidelines.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USAGE_LIMIT_BACKOFF_MS,
  __setHeadroomSourcesForTest,
  backgroundHeadroom,
  noteBackgroundUsageLimit,
  type HeadroomSource,
} from "./claude-headroom";
import {
  __resetMainspringPoolCacheForTest,
  __setMainspringDepsForTest,
  saveMainspringSettings,
} from "./mainspring";

let dir = "";
const previous = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
const previousEnv = {
  OPENSESSION_MODEL_PROVIDERS_CONFIG:
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG,
  OPENSESSION_WORKSPACE_SECRETS_STORE:
    process.env.OPENSESSION_WORKSPACE_SECRETS_STORE,
};
let restoreMainspring: (() => void) | undefined;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const LATER = "2026-11-10T15:00:00.000Z";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "headroom-"));
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(
    dir,
    "claude-accounts.json",
  );
  process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = join(
    dir,
    "model-providers.json",
  );
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
    dir,
    "workspace-secrets.json",
  );
  __resetMainspringPoolCacheForTest();
});
afterEach(() => {
  __setHeadroomSourcesForTest(undefined);
  restoreMainspring?.();
  restoreMainspring = undefined;
  for (const [name, value] of Object.entries(previousEnv))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined)
    delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = previous;
});

function write(
  accounts: Array<{ id: string; owner?: string }>,
  usage: Record<string, [number | null, number | null]> = {},
  sidelined: Record<string, number> = {},
) {
  writeFileSync(
    join(dir, "claude-accounts.json"),
    JSON.stringify({ accounts }),
  );
  writeFileSync(
    join(dir, "claude-accounts-usage.json"),
    JSON.stringify({
      usage: Object.fromEntries(
        Object.entries(usage).map(([id, [five, week]]) => [
          id,
          {
            fetchedAt: "2026-11-10T11:00:00.000Z",
            fiveHour: { utilization: five, resetsAt: LATER },
            sevenDay: { utilization: week, resetsAt: LATER },
          },
        ]),
      ),
    }),
  );
  writeFileSync(
    join(dir, "claude-accounts-state.json"),
    JSON.stringify({ exhaustedUntil: sidelined }),
  );
}

const CLAUDE = "pi/anthropic/claude-fable-5-1";
const ok = async (now = NOW, route = CLAUDE) =>
  (await backgroundHeadroom(route, now)).ok;

test("no accounts: nothing to protect", async () => {
  expect(await ok()).toBe(true);
});

test("one shared account with room is enough", async () => {
  write([{ id: "a" }, { id: "b" }], { a: [95, 20], b: [80, 90] });
  expect(await ok()).toBe(true);
});

test("every shared account near its 5-hour or weekly limit: no room", async () => {
  write([{ id: "a" }, { id: "b" }], { a: [81, 10], b: [10, 91] });
  expect(await backgroundHeadroom(CLAUDE, NOW)).toEqual({
    ok: false,
    reason: "Your Claude accounts are near their limits",
  });
});

test("personal accounts and sidelined accounts don't count", async () => {
  write(
    [{ id: "a", owner: "Ada" }, { id: "b" }],
    { a: [0, 0], b: [0, 0] },
    { b: NOW + 60_000 },
  );
  expect(await ok()).toBe(false);
});

test("a sideline for the route's model holds that account", async () => {
  write([{ id: "a" }], { a: [0, 0] }, { "a:claude-fable-5-1": NOW + 60_000 });
  expect(await ok()).toBe(false);
  expect(await ok(NOW, "pi/anthropic/claude-other-5")).toBe(true);
});

test("an account that reports no usage may have room, so it doesn't hold the work", async () => {
  write([{ id: "a" }, { id: "b" }], { a: [95, 20] });
  expect(await ok()).toBe(true);
  write([{ id: "a" }, { id: "b" }], { a: [null, null] });
  expect(await ok()).toBe(true);
});

test("usage logins expired everywhere and one account sidelined: still allowed", async () => {
  // The live failure: every usage poll errors (no windows), one account is
  // sidelined for its weekly limit. The others may well have room.
  write([{ id: "a" }, { id: "b" }, { id: "c" }], {}, { a: NOW + 86_400_000 });
  expect(await ok()).toBe(true);
});

test("every account measured over or sidelined: no room", async () => {
  write([{ id: "a" }, { id: "b" }], { b: [95, 20] }, { a: NOW + 60_000 });
  expect(await ok()).toBe(false);
});

test("a window that reset since the poll counts as room", async () => {
  write([{ id: "a" }], { a: [99, 50] });
  expect(await ok(Date.parse(LATER) + 1)).toBe(true);
});

test("a route no source serves is allowed", async () => {
  write([{ id: "a" }], { a: [99, 99] });
  expect(await ok(NOW, "pi/openai/gpt-6.1-sol")).toBe(true);
});

test("a usage limit holds the provider for the backoff, with or without a source", async () => {
  const hub: HeadroomSource = {
    label: "hub accounts",
    serves: (route) => route.startsWith("pi/hub/"),
    headroom: async () => null,
  };
  __setHeadroomSourcesForTest([hub]);
  const route = "pi/hub/claude-fable-5-1";
  expect(await ok(NOW, route)).toBe(true);
  noteBackgroundUsageLimit(route, NOW);
  expect(await backgroundHeadroom(route, NOW + 1)).toEqual({
    ok: false,
    reason: "The last background run hit a usage limit",
  });
  expect(await ok(NOW + 1, "pi/openai/gpt-6.1-sol")).toBe(true);
  expect(await ok(NOW + USAGE_LIMIT_BACKOFF_MS, route)).toBe(true);
});

describe("Claude through Mainspring", () => {
  const poolBody = (statuses: string[], coolUntil?: number) =>
    JSON.stringify({
      now: NOW,
      groups: [
        {
          provider: "claude",
          accounts: statuses.map((status, i) => ({
            label: `a${i}@example.test`,
            status,
            sessions: 0,
            windows: [],
            ...(coolUntil ? { cool_until: coolUntil + i * 60_000 } : {}),
          })),
        },
      ],
    });
  let pool: () => Response = () => new Response(poolBody(["next"]));
  let poolCalls = 0;

  async function routeThroughMainspring(fallbackDirect = false) {
    await saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: "sk-ms-test-key-0000",
      routeClaude: true,
      fallbackDirect,
    });
    poolCalls = 0;
    restoreMainspring = __setMainspringDepsForTest({
      resolve: async () => ["203.0.113.10"],
      fetch: async (url) => {
        poolCalls++;
        expect(url).toBe("https://mainspring.example.test/v1/pool");
        return pool();
      },
    });
  }

  test("local accounts near their limits don't hold routed Claude work", async () => {
    write([{ id: "a" }], { a: [99, 99] });
    expect(await ok()).toBe(false);
    pool = () => new Response(poolBody(["cooling", "active"]));
    await routeThroughMainspring();
    expect(await ok()).toBe(true);
    expect(poolCalls).toBe(1);
  });

  test("every Mainspring Claude account resting holds the work until the soonest is back", async () => {
    pool = () =>
      new Response(
        poolBody(["cooling", "benched", "needs_sign_in"], NOW + 3_600_000),
      );
    await routeThroughMainspring();
    const verdict = await backgroundHeadroom(CLAUDE, NOW);
    expect(verdict).toMatchObject({ ok: false, retryAt: NOW + 3_600_000 });
    if (verdict.ok) return;
    expect(verdict.reason).toStartWith(
      "Every Claude account in Mainspring is resting until",
    );
    // Cached for a minute: the next goal on this tick doesn't ask again.
    await backgroundHeadroom(CLAUDE, NOW + 1_000);
    expect(poolCalls).toBe(1);
  });

  test("a pool it can't read (404 with sharing off, unreachable) is allowed", async () => {
    write([{ id: "a" }], { a: [99, 99] });
    pool = () => new Response("{}", { status: 404 });
    await routeThroughMainspring();
    expect(await ok()).toBe(true);
    __resetMainspringPoolCacheForTest();
    pool = () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await ok()).toBe(true);
  });

  test("with the fallback on, a resting Mainspring defers to the local accounts", async () => {
    pool = () => new Response(poolBody(["cooling"]));
    await routeThroughMainspring(true);
    write([{ id: "a" }], { a: [10, 10] });
    expect(await ok()).toBe(true);
    write([{ id: "a" }], { a: [99, 99] });
    expect(await ok()).toBe(false);
  });

  test("other providers never ask Mainspring", async () => {
    pool = () => new Response(poolBody(["cooling"]));
    await routeThroughMainspring();
    expect(await ok(NOW, "pi/openai/gpt-6.1-sol")).toBe(true);
    expect(poolCalls).toBe(0);
  });
});
