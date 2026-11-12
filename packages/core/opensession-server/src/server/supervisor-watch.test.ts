/**
 * The supervisor's watch: its goal's lifecycle, the events that wake it
 * early, the cheap check before the model, its schedule and loop guards,
 * the follow-ups the conversation hands it, background deliveries routed
 * away from the conversation, and its tools. Runs on the in-memory kernel
 * with the real goal, inbox and watch stores, a fake clock and fake push
 * delivery; no real timers and no engine.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionKernelStore,
  __setSessionKernelStoreForTest,
} from "./session-kernel";
import type { Goal } from "./goals";
import type { WatchRunPlan, WatchWakePlan } from "./goal-runner";

const root = mkdtempSync(join(tmpdir(), "supervisor-watch-test-"));
const prior = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = root;

type Watch = typeof import("./supervisor-watch");
type Inbox = typeof import("./supervisor-inbox");
type Goals = typeof import("./goals");
type WatchMcp = typeof import("./supervisor-watch-mcp");
let watch: Watch;
let inbox: Inbox;
let goals: Goals;
let watchMcp: WatchMcp;

beforeAll(async () => {
  watch = await import("./supervisor-watch");
  inbox = await import("./supervisor-inbox");
  goals = await import("./goals");
  watchMcp = await import("./supervisor-watch-mcp");
});

afterAll(() => {
  if (prior === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

const USER = "Ada";
const NOON = Date.parse("2026-11-10T12:00:00.000Z");
let store: SessionKernelStore;
let previousStore: SessionKernelStore | undefined;
let clock = NOON;
let supervisor = true;
let headroom = true;
let incidents: Array<{
  id: string;
  project: string;
  title: string;
  state: "investigating";
  severity: "major";
  updatedAt: string;
}> = [];
let statuses: Record<string, string> = {};
let runnerReady = true;
let restoreInbox: () => void = () => {};

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  clock = NOON;
  supervisor = true;
  headroom = true;
  incidents = [];
  statuses = {};
  runnerReady = true;
  restoreInbox = inbox.__setSupervisorInboxDepsForTest({
    now: () => clock,
    notify: async () => ({}),
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup-ada",
    rotateSupervisor: async () => {},
    ensureWatch: async () => {},
    timeZone: () => "UTC",
  });
  watch.__setWatchDepsForTest(baseDeps());
});

function baseDeps(): Partial<import("./supervisor-watch").WatchDeps> {
  return {
    now: () => clock,
    hasSupervisor: async () => supervisor,
    openIncidents: async () => incidents,
    sessionStatus: async (id) => statuses[id] ?? "gone",
    headroom: async () =>
      headroom
        ? { ok: true }
        : { ok: false, reason: "Your Claude accounts are near their limits" },
    runnerReady: async () => runnerReady,
    random: () => 0,
  };
}

afterEach(() => {
  watch.__setWatchDepsForTest(undefined);
  watchMcp.__setWatchMcpDepsForTest(undefined);
  restoreInbox();
  inbox.__resetSupervisorInboxForTest();
  __setSessionKernelStoreForTest(previousStore);
  store.close();
});

const at = (iso: string) => Date.parse(iso);

async function watchGoal(): Promise<Goal> {
  const result = await watch.ensureWatchGoal(USER);
  if (result.action === "none") {
    const state = await watch.readWatchState(USER);
    return (await goals.getGoal(state.goalId!))!;
  }
  return (await goals.getGoal(result.goalId))!;
}

function run(plan: WatchWakePlan): WatchRunPlan {
  if ("block" in plan || "skip" in plan)
    throw new Error(`expected a run, got ${JSON.stringify(plan)}`);
  return plan;
}

function leadItem(title = "Roll back the deploy?") {
  return inbox.postSupervisorItem({
    user: USER,
    source: "lead:acme",
    kind: "needs-you",
    title,
    options: ["Roll back", "Wait"],
  });
}

describe("the watch goal", () => {
  test("one per person, server-owned, active, with no tools to end itself", async () => {
    const created = await watch.ensureWatchGoal(USER);
    expect(created.action).toBe("created");
    const goal = await watchGoal();
    expect(goal).toMatchObject({
      name: "Watch: Ada",
      watchOwner: USER,
      status: "active",
      mode: "ask",
      mcpServers: [],
      minWakeMinutes: watch.WATCH_MIN_WAKE_MINUTES,
    });
    expect(goal.mission).toContain("never speak in that conversation");
    expect((await watch.readWatchState(USER)).goalId).toBe(goal.id);
    // Again: nothing to do, and no second goal.
    expect((await watch.ensureWatchGoal(USER)).action).toBe("none");
    expect(
      (await goals.listGoals()).filter((g) => g.watchOwner === USER),
    ).toHaveLength(1);
  });

  test("its charter can't be patched and its owner can't be set from the API", async () => {
    const goal = await watchGoal();
    const patched = await goals.updateGoal(goal.id, {
      mission: "Do anything you like.",
      mcpServers: ["github"],
    });
    expect(patched).toEqual({
      error:
        "This goal is a supervisor's watch: its mission, mcpServers come from the watch's charter",
    });
    // A body that names watchOwner gets no watch: createGoal's input has
    // no such field, and a patch drops it.
    const plain = await goals.createGoal({
      name: "x",
      mission: "y",
      createdBy: "Ada",
      ...({ watchOwner: USER } as object),
    });
    if ("error" in plain) throw new Error(plain.error);
    expect(plain.watchOwner).toBeUndefined();
    const still = await goals.updateGoal(plain.id, {
      ...({ watchOwner: USER } as object),
    });
    expect((still as Goal).watchOwner).toBeUndefined();
  });

  test("off in the prefs pauses it, on again resumes it", async () => {
    const goal = await watchGoal();
    await inbox.setSupervisorPrefs(USER, { watch: { enabled: false } });
    expect(await watch.ensureWatchGoal(USER)).toEqual({
      action: "paused",
      goalId: goal.id,
    });
    expect(await goals.getGoal(goal.id)).toMatchObject({
      status: "paused",
      pauseReason: watch.WATCH_OFF_REASON,
    });
    await inbox.setSupervisorPrefs(USER, { watch: { enabled: true } });
    expect(await watch.ensureWatchGoal(USER)).toEqual({
      action: "resumed",
      goalId: goal.id,
    });
    expect((await goals.getGoal(goal.id))!.status).toBe("active");
  });

  test("an owner's own pause stays", async () => {
    const goal = await watchGoal();
    await goals.mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Paused from the goals page",
    }));
    expect((await watch.ensureWatchGoal(USER)).action).toBe("none");
    expect((await goals.getGoal(goal.id))!.status).toBe("paused");
  });

  test("no supervisor, no watch", async () => {
    supervisor = false;
    expect((await watch.ensureWatchGoal(USER)).action).toBe("none");
    expect(await goals.listGoals()).toHaveLength(0);
  });
});

describe("the wake check", () => {
  test("fails closed: another goal, or the watch off, pauses it", async () => {
    const goal = await watchGoal();
    expect(await watch.watchWakeCheck({ ...goal, id: "goal-other" })).toEqual({
      block: "Another goal is this person's watch",
    });
    expect(
      await watch.watchWakeCheck({ ...goal, watchOwner: undefined }),
    ).toEqual({ block: "Not a watch goal" });
    await inbox.setSupervisorPrefs(USER, { watch: { enabled: false } });
    expect(await watch.watchWakeCheck(goal)).toEqual({
      block: watch.WATCH_OFF_REASON,
    });
  });

  test("runs on the charter with what changed, then skips while nothing does", async () => {
    const goal = await watchGoal();
    await leadItem();
    const plan = run(await watch.watchWakeCheck(goal));
    expect(plan.fields.mcpServers).toEqual([]);
    expect(plan.fields.mission).toBe(goal.mission);
    expect(plan.maxTokens).toBe(watch.WATCH_MAX_TOKENS_PER_WAKE);
    expect(plan.prompt).toContain("Roll back the deploy?");
    expect(plan.prompt).toContain("Untrusted");
    // The item reached the prompt through the inbox; no listener is
    // registered here, so no event was pending.
    expect((await watch.readWatchState(USER)).events).toHaveLength(0);
    const next = await plan.afterWake(true);
    expect(next).toBe("2026-11-10T12:30:00.000Z");
    // Nothing changed since: no model.
    clock += 30 * 60_000;
    expect(await watch.watchWakeCheck(goal)).toEqual({
      skip: "nothing changed",
      nextWakeAt: "2026-11-10T13:00:00.000Z",
    });
    // An incident changing is a change.
    incidents = [
      {
        id: "inc-1",
        project: "acme",
        title: "Checkout down",
        state: "investigating",
        severity: "major",
        updatedAt: "2026-11-10T12:20:00.000Z",
      },
    ];
    expect(run(await watch.watchWakeCheck(goal)).prompt).toContain(
      "Checkout down",
    );
  });

  test("what the watch posts itself never wakes it again", async () => {
    const goal = await watchGoal();
    await (await run(await watch.watchWakeCheck(goal))).afterWake(true);
    await inbox.postSupervisorItem({
      user: USER,
      source: watch.WATCH_SOURCE,
      kind: "fyi",
      title: "Pat's review finished",
    });
    clock += 30 * 60_000;
    expect(await watch.watchWakeCheck(goal)).toMatchObject({
      skip: "nothing changed",
    });
  });

  test("never at night: quiet hours wait, unless something urgent is pending", async () => {
    const goal = await watchGoal();
    clock = at("2026-11-10T03:00:00.000Z");
    expect(await watch.watchWakeCheck(goal)).toEqual({
      skip: "quiet hours",
      nextWakeAt: "2026-11-10T08:00:00.000Z",
    });
    await watch.recordWatchEvent(USER, { kind: "item", title: "fyi" });
    expect(await watch.watchWakeCheck(goal)).toMatchObject({
      skip: "quiet hours",
    });
    await watch.recordWatchEvent(USER, {
      kind: "incident",
      title: "Everything is down",
      urgent: true,
    });
    expect(run(await watch.watchWakeCheck(goal)).prompt).toContain(
      "Everything is down",
    );
  });

  test("outside the active hours only events wake it", async () => {
    const goal = await watchGoal();
    clock = at("2026-11-10T23:00:00.000Z");
    expect(await watch.watchWakeCheck(goal)).toEqual({
      skip: "outside the active hours",
      nextWakeAt: "2026-11-11T08:00:00.000Z",
    });
    await watch.recordWatchEvent(USER, {
      kind: "worker-report",
      title: "A worker reported back",
    });
    run(await watch.watchWakeCheck(goal));
  });

  test("waits while the Claude pool is low", async () => {
    const goal = await watchGoal();
    headroom = false;
    expect(await watch.watchWakeCheck(goal)).toEqual({
      skip: "Your Claude accounts are near their limits",
      nextWakeAt: new Date(NOON + watch.WATCH_HEADROOM_RETRY_MS).toISOString(),
    });
  });

  test("stops at its wakes for the day and says so once", async () => {
    const goal = await watchGoal();
    for (let i = 0; i < watch.WATCH_MAX_WAKES_PER_DAY; i++) {
      await watch.recordWatchEvent(USER, { kind: "item", title: `n${i}` });
      await (await run(await watch.watchWakeCheck(goal))).afterWake(true);
    }
    await watch.recordWatchEvent(USER, { kind: "item", title: "one more" });
    expect(await watch.watchWakeCheck(goal)).toEqual({
      skip: "its wakes for today are used up",
      nextWakeAt: "2026-11-11T08:00:00.000Z",
    });
    await watch.watchWakeCheck(goal);
    const notes = await inbox.listSupervisorItems(USER, { state: "open" });
    expect(
      notes.filter((i) => i.title === "The watch reached its wakes for today"),
    ).toHaveLength(1);
    // A new local day starts again.
    clock = at("2026-11-11T09:00:00.000Z");
    run(await watch.watchWakeCheck(goal));
  });

  test("a failed wake keeps its events for the next one, soon", async () => {
    const goal = await watchGoal();
    await watch.recordWatchEvent(USER, { kind: "item", title: "kept" });
    const plan = run(await watch.watchWakeCheck(goal));
    expect(await plan.afterWake(false)).toBe(
      new Date(NOON + watch.WATCH_EVENT_GAP_MS).toISOString(),
    );
    expect(
      (await watch.readWatchState(USER)).events.map((e) => e.title),
    ).toEqual(["kept"]);
  });

  test("events that arrive during a wake stay for the next one", async () => {
    const goal = await watchGoal();
    await watch.recordWatchEvent(USER, { kind: "item", title: "seen" });
    const plan = run(await watch.watchWakeCheck(goal));
    await watch.recordWatchEvent(USER, { kind: "item", title: "late" });
    await plan.afterWake(true);
    expect(
      (await watch.readWatchState(USER)).events.map((e) => e.title),
    ).toEqual(["late"]);
  });
});

describe("events", () => {
  test("pull the next wake forward, no sooner than the gap after the last", async () => {
    const goal = await watchGoal();
    await (await run(await watch.watchWakeCheck(goal))).afterWake(true);
    expect((await goals.getGoal(goal.id))!.nextWakeAt).toBe(
      new Date(NOON).toISOString(),
    );
    await goals.mutateGoal(goal.id, (g) => ({
      ...g,
      nextWakeAt: "2026-11-10T12:30:00.000Z",
    }));
    clock = NOON + 60_000;
    expect(
      await watch.recordWatchEvent(USER, { kind: "item", title: "new" }),
    ).toBe(true);
    expect((await goals.getGoal(goal.id))!.nextWakeAt).toBe(
      new Date(NOON + watch.WATCH_EVENT_GAP_MS).toISOString(),
    );
  });

  test("the watch off takes none", async () => {
    await inbox.setSupervisorPrefs(USER, { watch: { enabled: false } });
    expect(
      await watch.recordWatchEvent(USER, { kind: "item", title: "x" }),
    ).toBe(false);
  });

  test("a lead's new item and an incident opening reach the watch; its own items and updates don't", async () => {
    await watchGoal();
    const { item } = await leadItem();
    await watch.onItemPosted(item, true);
    await watch.onItemPosted(item, false);
    await watch.onItemPosted({ ...item, source: watch.WATCH_SOURCE }, true);
    await watch.onIncidentOpened(
      {
        id: "inc-1",
        owner: "ada",
        project: "acme",
        title: "Checkout down",
        severity: "critical",
      },
      null,
    );
    await watch.onIncidentOpened(
      {
        id: "inc-1",
        owner: "ada",
        project: "acme",
        title: "Checkout down",
        severity: "critical",
      },
      {},
    );
    const events = (await watch.readWatchState(USER)).events;
    expect(events.map((e) => [e.kind, e.urgent ?? false])).toEqual([
      ["item", false],
      ["incident", true],
    ]);
  });

  test("the inbox tells its listeners about a post", async () => {
    const seen: Array<[string, boolean]> = [];
    inbox.onSupervisorItemPosted((item, created) => {
      seen.push([item.title, created]);
    });
    await leadItem("A");
    await leadItem("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([
      ["A", true],
      ["A", true],
    ]);
  });

  test("the owner's answer to a watch item wakes it", async () => {
    await watchGoal();
    const { item } = await inbox.postSupervisorItem({
      user: USER,
      source: watch.WATCH_SOURCE,
      kind: "needs-you",
      title: "Raise the lead's budget?",
    });
    await watch.onWatchAnswer(item, "Yes", "owner");
    const [event] = (await watch.readWatchState(USER)).events;
    expect(event).toMatchObject({
      kind: "answer",
      title: 'The owner answered "Raise the lead\'s budget?"',
      text: "Yes",
    });
  });
});

describe("background deliveries to the conversation", () => {
  const session = { supervisor: true, createdBy: USER };

  test("a worker's report goes to the watch, not the conversation", async () => {
    await watchGoal();
    const routed = await watch.routeSupervisorDelivery(
      session,
      "<!--os:worker-report-->\nDone: PR #10 is green.",
      "worker os-abc123",
      "d1",
    );
    expect(routed).toContain("watch");
    const [event] = (await watch.readWatchState(USER)).events;
    expect(event).toMatchObject({
      kind: "worker-report",
      text: "Done: PR #10 is green.",
    });
  });

  test("a failure beacon, a wait's wake and a check-back go too", async () => {
    await watchGoal();
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "<!--os:worker-report:os-abc123-->\nWorker task ended in error.",
        undefined,
        "worker-failure:os-abc123",
      ),
    ).toBeTruthy();
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "A durable background wait has completed.",
        undefined,
        "agent-wait:w1:wake",
      ),
    ).toBeTruthy();
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "Check on the deploy",
        "Ada (scheduled)",
        "sp-1",
      ),
    ).toBeTruthy();
    expect(
      (await watch.readWatchState(USER)).events.map((e) => [
        e.kind,
        e.sessionId,
      ]),
    ).toEqual([
      ["worker-report", "os-abc123"],
      ["wait", undefined],
      ["scheduled", undefined],
    ]);
  });

  test("the owner's own words, other sessions, and a watch that is off stay in the conversation", async () => {
    await watchGoal();
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "What's waiting?",
        USER,
        "d",
      ),
    ).toBeNull();
    expect(
      await watch.routeSupervisorDelivery(
        { supervisor: false, createdBy: USER },
        "<!--os:worker-report-->\nDone",
        "worker os-abc123",
        "d",
      ),
    ).toBeNull();
    await inbox.setSupervisorPrefs(USER, { watch: { enabled: false } });
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "<!--os:worker-report-->\nDone",
        "worker os-abc123",
        "d",
      ),
    ).toBeNull();
  });
});

describe("follow-ups", () => {
  test("watch_for records one and wakes the watch; resolving closes it", async () => {
    await watchGoal();
    const added = await watch.addWatchTask(USER, {
      what: "Tell me when Pat's review of #10 finishes",
      sessionId: "os-pat-1",
    });
    if (!added.ok) throw new Error(added.message);
    expect(added.task.until).toBe(NOON + 7 * 24 * 60 * 60_000);
    const state = await watch.readWatchState(USER);
    expect(state.tasks).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ kind: "task" });
    statuses["os-pat-1"] = "running";
    expect(await watch.openWatchTasks(USER)).toMatchObject([
      { id: added.task.id, sessionStatus: "running" },
    ]);
    expect(
      (await watch.resolveWatchTask(USER, added.task.id, "Approved"))?.state,
    ).toBe("resolved");
    expect(await watch.openWatchTasks(USER)).toEqual([]);
    expect(await watch.resolveWatchTask(USER, added.task.id, "again")).toBe(
      null,
    );
  });

  test("its session finishing is a change the cheap check sees", async () => {
    const goal = await watchGoal();
    await watch.addWatchTask(USER, { what: "Review", sessionId: "os-pat-1" });
    statuses["os-pat-1"] = "running";
    await (await run(await watch.watchWakeCheck(goal))).afterWake(true);
    clock += 30 * 60_000;
    expect(await watch.watchWakeCheck(goal)).toMatchObject({
      skip: "nothing changed",
    });
    statuses["os-pat-1"] = "idle";
    expect(run(await watch.watchWakeCheck(goal)).prompt).toContain(
      "session os-pat-1: idle",
    );
  });

  test("refuses a past time, a watch that is off, and too many", async () => {
    await watchGoal();
    expect(
      await watch.addWatchTask(USER, {
        what: "x",
        until: "2020-01-01T00:00:00Z",
      }),
    ).toMatchObject({ ok: false, message: "That time has passed." });
    expect(
      await watch.addWatchTask(USER, { what: "x", until: "soon" }),
    ).toMatchObject({ ok: false });
    for (let i = 0; i < watch.MAX_OPEN_TASKS; i++)
      expect((await watch.addWatchTask(USER, { what: `t${i}` })).ok).toBe(true);
    expect((await watch.addWatchTask(USER, { what: "one more" })).ok).toBe(
      false,
    );
    await inbox.setSupervisorPrefs(USER, { watch: { enabled: false } });
    expect(
      (await watch.addWatchTask(USER, { what: "x" })) as { message: string },
    ).toMatchObject({ ok: false });
  });

  test("one long past its deadline closes as expired at the next wake", async () => {
    const goal = await watchGoal();
    await watch.addWatchTask(USER, {
      what: "x",
      until: "2026-11-10T13:00:00Z",
    });
    clock = at("2026-11-11T14:00:00.000Z");
    await watch.watchWakeCheck(goal);
    expect((await watch.readWatchState(USER)).tasks[0]!.state).toBe("expired");
  });
});

describe("the digest", () => {
  test("leaves out the watch's own items and doesn't depend on order", () => {
    const a = {
      id: "a",
      updatedAt: 1,
      state: "open" as const,
      source: "lead:x",
    };
    const b = {
      id: "b",
      updatedAt: 2,
      state: "open" as const,
      source: "lead:y",
    };
    const own = {
      id: "c",
      updatedAt: 3,
      state: "open" as const,
      source: "watch",
    };
    const base = { incidents: [], tasks: [] };
    expect(watch.watchDigest({ ...base, items: [a, b] })).toBe(
      watch.watchDigest({ ...base, items: [b, own, a] }),
    );
    expect(watch.watchDigest({ ...base, items: [a] })).not.toBe(
      watch.watchDigest({ ...base, items: [a, b] }),
    );
  });
});

describe("opensession-watch", () => {
  async function tools() {
    const server = watchMcp.createWatchMcpServer({ user: USER });
    return (
      server as unknown as {
        instance: {
          _registeredTools: Record<
            string,
            {
              handler: (args: Record<string, unknown>) => Promise<{
                content: Array<{ text: string }>;
                isError?: boolean;
              }>;
            }
          >;
        };
      }
    ).instance._registeredTools;
  }

  test("reports only through the inbox and the ledger: no answers, no spawning, no ask_pat", async () => {
    expect(Object.keys(await tools()).sort()).toEqual([
      "append_ledger",
      "list_items",
      "list_watch_tasks",
      "post_item",
      "project_overview",
      "read_ledger",
      "resolve_watch_task",
    ]);
  });

  test("what it posts is the watch's", async () => {
    const t = await tools();
    await t.post_item!.handler({ kind: "fyi", title: "Pat finished" });
    const [item] = await inbox.listSupervisorItems(USER, { state: "open" });
    expect(item).toMatchObject({ source: "watch", title: "Pat finished" });
  });

  test("reads only the projects the owner leads", async () => {
    watchMcp.__setWatchMcpDepsForTest({
      ledProjects: async () => ["acme"],
      overview: async (project) => `overview of ${project}`,
    });
    const t = await tools();
    expect((await t.project_overview!.handler({})).content[0]!.text).toBe(
      "Projects: acme",
    );
    const overview = (await t.project_overview!.handler({ project: "acme" }))
      .content[0]!.text;
    expect(overview).toStartWith(watchMcp.WATCH_UNTRUSTED_LABEL);
    expect(overview).toEndWith("overview of acme");
    const refused = await t.project_overview!.handler({ project: "other" });
    expect(refused.isError).toBe(true);
  });

  test("lists and resolves follow-ups", async () => {
    await watchGoal();
    const added = await watch.addWatchTask(USER, { what: "Review #10" });
    if (!added.ok) throw new Error(added.message);
    const t = await tools();
    expect((await t.list_watch_tasks!.handler({})).content[0]!.text).toContain(
      "Review #10",
    );
    expect(
      (
        await t.resolve_watch_task!.handler({
          id: added.task.id,
          outcome: "Merged",
        })
      ).content[0]!.text,
    ).toBe("Resolved: Review #10");
    expect((await t.list_watch_tasks!.handler({})).content[0]!.text).toBe(
      "No open follow-ups.",
    );
  });
});

describe("the next decision after a wake", () => {
  test("an event that arrives mid-wake runs the next wake, never skips it", async () => {
    const goal = await watchGoal();
    await watch.recordWatchEvent(USER, { kind: "item", title: "seen" });
    const plan = run(await watch.watchWakeCheck(goal));
    await watch.recordWatchEvent(USER, {
      kind: "worker-report",
      title: "late",
    });
    expect(await plan.afterWake(true)).toBe(
      new Date(NOON + watch.WATCH_EVENT_GAP_MS).toISOString(),
    );
    clock += watch.WATCH_EVENT_GAP_MS;
    const next = run(await watch.watchWakeCheck(goal));
    expect(next.prompt).toContain("late");
    expect(next.prompt).not.toContain("seen");
  });

  test("an item that changes mid-wake runs the next wake; what the wake did itself doesn't", async () => {
    const goal = await watchGoal();
    const plan = run(await watch.watchWakeCheck(goal));
    // The wake posts its own item and resolves nothing; a lead posts one
    // while it runs (no listener here, so no event: only the digest sees it).
    await inbox.postSupervisorItem({
      user: USER,
      source: watch.WATCH_SOURCE,
      kind: "fyi",
      title: "The watch's own",
    });
    await leadItem("Posted mid-wake");
    await plan.afterWake(true);
    clock += 30 * 60_000;
    expect(run(await watch.watchWakeCheck(goal)).prompt).toContain(
      "Posted mid-wake",
    );
  });

  test("a follow-up the wake resolved doesn't wake it again", async () => {
    const goal = await watchGoal();
    const added = await watch.addWatchTask(USER, { what: "Review #10" });
    if (!added.ok) throw new Error(added.message);
    const plan = run(await watch.watchWakeCheck(goal));
    await watch.resolveWatchTask(USER, added.task.id, "Merged");
    await plan.afterWake(true);
    clock += 30 * 60_000;
    expect(await watch.watchWakeCheck(goal)).toMatchObject({
      skip: "nothing changed",
    });
  });

  test("a wake that keeps failing drops its events after 3 tries, says so once, and pauses the watch", async () => {
    const goal = await watchGoal();
    await watch.recordWatchEvent(USER, { kind: "item", title: "stuck" });
    for (let i = 0; i < watch.WATCH_MAX_EVENT_ATTEMPTS; i++) {
      const plan = run(await watch.watchWakeCheck(goal));
      expect(plan.prompt).toContain("stuck");
      await plan.afterWake(false);
      clock += watch.WATCH_EVENT_GAP_MS;
    }
    expect((await watch.readWatchState(USER)).events).toEqual([]);
    const open = await inbox.listSupervisorItems(USER, { state: "open" });
    expect(
      open.filter((i) => i.title.startsWith("The watch gave up")),
    ).toHaveLength(1);
    const breaker = open.find((i) => i.kind === "needs-you");
    expect(breaker?.title).toBe("The watch stopped: its last wakes failed");
    // The system telling on itself pushes; it never waits for the brief.
    expect(breaker?.urgency).toBe("now");
    expect(await goals.getGoal(goal.id)).toMatchObject({
      status: "paused",
      pauseReason: watch.WATCH_FAILING_REASON,
    });
    // Only the owner lifts it: ensure leaves it paused, and a worker's
    // report goes to the conversation meanwhile.
    await watch.ensureWatchGoal(USER);
    expect((await goals.getGoal(goal.id))!.status).toBe("paused");
    expect(
      await watch.routeSupervisorDelivery(
        { supervisor: true, createdBy: USER },
        "<!--os:worker-report-->\nDone.",
        "worker os-abc123",
        "d-paused",
      ),
    ).toBeNull();
    expect(breaker?.options).toEqual(["Resume", "Keep paused"]);
    await watch.onWatchAnswer(breaker!, "Keep paused", "owner");
    expect((await goals.getGoal(goal.id))!.status).toBe("paused");
    await watch.onWatchAnswer(breaker!, "Resume", "owner");
    expect((await goals.getGoal(goal.id))!.status).toBe("active");
    expect((await watch.readWatchState(USER)).events).toEqual([]);
  });

  test("a success in between resets the count of failed wakes", async () => {
    const goal = await watchGoal();
    for (const ok of [false, false, true, false, false]) {
      await watch.recordWatchEvent(USER, { kind: "item", title: `${ok}` });
      await run(await watch.watchWakeCheck(goal)).afterWake(ok);
      clock += watch.WATCH_EVENT_GAP_MS;
    }
    expect((await goals.getGoal(goal.id))!.status).toBe("active");
  });

  test("too many events drop items and incidents first, and the prompt says how many", async () => {
    const goal = await watchGoal();
    await watch.recordWatchEvent(USER, { kind: "item", title: "old item" });
    for (let i = 0; i < watch.MAX_EVENTS; i++)
      await watch.recordWatchEvent(USER, {
        kind: "worker-report",
        title: `report ${i}`,
      });
    const state = await watch.readWatchState(USER);
    expect(state.events).toHaveLength(watch.MAX_EVENTS);
    expect(state.events.every((e) => e.kind === "worker-report")).toBe(true);
    const plan = run(await watch.watchWakeCheck(goal));
    expect(plan.prompt).toContain("1 older events dropped");
    await plan.afterWake(true);
    await watch.recordWatchEvent(USER, { kind: "item", title: "new" });
    clock += watch.WATCH_EVENT_GAP_MS;
    expect(run(await watch.watchWakeCheck(goal)).prompt).not.toContain(
      "dropped",
    );
  });

  test("an urgent event wakes it with more thought, on the pinned model", async () => {
    const goal = await watchGoal();
    const routine = run(await watch.watchWakeCheck(goal));
    expect([routine.model, routine.effort]).toEqual([
      "pi/anthropic/claude-sonnet-5-5",
      "medium",
    ]);
    await routine.afterWake(true);
    await watch.recordWatchEvent(USER, {
      kind: "incident",
      title: "Down",
      urgent: true,
    });
    expect(run(await watch.watchWakeCheck(goal)).effort).toBe("high");
  });
});

describe("taking a delivery", () => {
  const session = { supervisor: true, createdBy: USER };
  const report = "<!--os:worker-report-->\nDone: PR #10 is green.";

  test("a watch the owner paused leaves it with the conversation, recording nothing", async () => {
    const goal = await watchGoal();
    await goals.mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Paused from the goals page",
    }));
    expect(
      await watch.routeSupervisorDelivery(
        session,
        report,
        "worker os-abc123",
        "d1",
      ),
    ).toBeNull();
    expect(
      await watch.recordWatchEvent(USER, { kind: "item", title: "x" }),
    ).toBe(false);
    expect(
      await watch.addWatchTask(USER, { what: "Review #10" }),
    ).toMatchObject({ ok: false });
    expect(await watch.readWatchState(USER)).toMatchObject({
      events: [],
      tasks: [],
    });
  });

  test("so does a server whose goal runner has no watch hooks", async () => {
    await watchGoal();
    runnerReady = false;
    expect(
      await watch.routeSupervisorDelivery(
        session,
        report,
        "worker os-abc123",
        "d1",
      ),
    ).toBeNull();
    expect((await watch.readWatchState(USER)).events).toEqual([]);
  });

  test("the same delivery twice is one event, before and after a wake took it", async () => {
    const goal = await watchGoal();
    for (let i = 0; i < 2; i++)
      expect(
        await watch.routeSupervisorDelivery(
          session,
          report,
          "worker os-abc123",
          "d1",
        ),
      ).toBeTruthy();
    expect((await watch.readWatchState(USER)).events).toHaveLength(1);
    await run(await watch.watchWakeCheck(goal)).afterWake(true);
    expect(
      await watch.routeSupervisorDelivery(
        session,
        report,
        "worker os-abc123",
        "d1",
      ),
    ).toBeTruthy();
    expect((await watch.readWatchState(USER)).events).toEqual([]);
  });

  test("once recorded, a failure to bring the wake forward still counts as taken", async () => {
    await watchGoal();
    await watch.recordWatchEvent(USER, { kind: "item", title: "warm" });
    watch.__setWatchDepsForTest({
      ...baseDeps(),
      mutateGoal: async () => {
        throw new Error("catalog down");
      },
    });
    expect(
      await watch.routeSupervisorDelivery(
        session,
        report,
        "worker os-abc123",
        "d2",
      ),
    ).toBeTruthy();
    expect(
      (await watch.readWatchState(USER)).events.map((e) => e.kind),
    ).toEqual(["item", "worker-report"]);
  });

  test("a worker's question stays in the conversation, which can answer it", async () => {
    await watchGoal();
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "<!--os:worker-report-->\nTests pass. Should I merge #10 now or wait for Pat?",
        "worker os-abc123",
        "d1",
      ),
    ).toBeNull();
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "Which branch did you mean?",
        "agent os-abc123",
        "d2",
      ),
    ).toBeNull();
    expect((await watch.readWatchState(USER)).events).toEqual([]);
    // A quoted or coded question isn't the worker asking.
    expect(
      await watch.routeSupervisorDelivery(
        session,
        "<!--os:worker-report-->\nDone. The issue asked:\n> Can we ship today?\n```\nif (ok?) run()\n```",
        "worker os-abc123",
        "d3",
      ),
    ).toBeTruthy();
  });

  test("a new watch's first wake is spread over half an hour", async () => {
    watch.__setWatchDepsForTest({ ...baseDeps(), random: () => 0.5 });
    const goal = await watchGoal();
    // On the pinned model, so the ticker's headroom check asks its route.
    expect(goal.model).toBe(watch.WATCH_MODEL);
    expect(goal.nextWakeAt).toBe(
      new Date(NOON + watch.WATCH_FIRST_WAKE_SPREAD_MS / 2).toISOString(),
    );
  });
});

describe("opensession-watch guards", () => {
  async function tools() {
    const server = watchMcp.createWatchMcpServer({ user: USER });
    return (
      server as unknown as {
        instance: {
          _registeredTools: Record<
            string,
            {
              handler: (args: Record<string, unknown>) => Promise<{
                content: Array<{ text: string }>;
              }>;
            }
          >;
        };
      }
    ).instance._registeredTools;
  }

  test("posts down only while an urgent event is pending", async () => {
    await watchGoal();
    const t = await tools();
    const refused = await t.post_item!.handler({
      kind: "needs-you",
      title: "Checkout is down",
      urgency: "down",
      dedupe_key: "checkout",
    });
    expect(refused.content[0]!.text).toContain("Posted as urgency now");
    let [item] = await inbox.listSupervisorItems(USER, { state: "open" });
    // Refused down still pushes: it goes out as now, not normal.
    expect(item!.urgency).toBe("now");
    await watch.recordWatchEvent(USER, {
      kind: "incident",
      title: "Checkout down",
      urgent: true,
    });
    await t.post_item!.handler({
      kind: "needs-you",
      title: "Checkout is down",
      urgency: "down",
      dedupe_key: "checkout",
    });
    [item] = await inbox.listSupervisorItems(USER, { state: "open" });
    expect(item!.urgency).toBe("down");
  });

  test("a decision raised while an incident is pending pushes now", async () => {
    await watchGoal();
    const t = await tools();
    await t.post_item!.handler({
      kind: "needs-you",
      title: "Restart the worker?",
      dedupe_key: "plain",
    });
    let [item] = await inbox.listSupervisorItems(USER, { state: "open" });
    expect(item!.urgency).toBeUndefined();
    await watch.recordWatchEvent(USER, {
      kind: "incident",
      title: "acme: checkout errors (high, inc-1)",
    });
    await t.post_item!.handler({
      kind: "needs-you",
      title: "Roll back checkout?",
      urgency: "normal",
      dedupe_key: "incident",
    });
    [item] = await inbox.listSupervisorItems(USER, { state: "open" });
    expect(item).toMatchObject({
      title: "Roll back checkout?",
      urgency: "now",
    });
    // An fyi still waits for the brief.
    await t.post_item!.handler({ kind: "fyi", title: "Checkout noted" });
    const note = (await inbox.listSupervisorItems(USER, { kind: "fyi" }))[0];
    expect(note!.urgency).toBeUndefined();
  });

  test("its ledger entries are marked as observations, its item lists as untrusted", async () => {
    const t = await tools();
    expect(
      (await t.append_ledger!.handler({ text: "Checkout recovered" }))
        .content[0]!.text,
    ).toMatch(/\n## .* UTC · observation\n\nCheckout recovered$/);
    await leadItem();
    expect((await t.list_items!.handler({})).content[0]!.text).toStartWith(
      watchMcp.WATCH_UNTRUSTED_LABEL,
    );
  });
});
