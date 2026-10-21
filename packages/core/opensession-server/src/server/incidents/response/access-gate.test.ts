import { afterEach, beforeEach, expect, test } from "bun:test";
import type { IncidentResponse } from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { resolveAgentAccess } from "../access/resolve";
import { useAccessTestEnv } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  __resetIncidentAccessGateForTest,
  incidentAccessGate,
  loadProjectMonthSpend,
  setProjectMonthSpend,
  startIncidentAccessGate,
} from "./access-gate";
import {
  __setProjectSettingsContextForTest,
  getProjectSettings,
  patchProjectSettings,
} from "./project-settings";

useIncidentTestKernel();
useAccessTestEnv();
beforeEach(() => {
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  __resetIncidentAccessGateForTest();
});
afterEach(() => {
  __setProjectSettingsContextForTest(undefined);
  __resetIncidentAccessGateForTest();
});

const incident = (costUsd = 0): Incident => ({
  id: "inc-1",
  project: "acme",
  title: "Search",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: [],
  primarySignalId: "sig-1",
  openedAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
  lastProblemAt: "2026-10-20T10:00:00Z",
  findings: [],
  events: [],
  droppedEvents: 0,
  response: { costUsd } as IncidentResponse,
});

test("settings not loaded: the gate refuses rather than skip the kill switch", () => {
  expect(incidentAccessGate(incident(), "investigator")).toBe(
    "Project settings not loaded",
  );
});

test("monthly spend not loaded: the gate refuses rather than start at $0", async () => {
  await getProjectSettings("acme");
  expect(incidentAccessGate(incident(), "investigator")).toBe(
    "Monthly spend not loaded",
  );
  setProjectMonthSpend("acme", 0);
  expect(incidentAccessGate(incident(), "investigator")).toBeNull();
});

test("boot loads the month's spend from the incidents, not $0", async () => {
  await patchProjectSettings("acme", (s) => ({
    ...s,
    budget: { perIncidentUsd: 20, perMonthUsd: 100 },
  }));
  const now = Date.parse("2026-10-20T12:00:00Z");
  // Each run's cost counts in the month it was spent (when the run ended),
  // whenever the incident opened.
  const spent = (
    id: string,
    openedAt: string,
    runs: Array<{ endedAt?: string; costUsd: number }>,
  ): Incident => ({
    ...incident(runs.reduce((sum, r) => sum + r.costUsd, 0)),
    id,
    openedAt,
    response: {
      costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
      agents: runs.map((r) => ({
        status: r.endedAt ? "done" : "running",
        startedAt: openedAt,
        ...r,
      })),
    } as IncidentResponse,
  });
  await loadProjectMonthSpend(now, async () => [
    spent("inc-a", "2026-10-02T00:00:00Z", [
      { endedAt: "2026-10-02T01:00:00Z", costUsd: 40 },
    ]),
    spent("inc-b", "2026-10-19T00:00:00Z", [{ costUsd: 45 }]),
    spent("inc-c", "2026-09-30T23:00:00Z", [
      { endedAt: "2026-09-30T23:30:00Z", costUsd: 500 },
      { endedAt: "2026-10-01T00:30:00Z", costUsd: 20 },
    ]),
    {
      ...spent("inc-d", "2026-10-03T00:00:00Z", [
        { endedAt: "2026-10-03T01:00:00Z", costUsd: 900 },
      ]),
      project: "globex",
    },
  ]);
  expect(incidentAccessGate(incident(1), "investigator")).toBe(
    "Agents stopped at the $100 monthly budget",
  );
  // Projects without incidents this month start at $0 once loaded.
  expect(
    incidentAccessGate({ ...incident(0), project: "initech" }, "verifier"),
  ).toBe("Project settings not loaded");
});

test("the kill switch refuses every role", async () => {
  await patchProjectSettings("acme", (s) => ({ ...s, agentsPaused: true }));
  setProjectMonthSpend("acme", 0);
  expect(incidentAccessGate(incident(), "investigator")).toBe(
    "Agents are paused for acme",
  );
  expect(incidentAccessGate(incident(), "verifier")).toBe(
    "Agents are paused for acme",
  );
});

test("the incident and monthly budgets refuse", async () => {
  await patchProjectSettings("acme", (s) => ({
    ...s,
    budget: { perIncidentUsd: 20, perMonthUsd: 100 },
  }));
  setProjectMonthSpend("acme", 0);
  expect(incidentAccessGate(incident(19.99), "investigator")).toBeNull();
  expect(incidentAccessGate(incident(20), "investigator")).toBe(
    "Agents stopped at the $20 budget for this incident",
  );
  setProjectMonthSpend("acme", 100);
  expect(incidentAccessGate(incident(1), "verifier")).toBe(
    "Agents stopped at the $100 monthly budget",
  );
});

test("registered once, the gate refuses spawn, turns and tool calls", async () => {
  startIncidentAccessGate();
  startIncidentAccessGate();
  await patchProjectSettings("acme", (s) => ({ ...s, agentsPaused: true }));
  await expect(
    resolveAgentAccess("investigator", incident(), null),
  ).rejects.toMatchObject({
    code: "gate",
    message: "Agents are paused for acme",
  });
  __resetIncidentAccessGateForTest();
  await expect(
    resolveAgentAccess("investigator", incident(), null),
  ).resolves.toMatchObject({ role: "investigator" });
});
