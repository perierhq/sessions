import { afterEach, expect, test } from "bun:test";
import type {
  AgentWorkspace,
  IncidentAction,
  IncidentProjectSettings,
  InvestigatorReport,
  VerifierReport,
} from "../../../shared/incident-response";
import type { Signal, SignalEvaluation } from "../../../shared/incidents";
import type { Automation } from "../../automations";
import type { PrMergeVerdict } from "../../pr-merge-readiness";
import { createIncident, getIncident } from "../incident-store";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { AgentAccessError } from "../access/resolve";
import type { AgentLive, IncidentAgents, SpawnAgentInput } from "./agents";
import {
  type CoordinatorDeps,
  __resetCoordinatorForTest,
  __setCoordinatorDepsForTest,
  __waitForCoordinatorForTest,
  advanceIncident,
  buildResponseView,
  projectMonthSpend,
  resolveCoordinatorDeps,
  runResponseTick,
  scheduleAdvance,
} from "./coordinator";
import type { MergeGithub } from "./merge";
import { defaultProjectSettings } from "./project-settings";

const kit = useIncidentTestKernel();
afterEach(() => {
  __setCoordinatorDepsForTest(undefined);
  __resetCoordinatorForTest();
});

const START = Date.parse("2026-10-20T12:00:00.000Z");
const fence = (o: unknown) =>
  `Done.\n\n\`\`\`incident-report\n${JSON.stringify(o)}\n\`\`\``;

const deploy: IncidentAction = {
  id: "deploy",
  kind: "deploy",
  label: "Deploy",
  runner: "runner-prod",
  command: "./deploy.sh {{ref}}",
  timeoutMs: 300_000,
  reversible: true,
  cost: { kind: "none" },
  needsSecret: false,
  scope: { services: [], paths: ["src/**"], migrationPaths: [] },
};
const rollback: IncidentAction = {
  ...deploy,
  id: "rollback",
  kind: "rollback",
  label: "Roll back",
  command: "./rollback.sh {{previousRef}}",
  scope: { services: [], paths: [], migrationPaths: [] },
};

const httpSignal: Signal = {
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  source: { kind: "http", url: "https://acme.example.test/search?q=x" },
  rule: { kind: "consecutive", failures: 3 },
  severity: "major",
  createdBy: "Ada",
  createdAt: "2026-10-19T12:00:00.000Z",
  updatedAt: "2026-10-19T12:00:00.000Z",
};

const goodInvestigator: Omit<InvestigatorReport, "notePath"> & {
  notePath?: string;
} = {
  role: "investigator",
  summary: "Upstream blocks our user agent",
  cause: "Bot protection rejects the default client.",
  readFirst: [{ path: "docs/incidents/runbook.md", found: true }],
  attempts: [
    {
      step: "Request with app UA",
      cost: "cheap",
      result: "confirmed",
      evidence: "200 with app UA, 403 without",
      source: "https://upstream.example.test/q",
    },
  ],
  candidate: { pr: true, actions: [] },
  check: {
    kind: "request",
    source: {
      kind: "http",
      url: "https://acme.example.test/search?q=x",
      headers: { "User-Agent": "acme-app/4.2" },
    },
  },
  claims: [
    {
      text: "Upstream returns 403 to the default user agent",
      source: "https://upstream.example.test/q",
    },
  ],
  runbookPaths: ["docs/incidents/runbook.md"],
};
const NOTE = "docs/incidents/2026-10-20-search.md";
const investigatorReport = { ...goodInvestigator, notePath: NOTE };
const goodVerifier: VerifierReport = {
  role: "verifier",
  verdict: "certain",
  reasons: [],
  claims: [
    {
      text: "Upstream returns 403 to the default user agent",
      status: "verified",
      evidence: "Reproduced with curl",
    },
  ],
  proofAccepted: false,
};

const automation = {
  id: "auto-1",
  name: "Incidents · acme",
  enabled: false,
  incidentResponse: { project: "acme" },
} as Automation;

const models = {
  investigator: {
    model: "pi/anthropic/claude-opus-5-5",
    provider: "anthropic",
    label: "Opus 5.5",
  },
  verifier: {
    model: "pi/openai/gpt-6.1-sol",
    provider: "openai",
    label: "GPT-6.1 Sol",
    independence: "other-provider" as const,
  },
};

