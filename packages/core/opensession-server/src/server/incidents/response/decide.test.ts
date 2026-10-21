import { expect, test } from "bun:test";
import type {
  ActionRun,
  AgentRun,
  CandidateState,
  IncidentAction,
  IncidentProjectSettings,
  IncidentResponse,
  InvestigatorReport,
  PrSnapshot,
  ProofResult,
  VerifierReport,
} from "../../../shared/incident-response";
import type {
  Incident,
  IncidentState,
  Signal,
  SignalEvaluation,
} from "../../../shared/incidents";
import type { AgentLive } from "./agents";
import {
  currentAgent,
  decideNextStep,
  manualRollbackAvailable,
  needsYouOptions,
  nextActionFor,
  ownSignalIds,
  rollbackFirstApplies,
} from "./decide";
import { defaultProjectSettings } from "./project-settings";
import type { ResponseView } from "./steps";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const fence = (o: unknown) =>
  `Done.\n\n\`\`\`incident-report\n${JSON.stringify(o)}\n\`\`\``;

const rollbackAction: IncidentAction = {
  id: "rollback",
  kind: "rollback",
  label: "Roll back",
  runner: "runner-prod",
  command: "./rollback.sh {{previousRef}}",
  timeoutMs: 300_000,
  reversible: true,
  cost: { kind: "none" },
  needsSecret: false,
  scope: { services: [], paths: [], migrationPaths: [] },
};
const deployAction: IncidentAction = {
  ...rollbackAction,
  id: "deploy",
  kind: "deploy",
  label: "Deploy",
  command: "./deploy.sh {{ref}}",
  scope: { services: [], paths: ["src/**"], migrationPaths: [] },
};
const defaultSettings: IncidentProjectSettings = {
  ...defaultProjectSettings("acme"),
  actions: [deployAction, rollbackAction],
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
  createdAt: iso(-86_400_000),
  updatedAt: iso(-86_400_000),
};

function evaluation(
  state: SignalEvaluation["state"],
  since: string,
  signalId = "sig-a",
): SignalEvaluation {
  return {
    signalId,
    state,
    since,
    at: iso(0),
    reason: state,
    inMaintenance: false,
  };
}

function response(over: Partial<IncidentResponse> = {}): IncidentResponse {
  return {
    phase: "investigating",
    round: 1,
    maxRounds: 2,
    agents: [],
    actionRuns: [],
    costUsd: 0,
    ownerTouched: false,
    ledger: [],
    droppedLedger: 0,
    next: { kind: "working", detail: "Starting" },
    startedAt: iso(-60_000),
    updatedAt: iso(-60_000),
    ...over,
  };
}

function incident(
  state: IncidentState,
  r?: IncidentResponse,
  over: Partial<Incident> = {},
): Incident {
  return {
    id: "inc-1",
    project: "acme",
    title: "Search is down",
    state,
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: iso(0),
    updatedAt: iso(0),
    lastProblemAt: iso(0),
    findings: [],
    events: [],
    droppedEvents: 0,
    ...(r ? { response: r } : {}),
    ...over,
  };
}

function run(role: AgentRun["role"], over: Partial<AgentRun> = {}): AgentRun {
  return {
    role,
    round: 1,
    attempt: 1,
    sessionId: role === "investigator" ? "child-1" : "child-2",
    model:
      role === "investigator"
        ? "pi/anthropic/claude-opus-5-5"
        : "pi/openai/gpt-6.1-sol",
    provider: role === "investigator" ? "anthropic" : "openai",
    workspace: { kind: "sandbox", provider: "daytona" },
    accessSummary: "Investigator · no connections · can edit acme",
    accessRevision: "r1",
    status: "running",
    startedAt: iso(-60_000),
    turnSentAt: iso(-60_000),
    costUsd: 0,
    tokens: 0,
    reminded: false,
    ...over,
  };
}

function actionRun(over: Partial<ActionRun> = {}): ActionRun {
  const actionId = over.actionId ?? "deploy";
  const action = actionId === "rollback" ? rollbackAction : deployAction;
  return {
    id: "act-1",
    round: 1,
    actionId,
    kind: action.kind,
    label: action.label,
    runner: "runner-prod",
    status: "ok",
    purpose: "plan",
    startedAt: iso(-120_000),
    detail: "Exit 0",
    secretTouched: false,
    ...over,
  };
}

