// The project lead's goal lifecycle, its wake check and the owner's answers,
// on the in-memory kernel with the real goal, project settings and
// supervisor inbox stores, a fake clock and fake push delivery.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProjectLeadPatch } from "../../shared/project-lead";
import type { ProjectSettingsPatch } from "../../shared/project-settings";
import {
  LEAD_UNAVAILABLE_REASON,
  createGoal,
  deleteGoal,
  getGoal,
  listGoals,
  mutateGoal,
  readLedger,
} from "../goals";
import { __setOwnerRosterForTest } from "../incidents/owner";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { __setLegacyEnvironmentForTest } from "../projects/legacy";
import {
  __setProjectStoreContextForTest,
  getProjectDocument,
  projectDocuments,
  updateProjectDocument,
} from "../projects/store";
import {
  __resetSupervisorInboxForTest,
  __setSupervisorInboxDepsForTest,
  answerSupervisorItem,
  listSupervisorItems,
  onSupervisorAnswer,
  setSupervisorPrefs,
} from "../supervisor-inbox";
import {
  KILL_SWITCH_REASON,
  LEAD_OFF_REASON,
  STARTING_REASON,
  __setLeadGoalDepsForTest,
  ensureLeadGoal,
  ensureLeadGoalsAtBoot,
  WAKE_CONDITION_CHECKS,
  handleLeadAnswer,
  leadGoalIdle,
  leadGoalWaiting,
  leadWakeCheck,
  wakeLeadFor,
  wakeLeadOnIncident,
} from "./goal";
import {
  __setLeadApprovalsDepsForTest,
  approve,
  claimApply,
  getRecord,
  listForProject,
  recordProposal,
} from "./approvals";
import type { ConditionResult, LeadCondition } from "./conditions";
import { deliverLeadProposal } from "./report";

useIncidentTestKernel();
const PROJECT = "acme";
let clock = Date.parse("2026-11-10T12:00:00.000Z");
let pushes = 0;
let restoreInbox: () => void = () => {};
let restoreApprovals: () => void = () => {};