function verdict(headSha: string): PrMergeVerdict {
  return {
    ready: true,
    summary: "",
    blockers: [],
    warnings: [],
    pr: {
      repo: "acme",
      ghRepo: "acme/web",
      number: 12,
      title: "Fix search",
      url: "https://github.com/acme/web/pull/12",
      author: "acme-bot",
      base: "main",
      head: "incident/2026-10-20-search",
      headSha,
    },
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checks: {
      total: 0,
      passing: [],
      failing: [],
      pending: [],
      skipped: [],
      missingRequired: [],
    },
    review: {
      decision: "NONE",
      approvedBy: [],
      changesRequestedBy: [],
      awaiting: [],
      requiredApprovals: 0,
    },
    rules: {
      readable: true,
      requiredChecks: [],
      requiredApprovals: 0,
      strictUpToDate: false,
    },
  } as PrMergeVerdict;
}

async function world(
  opts: {
    workspace?: AgentWorkspace | { error: string };
    access?: CoordinatorDeps["access"];
  } = {},
) {
  let clock = START;
  const settings: IncidentProjectSettings = {
    ...defaultProjectSettings("acme"),
    productionRunners: ["runner-prod"],
    actions: [deploy, rollback],
  };
  const live = new Map<string, AgentLive>();
  const texts = new Map<string, string>();
  const spawns: SpawnAgentInput[] = [];
  const sends: Array<{ id: string; message: string }> = [];
  const cancels: string[] = [];
  const evaluations = new Map<string, SignalEvaluation>([
    [
      "sig-a",
      {
        signalId: "sig-a",
        state: "failing",
        since: new Date(START - 3_600_000).toISOString(),
        at: new Date(START).toISOString(),
        reason: "failing",
        inMaintenance: false,
      },
    ],
  ]);
  let next = 0;
  const agents: IncidentAgents = {
    async spawn(input) {
      spawns.push(input);
      const id = `child-${++next}`;
      live.set(id, { status: "running", costUsd: 0, tokens: 0 });
      return { sessionId: id };
    },
    async status(id) {
      return live.get(id) ?? { status: "running", costUsd: 0, tokens: 0 };
    },
    async finalText(id) {
      return texts.get(id);
    },
    async send(id, message) {
      sends.push({ id, message });
      texts.delete(id);
      live.set(id, { ...live.get(id)!, status: "running" });
    },
    async cancel(id) {
      cancels.push(id);
      live.set(id, { ...live.get(id)!, status: "cancelled" });
    },
  };
  const github = {
    verdict: async () => verdict("abc1234"),
    files: async () => ["src/search.ts", NOTE, "docs/incidents/runbook.md"],
    mergeCommit: async () => undefined,
    mergeMethods: async () => ["squash"],
    merge: async () => {
      throw new Error("Not in this test");
    },
    appCredential: async () => {
      throw new Error("Not in this test");
    },
  } as unknown as MergeGithub;
  const deps: Partial<CoordinatorDeps> = {
    now: () => clock,
    settings: async () => settings,
    signal: async (id) => (id === "sig-a" ? httpSignal : null),
    evaluation: (id) => evaluations.get(id) ?? null,
    recent: () => [],
    models: () => models,
    access:
      opts.access ??
      (async (role, incident) =>
        agentAccessFixture({
          role,
          incidentId: incident.id,
          mode: role === "verifier" ? "ask" : "code",
          summary:
            role === "verifier"
              ? "Verifier · no connections · read only"
              : "Investigator · no connections · can edit acme",
        })),
    workspace: async () =>
      opts.workspace ?? { kind: "sandbox", provider: "daytona" },
    automation: async () => automation,
    coordinatorSession: async () => "coord-1",
    agents: () => agents,
    proof: async (input) => ({
      round: input.round,
      at: new Date(clock).toISOString(),
      baseline: {
        samples: [1, 2, 3].map(() => ({
          at: new Date(clock).toISOString(),
          result: "fail" as const,
          detail: "403",
        })),
        verdict: "fails",
      },
      candidate: {
        kind: "request",
        samples: [1, 2, 3].map(() => ({
          at: new Date(clock).toISOString(),
          result: "ok" as const,
          detail: "200",
        })),
        verdict: "passes",
      },
    }),
    github,
    ghRepoOf: () => "acme/web",
    defaultBranch: () => "main",
  };
  const incident = await createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    at: new Date(START).toISOString(),
    detail: "Search failing",
  });
  const w = {
    incident,
    deps,
    settings,
    spawns,
    sends,
    cancels,
    audits: kit.audits,
    get clock() {
      return clock;
    },
    set clock(v: number) {
      clock = v;
    },
    finish(id: string, text: string, over: Partial<AgentLive> = {}) {
      live.set(id, { ...live.get(id)!, status: "done", ...over });
      texts.set(id, text);
    },
    live(id: string, over: Partial<AgentLive>) {
      live.set(id, { ...live.get(id)!, ...over });
    },
    async runToVerifier() {
      await advanceIncident(incident.id, deps);
      w.finish("child-1", fence(investigatorReport), {
        prUrl: "https://github.com/acme/web/pull/12",
      });
      await advanceIncident(incident.id, deps);
    },
  };
  return w;
}

