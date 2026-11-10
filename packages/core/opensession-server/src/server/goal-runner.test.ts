/**
 * The goal runner and ticker against a real catalog, with the engine run
 * replaced by a scripted event stream. What is pinned here is the merge: the
 * runner's bookkeeping lands on the CURRENT goal record, so a pause, a
 * reschedule or a finish written while a wake runs is never overwritten.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "./config";
import type { Goal } from "./goals";
import type { StreamEvent } from "./run-events";

const root = mkdtempSync(join(tmpdir(), "goal-runner-test-"));
const previousRoot = process.env.OPENSESSION_STATE_DIR;
const previousConfig = process.env.OPENSESSION_CONFIG;
process.env.OPENSESSION_STATE_DIR = root;
// An ask goal runs in the default repo's checkout; register one.
const config = join(root, "config.json");
writeFileSync(
  config,
  JSON.stringify({
    repos: {
      app: { repo: join(root, "app"), ghRepo: "acme/app", default: true },
    },
  }),
);
process.env.OPENSESSION_CONFIG = config;
await getConfigAsync();

/** What the fake engine does for one wake. Set per test. */
let script: (opts: { prompt: string }) => AsyncGenerator<StreamEvent> =
  async function* () {};
let runs = 0;
/** What the last wake handed the engine. */
let lastRun: { prompt: string; inProcessMcp?: Record<string, unknown> } | null =
  null;
const realAgentRunner = await import("./agent-runner");
mock.module("./agent-runner", () => ({
  ...realAgentRunner,
  runAgent: (opts: {
    prompt: string;
    inProcessMcp?: Record<string, unknown>;
  }) => {
    runs++;
    lastRun = opts;
    return script(opts);
  },
  isAgentSessionBusy: () => false,
}));
// The session file and live transcript watchers are not under test.
const realSessionCache = await import("./session-cache");
mock.module("./session-cache", () => ({
  ...realSessionCache,
  updateSessionFile: async () => {},
}));
const realRunSession = await import("./run-session");
mock.module("./run-session", () => ({
  ...realRunSession,
  attachSessionWatchersToEngineTranscript: () => {},
}));
// Listing can be held open to overlap two ticks.
let listGate: Promise<void> | null = null;
let lists = 0;
const realGoals = await import("./goals");
// Captured first: mock.module rebinds the live namespace's exports too.
const listStoredGoals = realGoals.listGoals;
mock.module("./goals", () => ({
  ...realGoals,
  listGoals: async () => {
    lists++;
    if (listGate) await listGate;
    return listStoredGoals();
  },
}));

const { registerGoalWakeCheck, runGoal, runningGoals, tickGoals } =
  await import("./goal-runner");
const { createGoal, getGoal, mutateGoal, updateGoal } = realGoals;
const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousRoot;
  if (previousConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previousConfig;
  await getConfigAsync();
  rmSync(root, { recursive: true, force: true });
});

let store: InstanceType<typeof SessionKernelStore>;
let previousStore: InstanceType<typeof SessionKernelStore> | undefined;
beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  script = async function* () {};
  runs = 0;
  lastRun = null;
  lists = 0;
  listGate = null;
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

const DAY = 24 * 60 * 60 * 1000;
const PAST = "2020-01-01T00:00:00.000Z";

async function dueGoal(
  input: Partial<Parameters<typeof createGoal>[0]> = {},
): Promise<Goal> {
  const result = await createGoal({
    name: "Flake burndown",
    mission: "Fix the flakiest test each wake.",
    createdBy: "Ada",
    firstWakeAt: PAST,
    ...input,
  });
  if ("error" in result) throw new Error(result.error);
  return result;
}

