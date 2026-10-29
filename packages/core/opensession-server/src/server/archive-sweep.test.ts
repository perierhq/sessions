import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  archiveRetentionDays,
  runArchiveSweep,
  startArchiveSweep,
  type ArchiveSweepDeps,
} from "./archive-sweep";
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
    bankWork: async () => ({ retire: true, why: "clean" }),
    invalidate: () => {
      invalidated++;
    },
    now: () => NOW,
    ...over,
  };
  return { d, destroyed, swept, invalidated: () => invalidated };
}

afterEach(() => {
  resetHousekeepingHealthForTest();
  delete process.env.OPENSESSION_ARCHIVE_RETENTION_DAYS;
});

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

  test("retires a Sandbox once its session has been archived for the retention window", async () => {
    const box = (id: string) =>
      ({
        sandbox: { provider: "podman", sandboxId: `sbx-${id}` },
      }) as Partial<UnifiedSession>;
    // Archived 8 days ago: past the default 7.
    const expired = session("expired", box("expired"));
    // Idle for a month, but archived only yesterday: the window runs from
    // the archive, so it stays.
    const justArchived = session("fresh", box("fresh"));
    // Unarchived again: an open session keeps its Sandbox however old.
    const unarchived = session("back", { ...box("back"), archived: false });
    const archivedAt = new Map([
      ["expired", NOW - 8 * DAY],
      ["fresh", NOW - 1 * DAY],
    ]);
    const t = deps({
      sessions: async () => [expired, justArchived, unarchived],
      archivedAt: (s) => archivedAt.get(s.id) ?? null,
      sandboxBytes: (s) => (s.id === "expired" ? 1_300_000_000 : null),
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await runArchiveSweep(t.d)).sandboxes).toEqual(["expired"]);
      expect(t.destroyed).toEqual(["expired"]);

      // A shorter window (env, like the other housekeeping knobs) takes the
      // session archived yesterday too.
      process.env.OPENSESSION_ARCHIVE_RETENTION_DAYS = "0.5";
      expect(archiveRetentionDays()).toBe(0.5);
      expect((await runArchiveSweep(t.d)).sandboxes).toEqual([
        "expired",
        "fresh",
      ]);
    } finally {
      log.mockRestore();
    }
    const health = housekeepingHealth()["sandbox-sweep"];
    expect(health?.lastReclaimed).toEqual({ count: 2, bytes: 1_300_000_000 });
    expect(health?.reclaimedSinceBoot).toEqual({
      count: 3,
      bytes: 2_600_000_000,
    });
  });

  test("an archived session with no archive time falls back to its last activity", async () => {
    const old = session("old", {
      sandbox: { provider: "podman", sandboxId: "sbx-old" },
    } as Partial<UnifiedSession>);
    const recent = session("recent", {
      lastActivity: new Date(NOW - 3 * DAY).toISOString(),
      sandbox: { provider: "podman", sandboxId: "sbx-recent" },
    } as Partial<UnifiedSession>);
    const t = deps({
      sessions: async () => [old, recent],
      archivedAt: () => null,
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await runArchiveSweep(t.d)).sandboxes).toEqual(["old"]);
    } finally {
      log.mockRestore();
    }
  });

  test("an automation session's Sandbox goes once it has been idle for the window, archived or not", async () => {
    // Incident agents and other automation runs are never archived by a
    // person, so their sleeping pods and volumes would stay forever.
    const idleWorker = session("worker", {
      archived: false,
      automation: "Incidents · acme",
      lastActivity: new Date(NOW - 8 * DAY).toISOString(),
      sandbox: { provider: "podman", sandboxId: "sbx-worker" },
    } as Partial<UnifiedSession>);
    const busyWorker = session("busy", {
      archived: false,
      automation: "Incidents · acme",
      lastActivity: new Date(NOW - 2 * DAY).toISOString(),
      sandbox: { provider: "podman", sandboxId: "sbx-busy" },
    } as Partial<UnifiedSession>);
    const runningWorker = session("running", {
      archived: false,
      isRunning: true,
      automation: "Incidents · acme",
      sandbox: { provider: "podman", sandboxId: "sbx-running" },
    } as Partial<UnifiedSession>);
    const t = deps({
      sessions: async () => [idleWorker, busyWorker, runningWorker],
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await runArchiveSweep(t.d)).sandboxes).toEqual(["worker"]);
    } finally {
      log.mockRestore();
    }
  });

  test("a Sandbox whose working copy holds work it could not bank is kept and reported, archived or automation", async () => {
    // Every remote Sandbox, Podman included, holds the session's working
    // copy in its own volume: destroying it with uncommitted changes or
    // unpushed commits that no checkpoint holds would lose them.
    const box = (id: string, over: Partial<UnifiedSession> = {}) =>
      session(id, {
        sandbox: { provider: "podman", sandboxId: `sbx-${id}` },
        ...over,
      } as Partial<UnifiedSession>);
    const banked = box("banked");
    const dirty = box("dirty");
    const worker = box("worker", {
      archived: false,
      automation: "Incidents · acme",
    } as Partial<UnifiedSession>);
    const asked: string[] = [];
    const t = deps({
      sessions: async () => [banked, dirty, worker],
      sandboxBytes: () => 1_000,
      bankWork: async (s) => {
        asked.push(s.id);
        return s.id === "banked"
          ? { retire: true, why: "banked" }
          : {
              retire: false,
              reason:
                "uncommitted changes; no checkpoint: no GitHub credential",
            };
      },
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await runArchiveSweep(t.d)).sandboxes).toEqual(["banked"]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    expect(asked).toEqual(["banked", "dirty", "worker"]);
    expect(t.destroyed).toEqual(["banked"]);
    const health = housekeepingHealth()["sandbox-sweep"];
    expect(health?.lastReclaimed).toEqual({ count: 1, bytes: 1_000 });
    expect(health?.lastKept).toEqual({
      count: 2,
      items: [
        {
          id: "dirty",
          reason: "uncommitted changes; no checkpoint: no GitHub credential",
        },
        {
          id: "worker",
          reason: "uncommitted changes; no checkpoint: no GitHub credential",
        },
      ],
    });
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

  test("a short interval never runs two passes at once: the interval starts with the first pass", () => {
    process.env.OPENSESSION_ARCHIVE_SWEEP_MINUTES = "2";
    const timeouts: number[] = [];
    const timer = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
      _fn: () => void,
      ms?: number,
    ) => {
      timeouts.push(ms ?? 0);
      return timer;
    }) as unknown as typeof setTimeout);
    const interval = spyOn(globalThis, "setInterval").mockImplementation(
      (() => timer) as unknown as typeof setInterval,
    );
    try {
      startArchiveSweep();
      expect(timeouts).toEqual([120_000]);
      expect(interval).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      interval.mockRestore();
      delete process.env.OPENSESSION_ARCHIVE_SWEEP_MINUTES;
    }
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