test("an investigating incident starts its investigator with the brief", async () => {
  const w = await world();
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(w.spawns).toEqual([
    expect.objectContaining({
      role: "investigator",
      round: 1,
      attempt: 1,
      model: "pi/anthropic/claude-opus-5-5",
      branch: expect.stringMatching(/^incident\/\d{4}-\d{2}-\d{2}-search$/),
      prompt: expect.stringContaining("Before anything else, read these"),
    }),
  ]);
  expect(i?.response).toMatchObject({
    phase: "investigating",
    round: 1,
    coordinatorSessionId: "coord-1",
    automationId: "auto-1",
    agents: [{ role: "investigator", status: "running", sessionId: "child-1" }],
    next: { kind: "working", detail: "Investigator working, round 1 of 2" },
  });
  expect(i?.response?.ledger.map((e) => e.kind)).toEqual(["agent-started"]);
  expect(i?.events.map((e) => e.kind)).toContain("agent");
  expect(w.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_agent_started",
      incidentId: w.incident.id,
      role: "investigator",
      round: 1,
      attempt: 1,
      sessionId: "child-1",
      workspace: "sandbox",
      accessRevision: "r1",
    }),
  );
});

test("investigator report → proof from production → verifier on another provider, stacked on the fix", async () => {
  const w = await world();
  await advanceIncident(w.incident.id, w.deps);
  w.finish("child-1", fence(investigatorReport), {
    prUrl: "https://github.com/acme/web/pull/12",
    costUsd: 2.1,
  });
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("fix-ready");
  expect(i?.response).toMatchObject({
    phase: "verifying",
    costUsd: 2.1,
    proof: { baseline: { verdict: "fails" } },
    candidate: {
      prUrl: "https://github.com/acme/web/pull/12",
      pr: { headSha: "abc1234" },
    },
  });
  expect(w.spawns[1]).toMatchObject({
    role: "verifier",
    model: "pi/openai/gpt-6.1-sol",
    baseSessionId: "child-1",
    prompt: expect.stringContaining("abc1234"),
  });
  expect(i?.response?.agents[1]).toMatchObject({
    independence: "other-provider",
    provider: "openai",
  });
  expect(i?.response?.agents[0]).toMatchObject({
    status: "done",
    endedAt: expect.any(String),
    report: { summary: "Upstream blocks our user agent" },
  });
  expect(w.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_agent_finished",
      role: "investigator",
      status: "done",
      costUsd: 2.1,
    }),
  );
  expect(w.audits).toContainEqual(
    expect.objectContaining({
      kind: "incident_proof",
      round: 1,
      baseline: "fails",
      candidate: "passes",
    }),
  );
  expect(i?.response?.ledger.find((e) => e.kind === "proof")?.detail).toBe(
    "Baseline fails (3/3), candidate passes from the Sessions server",
  );
});

test("a certain verdict moves to deciding with the verified SHA", async () => {
  const w = await world();
  await w.runToVerifier();
  w.finish("child-2", fence(goodVerifier));
  // Stop before the veto: the steps after deciding are the next task's.
  w.settings.autonomy = "propose";
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.response?.verdict).toMatchObject({
    verdict: "certain",
    verifiedSha: "abc1234",
  });
  expect(i?.state).toBe("needs-you");
  expect(i?.response?.next).toEqual({
    kind: "needs-you",
    needsYou: "policy",
    reason: "Verified and ready. Waiting for you",
    rule: "Propose, from the project settings",
    options: ["approve", "send-back", "close"],
  });
  expect(w.audits).toContainEqual({
    kind: "incident_verdict",
    incidentId: w.incident.id,
    round: 1,
    verdict: "certain",
  });
});

