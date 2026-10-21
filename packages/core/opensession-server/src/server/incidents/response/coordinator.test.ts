import { afterEach, expect, test } from "bun:test";
import type {
  ActionRun,
  AgentWorkspace,
  IncidentAction,
  IncidentProjectSettings,
  InvestigatorReport,
  VerifierReport,
} from "../../../shared/incident-response";
import type { Signal, SignalEvaluation } from "../../../shared/incidents";
import type { Automation } from "../../automations";
import type { PrMergeVerdict } from "../../pr-merge-readiness";
import {
  reserveRunnerForIncidents,
  registerRunner,
  createRunnerPairing,
} from "../../runners";
import { createIncident, getIncident, updateIncident } from "../incident-store";
import { emptyResponse } from "./ledger";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { AgentAccessError } from "../access/resolve";
import {
  __resetIncidentAccessGateForTest,
  incidentAccessGate,
} from "./access-gate";
import type { AgentLive, IncidentAgents, SpawnAgentInput } from "./agents";
import {
  type CoordinatorDeps,
  __resetCoordinatorForTest,
  __setCoordinatorDepsForTest,
  __waitForCoordinatorForTest,
  advanceIncident,
  applyOwnerDecision,
  buildResponseView,
  incidentRunOnCheck,
  projectMonthSpend,
  recoverIncidentResponses,
  resolveCoordinatorDeps,
  runResponseTick,
  scheduleAdvance,
} from "./coordinator";
import type { MergeGithub } from "./merge";
import {
  __setProjectSettingsContextForTest,
  defaultProjectSettings,
  patchProjectSettings,
} from "./project-settings";