function live(
  states: Record<string, AgentLive["status"]>,
): Map<string, AgentLive> {
  return new Map(
    Object.entries(states).map(([id, status]) => [
      id,
      { status, costUsd: 0, tokens: 0 },
    ]),
  );
}

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

function view(over: Partial<ResponseView> = {}): ResponseView {
  return {
    now: NOW,
    incident: incident("investigating"),
    settings: defaultSettings,
    signals: new Map([["sig-a", httpSignal]]),
    evaluations: new Map([["sig-a", evaluation("failing", iso(-3_600_000))]]),
    primaryRecent: [],
    monthCostUsd: 0,
    agents: new Map(),
    liveActionRunIds: new Set(),
    models,
    ...over,
  };
}

const goodInvestigator: InvestigatorReport = {
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
  notePath: "docs/incidents/2026-10-20-search.md",
  runbookPaths: ["docs/incidents/runbook.md"],
};
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

function prSnapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    ghRepo: "acme/web",
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    headSha: "abc1234",
    base: "main",
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    requiredApprovals: 0,
    strictUpToDate: false,
    failingChecks: [],
    pendingChecks: [],
    missingRequired: [],
    files: [
      "src/search.ts",
      "docs/incidents/2026-10-20-search.md",
      "docs/incidents/runbook.md",
    ],
    fetchedAt: iso(-1_000),
    ...over,
  };
}

function candidate(over: Partial<CandidateState> = {}): CandidateState {
  return {
    round: 1,
    plan: { pr: true, actions: [] },
    check: goodInvestigator.check,
    claims: goodInvestigator.claims,
    notePath: goodInvestigator.notePath,
    runbookPaths: goodInvestigator.runbookPaths,
    prUrl: "https://github.com/acme/web/pull/12",
    ...over,
  };
}

function proofResult(over: {
  round: number;
  baseline: ProofResult["baseline"]["verdict"];
  candidate: ProofResult["candidate"]["verdict"];
}): ProofResult {
  return {
    round: over.round,
    at: iso(-30_000),
    baseline: { samples: [], verdict: over.baseline },
    candidate: {
      kind: over.candidate === "after-deploy" ? "after-deploy" : "request",
      samples: [],
      verdict: over.candidate,
    },
  };
}

test("guards: closed cancels, provider wait stops, kill switch pauses but never mid-command", () => {
  expect(
    decideNextStep(
      view({
        incident: incident(
          "closed-without-action",
          response({ agents: [run("investigator")] }),
        ),
        agents: live({ "child-1": "running" }),
      }),
    ),
  ).toEqual({
    step: "cancel-agents",
    reason: "Incident closed",
    for: "closed",
  });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "waiting-on-provider",
          response({ phase: "investigating" }),
        ),
      }),
    ),
  ).toEqual({
    step: "transition",
    to: null,
    phase: "idle",
    detail: "Agents stopped while waiting",
  });
  const paused = { ...defaultSettings, agentsPaused: true };
  expect(
    decideNextStep(
      view({
        settings: paused,
        incident: incident(
          "veto",
          response({ phase: "veto", veto: { startedAt: "x", deadline: "y" } }),
        ),
      }),
    ),
  ).toEqual({
    step: "transition",
    to: "paused",
    phase: "paused",
    detail: "Agents paused for acme",
    patch: { pausedFrom: "veto", veto: undefined },
  });
  expect(
    decideNextStep(
      view({
        settings: paused,
        liveActionRunIds: new Set(["act-1"]),
        incident: incident(
          "deploying",
          response({
            phase: "deploying",
            actionRuns: [actionRun({ id: "act-1", status: "running" })],
          }),
        ),
      }),
    ),
  ).toEqual({ step: "none" });
});

test("guards: a resolved incident closes its response; a heads-up stops agents", () => {
  expect(
    decideNextStep(
      view({
        incident: incident("resolved", response({ phase: "watching" })),
      }),
    ),
  ).toEqual({ step: "transition", to: null, phase: "done", detail: "Closed" });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "heads-up",
          response({ agents: [run("investigator")] }),
        ),
        agents: live({ "child-1": "running" }),
      }),
    ),
  ).toEqual({
    step: "cancel-agents",
    reason: "Back to a heads-up",
    for: "provider",
  });
});

