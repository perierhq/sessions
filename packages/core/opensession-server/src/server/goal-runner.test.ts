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
import type {
  LeadGoalFields,
  LeadWakePlan,
  WatchWakePlan,
} from "./goal-runner";
import type { StreamEvent } from "./run-events";

const root = mkdtempSync(join(tmpdir(), "goal-runner-test-"));
const previousRoot = process.env.OPENSESSION_STATE_DIR;
const previousConfig = process.env.OPENSESSION_CONFIG;
process.env.OPENSESSION_STATE_DIR = root;
// An ask goal runs in the default repo's checkout; register one, and a
// second repo for a project lead.
const config = join(root, "config.json");
writeFileSync(
  config,
  JSON.stringify({
    repos: {
      app: { repo: join(root, "app"), ghRepo: "acme/app", default: true },
      shop: { repo: join(root, "shop"), ghRepo: "acme/shop" },
    },
  }),
);
process.env.OPENSESSION_CONFIG = config;
await getConfigAsync();

/** What the fake engine does for one wake. Set per test. */
let script: (opts: { prompt: string }) => AsyncGenerator<StreamEvent> =
  async function* () {};
let runs = 0;
interface RunOpts {
  prompt: string;
  cwd: string;
  inProcessMcp?: Record<string, unknown>;
  mcpServers: unknown;
  aws?: boolean;
  startToken?: string;
  disableLocalWorkspaceTools?: boolean;
  model?: string;
  effort?: string;
}
/** What the last wake handed the engine. */
let lastRun: RunOpts | null = null;
/** Steers and cancels sent to a run, by its token. */
let steers: Array<{ token: string; text: string }> = [];
let cancels: string[] = [];
/** Whether each cancel lands, in turn; true once the list runs out. */
let cancelResults: boolean[] = [];
const realAgentRunner = await import("./agent-runner");
mock.module("./agent-runner", () => ({
  ...realAgentRunner,
  runAgent: (opts: RunOpts) => {
    runs++;
    lastRun = opts;
    return script(opts);
  },
  isAgentSessionBusy: () => false,
  steerAgentRunToken: (token: string, text: string) => {
    steers.push({ token, text });
    return true;
  },
  cancelAgentRunToken: async (token: string) => {
    cancels.push(token);
    return cancelResults.shift() ?? true;
  },
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

const {
  INTERRUPTED_WAKE_ERROR,
  goalRecoveryMcpServers,
  goalRecoveryPlan,
  registerLeadGoalHooks,
  registerWatchGoalHooks,
  runGoal,
  runningGoals,
  settleInterruptedGoalRun,
  tickGoals,
  wakeTokens,
  __setBackgroundHeadroomForTest,
} = await import("./goal-runner");
const { createGoalSelfMcpServer } = await import("../agents/slack/goal-tools");
const { __setHeadroomSourcesForTest } = await import("./claude-headroom");
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
  steers = [];
  cancels = [];
  cancelResults = [];
  lists = 0;
  listGate = null;
});
afterEach(() => {
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

const DAY = 24 * 60 * 60 * 1000;
const LEAD_DAY = "2026-11-10";
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

describe("leads and spend", () => {
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

describe("a project lead's goal", () => {
  const fields: LeadGoalFields = {
    name: "Lead: Shop",
    mission: "Lead the shop, from its settings.",
    mode: "ask",
    repo: "shop",
    minWakeMinutes: 60,
    mcpServers: [],
  };
  let plan: LeadWakePlan;
  let idles: string[];
  let waits: string[];
  let offHooks: () => void = () => {};

  beforeEach(() => {
    plan = {
      fields,
      day: LEAD_DAY,
      wakeTokens: 1_000_000,
      budgetUsd: 2,
      web: false,
    };
    idles = [];
    waits = [];
    offHooks = registerLeadGoalHooks({
      wake: async () => plan,
      idle: async (goal) => {
        idles.push(goal.id);
      },
      waiting: async (goal) => {
        waits.push(goal.id);
      },
    });
  });
  afterEach(() => offHooks());

  async function leadGoal(extra: Partial<Goal> = {}): Promise<Goal> {
    const created = await createGoal(
      {
        name: "Lead: Shop",
        mission: "Lead the shop.",
        createdBy: "Project lead",
        firstWakeAt: PAST,
      },
      { leadProject: "shop" },
    );
    if ("error" in created) throw new Error(created.error);
    return (await mutateGoal(created.id, (g) => ({ ...g, ...extra })))!;
  }

  async function toolNames(server: unknown): Promise<string[]> {
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");
    const c = new Client({ name: "test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (
      server as { instance: { connect(t: unknown): Promise<void> } }
    ).instance.connect(b);
    await c.connect(a);
    return (await c.listTools()).tools.map((t) => t.name).sort();
  }

  test("runs with the lead's tools: no ask_human, no web while it watches, no way to end itself", async () => {
    const lead = await leadGoal();
    await runGoal(lead);
    expect(Object.keys(lastRun!.inProcessMcp!).sort()).toEqual([
      "opensession-goal-self",
      "opensession-lead",
    ]);
    expect(
      await toolNames(lastRun!.inProcessMcp!["opensession-goal-self"]),
    ).toEqual(["append_ledger", "set_next_wake", "update_phase"]);
    expect(lastRun!.prompt).toContain("only through opensession-lead");
    expect(lastRun!.prompt).not.toContain("ask_human");
    expect(lastRun!.prompt).not.toContain("mark_paused");
    expect(lastRun!.prompt).not.toContain("mark_done");
    expect(lastRun!.prompt).toContain("spend about $2");
    // Past watch it may read the web.
    plan = {
      fields,
      day: LEAD_DAY,
      wakeTokens: 1_000_000,
      budgetUsd: 2,
      web: true,
    };
    await runGoal((await getGoal(lead.id))!);
    expect(Object.keys(lastRun!.inProcessMcp!)).toContain("opensession-web");

    const plain = await dueGoal();
    await runGoal(plain);
    expect(Object.keys(lastRun!.inProcessMcp!).sort()).toEqual([
      "opensession-goal-self",
      "opensession-humans",
      "opensession-web",
    ]);
    expect(
      await toolNames(lastRun!.inProcessMcp!["opensession-goal-self"]),
    ).toContain("mark_done");
    expect(lastRun!.mcpServers).toBe("all");
    expect(lastRun!.aws).toBe(true);
  });

  test("runs on the settings' fields, in its project's checkout, with no connectors and no cloud credentials", async () => {
    // Whatever an older record or a patch left in it.
    const goal = await leadGoal({
      mission: "Do anything you like.",
      mcpServers: undefined,
      mode: "ask",
      repo: undefined,
      minWakeMinutes: 5,
    });
    await runGoal(goal);
    expect(lastRun!.prompt).toContain("Lead the shop, from its settings.");
    expect(lastRun!.prompt).not.toContain("Do anything you like.");
    expect(lastRun!.mcpServers).toEqual([]);
    expect(lastRun!.aws).toBe(false);
    expect(lastRun!.cwd).toBe(join(root, "shop"));
    expect(await getGoal(goal.id)).toMatchObject({
      mission: fields.mission,
      repo: "shop",
      minWakeMinutes: 60,
      mcpServers: [],
    });
  });

  test("a patch can't change what the settings decide", async () => {
    const goal = await leadGoal();
    for (const patch of [
      { mission: "Do anything." },
      { mode: "code" as const },
      { repo: "app" },
      { minWakeMinutes: 5 },
      { mcpServers: ["github"] },
    ]) {
      const result = await updateGoal(goal.id, patch);
      expect("error" in result ? result.error : "").toStartWith(
        "This goal is a project lead's: its ",
      );
    }
    // The same values, or other fields, are fine.
    const same = await updateGoal(goal.id, {
      mission: goal.mission,
      name: "Lead: Shop (renamed)",
      model: "claude-sonnet",
    });
    expect("error" in same ? same.error : same.name).toBe(
      "Lead: Shop (renamed)",
    );
  });

  test("fails closed: no lead on the server, or a lead check that throws, pauses it unrun", async () => {
    offHooks();
    const goal = await leadGoal();
    await runGoal(goal);
    expect(runs).toBe(0);
    expect(await getGoal(goal.id)).toMatchObject({
      status: "paused",
      pauseReason: "The project lead isn't running on this server",
    });

    offHooks = registerLeadGoalHooks({
      wake: async () => {
        throw new Error("settings unreadable");
      },
      idle: async () => {},
    });
    const other = await leadGoal();
    await runGoal(other);
    expect(runs).toBe(0);
    expect(await getGoal(other.id)).toMatchObject({
      status: "paused",
      pauseReason: "Its wake check failed: settings unreadable",
    });
  });

  test("a block from the lead pauses it with the reason", async () => {
    plan = { block: "Agents are paused for this project" };
    const goal = await leadGoal();
    await runGoal(goal);
    expect(runs).toBe(0);
    expect((await getGoal(goal.id))?.pauseReason).toBe(
      "Agents are paused for this project",
    );
  });

  test("at its budget it is asked to wrap up, and past half again stopped", async () => {
    const usage = (costUsd: number) => ({
      costUsd,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 1,
    });
    script = async function* () {
      yield { type: "init", sessionId: "engine-1" } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(1) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(2.1) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(2.5) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(3.2) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(3.4) } as StreamEvent;
      yield {
        type: "done",
        sessionId: "engine-1",
        usage: usage(3.4),
      } as StreamEvent;
    };
    const goal = await leadGoal();
    await runGoal(goal);
    const token = lastRun!.startToken!;
    expect(token).toBeTruthy();
    expect(steers).toHaveLength(1);
    expect(steers[0]!.token).toBe(token);
    expect(steers[0]!.text).toContain("You reached what this wake may spend.");
    expect(cancels).toEqual([token]);
    const month = new Date().toISOString().slice(0, 7);
    expect(await getGoal(goal.id)).toMatchObject({
      spend: { month, usd: 3.4 },
      lastRunError: "Stopped: it reached its limit",
    });
  });

  test("past its token limit it wraps up, stops, and trips the guard, even after a Resume", async () => {
    plan = {
      fields,
      day: LEAD_DAY,
      wakeTokens: 100_000,
      budgetUsd: null,
      web: false,
    };
    const usage = (inputTokens: number) => ({
      costUsd: 0,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 1,
    });
    script = async function* () {
      yield { type: "init", sessionId: "engine-1" } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(50_000) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(110_000) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(160_000) } as StreamEvent;
    };
    // The owner lifted the guard earlier today, after a first trip.
    const goal = await leadGoal({
      guard: { day: LEAD_DAY, wakes: 3, lifted: true, trips: 1 },
    });
    const before = Date.now();
    await runGoal(goal);
    expect(lastRun!.prompt).toContain("about 100,000 tokens");
    expect(lastRun!.prompt).not.toContain("spend about");
    expect(steers).toHaveLength(1);
    expect(cancels).toHaveLength(1);
    const after = (await getGoal(goal.id))!;
    // A second trip: the Resume is gone and the next question has its own
    // key (leads/goal.ts).
    expect(after.guard).toEqual({
      day: LEAD_DAY,
      wakes: 4,
      trips: 2,
      trippedAt: expect.any(String),
      trippedTokens: 160_000,
    });
    expect(Date.parse(after.guard!.trippedAt!)).toBeGreaterThanOrEqual(before);
    expect(after.lastRunError).toBe("Stopped: it reached its limit");
    // No early wake: the lead set none, so the usual next day applies.
    expect(Date.parse(after.nextWakeAt)).toBeGreaterThanOrEqual(
      before + DAY - 60_000,
    );
  });

  test("cache reads count at a tenth", () => {
    expect(
      wakeTokens({
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 1_000,
      }),
    ).toBe(160);
  });

  test("every wake counts towards the day's wakes", async () => {
    const goal = await leadGoal();
    await runGoal(goal);
    await runGoal((await getGoal(goal.id))!);
    expect((await getGoal(goal.id))!.guard?.wakes).toBe(2);
  });

  test("a due goal waits 30 minutes when its provider is low, without pausing, and says why", async () => {
    const reason = "Your Claude accounts are near their limits";
    const routes: string[] = [];
    __setBackgroundHeadroomForTest(async (route) => {
      routes.push(route);
      return route.startsWith("pi/anthropic/")
        ? { ok: false, reason }
        : { ok: true };
    });
    try {
      const lead = await leadGoal();
      const plain = await dueGoal({ model: "pi/anthropic/claude-fable-5-1" });
      const before = Date.now();
      await tickGoals();
      expect(runs).toBe(0);
      // One headroom question per route a tick.
      expect(routes).toHaveLength(new Set(routes).size);
      for (const id of [lead.id, plain.id]) {
        const after = (await getGoal(id))!;
        expect(after.status).toBe("active");
        expect(after.waiting).toEqual({
          reason,
          since: expect.any(String),
        });
        expect(Date.parse(after.nextWakeAt)).toBeGreaterThanOrEqual(
          before + 29 * 60_000,
        );
      }
      // The lead hears about each wait, to tell its owner after a day.
      expect(waits).toEqual([lead.id]);
    } finally {
      __setBackgroundHeadroomForTest(undefined);
    }
  });

  test("a goal on another provider isn't held by the Claude pool", async () => {
    __setBackgroundHeadroomForTest(async (route) =>
      route.startsWith("pi/anthropic/")
        ? { ok: false, reason: "low" }
        : { ok: true },
    );
    try {
      const goal = await dueGoal({ model: "pi/openai/gpt-6.1-sol" });
      await tickGoals();
      await settled(goal.id);
      expect(runs).toBe(1);
      expect((await getGoal(goal.id))!.waiting).toBeUndefined();
    } finally {
      __setBackgroundHeadroomForTest(undefined);
    }
  });

  test("once there is room, goals that waited start one a tick", async () => {
    const waiting = { reason: "low", since: PAST };
    const a = await dueGoal({ name: "A" });
    const b = await dueGoal({ name: "B" });
    for (const g of [a, b]) await mutateGoal(g.id, (x) => ({ ...x, waiting }));
    __setBackgroundHeadroomForTest(async () => ({ ok: true }));
    try {
      await tickGoals();
      await settled(a.id);
      await settled(b.id);
      expect(runs).toBe(1);
      await tickGoals();
      await settled(a.id);
      await settled(b.id);
      expect(runs).toBe(2);
      for (const g of [a, b])
        expect((await getGoal(g.id))!.waiting).toBeUndefined();
    } finally {
      __setBackgroundHeadroomForTest(undefined);
    }
  });

  test("a run refused for a usage limit holds its provider's goals", async () => {
    __setHeadroomSourcesForTest([]);
    script = async function* () {
      yield {
        type: "error",
        content: "429 rate_limit_error: too many requests",
      } as StreamEvent;
    };
    try {
      const first = await dueGoal({ model: "pi/anthropic/claude-fable-5-1" });
      await runGoal(first);
      const second = await dueGoal({ model: "pi/anthropic/claude-fable-5-1" });
      await tickGoals();
      expect(runs).toBe(1);
      expect((await getGoal(second.id))!.waiting?.reason).toBe(
        "The last background run hit a usage limit",
      );
    } finally {
      __setHeadroomSourcesForTest(undefined);
    }
  });

  test("an ordinary goal has no budget to hold to", async () => {
    script = async function* () {
      yield {
        type: "usage_snapshot",
        usage: {
          costUsd: 500,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 1,
        },
      } as StreamEvent;
    };
    await runGoal(await dueGoal());
    expect(steers).toEqual([]);
    expect(cancels).toEqual([]);
  });

  test("what a wake spent is recorded even when the wake throws", async () => {
    script = async function* () {
      yield {
        type: "usage_snapshot",
        usage: {
          costUsd: 0.4,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 1,
        },
      } as StreamEvent;
      throw new Error("engine crashed");
    };
    const goal = await leadGoal();
    await runGoal(goal);
    const month = new Date().toISOString().slice(0, 7);
    expect(await getGoal(goal.id)).toMatchObject({
      spend: { month, usd: 0.4 },
      lastRunStatus: "error",
    });
  });

  test("the ticker hands a lead's idle goal to the lead", async () => {
    const goal = await leadGoal({ status: "paused", pauseReason: "x" });
    const plain = await dueGoal();
    await mutateGoal(plain.id, (g) => ({ ...g, status: "paused" }));
    await tickGoals();
    expect(idles).toEqual([goal.id]);
    expect(runs).toBe(0);
  });

  test("a cancel that doesn't land is tried again and claims no stop", async () => {
    const usage = (costUsd: number) => ({
      costUsd,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 1,
    });
    script = async function* () {
      yield { type: "usage_snapshot", usage: usage(2.1) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(3.2) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(3.4) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(3.6) } as StreamEvent;
    };
    cancelResults = [false, true];
    const goal = await leadGoal();
    await runGoal(goal);
    const token = lastRun!.startToken!;
    // Tried at 3.2, again at 3.4, then stopped; never a third time.
    expect(cancels).toEqual([token, token]);
    expect((await getGoal(goal.id))?.lastRunError).toBe(
      "Stopped: it reached its limit",
    );

    cancelResults = [false, false, false];
    cancels = [];
    const other = await leadGoal();
    await runGoal(other);
    expect(cancels).toHaveLength(3);
    expect((await getGoal(other.id))?.lastRunError).toBeUndefined();
  });
});

describe("a person's watch goal", () => {
  const fields: LeadGoalFields = {
    name: "Watch: Ada",
    mission: "Watch for Ada, from the charter.",
    mode: "ask",
    repo: undefined,
    minWakeMinutes: 10,
    mcpServers: [],
  };
  const NEXT = "2030-01-01T08:30:00.000Z";
  let plan: WatchWakePlan;
  let settled: boolean[];
  let idles: string[];
  let offHooks: () => void = () => {};

  beforeEach(() => {
    settled = [];
    idles = [];
    plan = {
      fields,
      prompt: "The watch's own prompt for this wake.",
      maxTokens: 1_000,
      model: "pi/anthropic/claude-sonnet-5-5",
      effort: "medium",
      afterWake: async (ok) => {
        settled.push(ok);
        return NEXT;
      },
    };
    offHooks = registerWatchGoalHooks({
      wake: async () => plan,
      idle: async (goal) => {
        idles.push(goal.id);
      },
    });
  });
  afterEach(() => offHooks());

  async function watchGoal(extra: Partial<Goal> = {}): Promise<Goal> {
    const created = await createGoal(
      {
        name: "Watch: Ada",
        mission: "Watch.",
        createdBy: "Supervisor watch",
        firstWakeAt: PAST,
      },
      { watchOwner: "Ada" },
    );
    if ("error" in created) throw new Error(created.error);
    return (await mutateGoal(created.id, (g) => ({ ...g, ...extra })))!;
  }

  test("runs with only its own tools, its own prompt, no connectors, no shell or web, no cloud credentials, on the pinned model", async () => {
    const goal = await watchGoal({
      mcpServers: ["github"],
      model: "pi/anthropic/claude-opus-5-5",
      fallbackModel: "none",
    });
    await runGoal(goal);
    expect(Object.keys(lastRun!.inProcessMcp!)).toEqual(["opensession-watch"]);
    expect(lastRun!.prompt).toBe("The watch's own prompt for this wake.");
    expect(lastRun!.mcpServers).toEqual([]);
    expect(lastRun!.aws).toBe(false);
    // read, grep, find, ls, bash, web_search and web_fetch are stripped.
    expect(lastRun!.disableLocalWorkspaceTools).toBe(true);
    expect(lastRun!.model).toBe("pi/anthropic/claude-sonnet-5-5");
    expect(lastRun!.effort).toBe("medium");
    expect(settled).toEqual([true]);
    // The server's schedule, not the 24h default.
    expect(await getGoal(goal.id)).toMatchObject({
      mission: fields.mission,
      nextWakeAt: NEXT,
      lastRunStatus: "ok",
    });
  });

  test("a skip reschedules without running; a block pauses", async () => {
    const goal = await watchGoal();
    plan = { skip: "nothing changed", nextWakeAt: NEXT };
    await runGoal(goal);
    expect(runs).toBe(0);
    expect(await getGoal(goal.id)).toMatchObject({
      status: "active",
      nextWakeAt: NEXT,
    });
    plan = { block: "The watch is off" };
    await runGoal((await getGoal(goal.id))!);
    expect(runs).toBe(0);
    expect(await getGoal(goal.id)).toMatchObject({
      status: "paused",
      pauseReason: "The watch is off",
    });
  });

  test("fails closed: no watch on the server, or a check that throws", async () => {
    offHooks();
    const goal = await watchGoal();
    await runGoal(goal);
    expect(runs).toBe(0);
    expect((await getGoal(goal.id))!.pauseReason).toBe(
      "The supervisor's watch isn't running on this server",
    );
    offHooks = registerWatchGoalHooks({
      wake: async () => {
        throw new Error("catalog down");
      },
      idle: async () => {},
    });
    const other = await watchGoal();
    await runGoal(other);
    expect(runs).toBe(0);
    expect((await getGoal(other.id))!.pauseReason).toBe(
      "Its wake check failed: catalog down",
    );
  });

  test("held to its tokens: asked to wrap up, then stopped", async () => {
    const usage = (tokens: number) => ({
      costUsd: 0.01,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 0,
      contextTokens: 1,
    });
    script = async function* () {
      yield { type: "usage_snapshot", usage: usage(500) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(1_100) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(1_600) } as StreamEvent;
    };
    const goal = await watchGoal();
    await runGoal(goal);
    expect(steers).toHaveLength(1);
    expect(steers[0]!.text).toContain("You reached what this wake may use.");
    expect(steers[0]!.text).not.toContain("set_next_wake");
    expect(cancels).toEqual([lastRun!.startToken!]);
    expect((await getGoal(goal.id))!.lastRunError).toBe(
      "Stopped: it reached its budget",
    );
  });

  test("a wake stopped at its tokens settles as done, so its events aren't replayed", async () => {
    const usage = (tokens: number) => ({
      costUsd: 0.01,
      inputTokens: tokens,
      outputTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 1,
    });
    script = async function* () {
      yield { type: "usage_snapshot", usage: usage(1_100) } as StreamEvent;
      yield { type: "usage_snapshot", usage: usage(1_600) } as StreamEvent;
      yield { type: "error", content: "Cancelled" } as StreamEvent;
    };
    const goal = await watchGoal();
    await runGoal(goal);
    expect(cancels).toHaveLength(1);
    expect(settled).toEqual([true]);
  });

  test("a wake that throws still settles and goes back on its schedule", async () => {
    script = async function* () {
      throw new Error("engine crashed");
    };
    const goal = await watchGoal();
    await runGoal(goal);
    expect(settled).toEqual([false]);
    expect(await getGoal(goal.id)).toMatchObject({
      lastRunStatus: "error",
      nextWakeAt: NEXT,
    });
  });

  test("the ticker hands an idle watch goal to the watch; a restart rewakes it", async () => {
    const goal = await watchGoal({ status: "paused", pauseReason: "x" });
    await tickGoals();
    expect(idles).toEqual([goal.id]);
    expect(goalRecoveryPlan(goal)).toBe("rewake");
  });
});

describe("restart recovery of a goal's run", () => {
  test("a lead's interrupted wake is woken afresh, never resumed with the interactive tools", async () => {
    const created = await createGoal(
      {
        name: "Lead: Shop",
        mission: "Lead the shop.",
        createdBy: "Project lead",
        firstWakeAt: "2099-01-01T00:00:00Z",
      },
      { leadProject: "shop" },
    );
    if ("error" in created) throw new Error(created.error);
    const interactive = () => ({
      "opensession-admin": {},
      "opensession-sessions": {},
      "opensession-goals": {},
    });
    expect(await goalRecoveryMcpServers(created.id, interactive)).toEqual({});
    const before = Date.now();
    expect(await settleInterruptedGoalRun({ kind: "goal" }, created.id)).toBe(
      true,
    );
    const goal = (await getGoal(created.id))!;
    expect(goal).toMatchObject({
      status: "active",
      lastRunStatus: "error",
      lastRunError: INTERRUPTED_WAKE_ERROR,
    });
    expect(Date.parse(goal.nextWakeAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(goal.nextWakeAt)).toBeLessThanOrEqual(Date.now());
    // The ticker then runs it through runGoal, which fails closed here: no
    // lead hooks are registered, so it pauses instead of running.
    await tickGoals();
    await settled(created.id);
    expect(runs).toBe(0);
    expect((await getGoal(created.id))?.status).toBe("paused");
  });

  test("a lead's wake stopped before its session file is found by its session", async () => {
    const created = await createGoal(
      {
        name: "Lead: Shop",
        mission: "Lead the shop.",
        createdBy: "Project lead",
      },
      { leadProject: "shop" },
    );
    if ("error" in created) throw new Error(created.error);
    await mutateGoal(created.id, (g) => ({ ...g, osSessionId: "os-lead-1" }));
    expect(
      await settleInterruptedGoalRun(
        { kind: "goal", osSessionId: "os-lead-1" },
        undefined,
      ),
    ).toBe(true);
    // Another kind of run, or a session no goal owns, is left alone.
    expect(
      await settleInterruptedGoalRun(
        { kind: "interactive", osSessionId: "os-lead-1" },
        undefined,
      ),
    ).toBe(false);
    expect(
      await settleInterruptedGoalRun(
        { kind: "goal", osSessionId: "os-other" },
        undefined,
      ),
    ).toBe(false);
  });

  test("an ordinary goal resumes as before; an unknown goal does not", async () => {
    const goal = await dueGoal();
    const interactive = () => ({ "opensession-admin": {} });
    expect(
      Object.keys(await goalRecoveryMcpServers(goal.id, interactive)).sort(),
    ).toEqual(["opensession-admin", "opensession-goal-self"]);
    expect(await settleInterruptedGoalRun({ kind: "goal" }, goal.id)).toBe(
      false,
    );
    expect((await getGoal(goal.id))?.lastRunError).toBeUndefined();
    expect(await settleInterruptedGoalRun({ kind: "goal" }, "missing")).toBe(
      true,
    );
    expect(await goalRecoveryMcpServers("missing", interactive)).toEqual({});
  });
});