test("a missing block gets one reminder, then needs you with Retry", async () => {
  const w = await world();
  await advanceIncident(w.incident.id, w.deps);
  w.finish("child-1", "All done, see PR", {
    prUrl: "https://github.com/acme/web/pull/12",
  });
  await advanceIncident(w.incident.id, w.deps);
  expect(w.sends).toEqual([
    {
      id: "child-1",
      message:
        "Your last message did not end with a valid incident-report block: No incident-report block. Reply with only the corrected block.",
    },
  ]);
  w.finish("child-1", "Still no block");
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("needs-you");
  expect(i?.response?.next).toEqual({
    kind: "needs-you",
    needsYou: "no-report",
    reason:
      "The investigator finished without a valid report: No incident-report block",
    options: ["retry", "resolve", "close"],
  });
  expect(i?.response?.needsYou).toMatchObject({
    kind: "no-report",
    resumePhase: "investigating",
  });
});

test("no sandbox and no agent user: needs you with the reason, never a silent stall", async () => {
  const reason =
    "Incident agents need a sandbox or the incident agent user. Set a default sandbox for acme, or create the system user opensession-incident (see docs/incident-host-agents.md), then retry.";
  const w = await world({ workspace: { error: reason } });
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("needs-you");
  expect(i?.response?.needsYou).toMatchObject({ kind: "setup", reason });
  expect(i?.response?.next).toMatchObject({
    options: ["retry", "resolve", "close"],
  });
  expect(w.spawns).toEqual([]);
});

test("refused access is a setup problem; a gate refusal is left to the guards", async () => {
  const refused = await world({
    access: async () => {
      throw new AgentAccessError(
        "Access settings for acme exceed their grants",
        "settings",
      );
    },
  });
  await advanceIncident(refused.incident.id, refused.deps);
  expect(
    (await getIncident(refused.incident.id))?.response?.needsYou,
  ).toMatchObject({
    kind: "setup",
    reason:
      "Incident agents could not start: Access settings for acme exceed their grants",
  });
  const gated = await world({
    access: async () => {
      throw new AgentAccessError("Agents are paused for acme", "gate");
    },
  });
  await advanceIncident(gated.incident.id, gated.deps);
  const i = await getIncident(gated.incident.id);
  expect(i?.state).toBe("investigating");
  expect(i?.response?.agents).toEqual([]);
});

test("a host worktree is recorded on the run, with the access it started under", async () => {
  const w = await world({
    workspace: { kind: "host", user: "opensession-incident" },
  });
  await advanceIncident(w.incident.id, w.deps);
  expect((await getIncident(w.incident.id))?.response?.agents[0]).toMatchObject(
    {
      workspace: { kind: "host", user: "opensession-incident" },
      accessSummary: "Investigator · no connections · can edit acme",
      accessRevision: expect.any(String),
    },
  );
  expect(w.spawns[0]).toMatchObject({
    workspace: { kind: "host", user: "opensession-incident" },
  });
});

test("budget: agents are cancelled at the cap and the owner is asked", async () => {
  const w = await world();
  await advanceIncident(w.incident.id, w.deps);
  w.live("child-1", { status: "running", costUsd: 20.5 });
  await advanceIncident(w.incident.id, w.deps);
  expect(w.cancels).toEqual(["child-1"]);
  const i = await getIncident(w.incident.id);
  expect(i?.response?.needsYou).toMatchObject({
    kind: "budget",
    reason: "Agents stopped at the $20 budget for this incident",
  });
  expect(i?.response?.agents[0]).toMatchObject({
    status: "cancelled",
    cancelledFor: "budget",
  });
  expect(w.audits).toContainEqual({
    kind: "incident_budget",
    incidentId: w.incident.id,
    costUsd: 20.5,
    capUsd: 20,
  });
});