/** Wait for a wake the ticker fired without awaiting. */
async function settled(id: string): Promise<void> {
  for (let i = 0; i < 200 && runningGoals.has(id); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(runningGoals.has(id)).toBe(false);
}

describe("goal ticker", () => {
  test("pauses a due goal at its wake cap instead of waking it", async () => {
    const goal = await dueGoal({ maxWakes: 2 });
    await mutateGoal(goal.id, (current) => ({ ...current, wakeCount: 2 }));
    await tickGoals();
    expect(runs).toBe(0);
    expect(await getGoal(goal.id)).toMatchObject({
      status: "paused",
      pauseReason: "Hit safety cap of 2 wakes — resume to continue.",
      wakeCount: 2,
    });
  });

  test("wakes a due goal and skips one not yet due or not active", async () => {
    const due = await dueGoal();
    await dueGoal({ name: "Later", firstWakeAt: "2099-01-01T00:00:00Z" });
    const paused = await dueGoal({ name: "Held" });
    await updateGoal(paused.id, { status: "paused" });
    await tickGoals();
    await settled(due.id);
    expect(runs).toBe(1);
    expect((await getGoal(due.id))?.wakeCount).toBe(1);
  });

  test("a tick that overlaps a running one does nothing", async () => {
    let release!: () => void;
    listGate = new Promise((resolve) => (release = resolve));
    const first = tickGoals();
    await tickGoals();
    expect(lists).toBe(1);
    release();
    await first;
    listGate = null;
    await tickGoals();
    expect(lists).toBe(2);
  });

  test("one goal failing its tick does not hold back the others", async () => {
    const broken = await dueGoal({ name: "Broken", maxWakes: 1 });
    const healthy = await dueGoal({ name: "Healthy" });
    await mutateGoal(broken.id, (current) => ({ ...current, wakeCount: 1 }));
    // Pausing the capped goal fails; the next goal still wakes.
    const put = store.putCatalogDocument.bind(store);
    store.putCatalogDocument = (input) => {
      if (input.key === broken.id) throw new Error("catalog down");
      return put(input);
    };
    await tickGoals();
    store.putCatalogDocument = put;
    await settled(healthy.id);
    expect(runs).toBe(1);
    expect((await getGoal(broken.id))?.status).toBe("active");
    expect((await getGoal(healthy.id))?.wakeCount).toBe(1);
  });
});

describe("goal wake", () => {
  test("records the run and defaults the next wake to a day later", async () => {
    const goal = await dueGoal();
    script = async function* () {
      yield { type: "init", sessionId: "engine-1" } as StreamEvent;
      yield { type: "done", sessionId: "engine-1" } as StreamEvent;
    };
    await runGoal(goal);
    const after = await getGoal(goal.id);
    expect(after).toMatchObject({
      status: "active",
      wakeCount: 1,
      engineSessionId: "engine-1",
      lastRunStatus: "ok",
    });
    expect(after?.osSessionId).toBeString();
    expect(Date.parse(after!.nextWakeAt)).toBe(
      Date.parse(after!.lastRunAt!) + DAY,
    );
  });

  test("keeps a pause written while the wake ran", async () => {
    const goal = await dueGoal();
    script = async function* () {
      yield { type: "init", sessionId: "engine-1" } as StreamEvent;
      // What opensession-goal-self mark_paused does mid-run.
      await mutateGoal(goal.id, (current) => ({
        ...current,
        status: "paused",
        pauseReason: "Needs Bea's sign-off",
      }));
      yield { type: "done", sessionId: "engine-1" } as StreamEvent;
    };
    await runGoal(goal);
    expect(await getGoal(goal.id)).toMatchObject({
      status: "paused",
      pauseReason: "Needs Bea's sign-off",
      // Paused, so no default wake is scheduled over it.
      nextWakeAt: PAST,
      wakeCount: 1,
      lastRunStatus: "ok",
    });
  });

  test("keeps a next wake the run chose for itself", async () => {
    const goal = await dueGoal();
    script = async function* () {
      await mutateGoal(goal.id, (current) => ({
        ...current,
        nextWakeAt: "2031-05-01T09:00:00.000Z",
      }));
      yield { type: "done", sessionId: "engine-1" } as StreamEvent;
    };
    await runGoal(goal);
    expect((await getGoal(goal.id))?.nextWakeAt).toBe(
      "2031-05-01T09:00:00.000Z",
    );
  });

  test("records an engine error and still schedules the next wake", async () => {
    const goal = await dueGoal();
    script = async function* () {
      yield { type: "error", content: "rate limited" } as StreamEvent;
    };
    await runGoal(goal);
    const after = await getGoal(goal.id);
    expect(after).toMatchObject({
      lastRunStatus: "error",
      lastRunError: "rate limited",
      wakeCount: 1,
    });
    expect(Date.parse(after!.nextWakeAt)).toBe(
      Date.parse(after!.lastRunAt!) + DAY,
    );
  });

  test("backs off a day when the wake itself fails", async () => {
    const goal = await dueGoal();
    script = async function* () {
      await mutateGoal(goal.id, (current) => ({ ...current, phase: "week 2" }));
      throw new Error("engine crashed");
    };
    await runGoal(goal);
    const after = await getGoal(goal.id);
    expect(after).toMatchObject({
      status: "active",
      lastRunStatus: "error",
      lastRunError: "engine crashed",
      // Written mid-run, kept by the failure path's merge.
      phase: "week 2",
      wakeCount: 0,
    });
    expect(Date.parse(after!.nextWakeAt)).toBe(
      Date.parse(after!.lastRunAt!) + DAY,
    );
    expect(runningGoals.has(goal.id)).toBe(false);
  });

  test("a deleted goal is not recreated by its wake", async () => {
    const goal = await dueGoal();
    await realGoals.deleteGoal(goal.id);
    await runGoal(goal);
    expect(runs).toBe(0);
    expect(await getGoal(goal.id)).toBeNull();
  });
});

describe("goal wake checks, leads and spend", () => {
  test("a wake check pauses the goal before it runs", async () => {
    const goal = await dueGoal();
    const other = await dueGoal({ name: "Other" });
    const off = registerGoalWakeCheck(async (g) =>
      g.id === goal.id ? "Over budget" : null,
    );
    try {
      await runGoal(goal);
      expect(runs).toBe(0);
      expect(await getGoal(goal.id)).toMatchObject({
        status: "paused",
        pauseReason: "Over budget",
        wakeCount: 0,
      });
      await runGoal(other);
      expect(runs).toBe(1);
    } finally {
      off();
    }
  });

  test("a wake check that throws lets the wake go ahead", async () => {
    const goal = await dueGoal();
    const off = registerGoalWakeCheck(async () => {
      throw new Error("settings unreadable");
    });
    try {
      await runGoal(goal);
      expect(runs).toBe(1);
    } finally {
      off();
    }
  });

  test("a lead's goal gets the lead tools and no ask_human", async () => {
    const lead = await createGoal(
      { name: "Lead: app", mission: "Lead app.", createdBy: "Project lead" },
      { leadProject: "app" },
    );
    if ("error" in lead) throw new Error(lead.error);
    expect(lead.leadProject).toBe("app");
    await runGoal(lead);
    expect(Object.keys(lastRun!.inProcessMcp!).sort()).toEqual([
      "opensession-goal-self",
      "opensession-lead",
      "opensession-web",
    ]);
    expect(lastRun!.prompt).toContain("only through opensession-lead");
    expect(lastRun!.prompt).not.toContain("ask_human");

    const plain = await dueGoal();
    await runGoal(plain);
    expect(Object.keys(lastRun!.inProcessMcp!).sort()).toEqual([
      "opensession-goal-self",
      "opensession-humans",
      "opensession-web",
    ]);
  });

  test("the lead project can't be set through a patch or the API body", async () => {
    const goal = await dueGoal({
      ...({ leadProject: "app" } as object),
    });
    expect(goal.leadProject).toBeUndefined();
    const patched = await updateGoal(goal.id, {
      ...({ leadProject: "app" } as object),
    });
    expect("error" in patched ? patched : patched.leadProject).toBeUndefined();
  });

  test("each run's cost adds to the goal's spend this month", async () => {
    const goal = await dueGoal();
    script = async function* () {
      yield { type: "init", sessionId: "engine-1" } as StreamEvent;
      yield {
        type: "done",
        sessionId: "engine-1",
        usage: {
          costUsd: 0.75,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 1,
        },
      } as StreamEvent;
    };
    const month = new Date().toISOString().slice(0, 7);
    await runGoal(goal);
    expect((await getGoal(goal.id))?.spend).toEqual({ month, usd: 0.75 });
    await runGoal((await getGoal(goal.id))!);
    expect((await getGoal(goal.id))?.spend).toEqual({ month, usd: 1.5 });
    // Last month's spend doesn't count towards this one.
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2020-01", usd: 99 },
    }));
    await runGoal((await getGoal(goal.id))!);
    expect((await getGoal(goal.id))?.spend).toEqual({ month, usd: 0.75 });
  });
});