beforeEach(() => {
  clock = Date.parse("2026-11-10T12:00:00.000Z");
  pushes = 0;
  __setLegacyEnvironmentForTest({
    projects: () => [PROJECT],
    sandbox: () => ({ perRepo: {} }),
    automations: async () => [],
    mcpServers: async () => [],
    webSearch: async () => "auto",
    defaultReviewServers: async () => [],
  });
  __setProjectStoreContextForTest({
    projectExists: (id) => id === PROJECT,
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  __setOwnerRosterForTest(
    [
      { name: "Ada Lovelace", github: "ada" },
      { name: "Grace Hopper", github: "grace" },
    ] as never,
    "Ada",
  );
  __setLeadGoalDepsForTest({
    now: () => clock,
    projectLabel: () => "Acme",
    isRepo: (id) => id === PROJECT,
  });
  restoreInbox = __setSupervisorInboxDepsForTest({
    now: () => clock,
    notify: async () => {
      pushes++;
      return {};
    },
    markDone: async () => {},
    supervisorSessionId: async (user) => `os-sup-${user}`,
    timeZone: () => "UTC",
  });
  let ids = 0;
  restoreApprovals = __setLeadApprovalsDepsForTest({
    now: () => clock,
    newId: () => `lp-${++ids}`,
  });
});

afterEach(() => {
  restoreApprovals();
  restoreInbox();
  __resetSupervisorInboxForTest();
  __setLeadGoalDepsForTest(undefined);
  __setOwnerRosterForTest(undefined);
  __setLegacyEnvironmentForTest(undefined);
  __setProjectStoreContextForTest(undefined);
});

async function setLead(
  lead: ProjectLeadPatch,
  extra: Omit<ProjectSettingsPatch, "expectedRevision"> = {},
) {
  const { revision } = await getProjectDocument(PROJECT);
  const doc = await updateProjectDocument(
    PROJECT,
    { expectedRevision: revision, lead, ...extra },
    { name: "Ada", verified: true, login: "ada" },
  );
  if ("error" in doc) throw new Error(doc.error);
  return doc;
}

async function leadGoal() {
  const { lead } = await getProjectDocument(PROJECT);
  const goal = lead.goalId ? await getGoal(lead.goalId) : null;
  if (!goal) throw new Error("no lead goal");
  return goal;
}

describe("ensureLeadGoal", () => {
  test("nothing while the lead is off", async () => {
    expect(await ensureLeadGoal(PROJECT)).toEqual({ action: "none" });
    expect((await getProjectDocument(PROJECT)).lead.goalId).toBeUndefined();
  });

  test("turning the lead on creates its goal and stores its id", async () => {
    await setLead({ enabled: true });
    const result = await ensureLeadGoal(PROJECT);
    expect(result.action).toBe("created");
    const doc = await getProjectDocument(PROJECT);
    expect(doc.lead.goalId).toBe((result as { goalId: string }).goalId);
    // A server write: the revision the page loaded stays valid.
    expect(doc.revision).toBe(1);
    const goal = await leadGoal();
    expect(goal).toMatchObject({
      name: "Lead: Acme",
      status: "active",
      mode: "ask",
      repo: PROJECT,
      minWakeMinutes: 60,
      mcpServers: [],
      leadProject: PROJECT,
      createdBy: "Project lead",
    });
    expect(goal.maxWakes).toBeUndefined();
    expect(goal.model).toBeUndefined();
    expect(goal.mission).toStartWith(
      "You are the project lead for Acme (acme).",
    );
    // A second pass changes nothing.
    expect(await ensureLeadGoal(PROJECT)).toEqual({ action: "none" });
  });

  test("two settings writes at once create one goal", async () => {
    await setLead({ enabled: true });
    const [a, b] = await Promise.all([
      ensureLeadGoal(PROJECT),
      ensureLeadGoal(PROJECT),
    ]);
    expect([a.action, b.action].sort()).toEqual(["created", "none"]);
  });

  test("a settings change rewrites the charter", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    await setLead({ budgetUsdPerMonth: 20, owner: "Grace" });
    expect((await ensureLeadGoal(PROJECT)).action).toBe("updated");
    const goal = await leadGoal();
    expect(goal.mission).toContain("report to Grace");
    expect(goal.mission).toContain("cost $20 a month");
  });

  test("off pauses the goal; on makes it active again", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    await setLead({ enabled: false });
    expect((await ensureLeadGoal(PROJECT)).action).toBe("paused");
    expect(await leadGoal()).toMatchObject({
      status: "paused",
      pauseReason: LEAD_OFF_REASON,
    });
    clock += 3_600_000;
    await setLead({ enabled: true });
    expect((await ensureLeadGoal(PROJECT)).action).toBe("resumed");
    const resumed = await leadGoal();
    expect(resumed.status).toBe("active");
    expect(resumed.nextWakeAt).toBe(new Date(clock).toISOString());
  });

  test("a pause or a finish from the goals page or API sticks", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    for (const [status, pauseReason] of [
      ["paused", undefined],
      ["paused", "Paused from the UI"],
      ["paused", "Hit safety cap of 5 wakes — resume to continue."],
      ["done", undefined],
      ["failed", undefined],
    ] as const) {
      await mutateGoal(goal.id, (g) => ({ ...g, status, pauseReason }));
      await ensureLeadGoal(PROJECT);
      const after = await leadGoal();
      expect(after.status).toBe(status);
      expect(after.pauseReason).toBe(pauseReason);
    }
    // Each pause the lead's own rules made lifts once nothing blocks it.
    for (const pauseReason of [
      LEAD_OFF_REASON,
      KILL_SWITCH_REASON,
      STARTING_REASON,
      LEAD_UNAVAILABLE_REASON,
      "Its wake check failed: settings unreadable",
      "Over the lead's budget: $5 of $5 this month",
      "Loop guard: 24 wakes today, the daily limit is 24",
    ]) {
      await mutateGoal(goal.id, (g) => ({
        ...g,
        status: "paused",
        pauseReason,
      }));
      expect((await ensureLeadGoal(PROJECT)).action).toBe("resumed");
      expect((await leadGoal()).status).toBe("active");
    }
  });

  test("the kill switch keeps a paused goal paused", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({ ...g, status: "paused" }));
    await setLead({}, { incidents: { agentsPaused: true } });
    await ensureLeadGoal(PROJECT);
    expect((await leadGoal()).status).toBe("paused");
  });

  test("a new goal waits paused until its id is stored", async () => {
    await setLead({ enabled: true });
    const seen: string[] = [];
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      setGoalId: async (_project, id) => {
        seen.push((await getGoal(id))!.status);
        const { patchProjectDocumentAsServer } =
          await import("../projects/store");
        await patchProjectDocumentAsServer(PROJECT, (d) => ({
          ...d,
          lead: { ...d.lead, goalId: id },
        }));
      },
    });
    expect((await ensureLeadGoal(PROJECT)).action).toBe("created");
    expect(seen).toEqual(["paused"]);
    expect((await leadGoal()).status).toBe("active");
  });

  test("a goal whose id can't be stored is deleted", async () => {
    await setLead({ enabled: true });
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      setGoalId: async () => {
        throw new Error("catalog down");
      },
    });
    await expect(ensureLeadGoal(PROJECT)).rejects.toThrow("catalog down");
    expect(await listGoals()).toEqual([]);
  });

  test("a goal left behind without its id stored is adopted, not doubled", async () => {
    await setLead({ enabled: true });
    const orphan = await createGoal(
      {
        name: "Lead: Acme",
        mission: "Old charter.",
        createdBy: "Project lead",
      },
      { leadProject: PROJECT, pauseReason: STARTING_REASON },
    );
    if ("error" in orphan) throw new Error(orphan.error);
    const result = await ensureLeadGoal(PROJECT);
    expect(result).toEqual({ action: "resumed", goalId: orphan.id });
    expect((await getProjectDocument(PROJECT)).lead.goalId).toBe(orphan.id);
    expect(await listGoals()).toHaveLength(1);
    const adopted = await leadGoal();
    expect(adopted.status).toBe("active");
    expect(adopted.mission).toStartWith("You are the project lead for Acme");
  });

  test("a goal id in the settings that isn't this project's lead is not adopted", async () => {
    await setLead({ enabled: true });
    const plain = await createGoal({
      name: "Flake burndown",
      mission: "Fix flakes.",
      createdBy: "Ada",
    });
    if ("error" in plain) throw new Error(plain.error);
    const { patchProjectDocumentAsServer } = await import("../projects/store");
    await patchProjectDocumentAsServer(PROJECT, (d) => ({
      ...d,
      lead: { ...d.lead, goalId: plain.id },
    }));
    const result = await ensureLeadGoal(PROJECT);
    expect(result.action).toBe("created");
    expect((result as { goalId: string }).goalId).not.toBe(plain.id);
    expect((await getGoal(plain.id))?.leadProject).toBeUndefined();
    expect((await getGoal(plain.id))?.mission).toBe("Fix flakes.");
  });

  test("a deleted goal is created again", async () => {
    await setLead({ enabled: true });
    const first = await ensureLeadGoal(PROJECT);
    await deleteGoal((first as { goalId: string }).goalId);
    const second = await ensureLeadGoal(PROJECT);
    expect(second.action).toBe("created");
    expect((await getProjectDocument(PROJECT)).lead.goalId).toBe(
      (second as { goalId: string }).goalId,
    );
  });
});

