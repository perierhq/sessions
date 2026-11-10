// The project lead's goal lifecycle, its wake check and the owner's answers,
// on the in-memory kernel with the real goal, project settings and
// supervisor inbox stores, a fake clock and fake push delivery.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProjectLeadPatch } from "../../shared/project-lead";
import type { ProjectSettingsPatch } from "../../shared/project-settings";
import { getGoal, mutateGoal, readLedger } from "../goals";
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
} from "../supervisor-inbox";
import {
  KILL_SWITCH_REASON,
  LEAD_OFF_REASON,
  __setLeadGoalDepsForTest,
  ensureLeadGoal,
  handleLeadAnswer,
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

  test("off pauses the goal, on resumes it; someone else's pause stays", async () => {
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

    await mutateGoal(resumed.id, (g) => ({
      ...g,
      status: "paused",
      pauseReason: "Waiting on the owner",
    }));
    await setLead({ stage: "watch", budgetUsdPerMonth: 40 });
    await ensureLeadGoal(PROJECT);
    expect(await leadGoal()).toMatchObject({
      status: "paused",
      pauseReason: "Waiting on the owner",
    });
  });

  test("a deleted goal is created again", async () => {
    await setLead({ enabled: true });
    const first = await ensureLeadGoal(PROJECT);
    await (
      await import("../goals")
    ).deleteGoal((first as { goalId: string }).goalId);
    const second = await ensureLeadGoal(PROJECT);
    expect(second.action).toBe("created");
    expect((await getProjectDocument(PROJECT)).lead.goalId).toBe(
      (second as { goalId: string }).goalId,
    );
  });
});

describe("leadWakeCheck", () => {
  test("other goals are never blocked", async () => {
    const goal = { id: "goal-x", name: "x" } as never;
    expect(await leadWakeCheck(goal)).toBeNull();
  });

  test("the kill switch and an off lead block the wake", async () => {
    await setLead({ enabled: true });
    await ensureLeadGoal(PROJECT);
    expect(await leadWakeCheck(await leadGoal())).toBeNull();
    await setLead({}, { incidents: { agentsPaused: true } });
    expect(await leadWakeCheck(await leadGoal())).toBe(KILL_SWITCH_REASON);
    await setLead({ enabled: false }, { incidents: { agentsPaused: false } });
    expect(await leadWakeCheck(await leadGoal())).toBe(LEAD_OFF_REASON);
  });

  test("over budget blocks the wake and asks the owner once a month", async () => {
    await setLead({ enabled: true, budgetUsdPerMonth: 5 });
    await ensureLeadGoal(PROJECT);
    const goal = await leadGoal();
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2026-11", usd: 5.2 },
    }));
    const reason = await leadWakeCheck((await leadGoal())!);
    expect(reason).toBe("Over the lead's budget: $5.2 of $5 this month");
    await leadWakeCheck((await leadGoal())!);
    const items = await listSupervisorItems("Ada", { kind: "needs-you" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "acme lead paused: over its budget",
      source: "lead:acme",
      options: ["Raise the budget", "Leave it paused"],
      dedupeKey: "lead:acme:budget:2026-11",
    });
    // Last month's spend doesn't count.
    await mutateGoal(goal.id, (g) => ({
      ...g,
      spend: { month: "2026-10", usd: 50 },
    }));
    expect(await leadWakeCheck((await leadGoal())!)).toBeNull();
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
    const delivered = await deliverLeadProposal(PROJECT, doc, {
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
    });
    if (!delivered.queued) throw new Error(delivered.reason);
    clock += 60_000;
    const answered = await answerSupervisorItem("Ada", delivered.itemId, "1");
    expect(answered.ok).toBe(true);
    const ledger = await readLedger(await leadGoal());
    expect(ledger).toContain(
      'Owner answered "Status page flaps" (lead:acme:signal-rule-change:sig-status consecutive.failures): Raise to 8 failures',
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
    );
    expect(await readLedger(await leadGoal())).toBe(before);
  });
});
