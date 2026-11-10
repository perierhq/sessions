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
  handleLeadAnswer,
  leadGoalIdle,
  leadWakeCheck,
} from "./goal";
import { deliverLeadProposal } from "./report";

useIncidentTestKernel();
const PROJECT = "acme";
let clock = Date.parse("2026-11-10T12:00:00.000Z");
let pushes = 0;
let restoreInbox: () => void = () => {};

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
});

afterEach(() => {
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
    expect(goal.mission).toContain("may cost $20 a month");
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

  test("a $0 budget's pause is retried at most every ten minutes", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 0 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Over the lead's budget: $0 of $0 this month",
      spend: { month: "2026-10", usd: 0.5 },
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