const kit = useIncidentTestKernel();
afterEach(async () => {
  await __waitForCoordinatorForTest();
  __setCoordinatorDepsForTest(undefined);
  __resetCoordinatorForTest();
  __setProjectSettingsContextForTest(undefined);
  __resetIncidentAccessGateForTest();
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

type PrShape = {
  requiredApprovals?: number;
  reviewDecision?: string;
  headSha?: string;
  pending?: string[];
};

function prVerdict(pr: PrShape, merged: boolean): PrMergeVerdict {
  const v = verdict(pr.headSha ?? "abc1234");
  return {
    ...v,
    state: merged ? "MERGED" : "OPEN",
    review: {
      ...v.review,
      decision: pr.reviewDecision ?? "NONE",
      requiredApprovals: pr.requiredApprovals ?? 0,
    },
    rules: { ...v.rules, requiredApprovals: pr.requiredApprovals ?? 0 },
    checks: {
      ...v.checks,
      pending: (pr.pending ?? []).map((name) => ({ name })),
    },
  } as PrMergeVerdict;
}

async function world(
  opts: {
    workspace?: AgentWorkspace | { error: string };
    access?: CoordinatorDeps["access"];
    pr?: PrShape;
    releasedMsBeforeOpen?: number;
  } = {},
) {
  let clock = START;
  const settings: IncidentProjectSettings = {
    ...defaultProjectSettings("acme"),
    productionRunners: ["runner-prod"],
    actions: [deploy, rollback],
    ...(opts.releasedMsBeforeOpen !== undefined
      ? {
          releases: [
            {
              at: new Date(START - opts.releasedMsBeforeOpen).toISOString(),
              source: "hook" as const,
              ref: "abc1234",
            },
          ],
        }
      : {}),
  };
  let pr: PrShape = opts.pr ?? {};
  let merged = false;
  const merges: Array<{ ghRepo: string; n: number; sha: string }> = [];
  const actions: Array<
    Parameters<CoordinatorDeps["runAction"]>[0] & { actionId: string }
  > = [];
  let hang = false;
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
    verdict: async () => prVerdict(pr, merged),
    files: async () => ["src/search.ts", NOTE, "docs/incidents/runbook.md"],
    mergeCommit: async () => (merged ? "9f9f9f9" : undefined),
    mergeMethods: async () => ["squash"],
    merge: async (ghRepo: string, n: number, o: { sha: string }) => {
      merges.push({ ghRepo, n, sha: o.sha });
      merged = true;
      return { ok: true, sha: "9f9f9f9" };
    },
    appCredential: async () => ({ env: {} }),
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
    runAction: (input) => {
      actions.push({ ...input, actionId: input.action.id });
      if (hang) return new Promise<ActionRun>(() => {});
      return Promise.resolve({
        id: input.runId,
        round: input.round,
        actionId: input.action.id,
        kind: input.action.kind,
        label: input.action.label,
        runner: input.action.runner,
        status: "ok",
        purpose: input.purpose,
        startedAt: new Date(clock).toISOString(),
        endedAt: new Date(clock).toISOString(),
        exitCode: 0,
        detail: "Exit 0",
        secretTouched: false,
      });
    },
    recordRelease: async (_project, release) => {
      settings.releases = [release, ...settings.releases];
      return undefined;
    },
    agentsPaused: () => settings.agentsPaused,
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
    merges,
    actions,
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
    /** Investigator and verifier through to a certain verdict. */
    async toCertain() {
      await w.runToVerifier();
      w.finish("child-2", fence(goodVerifier));
      await advanceIncident(incident.id, deps);
    },
    /** Certain, the veto elapsed, merged and deployed: watching. */
    async toWatching() {
      await w.toCertain();
      clock += 600_000;
      await advanceIncident(incident.id, deps);
    },
    setPr(next: PrShape) {
      pr = next;
    },
    hangActions() {
      hang = true;
    },
    evaluate(id: string, state: SignalEvaluation["state"]) {
      evaluations.set(id, {
        signalId: id,
        state,
        since: new Date(clock).toISOString(),
        at: new Date(clock).toISOString(),
        reason: state,
        inMaintenance: false,
      });
    },
    async until(check: () => Promise<boolean>) {
      for (let k = 0; k < 200; k++) {
        if (await check()) return;
        await Bun.sleep(5);
      }
      throw new Error("Timed out waiting");
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
  // Propose: the owner is asked instead of a veto.
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

test("upstream block: certain → veto → merged as the App → deployed → watched → resolved", async () => {
  const w = await world();
  await w.toCertain();
  let i = await getIncident(w.incident.id);
  expect(i?.state).toBe("veto");
  expect(i?.response?.next).toMatchObject({
    kind: "veto",
    rule: "Deploy after veto, from the project settings",
  });
  expect(w.audits).toContainEqual({
    kind: "incident_veto",
    incidentId: w.incident.id,
    event: "opened",
    deadline: new Date(START + 600_000).toISOString(),
  });
  w.clock += 600_000;
  await advanceIncident(w.incident.id, w.deps);
  expect(w.merges).toEqual([expect.objectContaining({ sha: "abc1234" })]);
  expect(w.actions).toEqual([
    expect.objectContaining({
      actionId: "deploy",
      vars: expect.objectContaining({ ref: "9f9f9f9" }),
      owner: "Ada",
    }),
  ]);
  i = await getIncident(w.incident.id);
  expect(i?.state).toBe("watching");
  expect(i?.response?.merge).toMatchObject({
    status: "merged",
    mergedSha: "9f9f9f9",
  });
  expect(i?.response?.actionRuns).toEqual([
    expect.objectContaining({ actionId: "deploy", status: "ok" }),
  ]);
  expect(i?.response?.ledger.map((e) => e.kind)).toEqual(
    expect.arrayContaining(["veto", "merge", "action"]),
  );
  w.evaluate("sig-a", "ok");
  await advanceIncident(w.incident.id, w.deps);
  i = await getIncident(w.incident.id);
  expect(i).toMatchObject({ state: "resolved", fixedBy: "agents" });
  expect(i?.response?.note).toMatchObject({ merged: true });
  expect(w.settings.releases[0]).toMatchObject({
    source: "action",
    ref: "9f9f9f9",
  });
  expect(i?.events.map((e) => e.marker).filter(Boolean)).toEqual([
    "detected",
    "fix-ready",
    "deploy",
    "released",
    "resolved",
  ]);
});

test("branch protection: needs you, approve after review, then merge", async () => {
  const w = await world({ pr: { requiredApprovals: 1 } });
  await w.toCertain();
  expect((await getIncident(w.incident.id))?.response?.needsYou).toMatchObject({
    kind: "protection",
    reason: "Branch protection requires a review on PR #12",
  });
  expect(w.merges).toEqual([]);
  w.setPr({ requiredApprovals: 1, reviewDecision: "APPROVED" });
  expect(
    await applyOwnerDecision(w.incident.id, "approve", "Bo", undefined, w.deps),
  ).toMatchObject({ state: "deploying" });
  await advanceIncident(w.incident.id, w.deps);
  expect(w.merges).toHaveLength(1);
  expect((await getIncident(w.incident.id))?.response?.ownerTouched).toBe(true);
});

test("the head moves between the snapshot and the merge: nothing is merged", async () => {
  const w = await world();
  await w.toCertain();
  w.clock += 600_000;
  // Fresh enough to skip the decide-time fetch, but the PR moved.
  w.setPr({ headSha: "bbb2222" });
  w.deps.github = {
    ...w.deps.github!,
    verdict: (() => {
      let calls = 0;
      return async () =>
        prVerdict({ headSha: ++calls > 1 ? "bbb2222" : "abc1234" }, false);
    })(),
  };
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(w.merges).toEqual([]);
  expect(i?.response?.needsYou).toMatchObject({
    kind: "merge",
    reason: "PR #12 changed after verification",
  });
});

test("the watch fails: automatic rollback, then round 2 for the same investigator", async () => {
  const w = await world();
  await w.toWatching();
  w.clock += 600_001;
  await advanceIncident(w.incident.id, w.deps);
  expect(w.actions.at(-1)).toMatchObject({
    actionId: "rollback",
    purpose: "auto-rollback",
  });
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("investigating");
  expect(i?.response?.round).toBe(2);
  expect(w.sends.at(-1)?.message).toStartWith(
    "Your fix was released and rolled back",
  );
  expect(w.sends.at(-1)?.message).toContain(
    "Search was still failing 10 min after the release",
  );
});

test("regression after our release: rollback first, investigator in parallel", async () => {
  const w = await world({ releasedMsBeforeOpen: 300_000 });
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("veto");
  expect(i?.response?.candidate).toMatchObject({
    rollbackFirst: true,
    plan: { pr: false, actions: ["rollback"] },
  });
  expect(w.spawns).toEqual([
    expect.objectContaining({
      role: "investigator",
      prompt: expect.stringContaining("Sessions is rolling it back now."),
    }),
  ]);
});

test("rollback-first: a workspace error skips the parallel investigator, the rollback goes on", async () => {
  const w = await world({
    releasedMsBeforeOpen: 300_000,
    workspace: { error: "No sandbox" },
  });
  await advanceIncident(w.incident.id, w.deps);
  let i = await getIncident(w.incident.id);
  expect(i?.state).toBe("veto");
  expect(i?.response?.parallelInvestigator).toBe("unavailable");
  expect(i?.response?.needsYou).toBeUndefined();
  expect(i?.response?.ledger).toContainEqual(
    expect.objectContaining({
      detail: "Investigator not started alongside the rollback: No sandbox",
    }),
  );
  expect(w.spawns).toEqual([]);
  w.clock += 600_000;
  await advanceIncident(w.incident.id, w.deps);
  i = await getIncident(w.incident.id);
  expect(w.actions.map((a) => a.purpose)).toEqual(["rollback-first"]);
  expect(i?.state).toBe("watching");
});

test("rollback-first: with the month's budget used up the rollback still runs", async () => {
  const w = await world({ releasedMsBeforeOpen: 300_000 });
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
  await updateIncident(other.id, (c) => ({
    ...c,
    state: "closed-without-action",
    response: {
      ...emptyResponse({
        now: new Date(START).toISOString(),
        maxRounds: 2,
        phase: "done",
      }),
      costUsd: 200,
    },
  }));
  await advanceIncident(w.incident.id, w.deps);
  let i = await getIncident(w.incident.id);
  expect(i?.state).toBe("veto");
  expect(i?.response?.parallelInvestigator).toBe("refused");
  expect(i?.response?.ledger).toContainEqual(
    expect.objectContaining({
      detail:
        "Investigator not started alongside the rollback: Agents stopped at the $200 monthly budget",
    }),
  );
  expect(w.spawns).toEqual([]);
  w.clock += 600_000;
  await advanceIncident(w.incident.id, w.deps);
  i = await getIncident(w.incident.id);
  expect(w.actions.map((a) => a.purpose)).toEqual(["rollback-first"]);
  expect(i?.state).toBe("watching");
});

test("rollback-first: a gate refusal skips the parallel investigator instead of stalling", async () => {
  const w = await world({
    releasedMsBeforeOpen: 300_000,
    access: async () => {
      throw new AgentAccessError("Monthly spend not loaded", "gate");
    },
  });
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("veto");
  expect(i?.response?.parallelInvestigator).toBe("refused");
});

test("a restart mid-deploy never re-runs the action", async () => {
  const w = await world();
  await w.toCertain();
  w.clock += 600_000;
  w.hangActions(); // runAction never settles
  void advanceIncident(w.incident.id, w.deps);
  await w.until(
    async () =>
      (await getIncident(w.incident.id))?.response?.actionRuns.length === 1,
  );
  expect(
    (await getIncident(w.incident.id))?.response?.actionRuns[0],
  ).toMatchObject({ status: "running", detail: "Running", label: "Deploy" });
  __resetCoordinatorForTest(); // the process "restarts": nothing is live any more
  expect(await recoverIncidentResponses(w.deps)).toBe(1);
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.response?.actionRuns[0]).toMatchObject({
    status: "interrupted",
    detail: "Sessions restarted while this was running",
  });
  expect(i?.response?.needsYou).toMatchObject({
    kind: "interrupted",
    reason:
      "Sessions restarted while Deploy was running. Check production before going on.",
  });
  expect(w.actions).toHaveLength(1);
});

test("stop and deploy now during the veto", async () => {
  const w = await world();
  await w.toCertain();
  expect(
    await applyOwnerDecision(w.incident.id, "stop", "Bo", undefined, w.deps),
  ).toMatchObject({
    state: "needs-you",
    response: { needsYou: { kind: "stopped", reason: "Stopped by Bo" } },
  });
  expect(
    await applyOwnerDecision(
      w.incident.id,
      "deploy-now",
      "Bo",
      undefined,
      w.deps,
    ),
  ).toEqual({ error: "No veto window is open", status: 409 });
  expect(
    await applyOwnerDecision(w.incident.id, "send-back", "Bo", "", w.deps),
  ).toEqual({ error: "A note is required", status: 400 });
  expect(
    await applyOwnerDecision(
      w.incident.id,
      "send-back",
      "Bo",
      "Try the app's TLS fingerprint too",
      w.deps,
    ),
  ).toMatchObject({ state: "investigating", response: { round: 2 } });
  expect(w.audits).toContainEqual({
    kind: "incident_decision",
    incidentId: w.incident.id,
    decision: "stop",
    by: "Bo",
  });
  expect(w.audits).toContainEqual({
    kind: "incident_veto",
    incidentId: w.incident.id,
    event: "stopped",
    by: "Bo",
  });
  await __waitForCoordinatorForTest();
  expect(w.sends.at(-1)?.message).toContain(
    "Try the app's TLS fingerprint too",
  );
});

/** An advance that is already running, held right after it started. */
function holdNextAdvance(w: Awaited<ReturnType<typeof world>>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const settings = w.deps.settings!;
  let held = false;
  const deps: Partial<CoordinatorDeps> = {
    ...w.deps,
    settings: async (p) => {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return settings(p);
    },
  };
  return { deps, started, release };
}

test("stop sent before the veto deadline wins against an advance already running", async () => {
  const w = await world();
  await w.toCertain();
  const deadline = START + 600_000;
  w.clock = deadline - 1_000;
  const hold = holdNextAdvance(w);
  const running = advanceIncident(w.incident.id, hold.deps);
  await hold.started;
  // Stop arrives before the deadline, while the advance is mid-flight.
  const stop = applyOwnerDecision(
    w.incident.id,
    "stop",
    "Bo",
    undefined,
    w.deps,
  );
  // The advance only reads the clock after the deadline has passed.
  w.clock = deadline + 1_000;
  hold.release();
  await running;
  expect(await stop).toMatchObject({
    state: "needs-you",
    response: { needsYou: { kind: "stopped" } },
  });
  await __waitForCoordinatorForTest();
  expect(w.merges).toEqual([]);
  expect(w.actions).toEqual([]);
});

test("stop sent after the veto deadline does not undo a release under way", async () => {
  const w = await world();
  await w.toCertain();
  const deadline = START + 600_000;
  w.clock = deadline + 1_000;
  const hold = holdNextAdvance(w);
  const running = advanceIncident(w.incident.id, hold.deps);
  await hold.started;
  const stop = applyOwnerDecision(
    w.incident.id,
    "stop",
    "Bo",
    undefined,
    w.deps,
  );
  hold.release();
  await running;
  expect(await stop).toEqual({ error: "Nothing to stop", status: 409 });
  expect(w.merges).toHaveLength(1);
});

test("stop while the merge waits for checks: nothing is merged", async () => {
  const w = await world();
  await w.toCertain();
  w.setPr({ pending: ["ci"] });
  w.clock += 600_000;
  await advanceIncident(w.incident.id, w.deps);
  expect(await getIncident(w.incident.id)).toMatchObject({
    state: "deploying",
    response: { phase: "merging" },
  });
  expect(
    await applyOwnerDecision(w.incident.id, "stop", "Bo", undefined, w.deps),
  ).toMatchObject({
    state: "needs-you",
    response: {
      needsYou: { kind: "stopped", resumePhase: "merging" },
    },
  });
  w.setPr({});
  await __waitForCoordinatorForTest();
  await advanceIncident(w.incident.id, w.deps);
  expect(w.merges).toEqual([]);
  expect((await getIncident(w.incident.id))?.state).toBe("needs-you");
});

test("deploy now skips the rest of the veto", async () => {
  const w = await world();
  await w.toCertain();
  const out = await applyOwnerDecision(
    w.incident.id,
    "deploy-now",
    "Bo",
    undefined,
    w.deps,
  );
  expect(out).toMatchObject({
    state: "deploying",
    response: { phase: "merging" },
  });
  expect(w.audits).toContainEqual({
    kind: "incident_veto",
    incidentId: w.incident.id,
    event: "skipped",
    by: "Bo",
  });
  await __waitForCoordinatorForTest();
  await advanceIncident(w.incident.id, w.deps);
  expect(w.merges).toHaveLength(1);
  expect((await getIncident(w.incident.id))?.state).toBe("watching");
});

test("decisions: unknown incident, unknown decision, and no response", async () => {
  const w = await world();
  expect(
    await applyOwnerDecision("inc-nope", "stop", "Bo", undefined, w.deps),
  ).toEqual({ error: "Not found", status: 404 });
  expect(
    await applyOwnerDecision(
      w.incident.id,
      "dance" as never,
      "Bo",
      undefined,
      w.deps,
    ),
  ).toEqual({ error: "Unknown decision", status: 400 });
  expect(
    await applyOwnerDecision(w.incident.id, "stop", "Bo", undefined, w.deps),
  ).toEqual({ error: "Nothing to stop", status: 409 });
  const closed = await applyOwnerDecision(
    w.incident.id,
    "close",
    "Bo",
    undefined,
    w.deps,
  );
  expect(closed).toMatchObject({ state: "closed-without-action" });
  expect(closed).not.toHaveProperty("response");
});

test("stop while investigating cancels the agents; retry and close", async () => {
  const w = await world();
  await advanceIncident(w.incident.id, w.deps);
  expect(
    await applyOwnerDecision(w.incident.id, "retry", "Bo", undefined, w.deps),
  ).toEqual({ error: "Nothing to retry", status: 409 });
  const stopped = await applyOwnerDecision(
    w.incident.id,
    "stop",
    "Bo",
    undefined,
    w.deps,
  );
  expect(stopped).toMatchObject({
    state: "needs-you",
    response: {
      agents: [{ status: "cancelled", cancelledFor: "stopped" }],
      needsYou: { kind: "stopped" },
    },
  });
  expect(w.cancels).toEqual(["child-1"]);
  expect(
    await applyOwnerDecision(w.incident.id, "approve", "Bo", undefined, w.deps),
  ).toEqual({ error: "Nothing verified to approve", status: 409 });
  expect(
    await applyOwnerDecision(w.incident.id, "close", "Bo", undefined, w.deps),
  ).toMatchObject({
    state: "closed-without-action",
    response: { phase: "done", ownerTouched: true },
  });
});

test("retry after a setup problem starts the agents again", async () => {
  let fail = true;
  const w = await world();
  w.deps.workspace = async () =>
    fail
      ? { error: "No sandbox" }
      : { kind: "sandbox" as const, provider: "daytona" };
  await advanceIncident(w.incident.id, w.deps);
  expect((await getIncident(w.incident.id))?.response?.needsYou).toMatchObject({
    kind: "setup",
  });
  fail = false;
  expect(
    await applyOwnerDecision(w.incident.id, "retry", "Bo", undefined, w.deps),
  ).toMatchObject({ state: "investigating" });
  await __waitForCoordinatorForTest();
  expect(w.spawns).toHaveLength(1);
});

test("kill switch while the veto counts down: no merge, ever", async () => {
  const w = await world();
  await w.toCertain();
  w.settings.agentsPaused = true;
  w.clock += 600_000;
  await advanceIncident(w.incident.id, w.deps);
  expect((await getIncident(w.incident.id))?.state).toBe("paused");
  expect(w.merges).toEqual([]);
});

test("kill switch turned on while the merge is under way: nothing is merged", async () => {
  const w = await world();
  await w.toCertain();
  w.clock += 600_000;
  const verdict = w.deps.github!.verdict;
  let calls = 0;
  w.deps.github = {
    ...w.deps.github!,
    verdict: async (...args: Parameters<MergeGithub["verdict"]>) => {
      // The fresh snapshot read right before merging.
      if (++calls === 2) w.settings.agentsPaused = true;
      return verdict(...args);
    },
  };
  await advanceIncident(w.incident.id, w.deps);
  expect(calls).toBe(2);
  expect(w.merges).toEqual([]);
  expect(w.actions).toEqual([]);
});

test("kill switch turned on right after the merge: the deploy never runs", async () => {
  const w = await world();
  await w.toCertain();
  w.clock += 600_000;
  const merge = w.deps.github!.merge;
  w.deps.github = {
    ...w.deps.github!,
    merge: async (...args: Parameters<MergeGithub["merge"]>) => {
      const out = await merge(...args);
      w.settings.agentsPaused = true;
      return out;
    },
  };
  await advanceIncident(w.incident.id, w.deps);
  expect(w.merges).toHaveLength(1);
  expect(w.actions).toEqual([]);
  expect((await getIncident(w.incident.id))?.response?.actionRuns).toEqual([]);
});

test("kill switch turned on before the incident note merges: it is left open", async () => {
  const w = await world({ releasedMsBeforeOpen: 300_000 });
  w.deps.github = {
    ...w.deps.github!,
    files: async () => [NOTE, "docs/incidents/runbook.md"],
    verdict: (() => {
      const verdict = w.deps.github!.verdict;
      return async (...args: Parameters<MergeGithub["verdict"]>) => {
        // The note PR's snapshot, read right before merging it.
        w.settings.agentsPaused = true;
        return verdict(...args);
      };
    })(),
  };
  await advanceIncident(w.incident.id, w.deps);
  w.finish(
    "child-1",
    fence({ ...investigatorReport, candidate: null, noCandidateReason: "x" }),
    { prUrl: "https://github.com/acme/web/pull/12" },
  );
  w.clock += 600_000;
  await advanceIncident(w.incident.id, w.deps);
  expect((await getIncident(w.incident.id))?.state).toBe("watching");
  w.evaluate("sig-a", "ok");
  await advanceIncident(w.incident.id, w.deps);
  await advanceIncident(w.incident.id, w.deps);
  const i = await getIncident(w.incident.id);
  expect(i?.state).toBe("resolved");
  expect(w.merges).toEqual([]);
  expect(i?.response?.note).toMatchObject({ merged: false });
});

test("kill switch while watching: no automatic rollback", async () => {
  const w = await world();
  await w.toWatching();
  w.settings.agentsPaused = true;
  w.clock += 600_001;
  await advanceIncident(w.incident.id, w.deps);
  expect((await getIncident(w.incident.id))?.state).toBe("paused");
  expect(w.actions.map((a) => a.actionId)).toEqual(["deploy"]);
});

test("manual rollback while watching, then the next round", async () => {
  const w = await world();
  await w.toWatching();
  expect((await getIncident(w.incident.id))?.response?.next).toMatchObject({
    kind: "watching",
    options: ["roll-back"],
  });
  expect(
    await applyOwnerDecision(
      w.incident.id,
      "roll-back",
      "Bo",
      undefined,
      w.deps,
    ),
  ).toMatchObject({ state: "rolled-back" });
  await advanceIncident(w.incident.id, w.deps);
  expect(w.actions.at(-1)).toMatchObject({
    actionId: "rollback",
    purpose: "owner-rollback",
  });
  expect(await getIncident(w.incident.id)).toMatchObject({
    state: "investigating",
    response: { round: 2 },
  });
  expect(w.audits).toContainEqual({
    kind: "incident_rollback_requested",
    incidentId: w.incident.id,
    by: "Bo",
    from: "watching",
  });
  expect(
    await applyOwnerDecision(
      w.incident.id,
      "roll-back",
      "Bo",
      undefined,
      w.deps,
    ),
  ).toEqual({ error: "Nothing to roll back", status: 409 });
});

test("manual rollback after resolution reopens the incident, rounds uncapped", async () => {
  const w = await world();
  await w.toWatching();
  w.evaluate("sig-a", "ok");
  await advanceIncident(w.incident.id, w.deps);
  const resolved = await getIncident(w.incident.id);
  expect(resolved?.state).toBe("resolved");
  // Max rounds already used: an owner's rollback still starts the next one.
  w.settings.maxRounds = 1;
  expect(
    await applyOwnerDecision(
      w.incident.id,
      "roll-back",
      "Bo",
      undefined,
      w.deps,
    ),
  ).toMatchObject({
    state: "investigating",
    response: { phase: "rolling-back", ownerRollback: { by: "Bo" } },
  });
  await __waitForCoordinatorForTest();
  await advanceIncident(w.incident.id, w.deps);
  expect(w.actions.at(-1)).toMatchObject({ purpose: "owner-rollback" });
  expect(await getIncident(w.incident.id)).toMatchObject({
    state: "investigating",
    response: { round: 2, phase: "investigating" },
  });
});

test("the access gate refuses agents of a paused or over-budget project", async () => {
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  const w = await world();
  await advanceIncident(w.incident.id, w.deps);
  await projectMonthSpend("acme", START, w.deps);
  const incident = (await getIncident(w.incident.id))!;
  expect(incidentAccessGate(incident, "investigator")).toBe(
    "Project settings not loaded",
  );
  await patchProjectSettings("acme", (s) => s);
  expect(incidentAccessGate(incident, "investigator")).toBeNull();
  await patchProjectSettings("acme", (s) => ({ ...s, agentsPaused: true }));
  expect(incidentAccessGate(incident, "verifier")).toBe(
    "Agents are paused for acme",
  );
  await patchProjectSettings("acme", (s) => ({ ...s, agentsPaused: false }));
  expect(
    incidentAccessGate(
      { ...incident, response: { ...incident.response!, costUsd: 25 } },
      "investigator",
    ),
  ).toBe("Agents stopped at the $20 budget for this incident");
});

test("runOn must be a production Runner of the project", async () => {
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  const out = registerRunner({
    code: createRunnerPairing("Ada").code,
    name: "prod-1",
    platform: "linux",
    arch: "x64",
    address: "100.64.0.9",
  });
  if (!out.ok) throw new Error(out.error);
  reserveRunnerForIncidents(out.runner.id, { repos: ["acme"] });
  await patchProjectSettings("acme", (s) => ({
    ...s,
    productionRunners: [out.runner.id],
  }));
  expect(await incidentRunOnCheck({ ...httpSignal, runOn: "runner-lab" })).toBe(
    "Runner runner-lab is not a production Runner for acme",
  );
  expect(
    await incidentRunOnCheck({ ...httpSignal, runOn: out.runner.id }),
  ).toBeNull();
  expect(
    await incidentRunOnCheck({
      ...httpSignal,
      source: { kind: "webhook" } as Signal["source"],
      runOn: out.runner.id,
    }),
  ).toBe("Only http checks can run on a Runner");
});
