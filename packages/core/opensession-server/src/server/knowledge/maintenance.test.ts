import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { KNOWLEDGE_REVALIDATE_MS } from "../../shared/knowledge";
import type { RevalidateResult } from "./freshness/revalidate";
import {
  __setKnowledgeMaintenanceDepsForTest,
  KNOWLEDGE_DAILY_STEPS,
  KNOWLEDGE_NUDGE_MS,
  nudgeKnowledge,
  requestRevalidation,
  runKnowledgeTick,
  startKnowledgeMaintenance,
  type KnowledgeMaintenanceDeps,
} from "./maintenance";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00Z");

function result(over: Partial<RevalidateResult> = {}): RevalidateResult {
  return {
    checked: 0,
    flipped: [],
    refreshed: 0,
    conflicts: [],
    errors: [],
    ...over,
  };
}

let marks: Map<string, unknown>;
let runs: Array<{ project: string; scope: string }>;
let fetches: string[];
let withRepo: Set<string>;
let enabled: boolean;
let revalidate: KnowledgeMaintenanceDeps["revalidateProject"];

function install(over: Partial<KnowledgeMaintenanceDeps> = {}) {
  __setKnowledgeMaintenanceDepsForTest({
    enabled: () => enabled,
    projects: () => ["acme", "globex", "initech"],
    hasRepo: async (project) => withRepo.has(project),
    revalidateProject: (project, opts) => revalidate(project, opts),
    fetchDefaultBranch: async (project) => {
      fetches.push(project);
      return true;
    },
    marks: {
      load: async (key) => marks.get(key) ?? null,
      save: async (key, value) => void marks.set(key, value),
    },
    now: () => NOW,
    steps: KNOWLEDGE_DAILY_STEPS.filter((s) => s.name === "revalidate"),
    ...over,
  });
}

beforeEach(() => {
  marks = new Map();
  runs = [];
  fetches = [];
  withRepo = new Set(["acme", "globex"]);
  enabled = true;
  revalidate = async (project, opts) => {
    runs.push({ project, scope: opts?.scope ?? "all" });
    return result();
  };
  install();
});

afterEach(() => {
  __setKnowledgeMaintenanceDepsForTest(null);
  jest.useRealTimers();
});

function checkedAgo(project: string, ms: number) {
  marks.set(`revalidate:${project}`, {
    at: new Date(NOW - ms).toISOString(),
  });
}