test("not certain twice: round 2 goes to the same investigator, then needs you", async () => {
  const w = await world();
  await w.runToVerifier();
  w.finish(
    "child-2",
    fence({
      ...goodVerifier,
      verdict: "not-certain",
      reasons: ["The 403 also happens with the new agent"],
    }),
  );
  await advanceIncident(w.incident.id, w.deps);
  expect(w.sends.at(-1)).toEqual({
    id: "child-1",
    message: expect.stringMatching(
      /^The verifier was not certain \(round 2 of 2\)/,
    ),
  });
  let i = await getIncident(w.incident.id);
  expect(i).toMatchObject({ state: "investigating", response: { round: 2 } });
  expect(i?.response?.agents[0]).toMatchObject({
    round: 2,
    status: "running",
  });
  expect(i?.response?.sendBack).toBeUndefined();
  w.finish("child-1", fence(investigatorReport), {
    prUrl: "https://github.com/acme/web/pull/12",
  });
  await advanceIncident(w.incident.id, w.deps);
  expect(w.spawns.at(-1)).toMatchObject({ role: "verifier", round: 2 });
  w.finish(
    "child-3",
    fence({ ...goodVerifier, verdict: "not-certain", reasons: ["Still 403"] }),
  );
  await advanceIncident(w.incident.id, w.deps);
  i = await getIncident(w.incident.id);
  expect(i?.response?.needsYou).toMatchObject({
    kind: "rounds",
    reason: "Not certain after 2 rounds: Still 403",
  });
});

test("rollback-first: the candidate is the rollback and waits for the next steps", async () => {
  const w = await world();
  w.settings.releases = [
    {
      at: new Date(START - 300_000).toISOString(),
      source: "hook",
      ref: "abc1234",
    },
  ];
  w.settings.autonomy = "propose";
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.response?.candidate).toMatchObject({
    rollbackFirst: true,
    plan: { pr: false, actions: ["rollback"] },
    check: {
      kind: "after-deploy",
      reason: "Rolling back the release at 11:55 UTC",
    },
  });
  expect(
    i?.events.some(
      (e) => e.detail === "Rolling back the release at 11:55 UTC first",
    ),
  ).toBe(true);
  expect(i?.response?.ledger[0]).toMatchObject({
    kind: "release",
    detail: "Rolling back first: a release went out at 11:55 UTC",
  });
  expect(w.spawns).toEqual([
    expect.objectContaining({
      role: "investigator",
      prompt: expect.stringContaining("Sessions is rolling it back now."),
    }),
  ]);
  expect(i?.response?.needsYou).toMatchObject({ kind: "policy" });
});

test("the view counts the month's spend without this incident", async () => {
  const w = await world();
  const other = await createIncident({
    project: "acme",
    title: "Checkout",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    at: new Date(START).toISOString(),
    detail: "x",
  });
  await advanceIncident(other.id, w.deps);
  w.live("child-1", { costUsd: 7 });
  await advanceIncident(other.id, w.deps);
  const view = await buildResponseView(
    (await getIncident(w.incident.id))!,
    resolveCoordinatorDeps(w.deps),
  );
  expect(view.monthCostUsd).toBe(7);
  expect(await projectMonthSpend("acme", START, w.deps)).toEqual({
    month: "2026-10",
    monthUsd: 7,
    perMonthUsd: 200,
  });
});

test("the tick schedules open work and skips what waits on a person", async () => {
  const w = await world();
  __setCoordinatorDepsForTest(w.deps);
  const scheduled = await runResponseTick(START, w.deps);
  expect(scheduled).toContain(w.incident.id);
  await __waitForCoordinatorForTest();
  expect(w.spawns).toHaveLength(1);
  w.live("child-1", { costUsd: 25 });
  await advanceIncident(w.incident.id, w.deps);
  expect((await getIncident(w.incident.id))?.state).toBe("needs-you");
  expect(await runResponseTick(START, w.deps)).not.toContain(w.incident.id);
});

test("coalesced wake-ups never run two advances for one incident at once", async () => {
  const w = await world();
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  __setCoordinatorDepsForTest({
    ...w.deps,
    settings: async (p) => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(5);
      inFlight--;
      return w.deps.settings!(p);
    },
  });
  for (let k = 0; k < 5; k++) scheduleAdvance(w.incident.id);
  await __waitForCoordinatorForTest();
  expect(maxInFlight).toBe(1);
  expect(w.spawns).toHaveLength(1);
  expect(calls).toBeLessThan(5 * 8);
});