describe("leadWakeCheck", () => {
  test("a goal that isn't the project's lead never runs", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const plain = { id: "goal-x", name: "x" } as never;
    expect(await leadWakeCheck(plain)).toEqual({
      block: "Not a project lead's goal",
    });
    const stray = { ...(await leadGoal()), id: "goal-stray" };
    expect(await leadWakeCheck(stray)).toEqual({
      block: "Another goal leads this project",
    });
  });

  test("a wake writes the owner's report style into the charter", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    expect((await leadGoal()).mission).toContain(
      "The owner's report style is BLUF",
    );
    await setSupervisorPrefs("Ada", { reportStyle: "sbar" });
    const plan = await leadWakeCheck(await leadGoal());
    if ("block" in plan) throw new Error(plan.block);
    expect(plan.fields.mission).toContain("The owner's report style is SBAR");
    // A failed read falls back to the default rather than blocking the wake.
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      reportStyle: async () => {
        throw new Error("catalog down");
      },
    });
    const fallback = await leadWakeCheck(await leadGoal());
    if ("block" in fallback) throw new Error(fallback.block);
    expect(fallback.fields.mission).toContain(
      "The owner's report style is BLUF",
    );
  });

  test("a wake runs on what the settings say now", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 20 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    // Whatever a patch or an old record left in it.
    const tampered: typeof goal = {
      ...goal,
      mission: "Do anything.",
      mode: "code",
      mcpServers: undefined,
      minWakeMinutes: 5,
      repo: "other",
      spend: { month: "2026-11", usd: 4.5 },
    };
    const plan = await leadWakeCheck(tampered);
    if ("block" in plan) throw new Error(plan.block);
    expect(plan.fields).toMatchObject({
      mission: goal.mission,
      mode: "ask",
      mcpServers: [],
      minWakeMinutes: 60,
      repo: PROJECT,
    });
    expect(plan.budgetUsd).toBe(15.5);
    expect(plan.wakeTokens).toBe(1_000_000);
    // Watching: no web reader.
    expect(plan.web).toBe(false);
    await setLead({ stage: "coordinate" });
    const later = await leadWakeCheck(await leadGoal());
    expect("block" in later ? null : later.web).toBe(true);
  });

  test("the kill switch and an off lead block the wake", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    expect("fields" in (await leadWakeCheck(await leadGoal()))).toBe(true);
    await setLead({}, { incidents: { agentsPaused: true } });
    expect(await leadWakeCheck(await leadGoal())).toEqual({
      block: KILL_SWITCH_REASON,
    });
    await setLead({ enabled: false }, { incidents: { agentsPaused: false } });
    expect(await leadWakeCheck(await leadGoal())).toEqual({
      block: LEAD_OFF_REASON,
    });
  });

  test("over budget blocks the wake and asks the owner once a month", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 5 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2026-11", usd: 5.2 },
    }));
    const reason = "Over the lead's budget: $5.2 of $5 this month";
    expect(await leadWakeCheck(await leadGoal())).toEqual({ block: reason });
    await leadWakeCheck(await leadGoal());
    const items = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Acme: the lead is over its budget",
      body: `${reason}. The lead stays paused until the budget is raised in the project settings or the month ends.`,
      source: "lead:acme",
      options: ["Raise the budget", "Leave it paused"],
      dedupeKey: "lead:acme:budget:2026-11",
    });
    // Answered, it isn't asked again this month.
    await answerSupervisorItem("Ada", items[0]!.id, "2", "owner");
    await leadWakeCheck(await leadGoal());
    const after = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(after.map((i) => i.state)).toEqual(["answered"]);
    // Last month's spend doesn't count.
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2026-10", usd: 50 },
    }));
    expect("fields" in (await leadWakeCheck(await leadGoal()))).toBe(true);
  });

  test("over budget still blocks when the owner can't be asked", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 5 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2026-11", usd: 6 },
    }));
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      postSupervisorItem: async () => {
        throw new Error("inbox down");
      },
    });
    expect(await leadWakeCheck(await leadGoal())).toEqual({
      block: "Over the lead's budget: $6 of $5 this month",
    });
  });

  test("raising the budget lifts a budget pause", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 5 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Over the lead's budget: $5.2 of $5 this month",
      spend: { month: "2026-11", usd: 5.2 },
    }));
    await setLead({ budgetUsdPerMonth: 10 });
    expect((await ensureLeadGoal(PROJECT)).action).toBe("resumed");
  });
});

describe("the loop guard", () => {
  test("no dollar cap by default: spend never blocks", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2026-11", usd: 900 },
    }));
    const plan = await leadWakeCheck(await leadGoal());
    if ("block" in plan) throw new Error(plan.block);
    expect(plan.budgetUsd).toBeNull();
  });

  test("the daily wake limit pauses, asks once, and Resume lifts it for the day", async () => {
    await setLead({ enabled: true, dailyWakeLimit: 3 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      guard: { day: "2026-11-10", wakes: 2 },
    }));
    expect("fields" in (await leadWakeCheck(await leadGoal()))).toBe(true);
    await mutateGoal(goal.id, (g) => ({
      ...g,
      guard: { day: "2026-11-10", wakes: 3 },
    }));
    const reason = "Loop guard: 3 wakes today, the daily limit is 3";
    expect(await leadWakeCheck(await leadGoal())).toEqual({ block: reason });
    await leadWakeCheck(await leadGoal());
    const items = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Acme: the lead paused itself",
      body: "3 wakes today, the daily limit is 3. The lead may be stuck in a loop. Resume lets it run for the rest of today; otherwise it starts again tomorrow.",
      options: ["Resume", "Keep paused"],
      dedupeKey: "lead:acme:guard:wakes:2026-11-10",
    });
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: reason,
    }));
    onSupervisorAnswer("lead:", handleLeadAnswer);
    await answerSupervisorItem("Ada", items[0]!.id, "1", "owner");
    const resumed = await leadGoal();
    expect(resumed.status).toBe("active");
    expect(resumed.guard).toMatchObject({ day: "2026-11-10", lifted: true });
    expect("fields" in (await leadWakeCheck(resumed))).toBe(true);
  });

  test("Keep paused leaves it paused until the next day", async () => {
    await setLead({ enabled: true, dailyWakeLimit: 1 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    const reason = "Loop guard: 1 wakes today, the daily limit is 1";
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: reason,
      guard: { day: "2026-11-10", wakes: 1 },
    }));
    await leadWakeCheck(await leadGoal());
    const [item] = await listSupervisorItems("Ada", { kind: "needs-you" });
    await handleLeadAnswer(item!, "Keep paused", "owner");
    expect((await leadGoal()).status).toBe("paused");
    await leadGoalIdle(await leadGoal(), clock);
    expect((await leadGoal()).status).toBe("paused");
    clock = Date.parse("2026-11-11T00:05:00.000Z");
    await leadGoalIdle(await leadGoal(), clock);
    expect((await leadGoal()).status).toBe("active");
  });

  test("a wake past its token limit holds the lead 12 hours, across midnight", async () => {
    clock = Date.parse("2026-11-10T20:00:00.000Z");
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      guard: {
        day: "2026-11-10",
        wakes: 1,
        trips: 1,
        trippedAt: new Date(clock).toISOString(),
        trippedTokens: 1_250_000,
      },
    }));
    const block = {
      block:
        "Loop guard: a wake used 1,250,000 tokens, over its limit of 1,000,000",
    };
    expect(await leadWakeCheck(await leadGoal())).toEqual(block);
    const [item] = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(item).toMatchObject({
      body: "A wake used 1,250,000 tokens, over its limit of 1,000,000. The lead may be stuck in a loop. Resume lets it run again; otherwise it waits 12 hours.",
      dedupeKey: "lead:acme:guard:trip:1",
    });
    clock = Date.parse("2026-11-11T07:59:00.000Z");
    expect(await leadWakeCheck(await leadGoal())).toEqual(block);
    clock = Date.parse("2026-11-11T08:00:00.000Z");
    expect("fields" in (await leadWakeCheck(await leadGoal()))).toBe(true);
  });

  test("a trip after a Resume pauses again and asks again, under a new key", async () => {
    await setLead({ enabled: true, dailyWakeLimit: 3 });
    await ensureLeadGoal(PROJECT);
    onSupervisorAnswer("lead:", handleLeadAnswer);
    const goal = await leadGoal();
    // The owner resumed today's wake limit...
    await mutateGoal(goal.id, (g) => ({
      ...g,
      guard: { day: "2026-11-10", wakes: 3, lifted: true },
    }));
    expect("fields" in (await leadWakeCheck(await leadGoal()))).toBe(true);
    // ...then a wake tripped (goal-runner clears the Resume when it does).
    const trip = (trips: number) =>
      mutateGoal(goal.id, (g) => ({
        ...g,
        guard: {
          day: "2026-11-10",
          wakes: 4,
          trips,
          trippedAt: new Date(clock).toISOString(),
          trippedTokens: 1_100_000,
        },
      }));
    await trip(1);
    const first = await leadWakeCheck(await leadGoal());
    expect("block" in first).toBe(true);
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: (first as { block: string }).block,
    }));
    const [item1] = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(item1!.dedupeKey).toBe("lead:acme:guard:trip:1");
    await answerSupervisorItem("Ada", item1!.id, "1", "owner");
    const resumed = await leadGoal();
    expect(resumed.status).toBe("active");
    // The Resume lifts the trip and today's wake limit, which the trip had
    // cleared.
    expect(resumed.guard).toEqual({
      day: "2026-11-10",
      wakes: 4,
      trips: 1,
      lifted: true,
    });
    await trip(2);
    expect("block" in (await leadWakeCheck(await leadGoal()))).toBe(true);
    const keys = (await listSupervisorItems("Ada", { kind: "needs-you" })).map(
      (i) => i.dedupeKey,
    );
    expect(keys).toContain("lead:acme:guard:trip:2");
    expect(keys.filter((k) => k === "lead:acme:guard:trip:2")).toHaveLength(1);
  });

  test("wakes count on the owner's local day", async () => {
    restoreInbox();
    restoreInbox = __setSupervisorInboxDepsForTest({
      now: () => clock,
      notify: async () => ({}),
      markDone: async () => {},
      supervisorSessionId: async (user) => `os-sup-${user}`,
      timeZone: () => "Pacific/Auckland",
    });
    // 12:00 UTC is already the 11th in Auckland.
    await setLead({ enabled: true, dailyWakeLimit: 1 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      guard: { day: "2026-11-10", wakes: 1 },
    }));
    const plan = await leadWakeCheck(await leadGoal());
    if ("block" in plan) throw new Error(plan.block);
    expect(plan.day).toBe("2026-11-11");
  });
});