describe("runKnowledgeTick", () => {
  test("re-validates a project last checked a day ago, not one checked recently", async () => {
    checkedAgo("acme", 25 * HOUR);
    checkedAgo("globex", 2 * HOUR);
    await runKnowledgeTick(NOW);
    expect(runs).toEqual([{ project: "acme", scope: "all" }]);
    expect(marks.get("revalidate:acme")).toEqual({
      at: new Date(NOW).toISOString(),
    });
    // The next hour nothing is due.
    await runKnowledgeTick(NOW + HOUR);
    expect(runs).toHaveLength(1);
  });

  test("a project never checked is due; one without a knowledge repository is skipped", async () => {
    withRepo.add("initech");
    withRepo.delete("globex");
    await runKnowledgeTick(NOW);
    expect(runs.map((r) => r.project)).toEqual(["acme", "initech"]);
  });

  test("a run that throws is retried on the next tick", async () => {
    let fail = true;
    revalidate = async (project) => {
      runs.push({ project, scope: "all" });
      if (fail) throw new Error("Knowledge worker unavailable");
      return result();
    };
    checkedAgo("globex", 2 * HOUR);
    await runKnowledgeTick(NOW);
    expect(marks.has("revalidate:acme")).toBe(false);
    fail = false;
    await runKnowledgeTick(NOW + HOUR);
    expect(runs.map((r) => r.project)).toEqual(["acme", "acme"]);
    expect(marks.has("revalidate:acme")).toBe(true);
  });

  test("an unreadable mark counts as due (can't tell is never fresh)", async () => {
    checkedAgo("globex", 2 * HOUR);
    install({
      marks: {
        load: async (key) => {
          if (key === "revalidate:globex") throw new Error("catalog down");
          return marks.get(key) ?? null;
        },
        save: async (key, value) => void marks.set(key, value),
      },
    });
    await runKnowledgeTick(NOW);
    expect(runs.map((r) => r.project)).toEqual(["acme", "globex"]);
  });

  test("a step with its own cadence runs on that cadence", async () => {
    const seen: string[] = [];
    install({
      steps: [
        {
          name: "weekly",
          everyMs: 7 * 24 * HOUR,
          run: async (project) => void seen.push(project),
        },
      ],
    });
    marks.set("weekly:acme", {
      at: new Date(NOW - 2 * 24 * HOUR).toISOString(),
    });
    await runKnowledgeTick(NOW);
    expect(seen).toEqual(["globex"]);
  });

  test("a global step runs once per tick, also with no repository", async () => {
    let calls = 0;
    withRepo = new Set();
    install({
      steps: [
        {
          name: "captures",
          everyMs: HOUR,
          global: true,
          run: async () => void calls++,
        },
      ],
    });
    await runKnowledgeTick(NOW);
    expect(calls).toBe(1);
    expect(marks.has("captures")).toBe(true);
    await runKnowledgeTick(NOW + 10 * 60_000);
    expect(calls).toBe(1);
    await runKnowledgeTick(NOW + HOUR);
    expect(calls).toBe(2);
  });

  test("the captures step is global", () => {
    expect(
      KNOWLEDGE_DAILY_STEPS.find((s) => s.name === "captures")?.global,
    ).toBe(true);
  });

  test("nothing runs while email support is off", async () => {
    enabled = false;
    await runKnowledgeTick(NOW);
    expect(runs).toEqual([]);
  });

  test("the revalidate step is first and due daily", () => {
    expect(KNOWLEDGE_DAILY_STEPS[0]?.name).toBe("revalidate");
    expect(KNOWLEDGE_DAILY_STEPS[0]?.everyMs ?? KNOWLEDGE_REVALIDATE_MS).toBe(
      KNOWLEDGE_REVALIDATE_MS,
    );
  });
});

describe("requestRevalidation", () => {
  test("runs a full check and returns the result", async () => {
    revalidate = async (project, opts) => {
      runs.push({ project, scope: opts?.scope ?? "all" });
      return result({ checked: 3 });
    };
    expect((await requestRevalidation("acme")).checked).toBe(3);
    expect(runs).toEqual([{ project: "acme", scope: "all" }]);
  });

  test("one run at a time per project; a request while one waits joins it", async () => {
    let active = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    revalidate = async (project, opts) => {
      active++;
      most = Math.max(most, active);
      runs.push({ project, scope: opts?.scope ?? "all" });
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return result({ checked: runs.length });
    };
    const first = requestRevalidation("acme");
    // Started: a later request waits for it rather than joining it.
    await Bun.sleep(1);
    const second = requestRevalidation("acme");
    const third = requestRevalidation("acme");
    const other = requestRevalidation("globex");
    await Bun.sleep(1);
    // acme's first run and globex's run; acme's second waits.
    expect(runs.map((r) => r.project).sort()).toEqual(["acme", "globex"]);
    for (const open of gates.splice(0)) open();
    await Promise.all([first, other]);
    await Bun.sleep(1);
    expect(runs.filter((r) => r.project === "acme")).toHaveLength(2);
    for (const open of gates.splice(0)) open();
    const [a, b] = await Promise.all([second, third]);
    expect(a).toBe(b);
    expect(most).toBe(2);
    expect(runs.filter((r) => r.project === "acme")).toHaveLength(2);
  });

  test("the tick's full run and a person's request never overlap for one project", async () => {
    let active = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    revalidate = async (project, opts) => {
      active++;
      most = Math.max(most, active);
      runs.push({ project, scope: opts?.scope ?? "all" });
      await new Promise<void>((resolve) => gates.push(resolve));
      active--;
      return result();
    };
    withRepo.delete("globex");
    const tick = runKnowledgeTick(NOW);
    await Bun.sleep(1);
    const asked = requestRevalidation("acme");
    await Bun.sleep(1);
    expect(runs).toHaveLength(1);
    for (const open of gates.splice(0)) open();
    await tick;
    await Bun.sleep(1);
    expect(runs).toHaveLength(2);
    for (const open of gates.splice(0)) open();
    await asked;
    expect(most).toBe(1);
  });

  test("refuses while email support is off", async () => {
    enabled = false;
    await expect(requestRevalidation("acme")).rejects.toThrow();
    expect(runs).toEqual([]);
  });
});