test("resume after the kill switch restarts the veto from scratch", () => {
  expect(
    decideNextStep(
      view({
        incident: incident(
          "paused",
          response({ phase: "paused", pausedFrom: "veto" }),
          { resumeState: "veto" },
        ),
      }),
    ),
  ).toEqual({
    step: "transition",
    to: "fix-ready",
    phase: "deciding",
    detail: "Agents back on",
    patch: { pausedFrom: undefined },
  });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "paused",
          response({ phase: "paused", pausedFrom: "watching" }),
        ),
      }),
    ),
  ).toMatchObject({
    to: "watching",
    phase: "watching",
    patch: { watch: undefined },
  });
});

test("start: init, rollback-first, watch level, setup problem", () => {
  expect(decideNextStep(view({ incident: incident("investigating") }))).toEqual(
    { step: "init", rollbackFirst: false },
  );
  expect(
    decideNextStep(
      view({
        incident: incident("investigating"),
        settings: {
          ...defaultSettings,
          releases: [{ at: iso(-600_000), source: "hook", ref: "abc1234" }],
        },
      }),
    ),
  ).toEqual({ step: "init", rollbackFirst: true });
  expect(
    decideNextStep(
      view({
        incident: incident("investigating"),
        settings: { ...defaultSettings, autonomy: "watch" },
      }),
    ),
  ).toMatchObject({ step: "transition", phase: "watch-only" });
  expect(
    decideNextStep(
      view({
        incident: incident("investigating"),
        models: {
          error: "No model provider is configured for incident agents",
        },
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "setup",
    reason: "No model provider is configured for incident agents",
  });
});

test("rollback-first needs a recent release and a rollback action", () => {
  const withRelease = (at: string, actions = defaultSettings.actions) =>
    view({
      settings: {
        ...defaultSettings,
        actions,
        releases: [{ at, source: "hook" }],
      },
    });
  expect(rollbackFirstApplies(withRelease(iso(-1_800_000)))).toBe(true);
  expect(rollbackFirstApplies(withRelease(iso(-1_800_001)))).toBe(false);
  expect(rollbackFirstApplies(withRelease(iso(60_000)))).toBe(false);
  expect(rollbackFirstApplies(withRelease(iso(-60_000), [deployAction]))).toBe(
    false,
  );
});

test("investigation: start, remind once, then needs you", () => {
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({ phase: "investigating" }),
        ),
      }),
    ),
  ).toEqual({
    step: "start-agent",
    role: "investigator",
    round: 1,
    attempt: 1,
  });
  const done = (over: Partial<AgentRun>, text?: string) =>
    view({
      incident: incident(
        "investigating",
        response({
          phase: "investigating",
          agents: [run("investigator", over)],
        }),
      ),
      agents: new Map([
        [
          "child-1",
          {
            status: "done",
            costUsd: 1,
            tokens: 10,
            prUrl: "https://github.com/acme/web/pull/12",
            finalText: text,
          },
        ],
      ]),
    });
  expect(decideNextStep(done({}, "no block"))).toEqual({
    step: "record-report",
    sessionId: "child-1",
    error: "No incident-report block",
  });
  expect(
    decideNextStep(done({ reportError: "No incident-report block" })),
  ).toEqual({
    step: "message-agent",
    sessionId: "child-1",
    message: "reminder",
  });
  expect(
    decideNextStep(
      done({ reportError: "No incident-report block", reminded: true }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "no-report",
    reason:
      "The investigator finished without a valid report: No incident-report block",
  });
  expect(decideNextStep(done({ report: goodInvestigator }))).toMatchObject({
    step: "transition",
    to: "fix-ready",
    phase: "proving",
    patch: {
      candidate: {
        round: 1,
        plan: { pr: true, actions: [] },
        prUrl: "https://github.com/acme/web/pull/12",
      },
    },
  });
});