describe("waiting for headroom", () => {
  test("a day of waiting tells the owner once", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const since = new Date(clock).toISOString();
    const waiting = {
      reason: "Your Claude accounts are near their limits",
      since,
    };
    await leadGoalWaiting({ ...(await leadGoal()), waiting }, clock + 60_000);
    expect(await listSupervisorItems("Ada", { kind: "needs-you" })).toEqual([]);
    const later = clock + 24 * 60 * 60_000;
    await leadGoalWaiting({ ...(await leadGoal()), waiting }, later);
    await leadGoalWaiting({ ...(await leadGoal()), waiting }, later + 60_000);
    const items = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Acme: the lead has waited a day to run",
      body: "Your Claude accounts are near their limits, so its wakes wait. It runs again once there is room.",
    });
  });
});

describe("leadGoalIdle", () => {
  test("a budget pause lapses when the month turns", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 5 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Over the lead's budget: $5.2 of $5 this month",
      spend: { month: "2026-11", usd: 5.2 },
    }));
    // Same month: stays paused.
    await leadGoalIdle(await leadGoal(), clock);
    expect((await leadGoal()).status).toBe("paused");
    clock = Date.parse("2026-12-01T00:01:00.000Z");
    await leadGoalIdle(await leadGoal(), clock);
    expect(await leadGoal()).toMatchObject({
      status: "active",
      nextWakeAt: new Date(clock).toISOString(),
    });
  });

  test("a pause the runner made is retried every ten minutes", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    const pause = () =>
      mutateGoal(goal.id, (g) => ({
        ...g,
        status: "paused",
        pauseReason: LEAD_UNAVAILABLE_REASON,
      }));
    await pause();
    await leadGoalIdle(await leadGoal(), clock);
    expect((await leadGoal()).status).toBe("active");
    await pause();
    await leadGoalIdle(await leadGoal(), clock + 60_000);
    expect((await leadGoal()).status).toBe("paused");
    await leadGoalIdle(await leadGoal(), clock + 11 * 60_000);
    expect((await leadGoal()).status).toBe("active");
  });

  test("a lapsed pause that stays blocked is retried at most every ten minutes", async () => {
    await setLead(
      { enabled: true, budgetUsdPerMonth: 5 },
      { incidents: { agentsPaused: true } },
    );
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Over the lead's budget: $5 of $5 this month",
      spend: { month: "2026-10", usd: 5 },
    }));
    let reads = 0;
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      projectDocument: async (project) => {
        reads++;
        return getProjectDocument(project);
      },
    });
    for (let minute = 0; minute < 10; minute++)
      await leadGoalIdle(await leadGoal(), clock + minute * 60_000);
    expect(reads).toBe(1);
    await leadGoalIdle(await leadGoal(), clock + 10 * 60_000);
    expect(reads).toBe(2);
    expect((await leadGoal()).status).toBe("paused");
  });

  test("other pauses are left to the settings", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Paused from the UI",
    }));
    await leadGoalIdle(await leadGoal(), clock);
    expect((await leadGoal()).status).toBe("paused");
  });
});