describe("nudgeKnowledge", () => {
  async function settle() {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  test("three nudges within a minute cause one repo-scoped run", async () => {
    jest.useFakeTimers();
    nudgeKnowledge("acme");
    jest.advanceTimersByTime(20_000);
    nudgeKnowledge("acme");
    jest.advanceTimersByTime(20_000);
    nudgeKnowledge("acme");
    await settle();
    expect(runs).toEqual([]);
    jest.advanceTimersByTime(KNOWLEDGE_NUDGE_MS);
    await settle();
    expect(fetches).toEqual(["acme"]);
    expect(runs).toEqual([{ project: "acme", scope: "repo" }]);
    // A later push nudges again.
    nudgeKnowledge("acme");
    jest.advanceTimersByTime(KNOWLEDGE_NUDGE_MS);
    await settle();
    expect(runs).toHaveLength(2);
  });

  test("the debounce is per project", async () => {
    jest.useFakeTimers();
    nudgeKnowledge("acme");
    nudgeKnowledge("globex");
    jest.advanceTimersByTime(KNOWLEDGE_NUDGE_MS);
    await settle();
    expect(runs.map((r) => r.project).sort()).toEqual(["acme", "globex"]);
  });

  test("a repo-scoped run doesn't count as the daily full run", async () => {
    jest.useFakeTimers();
    nudgeKnowledge("acme");
    jest.advanceTimersByTime(KNOWLEDGE_NUDGE_MS);
    await settle();
    expect(marks.has("revalidate:acme")).toBe(false);
  });

  test("no fetch for a project without knowledge, nothing while email support is off", async () => {
    jest.useFakeTimers();
    nudgeKnowledge("initech");
    enabled = false;
    nudgeKnowledge("acme");
    jest.advanceTimersByTime(KNOWLEDGE_NUDGE_MS);
    await settle();
    expect(fetches).toEqual([]);
    expect(runs).toEqual([]);
  });
});

describe("startKnowledgeMaintenance", () => {
  const timers = () =>
    (globalThis as { __osKnowledgeTimers?: unknown[] }).__osKnowledgeTimers ??
    [];

  test("marks imports interrupted by the restart as failed and arms the tick", async () => {
    let failed = 0;
    install({ failInterruptedJobs: async () => void failed++ });
    startKnowledgeMaintenance();
    await Bun.sleep(1);
    expect(failed).toBe(1);
    expect(timers()).toHaveLength(2);
    // A restart replaces the timers instead of adding more.
    startKnowledgeMaintenance();
    await Bun.sleep(1);
    expect(timers()).toHaveLength(2);
    enabled = false;
    startKnowledgeMaintenance();
    expect(timers()).toHaveLength(0);
  });

  test("does nothing while email support is off", async () => {
    let failed = 0;
    enabled = false;
    install({ failInterruptedJobs: async () => void failed++ });
    startKnowledgeMaintenance();
    await Bun.sleep(1);
    expect(failed).toBe(0);
    expect(timers()).toHaveLength(0);
  });
});
