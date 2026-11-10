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
let restoreInbox: () => void = () => {};

beforeEach(() => {
  store = new SessionKernelStore(":memory:");
  previousStore = __setSessionKernelStoreForTest(store);
  clock = NOON;
  supervisor = true;
  headroom = true;
  incidents = [];
  statuses = {};
  restoreInbox = inbox.__setSupervisorInboxDepsForTest({
    now: () => clock,
    notify: async () => ({}),
    markDone: async () => {},
    supervisorSessionId: async () => "os-sup-ada",
    rotateSupervisor: async () => {},
    ensureWatch: async () => {},
    timeZone: () => "UTC",
  });
  watch.__setWatchDepsForTest({
    now: () => clock,
    hasSupervisor: async () => supervisor,
    openIncidents: async () => incidents,
    sessionStatus: async (id) => statuses[id] ?? "gone",
    headroomOk: async () => headroom,
  });
});

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
      skip: "the Claude pool is low",
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

describe("the digest and the headroom rule", () => {
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
    const base = { incidents: [], events: [], tasks: [] };
    expect(watch.watchDigest({ ...base, items: [a, b] })).toBe(
      watch.watchDigest({ ...base, items: [b, own, a] }),
    );
    expect(watch.watchDigest({ ...base, items: [a] })).not.toBe(
      watch.watchDigest({ ...base, items: [a, b] }),
    );
  });

  test("the pool is low when no shared account has room", () => {
    const account = (five: number, week: number, extra = {}) => ({
      usable: true,
      usage: {
        fiveHour: { utilization: five },
        sevenDay: { utilization: week },
      },
      ...extra,
    });
    expect(watch.watchHeadroomOk([])).toBe(true);
    expect(watch.watchHeadroomOk([account(50, 50)])).toBe(true);
    expect(watch.watchHeadroomOk([account(85, 10), account(10, 95)])).toBe(
      false,
    );
    expect(watch.watchHeadroomOk([account(10, 10, { usable: false })])).toBe(
      false,
    );
    // Personal accounts never serve the watch: they don't count.
    expect(watch.watchHeadroomOk([account(10, 10, { owner: "Bob" })])).toBe(
      true,
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
    expect(
      (await t.project_overview!.handler({ project: "acme" })).content[0]!.text,
    ).toBe("overview of acme");
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