describe("the owner's answers", () => {
  test("land in the ledger and wake the lead; watch applies nothing", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      nextWakeAt: "2026-11-10T18:00:00.000Z",
    }));
    onSupervisorAnswer("lead:", handleLeadAnswer);
    const doc = await getProjectDocument(PROJECT);
    const delivered = await deliverLeadProposal(
      PROJECT,
      doc,
      {
        kind: "proposal",
        category: "signal-rule-change",
        title: "Status page flaps",
        body: "16 incidents closed by themselves.",
        options: ["Raise to 8 failures", "Leave it"],
        subject: "sig-status consecutive.failures",
        decision: {
          level: "asks-first",
          effective: "ask",
          rule: "Asks first: Signal rule changes, from the project settings",
        },
      },
      "Acme",
    );
    if (!delivered.queued) throw new Error(delivered.reason);
    clock += 60_000;
    const answered = await answerSupervisorItem(
      "Ada",
      delivered.itemId,
      "1",
      "owner",
    );
    expect(answered.ok).toBe(true);
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain(
      'Owner answered "Acme: Signal rule changes" (lead:acme:signal-rule-change:sig-status consecutive.failures): Raise to 8 failures',
    );
    expect(ledger).toContain("Watch stage: nothing was applied.");
    expect((await leadGoal()).nextWakeAt).toBe(new Date(clock).toISOString());
    // The signal itself was never touched: the lead has no tool that could.
  });

  test("answers to other sources are not the lead's", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const before = await readLedger(await leadGoal());
    await handleLeadAnswer(
      { source: "supervisor", title: "x" } as never,
      "yes",
      "owner",
    );
    expect(await readLedger(await leadGoal())).toBe(before);
  });

  test("an answer the supervisor recorded approves nothing", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Paused from the UI",
      nextWakeAt: "2026-11-10T18:00:00.000Z",
    }));
    await handleLeadAnswer(
      {
        source: "lead:acme",
        title: "Acme: Signal rule changes",
        dedupeKey: "lead:acme:signal-rule-change:x",
      } as never,
      "Approve",
      "supervisor",
    );
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain(
      'The supervisor recorded an answer to "Acme: Signal rule changes" (lead:acme:signal-rule-change:x): Approve',
    );
    expect(ledger).toContain("it approves nothing");
    expect(ledger).not.toContain("Owner answered");
    // Neither resumed nor woken.
    expect(await leadGoal()).toMatchObject({
      status: "paused",
      nextWakeAt: "2026-11-10T18:00:00.000Z",
    });
  });

  test("the owner's answer resumes a lead from its own pause and wakes it", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: LEAD_UNAVAILABLE_REASON,
    }));
    clock += 60_000;
    await handleLeadAnswer(
      { source: "lead:acme", title: "Acme: CI repair", user: "Ada" } as never,
      "Approve",
      "owner",
    );
    expect(await leadGoal()).toMatchObject({
      status: "active",
      nextWakeAt: new Date(clock).toISOString(),
    });
  });

  test("the owner's answer leaves a pause from the goals page alone", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Paused from the UI",
    }));
    await handleLeadAnswer(
      { source: "lead:acme", title: "Acme: CI repair", user: "ada" } as never,
      "Approve",
      "owner",
    );
    expect(await readLedger(await leadGoal())).toContain(
      'Owner answered "Acme: CI repair": Approve',
    );
    expect((await leadGoal()).status).toBe("paused");
  });

  test("an answer from someone who isn't the lead's owner approves nothing", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      nextWakeAt: "2026-11-10T18:00:00.000Z",
    }));
    await handleLeadAnswer(
      { source: "lead:acme", title: "Acme: CI repair", user: "Grace" } as never,
      "Approve",
      "owner",
    );
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain('Grace answered "Acme: CI repair": Approve');
    expect(ledger).toContain("not the lead's owner now");
    expect(ledger).not.toContain("Owner answered");
    expect((await leadGoal()).nextWakeAt).toBe("2026-11-10T18:00:00.000Z");
  });
});

