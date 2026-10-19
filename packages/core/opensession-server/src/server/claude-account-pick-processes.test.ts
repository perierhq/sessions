/**
 * The Claude pool pick across processes. A hosted turn binds its account in
 * a run-host process of its own, so every turn here runs in a fresh bun
 * process (testing/claude-pick-process.ts) with empty module state. This
 * test process plays the gateway: it owns the store and publishes usage
 * snapshots the way the usage poller does.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as accounts from "./claude-accounts";

const fixture = join(import.meta.dir, "testing/claude-pick-process.ts");
const dir = mkdtempSync(join(tmpdir(), "claude-pick-processes-"));
const accountsFile = join(dir, "accounts.json");
const savedStore = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;

beforeAll(() => {
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = accountsFile;
});

afterAll(() => {
  if (savedStore === undefined)
    delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = savedStore;
  rmSync(dir, { recursive: true, force: true });
});

function seed(entries: Array<{ id: string; owner?: string; pct: number }>) {
  writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: entries.map(({ id, owner }) => ({
        id,
        name: id,
        token: `sk-ant-oat01-${id}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        ...(owner ? { owner } : {}),
      })),
    }),
  );
  accounts.__resetSharedPickStateForTest();
  for (const { id, pct } of entries) publishUsage(id, pct);
}

/** What the gateway's usage poll writes for an account. */
function publishUsage(id: string, pct: number) {
  accounts.__setUsageCacheForTest(id, {
    fetchedAt: new Date().toISOString(),
    fiveHour: { utilization: pct, resetsAt: null },
    sevenDay: null,
    extraUsage: null,
  });
}

/** One turn's binding in a fresh process. */
async function turn(
  sessionKey: string,
  user = "",
): Promise<{ id?: string; reason?: string }> {
  const proc = Bun.spawn([process.execPath, fixture, user, sessionKey], {
    env: {
      ...process.env,
      OPENSESSION_CLAUDE_ACCOUNTS_PATH: accountsFile,
      OPENSESSION_MODEL_PROVIDERS_CONFIG: join(dir, "model-providers.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`pick process exited ${code}: ${stderr}`);
  const line = stdout.trim().split("\n").at(-1) || "{}";
  expect(line).not.toContain("sk-ant-");
  return JSON.parse(line);
}

describe("Claude pool pick in separate processes", () => {
  test("a session's next turn stays on the account that served it", async () => {
    seed([
      { id: "pool-a", pct: 5 },
      { id: "pool-b", pct: 5 },
      { id: "pool-c", pct: 5 },
    ]);
    const first = await turn("session-1");
    expect(first.reason).toBe("pool");
    // Other sessions take their turns in between.
    await turn("session-2");
    await turn("session-3");
    const second = await turn("session-1");
    expect(second).toEqual({ id: first.id, reason: "sticky" });
  }, 30_000);

  test("sessions picked back to back rotate through the least-used bucket", async () => {
    // The first account in the store is busier than the rest: a process that
    // cannot see the gateway's usage would take it every time.
    seed([
      { id: "busy", pct: 55 },
      { id: "pool-a", pct: 5 },
      { id: "pool-b", pct: 9 },
      { id: "pool-c", pct: 8 },
    ]);
    const picks = [
      await turn("session-1"),
      await turn("session-2"),
      await turn("session-3"),
    ];
    expect(picks.map((p) => p.reason)).toEqual(["pool", "pool", "pool"]);
    expect(new Set(picks.map((p) => p.id))).toEqual(
      new Set(["pool-a", "pool-b", "pool-c"]),
    );
  }, 30_000);

  test("processes picking at the same moment take different accounts", async () => {
    seed([
      { id: "pool-a", pct: 5 },
      { id: "pool-b", pct: 5 },
      { id: "pool-c", pct: 5 },
    ]);
    const picks = await Promise.all(
      ["session-1", "session-2", "session-3"].map((key) => turn(key)),
    );
    expect(new Set(picks.map((p) => p.id))).toEqual(
      new Set(["pool-a", "pool-b", "pool-c"]),
    );
  }, 30_000);

  test("a run without a session key is never remembered", async () => {
    seed([
      { id: "pool-a", pct: 5 },
      { id: "pool-b", pct: 5 },
    ]);
    const first = await turn("");
    const second = await turn("");
    expect([first.reason, second.reason]).toEqual(["pool", "pool"]);
    expect(second.id).not.toBe(first.id);
  }, 30_000);

  test("stickiness never keeps a user off their own subscription", async () => {
    seed([
      { id: "pool-a", pct: 5 },
      { id: "ada-own", owner: "ada", pct: 99 },
    ]);
    const first = await turn("ada-session", "ada");
    expect(first).toEqual({ id: "pool-a", reason: "pool" });
    // The personal subscription resets; the gateway's next poll sees it.
    publishUsage("ada-own", 10);
    const second = await turn("ada-session", "ada");
    expect(second).toEqual({ id: "ada-own", reason: "personal" });
    // And the session stays there from now on.
    const third = await turn("ada-session", "ada");
    expect(third).toEqual({ id: "ada-own", reason: "sticky" });
  }, 30_000);

  test("another user's remembered session is not inherited", async () => {
    seed([
      { id: "pool-a", pct: 5 },
      { id: "pool-b", pct: 5 },
    ]);
    const ada = await turn("shared-key", "ada");
    const bo = await turn("shared-key", "bo");
    expect(ada.reason).toBe("pool");
    expect(bo.reason).toBe("pool");
    expect(bo.id).not.toBe(ada.id);
  }, 30_000);
});
