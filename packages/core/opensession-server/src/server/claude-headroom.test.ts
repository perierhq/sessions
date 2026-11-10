// backgroundHeadroom asks the source that serves a route; the local Claude
// source reads the account store, the shared usage file and the sidelines.
import { afterEach, beforeEach, expect, test } from "bun:test";
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

let dir = "";
const previous = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const LATER = "2026-11-10T15:00:00.000Z";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "headroom-"));
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = join(
    dir,
    "claude-accounts.json",
  );
});
afterEach(() => {
  __setHeadroomSourcesForTest(undefined);
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

test("accounts that report no usage don't count; with none reporting, allow", async () => {
  write([{ id: "a" }, { id: "b" }], { a: [95, 20] });
  expect(await ok()).toBe(false);
  write([{ id: "a" }, { id: "b" }], { a: [null, null] });
  expect(await ok()).toBe(true);
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