test("reports: a valid block is parsed; a candidate without a PR is refused", () => {
  const finished = (prUrl?: string) =>
    view({
      incident: incident(
        "investigating",
        response({ agents: [run("investigator")] }),
      ),
      agents: new Map([
        [
          "child-1",
          {
            status: "done",
            costUsd: 1,
            tokens: 10,
            ...(prUrl ? { prUrl } : {}),
            finalText: fence(goodInvestigator),
          },
        ],
      ]),
    });
  expect(
    decideNextStep(finished("https://github.com/acme/web/pull/12")),
  ).toMatchObject({
    step: "record-report",
    sessionId: "child-1",
    report: { role: "investigator", summary: "Upstream blocks our user agent" },
  });
  expect(decideNextStep(finished())).toEqual({
    step: "record-report",
    sessionId: "child-1",
    error: "Open a pull request with the note and the runbook update",
  });
  // Finished without any final message: no report after a grace period.
  const silent = (sentAgoMs: number) =>
    view({
      incident: incident(
        "investigating",
        response({
          agents: [run("investigator", { turnSentAt: iso(-sentAgoMs) })],
        }),
      ),
      agents: live({ "child-1": "done" }),
    });
  expect(decideNextStep(silent(10_000))).toEqual({ step: "none" });
  expect(decideNextStep(silent(120_000))).toEqual({
    step: "record-report",
    sessionId: "child-1",
    error: "No incident-report block",
  });
});

test("investigation: questions, errors, timeouts and no candidate", () => {
  const one = (agentOver: Partial<AgentRun>, status: AgentLive["status"]) =>
    view({
      incident: incident(
        "investigating",
        response({ agents: [run("investigator", agentOver)] }),
      ),
      agents: live({ "child-1": status }),
    });
  expect(decideNextStep(one({}, "waiting"))).toEqual({
    step: "needs-you",
    kind: "question",
    reason: "The investigator asked a question",
  });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({
            agents: [run("investigator", { status: "error", error: "boom" })],
          }),
        ),
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "agent-error",
    reason: "The investigator stopped: boom",
  });
  expect(
    decideNextStep(one({ turnSentAt: iso(-7_200_001) }, "running")),
  ).toEqual({
    step: "cancel-agents",
    reason: "The investigator ran for 2 h without finishing",
    for: "timeout",
  });
  expect(
    decideNextStep(
      one(
        {
          status: "cancelled",
          cancelledFor: "timeout",
          error: "The investigator ran for 2 h without finishing",
        },
        "cancelled",
      ),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "agent-error",
    reason: "The investigator ran for 2 h without finishing",
  });
  expect(
    decideNextStep(
      one(
        {
          status: "done",
          report: {
            ...goodInvestigator,
            candidate: null,
            noCandidateReason: "Upstream is down for everyone",
          },
        },
        "done",
      ),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "no-candidate",
    reason: "No fix found: Upstream is down for everyone",
  });
  // Cancelled by the kill switch: a new attempt once it is off.
  expect(
    decideNextStep(
      one({ status: "cancelled", cancelledFor: "paused" }, "cancelled"),
    ),
  ).toEqual({
    step: "start-agent",
    role: "investigator",
    round: 1,
    attempt: 2,
  });
  // Retry after an error: a new attempt.
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({
            retryRequested: true,
            agents: [run("investigator", { status: "error", error: "boom" })],
          }),
        ),
      }),
    ),
  ).toMatchObject({ step: "start-agent", attempt: 2 });
});

test("a question ends when the agent runs again", () => {
  const asked = (status: AgentLive["status"]) =>
    view({
      incident: incident(
        "needs-you",
        response({
          phase: "needs-you",
          needsYou: {
            kind: "question",
            reason: "The investigator asked a question",
            since: iso(-60_000),
            resumePhase: "investigating",
          },
          agents: [run("investigator", { status: "waiting" })],
        }),
        { resumeState: "investigating" },
      ),
      agents: live({ "child-1": status }),
    });
  expect(decideNextStep(asked("waiting"))).toEqual({ step: "none" });
  expect(decideNextStep(asked("running"))).toEqual({
    step: "transition",
    to: "investigating",
    phase: "investigating",
    detail: "Question answered",
    patch: { needsYou: undefined },
  });
});

test("a send-back goes to the same investigator; a reopen starts the next round", () => {
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({
            round: 2,
            agents: [
              run("investigator", { status: "done", report: goodInvestigator }),
            ],
          }),
        ),
      }),
    ),
  ).toEqual({
    step: "message-agent",
    sessionId: "child-1",
    message: "send-back",
  });
  expect(
    decideNextStep(
      view({
        incident: incident("investigating", response({ phase: "done" }), {
          events: [
            {
              id: "evt-1",
              at: iso(0),
              kind: "reopened",
              by: "sessions",
              detail: "Search failing again",
            },
          ],
        }),
      }),
    ),
  ).toMatchObject({
    step: "transition",
    to: null,
    phase: "investigating",
    detail: "Reopened",
    patch: {
      round: 2,
      sendBack: { kind: "reopened", detail: "Search failing again" },
    },
  });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({ phase: "done", round: 2 }),
        ),
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "rounds",
    reason: "Reopened after 2 rounds",
  });
});