describe("the owner's answer approves the proposal it saw", () => {
  const ADA = { login: "ada" };
  const SHA = "a".repeat(40);

  beforeEach(async () => {
    await setLead({ enabled: true, stage: "act" });
    await ensureLeadGoal(PROJECT);
    onSupervisorAnswer("lead:", handleLeadAnswer);
  });

  /** A lead proposal delivered to Ada's inbox as an item, and, unless
   *  `record` is false, the act proposal recorded for that item. */
  async function proposed(
    subject: string,
    extra: { condition?: unknown; record?: boolean } = {},
  ) {
    const delivered = await deliverLeadProposal(
      PROJECT,
      await getProjectDocument(PROJECT),
      {
        kind: "proposal",
        category: "fix-verified",
        title: "Merge the checkout fix",
        body: "The fix is verified on a preview.",
        options: ["Merge it", "Leave it"],
        subject,
        decision: {
          level: "asks-first",
          effective: "ask",
          rule: "Asks first: Verified fixes, from the project settings",
        },
      },
      "Acme",
    );
    if (!delivered.queued) throw new Error(delivered.reason);
    const item = (await listSupervisorItems("Ada")).find(
      (i) => i.id === delivered.itemId,
    )!;
    let proposalId: string | undefined;
    if (extra.record !== false) {
      const recorded = await recordProposal({
        project: PROJECT,
        category: "fix-verified",
        subject,
        itemId: item.id,
        itemRevision: item.updatedAt,
        steps: [
          { kind: "merge-pr", ghRepo: "acme/api", number: 42, headSha: SHA },
        ],
        ...(extra.condition ? { condition: extra.condition } : {}),
      });
      if (!recorded.ok) throw new Error(recorded.error);
      proposalId = recorded.value.id;
    }
    clock += 60_000;
    return { item, proposalId };
  }

  async function record(proposalId: string | undefined) {
    return (await getRecord(PROJECT, proposalId!))!;
  }

  test("the first option, signed in, at the current revision: ready at once", async () => {
    const { item, proposalId } = await proposed("PR 42");
    const answered = await answerSupervisorItem("Ada", item.id, "1", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect(answered.ok).toBe(true);
    expect((await record(proposalId)).approval).toMatchObject({
      approvedBy: "Ada",
      login: "ada",
      at: clock,
      state: "ready",
      expiresAt: clock + 7 * 24 * 60 * 60_000,
    });
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain(
      "Approved: Acme: Fixes verified by a second agent. Ready to apply.",
    );
    expect(ledger).not.toContain("Watch stage: nothing was applied.");
  });

  test("a proposal with a condition waits for it", async () => {
    const condition = { kind: "pr-merged", ghRepo: "acme/api", number: 41 };
    const { item, proposalId } = await proposed("PR 42", { condition });
    await answerSupervisorItem("Ada", item.id, "Merge it", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toMatchObject({
      state: "waiting",
      condition,
    });
    expect(await readLedger(await leadGoal())).toContain(
      "Approved: Acme: Fixes verified by a second agent. Runs when PR #41 in acme/api is merged.",
    );
  });

  test.each([
    ["with a condition: waiting", true],
    ["without one: ready", false],
  ] as const)(
    "the lead proposes steps, the owner approves %s",
    async (_case, withCondition) => {
      const condition = {
        kind: "pr-merged",
        ghRepo: "acme/api",
        number: 41,
      } as const;
      const steps = [
        { kind: "merge-pr", ghRepo: "acme/api", number: 42, headSha: SHA },
      ] as const;
      const expiresAt = clock + 3 * 24 * 60 * 60_000;
      const delivered = await deliverLeadProposal(
        PROJECT,
        await getProjectDocument(PROJECT),
        {
          kind: "proposal",
          category: "fix-verified",
          title: "Merge the checkout fix",
          body: "The fix is verified on a preview.",
          options: ["Merge it", "Leave it"],
          subject: "PR 42",
          decision: {
            level: "asks-first",
            effective: "ask",
            rule: "Asks first: Verified fixes, from the project settings",
          },
          act: {
            steps: [...steps],
            ...(withCondition ? { condition } : {}),
            expiresAt,
            signalNames: {},
          },
        },
        "Acme",
      );
      if (!delivered.queued) throw new Error(delivered.reason);
      expect(delivered.proposalId).toBeDefined();
      const item = (await listSupervisorItems("Ada")).find(
        (i) => i.id === delivered.itemId,
      )!;
      const recorded = await record(delivered.proposalId);
      expect(recorded.proposal).toMatchObject({
        itemId: item.id,
        itemRevision: item.updatedAt,
        steps,
        expiresAt,
      });
      clock += 60_000;
      const answered = await answerSupervisorItem(
        "Ada",
        item.id,
        "1",
        "owner",
        { ...ADA, revision: item.updatedAt },
      );
      expect(answered.ok).toBe(true);
      const approval = (await record(delivered.proposalId)).approval;
      expect(approval).toMatchObject({
        approvedBy: "Ada",
        login: "ada",
        expiresAt,
        state: withCondition ? "waiting" : "ready",
      });
      if (withCondition) expect(approval?.condition).toEqual(condition);
      else expect(approval?.condition).toBeUndefined();
    },
  );

  test.each([
    ["free text", "Merge it, but tomorrow", { ...ADA, rev: true }],
    ["no signed-in login", "1", { rev: true }],
    ["an old client without a revision", "1", ADA],
  ] as const)("%s approves nothing", async (_case, answer, context) => {
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, answer, "owner", {
      ...("login" in context ? { login: context.login } : {}),
      ...("rev" in context ? { revision: item.updatedAt } : {}),
    });
    const after = await record(proposalId);
    expect(after.approval).toBeUndefined();
    expect(after.proposal.voidedAt).toBeUndefined();
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain("Owner answered");
    expect(ledger).not.toContain("Approved:");
  });

  test("an answer the supervisor recorded approves nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "1", "supervisor", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
    expect(await readLedger(await leadGoal())).toContain("approves nothing");
  });

  test("an answer from someone who isn't the lead's owner approves nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    await handleLeadAnswer({ ...item, user: "Grace" }, "Merge it", "owner", {
      login: "grace",
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
    expect(await readLedger(await leadGoal())).toContain(
      "not the lead's owner now",
    );
  });

  test("an item that changed since the owner read it approves nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    // The lead updates the item; the owner answers what they saw before.
    await proposed("PR 42", { record: false });
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
  });

  test("a proposal recorded for an earlier revision of the item approves nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    // The item moved on, with no proposal recorded for what it says now.
    await proposed("PR 42", { record: false });
    const current = (await listSupervisorItems("Ada")).find(
      (i) => i.id === item.id,
    )!;
    expect(current.updatedAt).not.toBe(item.updatedAt);
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      ...ADA,
      revision: current.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
    expect(await readLedger(await leadGoal())).not.toContain("Approved:");
  });

  test("without a recorded proposal the answer stays in the ledger", async () => {
    const { item } = await proposed("PR 42", { record: false });
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect(await listForProject(PROJECT)).toEqual([]);
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain("Owner answered");
    expect(ledger).toContain("Nothing was applied by answering");
    expect(ledger).not.toContain("Approved:");
  });

  test("at the watch stage the first option approves nothing", async () => {
    await setLead({ stage: "watch" });
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain("Watch stage: nothing was applied.");
    expect(ledger).not.toContain("Approved:");
  });

  test("someone sharing the owner's first name approves nothing", async () => {
    __setOwnerRosterForTest(
      [
        { name: "Ada Lovelace", github: "ada" },
        { name: "Ada Byron", github: "ada-byron" },
      ] as never,
      "Ada",
    );
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      login: "Ada-Byron",
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
    expect(await readLedger(await leadGoal())).not.toContain("Approved:");
  });

  test("the owner's login is matched in any case", async () => {
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      login: "ADA",
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval?.state).toBe("ready");
  });

  test("an owner with no GitHub login on the team approves nothing", async () => {
    __setOwnerRosterForTest(
      [
        { name: "Ada Lovelace" },
        { name: "Grace Hopper", github: "grace" },
      ] as never,
      "Ada",
    );
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "1", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).approval).toBeUndefined();
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain("has no GitHub login on the team");
    expect(ledger).not.toContain("Approved:");
  });

  test("any other option voids the item's proposal", async () => {
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "2", "owner", {
      ...ADA,
      revision: item.updatedAt,
    });
    const after = await record(proposalId);
    expect(after.approval).toBeUndefined();
    expect(after.proposal).toMatchObject({
      voidedAt: clock,
      voidReason: "declined",
    });
  });

  test("a decline the supervisor recorded voids nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    await answerSupervisorItem("Ada", item.id, "2", "supervisor", {
      ...ADA,
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).proposal.voidedAt).toBeUndefined();
  });

  test("a decline from a former owner voids nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    await handleLeadAnswer({ ...item, user: "Grace" }, "Leave it", "owner", {
      login: "grace",
      revision: item.updatedAt,
    });
    expect((await record(proposalId)).proposal.voidedAt).toBeUndefined();
  });

  test("answering again changes nothing", async () => {
    const { item, proposalId } = await proposed("PR 42");
    const context = { ...ADA, revision: item.updatedAt };
    const answered = await answerSupervisorItem(
      "Ada",
      item.id,
      "1",
      "owner",
      context,
    );
    if (!answered.ok) throw new Error(answered.error);
    const first = (await record(proposalId)).approval;
    expect(first?.state).toBe("ready");
    clock += 60_000;
    expect(
      await answerSupervisorItem("Ada", item.id, "1", "owner", context),
    ).toEqual({ ok: false, error: "closed" });
    await handleLeadAnswer(answered.item, "Merge it", "owner", context);
    expect((await record(proposalId)).approval).toEqual(first);
    expect(await listForProject(PROJECT)).toHaveLength(1);
  });
});

