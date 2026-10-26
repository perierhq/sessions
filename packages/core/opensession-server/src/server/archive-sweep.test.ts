import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { runArchiveSweep, type ArchiveSweepDeps } from "./archive-sweep";
import {
  failingHousekeepingJobs,
  HOUSEKEEPING_FAILING_AFTER,
  housekeepingHealth,
  resetHousekeepingHealthForTest,
} from "./housekeeping-health";
import type { UnifiedSession } from "./types";

const NOW = Date.parse("2026-03-01T00:00:00Z");
const DAY = 86_400_000;

function session(
  id: string,
  over: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    archived: true,
    isRunning: false,
    lastActivity: new Date(NOW - 30 * DAY).toISOString(),
    branch: `acme-${id}`,
    worktreeDir: `/tmp/acme/${id}`,
    ...over,
  } as UnifiedSession;
}

function deps(over: Partial<ArchiveSweepDeps> = {}) {
  const destroyed: string[] = [];
  const swept: UnifiedSession[][] = [];
  let invalidated = 0;
  const d: ArchiveSweepDeps = {
    sessions: async () => [],
    sweepWorktrees: async (sessions) => {
      swept.push(sessions);
      return [];
    },
    destroySandbox: (s) => {
      destroyed.push(s.id);
    },
    invalidate: () => {
      invalidated++;
    },
    now: () => NOW,
    ...over,
  };
  return { d, destroyed, swept, invalidated: () => invalidated };
}

afterEach(() => resetHousekeepingHealthForTest());

describe("archive sweep", () => {
  test("sweeps worktrees and retires Sandboxes of long-archived sessions", async () => {
    const old = session("a", {
      sandbox: { provider: "podman", sandboxId: "sbx-a" },
    } as Partial<UnifiedSession>);
    const recent = session("b", {
      lastActivity: new Date(NOW - 2 * DAY).toISOString(),
      sandbox: { provider: "podman", sandboxId: "sbx-b" },
    } as Partial<UnifiedSession>);
    const open = session("c", {
      archived: false,
      sandbox: { provider: "podman", sandboxId: "sbx-c" },
    } as Partial<UnifiedSession>);
    const running = session("d", {
      isRunning: true,
      sandbox: { provider: "podman", sandboxId: "sbx-d" },
    } as Partial<UnifiedSession>);
    const t = deps({
      sessions: async () => [old, recent, open, running],
      sweepWorktrees: async () => ["acme-a"],
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await runArchiveSweep(t.d);
      expect(result).toEqual({ worktrees: ["acme-a"], sandboxes: ["a"] });
    } finally {
      log.mockRestore();
    }
    expect(t.destroyed).toEqual(["a"]);
    expect(t.invalidated()).toBe(1);
    const health = housekeepingHealth();
    expect(health["worktree-sweep"]?.consecutiveFailures).toBe(0);
    expect(health["sandbox-sweep"]?.lastOkAt).toBeTruthy();
  });

  test("a failed session listing fails both sweeps, never reads as nothing archived", async () => {
    const t = deps({
      sessions: async () => {
        throw new Error("Session list unavailable: catalogs unreachable");
      },
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await runArchiveSweep(t.d);
      expect(result).toEqual({ worktrees: [], sandboxes: [] });
    } finally {
      error.mockRestore();
    }
    expect(t.swept).toEqual([]);
    const health = housekeepingHealth();
    expect(health["worktree-sweep"]?.lastError).toContain(
      "Session list unavailable",
    );
    expect(health["sandbox-sweep"]?.consecutiveFailures).toBe(1);
  });

  test("repeated failures raise one alert and show as failing until a run works", async () => {
    let fail = true;
    const t = deps({
      sessions: async () => {
        if (fail) throw new Error("boom");
        return [];
      },
    });
    const lines: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    const log = spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      for (let i = 0; i < HOUSEKEEPING_FAILING_AFTER + 1; i++)
        await runArchiveSweep(t.d);
      expect(failingHousekeepingJobs()).toEqual([
        "sandbox-sweep",
        "worktree-sweep",
      ]);
      expect(
        lines.filter((l) => l.includes("[housekeeping] ALERT: worktree-sweep"))
          .length,
      ).toBe(1);
      fail = false;
      await runArchiveSweep(t.d);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(failingHousekeepingJobs()).toEqual([]);
    expect(
      lines.some((l) => l.includes("[housekeeping] worktree-sweep recovered")),
    ).toBe(true);
  });

  test("the gateway starts the sweep instead of scanning session files", () => {
    const boot = readFileSync(
      join(import.meta.dir, "../../opensession.ts"),
      "utf8",
    );
    expect(boot).toContain("startArchiveSweep()");
    expect(boot).not.toContain("getAllSessions(");
  });
});