test("proving: measure, stop when the problem stopped, fetch the PR, then verify", () => {
  const proving = (over: Partial<IncidentResponse>) =>
    view({
      incident: incident(
        "fix-ready",
        response({ phase: "proving", candidate: candidate(), ...over }),
      ),
    });
  expect(decideNextStep(proving({}))).toEqual({ step: "run-proof" });
  expect(
    decideNextStep(
      proving({
        proof: proofResult({
          round: 1,
          baseline: "passes",
          candidate: "passes",
        }),
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "proof-stopped",
    reason: "The problem stopped before the fix could be proven",
  });
  const proof = proofResult({
    round: 1,
    baseline: "fails",
    candidate: "passes",
  });
  expect(decideNextStep(proving({ proof }))).toEqual({
    step: "fetch-pr",
    purpose: "verify",
  });
  expect(
    decideNextStep(
      proving({
        proof,
        candidate: candidate({ pr: prSnapshot({ fetchedAt: iso(-31_000) }) }),
      }),
    ),
  ).toEqual({ step: "fetch-pr", purpose: "verify" });
  expect(
    decideNextStep(
      proving({ proof, candidate: candidate({ pr: prSnapshot() }) }),
    ),
  ).toEqual({
    step: "transition",
    to: null,
    phase: "verifying",
    detail: "Proof measured",
  });
});

test("verification: certain pins the SHA; not certain sends back, then stops at max rounds", () => {
  const verifying = (round: number, report: VerifierReport) =>
    view({
      incident: incident(
        "fix-ready",
        response({
          phase: "verifying",
          round,
          candidate: candidate({
            pr: prSnapshot({
              headSha: "abc1234",
              files: [
                "src/search.ts",
                "docs/incidents/2026-10-20-search.md",
                "docs/incidents/runbook.md",
              ],
            }),
          }),
          proof: proofResult({ round, baseline: "fails", candidate: "passes" }),
          agents: [
            run("investigator", { round, status: "done" }),
            run("verifier", {
              round,
              sessionId: "child-2",
              status: "done",
              report,
            }),
          ],
        }),
      ),
    });
  expect(decideNextStep(verifying(1, goodVerifier))).toMatchObject({
    step: "transition",
    phase: "deciding",
    patch: { verdict: { verdict: "certain", verifiedSha: "abc1234" } },
  });
  const doubt = {
    ...goodVerifier,
    verdict: "not-certain" as const,
    reasons: ["The 403 also happens with the new agent"],
  };
  expect(decideNextStep(verifying(1, doubt))).toMatchObject({
    step: "transition",
    to: "investigating",
    detail: "Sent back: The 403 also happens with the new agent",
    patch: {
      round: 2,
      sendBack: {
        kind: "not-certain",
        reasons: ["The 403 also happens with the new agent"],
      },
    },
  });
  expect(decideNextStep(verifying(2, doubt))).toEqual({
    step: "needs-you",
    kind: "rounds",
    reason:
      "Not certain after 2 rounds: The 403 also happens with the new agent",
  });
});

test("verification: Sessions overrides a certain verdict without the note", () => {
  const v = view({
    incident: incident(
      "fix-ready",
      response({
        phase: "verifying",
        candidate: candidate({ pr: prSnapshot({ files: ["src/search.ts"] }) }),
        proof: proofResult({
          round: 1,
          baseline: "fails",
          candidate: "passes",
        }),
        agents: [
          run("investigator", { status: "done" }),
          run("verifier", { status: "done", report: goodVerifier }),
        ],
      }),
    ),
  });
  expect(decideNextStep(v)).toMatchObject({
    step: "transition",
    to: "investigating",
    detail: "Sent back: The incident note is missing from the PR",
  });
});

test("verifying: start the verifier, and treat a missing report as not certain", () => {
  const base = {
    phase: "verifying" as const,
    candidate: candidate({ pr: prSnapshot() }),
    proof: proofResult({ round: 1, baseline: "fails", candidate: "passes" }),
  };
  expect(
    decideNextStep(
      view({
        incident: incident(
          "fix-ready",
          response({
            ...base,
            agents: [run("investigator", { status: "done" })],
          }),
        ),
      }),
    ),
  ).toEqual({ step: "start-agent", role: "verifier", round: 1, attempt: 1 });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "fix-ready",
          response({
            ...base,
            agents: [
              run("investigator", { status: "done" }),
              run("verifier", {
                status: "done",
                reportError: "No incident-report block",
                reminded: true,
              }),
            ],
          }),
        ),
      }),
    ),
  ).toMatchObject({
    step: "transition",
    to: "investigating",
    detail: "Sent back: The verifier did not return a valid report",
  });
});