describe("approvals on a wake", () => {
  const SHA = "a".repeat(40);
  const PR41 = { kind: "pr-merged", ghRepo: "acme/api", number: 41 } as const;
  const TITLE = "Acme: Fixes verified by a second agent";
  let checks: LeadCondition[] = [];
  let verdict: (c: LeadCondition) => Promise<ConditionResult>;

  beforeEach(async () => {
    checks = [];
    verdict = async () => ({ status: "not-met", reason: "not yet" });
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      checkCondition: (c) => {
        checks.push(c);
        return verdict(c);
      },
    });
    await setLead({ enabled: true, stage: "act" });
    await ensureLeadGoal(PROJECT);
  });

  /** A recorded proposal the owner approved, waiting on `condition` or
   *  ready without one. */
  async function approved(
    n: number,
    condition?: LeadCondition,
    expiresAt?: number,
  ) {
    const recorded = await recordProposal({
      project: PROJECT,
      category: "fix-verified",
      subject: `PR ${n}`,
      itemId: `item-${n}`,
      itemRevision: 1,
      steps: [
        { kind: "merge-pr", ghRepo: "acme/api", number: n, headSha: SHA },
      ],
      ...(condition ? { condition } : {}),
    });
    if (!recorded.ok) throw new Error(recorded.error);
    const result = await approve({
      project: PROJECT,
      proposalId: recorded.value.id,
      approvedBy: "Ada",
      login: "ada",
      condition,
      expiresAt,
      itemRevision: 1,
    });
    if (!result.ok) throw new Error(result.error);
    return recorded.value.id;
  }

  async function wake() {
    const plan = await leadWakeCheck(await leadGoal());
    if ("block" in plan) throw new Error(plan.block);
    return plan.approvals ?? [];
  }

  const readyItems = async () =>
    (await listSupervisorItems("Ada")).filter((i) =>
      i.title.startsWith("Ready to apply"),
    );

  test("a met condition moves the approval to ready, lists it and tells the owner once", async () => {
    const id = await approved(42, PR41);
    verdict = async () => ({ status: "met" });
    expect(await wake()).toEqual([
      `Ready to apply: ${TITLE} (proposal ${id}). Call lead_apply.`,
    ]);
    expect(checks).toEqual([PR41]);
    expect((await getRecord(PROJECT, id))?.approval?.state).toBe("ready");
    const [item, ...rest] = await readyItems();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      kind: "fyi",
      title: `Ready to apply: ${TITLE}`,
      dedupeKey: `lead:${PROJECT}:ready:${id}`,
    });
    expect(item!.body).toBe(
      `PR #41 in acme/api is merged, so the lead can apply what you approved.\n\nSteps:\n1. Merge PR #42 in acme/api at aaaaaaa`,
    );
    // Ready now: the next wake lists it without checking again or posting.
    checks = [];
    clock += 60_000;
    expect(await wake()).toEqual([
      `Ready to apply: ${TITLE} (proposal ${id}). Call lead_apply.`,
    ]);
    expect(checks).toEqual([]);
    expect(await readyItems()).toHaveLength(1);
  });

  test("an unmet, unknown or failing check leaves it waiting with its condition", async () => {
    const id = await approved(42, PR41);
    const waiting = [
      `Waiting: ${TITLE} (proposal ${id}). Runs when PR #41 in acme/api is merged.`,
    ];
    expect(await wake()).toEqual(waiting);
    verdict = async () => ({ status: "unknown", reason: "GitHub is down" });
    expect(await wake()).toEqual(waiting);
    verdict = async () => {
      throw new Error("boom");
    };
    expect(await wake()).toEqual(waiting);
    expect((await getRecord(PROJECT, id))?.approval?.state).toBe("waiting");
    expect(await readyItems()).toEqual([]);
  });

  test("ready approvals come first; each condition reads in fixed copy", async () => {
    const plain = await approved(40);
    const green = await approved(43, {
      kind: "checks-green",
      ghRepo: "acme/api",
      number: 43,
      headSha: SHA,
    });
    const incident = await approved(44, {
      kind: "incident-resolved",
      id: "inc-1",
    });
    expect(await wake()).toEqual([
      `Ready to apply: ${TITLE} (proposal ${plain}). Call lead_apply.`,
      `Waiting: ${TITLE} (proposal ${green}). Runs when checks pass on PR #43 in acme/api at aaaaaaa.`,
      `Waiting: ${TITLE} (proposal ${incident}). Runs when incident inc-1 is resolved.`,
    ]);
    // No fyi for an approval that was ready when the owner gave it.
    expect(await readyItems()).toEqual([]);
  });

  test("one wake checks a bounded number of conditions, the next wake the rest", async () => {
    for (let n = 1; n <= WAKE_CONDITION_CHECKS + 2; n++)
      await approved(100 + n, {
        kind: "pr-merged",
        ghRepo: "acme/api",
        number: n,
      });
    await wake();
    expect(checks).toHaveLength(WAKE_CONDITION_CHECKS);
    const first = new Set(checks.map((c) => (c as typeof PR41).number));
    checks = [];
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({ ...g, wakeCount: g.wakeCount + 1 }));
    await wake();
    const second = checks.map((c) => (c as typeof PR41).number);
    expect(second).toHaveLength(WAKE_CONDITION_CHECKS);
    expect(new Set([...first, ...second]).size).toBe(WAKE_CONDITION_CHECKS + 2);
  });

  test("expired approvals are voided and interrupted applies settled", async () => {
    const old = await approved(42, PR41, clock + 24 * 60 * 60_000);
    const stuck = await approved(45);
    const claimed = await claimApply(PROJECT, stuck, "claim-1");
    if (!claimed.ok) throw new Error(claimed.error);
    clock += 25 * 60 * 60_000;
    expect(await wake()).toEqual([]);
    expect(checks).toEqual([]);
    const expired = (await listForProject(PROJECT)).find(
      (r) => r.proposal.id === old,
    );
    expect(expired?.approval).toMatchObject({
      state: "void",
      reason: "expired",
    });
    expect((await getRecord(PROJECT, stuck))?.approval).toMatchObject({
      state: "partial",
      reason: "interrupted",
    });
  });

  test("before the act stage nothing is checked or listed", async () => {
    await approved(42, PR41);
    verdict = async () => ({ status: "met" });
    await setLead({ stage: "coordinate" });
    expect(await wake()).toEqual([]);
    expect(checks).toEqual([]);
  });

  describe("event wakes", () => {
    async function wakeLater() {
      const goal = await leadGoal();
      const later = new Date(clock + 6 * 60 * 60_000).toISOString();
      await mutateGoal(goal.id, (g) => ({ ...g, nextWakeAt: later }));
      return later;
    }

    test("a merged PR an approval waits on wakes the lead now", async () => {
      await approved(42, PR41);
      const later = await wakeLater();
      expect(
        await wakeLeadFor(PROJECT, {
          kind: "pr-merged",
          ghRepo: "acme/api",
          number: 40,
        }),
      ).toBe(false);
      expect(
        await wakeLeadFor(PROJECT, {
          kind: "pr-merged",
          ghRepo: "acme/other",
          number: 41,
        }),
      ).toBe(false);
      expect((await leadGoal()).nextWakeAt).toBe(later);
      expect(
        await wakeLeadFor(PROJECT, {
          kind: "pr-merged",
          ghRepo: "ACME/api",
          number: 41,
        }),
      ).toBe(true);
      expect((await leadGoal()).nextWakeAt).toBe(new Date(clock).toISOString());
    });

    test("a ready or voided approval wakes nothing", async () => {
      await approved(41);
      await wakeLater();
      expect(
        await wakeLeadFor(PROJECT, {
          kind: "pr-merged",
          ghRepo: "acme/api",
          number: 41,
        }),
      ).toBe(false);
    });

    test("an incident that resolves wakes the lead waiting on it, once", async () => {
      await approved(42, { kind: "incident-resolved", id: "inc-1" });
      const later = await wakeLater();
      const incident = { id: "inc-1", project: PROJECT, state: "resolved" };
      expect(
        await wakeLeadOnIncident(incident as never, { state: "resolved" }),
      ).toBe(false);
      expect(
        await wakeLeadOnIncident(
          { ...incident, id: "inc-2" } as never,
          {
            state: "open",
          } as never,
        ),
      ).toBe(false);
      expect((await leadGoal()).nextWakeAt).toBe(later);
      expect(
        await wakeLeadOnIncident(incident as never, { state: "open" } as never),
      ).toBe(true);
      expect((await leadGoal()).nextWakeAt).toBe(new Date(clock).toISOString());
    });

    test("a lead that is off is not woken", async () => {
      await approved(42, PR41);
      const later = await wakeLater();
      await setLead({ enabled: false });
      expect(
        await wakeLeadFor(PROJECT, {
          kind: "pr-merged",
          ghRepo: "acme/api",
          number: 41,
        }),
      ).toBe(false);
      expect((await leadGoal()).nextWakeAt).toBe(later);
    });
  });
});

