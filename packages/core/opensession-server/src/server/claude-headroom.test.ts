// backgroundHeadroomOk reads the account store, the shared usage file and
// the sidelines, and answers whether any shared account has room.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundHeadroomOk } from "./claude-headroom";

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
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined)
    delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = previous;
});

function write(
  accounts: Array<{ id: string; owner?: string }>,
  usage: Record<string, [number, number]> = {},
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

test("no accounts: nothing to protect", async () => {
  expect(await backgroundHeadroomOk(NOW)).toBe(true);
});

test("one shared account with room is enough", async () => {
  write([{ id: "a" }, { id: "b" }], { a: [95, 20], b: [80, 90] });
  expect(await backgroundHeadroomOk(NOW)).toBe(true);
});

test("every shared account near its 5-hour or weekly limit: no room", async () => {
  write([{ id: "a" }, { id: "b" }], { a: [81, 10], b: [10, 91] });
  expect(await backgroundHeadroomOk(NOW)).toBe(false);
});

test("personal accounts and sidelined accounts don't count", async () => {
  write(
    [{ id: "a", owner: "Ada" }, { id: "b" }],
    { a: [0, 0], b: [0, 0] },
    { b: NOW + 60_000 },
  );
  expect(await backgroundHeadroomOk(NOW)).toBe(false);
});

test("a window that reset since the poll counts as room", async () => {
  write([{ id: "a" }], { a: [99, 50] });
  expect(await backgroundHeadroomOk(Date.parse(LATER) + 1)).toBe(true);
});