test("budget stops agents and asks", () => {
  const over = view({
    incident: incident(
      "investigating",
      response({
        phase: "investigating",
        costUsd: 20.4,
        agents: [run("investigator")],
      }),
    ),
    agents: live({ "child-1": "running" }),
  });
  expect(decideNextStep(over)).toEqual({
    step: "cancel-agents",
    reason: "Agents stopped at the $20 budget for this incident",
    for: "budget",
  });
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({ phase: "investigating", costUsd: 5 }),
        ),
        monthCostUsd: 196,
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "budget",
    reason: "Agents stopped at the $200 monthly budget",
    rule: "Budget: $200 per month, from the project settings",
  });
});

test("next action copy and options", () => {
  expect(
    needsYouOptions(
      "protection",
      response({
        verdict: { round: 1, at: "x", verdict: "certain", reasons: [] },
      }),
    ),
  ).toEqual(["approve", "send-back", "close"]);
  expect(needsYouOptions("protection", response({}))).toEqual([
    "send-back",
    "close",
  ]);
  expect(needsYouOptions("setup", response({}))).toEqual([
    "retry",
    "resolve",
    "close",
  ]);
  expect(needsYouOptions("question", response({}))).toEqual([]);
  expect(needsYouOptions("rounds", response({}))).toEqual([
    "send-back",
    "resolve",
    "close",
  ]);
  expect(
    nextActionFor(
      incident("investigating", response({ phase: "investigating", round: 2 })),
      defaultSettings,
    ),
  ).toEqual({ kind: "working", detail: "Investigator working, round 2 of 2" });
  expect(
    nextActionFor(
      incident(
        "needs-you",
        response({
          phase: "needs-you",
          decision: {
            kind: "ask",
            reason: "Verified and ready. Waiting for you",
            rule: "Propose, from the project settings",
          },
          needsYou: {
            kind: "policy",
            reason: "Verified and ready. Waiting for you",
            since: iso(0),
            resumePhase: "deciding",
          },
        }),
      ),
      defaultSettings,
    ),
  ).toEqual({
    kind: "needs-you",
    needsYou: "policy",
    reason: "Verified and ready. Waiting for you",
    rule: "Propose, from the project settings",
    options: ["send-back", "close"],
  });
  expect(
    nextActionFor(
      incident("paused", response({ phase: "paused" })),
      defaultSettings,
    ),
  ).toEqual({
    kind: "info",
    detail: "Agents paused for acme",
    rule: "Kill switch, from the project settings",
  });
  expect(
    nextActionFor(
      incident("investigating", response({ phase: "watch-only" })),
      defaultSettings,
    ),
  ).toEqual({
    kind: "info",
    detail: "Watching only. Agents are off for acme",
    rule: "Watch, from the project settings",
  });
});

test("helpers: current agent and own signals", () => {
  const r = response({
    agents: [
      run("investigator", { attempt: 1 }),
      run("verifier"),
      run("investigator", { attempt: 2, sessionId: "child-3" }),
    ],
  });
  expect(currentAgent(r, "investigator")?.sessionId).toBe("child-3");
  expect(
    ownSignalIds(
      view({
        incident: incident("investigating", undefined, {
          signalIds: ["sig-a", "sig-p", "sig-gone"],
        }),
        signals: new Map([
          ["sig-a", httpSignal],
          ["sig-p", { ...httpSignal, id: "sig-p", provider: true }],
        ]),
      }),
    ),
  ).toEqual(["sig-a"]);
  expect(
    manualRollbackAvailable(
      incident("investigating", response()),
      defaultSettings,
    ),
  ).toBe(false);
});