describe("ensureLeadGoalsAtBoot", () => {
  test("brings every lead's goal in line, retrying a failure later", async () => {
    await setLead({ enabled: true });
    const retries: Array<{ fn: () => void; ms: number }> = [];
    let lists = 0;
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      listProjectDocuments: async () => {
        if (++lists === 1) throw new Error("catalog down");
        return [await getProjectDocument(PROJECT)];
      },
      later: (fn, ms) => {
        retries.push({ fn, ms });
      },
    });
    await ensureLeadGoalsAtBoot();
    expect(await listGoals()).toEqual([]);
    expect(retries.map((r) => r.ms)).toEqual([60_000]);
    retries[0]!.fn();
    const active = async () =>
      (await listGoals()).some((g) => g.status === "active");
    for (let i = 0; i < 100 && !(await active()); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await leadGoal()).status).toBe("active");
    expect(retries).toHaveLength(1);
  });

  test("a project whose ensure fails is retried with a longer delay", async () => {
    await setLead({ enabled: true });
    const retries: number[] = [];
    __setLeadGoalDepsForTest({
      now: () => clock,
      projectLabel: () => "Acme",
      isRepo: (id) => id === PROJECT,
      setGoalId: async () => {
        throw new Error("catalog down");
      },
      later: (_fn, ms) => {
        retries.push(ms);
      },
    });
    await ensureLeadGoalsAtBoot(20 * 60_000);
    expect(retries).toEqual([20 * 60_000]);
  });

  test("a lead held at a $0 budget before the loop guards stays off", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    const held = "Over the lead's budget: $0 of $0 this month";
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: held,
    }));
    // The block as an older build stored it: a $0 budget, no guard fields.
    const doc = await getProjectDocument(PROJECT);
    const {
      dailyWakeLimit: _w,
      wakeTokenLimit: _t,
      ...older
    } = doc.lead as unknown as Record<string, unknown>;
    await projectDocuments().set(PROJECT, {
      ...doc,
      lead: { ...older, budgetUsdPerMonth: 0 },
      revision: doc.revision + 1,
    } as never);
    expect((await getProjectDocument(PROJECT)).lead.enabled).toBe(false);
    await ensureLeadGoalsAtBoot();
    expect(await leadGoal()).toMatchObject({
      status: "paused",
      pauseReason: held,
    });
  });

  test("leaves projects whose lead was never on alone", async () => {
    const retries: number[] = [];
    __setLeadGoalDepsForTest({
      now: () => clock,
      listProjectDocuments: async () => [await getProjectDocument(PROJECT)],
      later: (_fn, ms) => {
        retries.push(ms);
      },
    });
    await ensureLeadGoalsAtBoot();
    expect(await listGoals()).toEqual([]);
    expect(retries).toEqual([]);
  });
});
