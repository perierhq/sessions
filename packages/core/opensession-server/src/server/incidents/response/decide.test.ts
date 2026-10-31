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
import { roundOfMax } from "../../../shared/incident-response";
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
  waitingMayBeStale,
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
    retryable: false,
    fix: "providers",
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
  // The newest release was a rollback: the release it undid is not rolled
  // back again.
  expect(
    rollbackFirstApplies(
      view({
        settings: {
          ...defaultSettings,
          releases: [
            { at: iso(-60_000), source: "action", rollback: true },
            { at: iso(-600_000), source: "hook" },
          ],
        },
      }),
    ),
  ).toBe(false);
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
    problem: "missing",
    issues: [
      { rule: "block", problem: "missing", error: "No incident-report block" },
    ],
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
      done({
        reportError: "No incident-report block",
        reportProblem: "missing",
        reminded: true,
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "no-report",
    reason:
      "The investigator finished without writing its report. Try again so it writes one.",
  });
  // The parser's detail never reaches the owner, even from an older run
  // stored without a problem kind.
  expect(
    decideNextStep(
      done({
        reportError: "The summary field must say what broke",
        reminded: true,
      }),
    ),
  ).toMatchObject({
    step: "needs-you",
    reason:
      "The investigator's report could not be used. Try again so it finishes the report.",
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
  const noPr = {
    rule: "pr",
    problem: "pr" as const,
    error: "Open a pull request with the note and the runbook update",
  };
  expect(decideNextStep(finished())).toEqual({
    step: "record-report",
    sessionId: "child-1",
    error: noPr.error,
    problem: "pr",
    issues: [noPr],
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
    problem: "missing",
    issues: [
      { rule: "block", problem: "missing", error: "No incident-report block" },
    ],
  });
});

test("a report's findings ride on the record-report step", () => {
  const findings = {
    blocks: [{ id: "unknown", kind: "question", text: "Why only some?" }],
  };
  const investigatorDone = (report: object) =>
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
            prUrl: "https://github.com/acme/web/pull/12",
            finalText: fence(report),
          },
        ],
      ]),
    });
  const verifierDone = (report: object) =>
    view({
      incident: incident(
        "fix-ready",
        response({
          phase: "verifying",
          candidate: candidate(),
          agents: [
            run("investigator", { status: "done", report: goodInvestigator }),
            run("verifier", { sessionId: "child-2" }),
          ],
        }),
      ),
      agents: new Map([
        [
          "child-2",
          { status: "done", costUsd: 1, tokens: 10, finalText: fence(report) },
        ],
      ]),
    });
  const inv = decideNextStep(
    investigatorDone({ ...goodInvestigator, findings }),
  );
  expect(inv).toMatchObject({
    step: "record-report",
    sessionId: "child-1",
    report: { role: "investigator" },
  });
  expect(inv).toHaveProperty("findings", findings);
  const ver = decideNextStep(verifierDone({ ...goodVerifier, findings }));
  expect(ver).toMatchObject({
    step: "record-report",
    sessionId: "child-2",
    report: { role: "verifier" },
  });
  expect(ver).toHaveProperty("findings", findings);
  expect(decideNextStep(investigatorDone(goodInvestigator))).not.toHaveProperty(
    "findings",
  );
  expect(decideNextStep(verifierDone(goodVerifier))).not.toHaveProperty(
    "findings",
  );
  // A refused report carries none: nothing is saved from it.
  expect(
    decideNextStep(
      investigatorDone({ ...goodInvestigator, summary: "", findings }),
    ),
  ).not.toHaveProperty("findings");
});

test("reports: a refused fix without its PR names the block's problems and the PR at once", () => {
  const v = view({
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
          finalText: fence({
            ...goodInvestigator,
            summary: "",
            notePath: "notes.md",
          }),
        },
      ],
    ]),
  });
  expect(decideNextStep(v)).toEqual({
    step: "record-report",
    sessionId: "child-1",
    error:
      "The summary field must say what broke; The notePath field must be docs/incidents/YYYY-MM-DD-<slug>.md",
    // The owner hears about the report first: a PR alone would be found
    // again on a Retry.
    problem: "conclusion",
    issues: [
      {
        rule: "summary",
        problem: "conclusion",
        error: "The summary field must say what broke",
      },
      {
        rule: "note",
        problem: "note",
        error: "The notePath field must be docs/incidents/YYYY-MM-DD-<slug>.md",
      },
      {
        rule: "pr",
        problem: "pr",
        error: "Open a pull request with the note and the runbook update",
      },
    ],
  });
});

test("reports: on a Retry, a report refused for want of a PR is read again once the PR is found", () => {
  const refused = (over: { prUrl?: string; retry?: boolean }) =>
    view({
      incident: incident(
        "investigating",
        response({
          ...(over.retry === false ? {} : { retryRequested: true }),
          agents: [
            run("investigator", {
              status: "done",
              reminded: true,
              reportError:
                "Open a pull request with the note and the runbook update",
              reportProblem: "pr",
            }),
          ],
        }),
      ),
      agents: new Map([
        [
          "child-1",
          {
            status: "done",
            costUsd: 1,
            tokens: 10,
            ...(over.prUrl ? { prUrl: over.prUrl } : {}),
            finalText: fence(goodInvestigator),
          },
        ],
      ]),
    });
  const pr = "https://github.com/acme/web/pull/469";
  expect(decideNextStep(refused({ prUrl: pr }))).toMatchObject({
    step: "record-report",
    sessionId: "child-1",
    report: { role: "investigator", summary: "Upstream blocks our user agent" },
    prUrl: pr,
    reread: true,
  });
  // Still no pull request: the Retry starts the investigator over.
  expect(decideNextStep(refused({}))).toMatchObject({
    step: "start-agent",
    role: "investigator",
    attempt: 2,
  });
  // Without a Retry nothing is read again.
  expect(decideNextStep(refused({ prUrl: pr, retry: false }))).toMatchObject({
    step: "needs-you",
    kind: "no-report",
  });
});

test("reports: an unknown attempt result is repaired with a warning, not refused", () => {
  const text = fence({
    ...goodInvestigator,
    attempts: [
      {
        step: "Read the status page",
        cost: "free",
        result: "Informative",
        evidence: "Day bars show the outage",
      },
      { ...goodInvestigator.attempts[0], result: "helpful" },
    ],
  });
  const step = decideNextStep(
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
            prUrl: "https://github.com/acme/web/pull/12",
            finalText: text,
          },
        ],
      ]),
    }),
  );
  expect(step).toMatchObject({
    step: "record-report",
    sessionId: "child-1",
    report: { role: "investigator" },
  });
  if (step.step !== "record-report" || step.report?.role !== "investigator")
    throw new Error("expected an investigator report");
  expect(step.report.attempts.map((a) => a.result)).toEqual([
    "informative",
    "inconclusive",
  ]);
  expect(step.report.attempts[1].evidence).toBe(
    '200 with app UA, 403 without\n(Reported result: "helpful")',
  );
  expect(step.warnings).toEqual([
    'Attempt 2 (Request with app UA) had result "helpful", not one of ruled-out, confirmed, inconclusive, informative; recorded as inconclusive',
  ]);
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
  // Stopped from its own session: the owner decides.
  expect(decideNextStep(one({ status: "cancelled" }, "cancelled"))).toEqual({
    step: "needs-you",
    kind: "agent-error",
    reason: "The investigator was stopped",
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
        incident: incident(
          "investigating",
          response({
            phase: "done",
            agents: [run("investigator", { status: "done" })],
          }),
          {
            events: [
              {
                id: "evt-1",
                at: iso(0),
                kind: "reopened",
                by: "sessions",
                detail: "Search failing again",
              },
            ],
          },
        ),
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
          response({
            phase: "done",
            round: 2,
            agents: [
              run("investigator", { status: "done" }),
              run("investigator", { round: 2, status: "done" }),
            ],
          }),
        ),
      }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "rounds",
    reason: "Reopened after 2 rounds",
  });
});

test("a reopen counts only rounds an investigator worked in", () => {
  // Closed before any agent ran (no sandbox yet): the round never ran, so
  // the reopen starts it instead of counting it as used.
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({ phase: "done", round: 1 }),
        ),
      }),
    ),
  ).toMatchObject({
    step: "transition",
    to: null,
    phase: "investigating",
    detail: "Reopened",
    patch: { round: 1 },
  });
  // Round 2 never ran: one round was used, not two.
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({
            phase: "done",
            round: 2,
            agents: [run("investigator", { status: "done" })],
          }),
        ),
      }),
    ),
  ).toMatchObject({ step: "transition", patch: { round: 2 } });
});

test("a round past the limit is labelled as an extra round", () => {
  expect(roundOfMax(2, 2)).toBe("2 of 2");
  expect(roundOfMax(3, 2)).toBe("3, an extra round past the limit of 2");
  expect(
    nextActionFor(
      incident("investigating", response({ round: 3, maxRounds: 2 })),
      defaultProjectSettings("acme"),
    ),
  ).toEqual({
    kind: "working",
    detail: "Investigator working, round 3, an extra round past the limit of 2",
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

// --- Task 16: policy, veto, merge, deploy, watch, rollback, notes ---

const VERIFIED = "abc1234";
const certainVerdict = {
  round: 1,
  at: iso(-60_000),
  verdict: "certain" as const,
  reasons: [],
  verifiedSha: VERIFIED,
};
const verifiedAgents = [
  run("investigator", {
    status: "done",
    report: goodInvestigator,
    prUrl: "https://github.com/acme/web/pull/12",
  }),
  run("verifier", {
    status: "done",
    report: goodVerifier,
    independence: "other-provider",
  }),
];

function settingsWith(deployScope?: Partial<IncidentAction["scope"]>) {
  return {
    ...defaultSettings,
    actions: [
      { ...deployAction, scope: { ...deployAction.scope, ...deployScope } },
      rollbackAction,
    ],
  };
}

function certain(
  over: {
    pr?: Partial<PrSnapshot>;
    deployScope?: Partial<IncidentAction["scope"]>;
  } = {},
): ResponseView {
  return view({
    settings: settingsWith(over.deployScope),
    incident: incident(
      "fix-ready",
      response({
        phase: "deciding",
        candidate: candidate({ pr: prSnapshot(over.pr) }),
        proof: proofResult({
          round: 1,
          baseline: "fails",
          candidate: "passes",
        }),
        verdict: certainVerdict,
        agents: verifiedAgents,
      }),
    ),
  });
}

const actDecision = {
  kind: "act" as const,
  after: "veto" as const,
  vetoMs: 600_000,
  rule: "Deploy after veto, from the project settings",
};

function inVeto(veto: { deadline: string }): ResponseView {
  return view({
    incident: incident(
      "veto",
      response({
        phase: "veto",
        candidate: candidate({ pr: prSnapshot() }),
        verdict: certainVerdict,
        decision: actDecision,
        veto: { startedAt: iso(-600_000), deadline: veto.deadline },
        agents: verifiedAgents,
      }),
    ),
  });
}

function merging(
  pr: Partial<PrSnapshot>,
  over: Partial<IncidentResponse> = {},
): ResponseView {
  return view({
    incident: incident(
      "deploying",
      response({
        phase: "merging",
        candidate: candidate({ pr: prSnapshot(pr) }),
        verdict: certainVerdict,
        decision: actDecision,
        mergingSince: iso(-1_000),
        agents: verifiedAgents,
        ...over,
      }),
    ),
  });
}

const mergedRecord = {
  ghRepo: "acme/web",
  number: 12,
  sha: VERIFIED,
  status: "merged" as const,
  mergedSha: "9f9f9f9",
  at: iso(-30_000),
};

function deploying(
  actionRuns: ActionRun[],
  liveIds: Set<string> = new Set(),
): ResponseView {
  return view({
    liveActionRunIds: liveIds,
    incident: incident(
      "deploying",
      response({
        phase: "deploying",
        candidate: candidate({ pr: prSnapshot() }),
        verdict: certainVerdict,
        decision: actDecision,
        merge: mergedRecord,
        actionRuns,
        agents: verifiedAgents,
      }),
    ),
  });
}

function watching(
  watch: { startedAt: string; deadline: string },
  evaluations: Map<string, SignalEvaluation>,
  over: Partial<IncidentResponse> = {},
): ResponseView {
  return view({
    evaluations,
    incident: incident(
      "watching",
      response({
        phase: "watching",
        candidate: candidate({ pr: prSnapshot() }),
        verdict: certainVerdict,
        decision: actDecision,
        merge: mergedRecord,
        actionRuns: [actionRun({ actionId: "deploy", status: "ok" })],
        watch,
        agents: verifiedAgents,
        ...over,
      }),
    ),
  });
}

function rollingBack(
  actionRuns: ActionRun[],
  over: Partial<IncidentResponse> & { state?: IncidentState } = {},
): ResponseView {
  const { state = "rolled-back", ...rest } = over;
  return view({
    incident: incident(
      state,
      response({
        phase: "rolling-back",
        candidate: candidate({ pr: prSnapshot() }),
        merge: mergedRecord,
        actionRuns: [
          actionRun({ id: "act-0", actionId: "deploy", status: "ok" }),
          ...actionRuns,
        ],
        agents: verifiedAgents,
        ...rest,
      }),
    ),
  });
}

const rollbackCandidate = candidate({
  plan: { pr: false, actions: ["rollback"] },
  check: {
    kind: "after-deploy",
    reason: "Rolling back the release at 11:55 UTC",
  },
  claims: [],
  prUrl: undefined,
  rollbackFirst: true,
});

function rollbackFirst(over: Partial<IncidentResponse> = {}): ResponseView {
  return view({
    incident: incident(
      "fix-ready",
      response({ phase: "deciding", candidate: rollbackCandidate, ...over }),
    ),
  });
}

function rollbackFirstWatching(watch: { deadline: string }): ResponseView {
  return view({
    incident: incident(
      "watching",
      response({
        phase: "watching",
        candidate: rollbackCandidate,
        decision: actDecision,
        actionRuns: [
          actionRun({
            actionId: "rollback",
            purpose: "rollback-first",
            status: "ok",
          }),
        ],
        watch: { startedAt: iso(-600_000), deadline: watch.deadline },
        agents: [run("investigator")],
      }),
    ),
    agents: live({ "child-1": "running" }),
  });
}

function documenting(
  pr: Partial<PrSnapshot>,
  over: Partial<IncidentResponse> = {},
): ResponseView {
  return view({
    incident: incident(
      "resolved",
      response({
        phase: "documenting",
        documentingSince: iso(-60_000),
        agents: [
          run("investigator", {
            status: "done",
            prUrl: "https://github.com/acme/web/pull/13",
          }),
        ],
        note: {
          prUrl: "https://github.com/acme/web/pull/13",
          pr: prSnapshot({
            number: 13,
            url: "https://github.com/acme/web/pull/13",
            ...pr,
          }),
          merged: false,
        },
        ...over,
      }),
      { fixedBy: "by-hand" },
    ),
  });
}

test("deciding: default policy opens the veto; protection asks first", () => {
  expect(decideNextStep(certain())).toEqual({
    step: "open-veto",
    decision: {
      kind: "act",
      after: "veto",
      vetoMs: 600_000,
      rule: "Deploy after veto, from the project settings",
    },
  });
  expect(
    decideNextStep(certain({ pr: { requiredApprovals: 1 } })),
  ).toMatchObject({
    step: "needs-you",
    kind: "protection",
    reason: "Branch protection requires a review on PR #12",
  });
  expect(
    decideNextStep(
      certain({
        pr: { files: ["src/db/migrations/0042.sql"] },
        deployScope: { migrationPaths: ["src/db/migrations/**"] },
      }),
    ),
  ).toMatchObject({
    step: "needs-you",
    kind: "policy",
    rule: "Never without you: runs a migration, from the project settings",
  });
});

test("deciding: a stale PR is fetched first; right away goes straight to merging", () => {
  expect(decideNextStep(certain({ pr: { fetchedAt: iso(-60_000) } }))).toEqual({
    step: "fetch-pr",
    purpose: "merge",
  });
  const now = certain();
  expect(
    decideNextStep({
      ...now,
      settings: { ...now.settings, autonomy: "deploy-right-away" },
    }),
  ).toEqual({
    step: "transition",
    to: "deploying",
    phase: "merging",
    detail: "Deploy right away, from the project settings",
    patch: {
      decision: {
        kind: "act",
        after: "now",
        vetoMs: 0,
        rule: "Deploy right away, from the project settings",
      },
      mergingSince: iso(0),
    },
  });
  expect(
    decideNextStep({
      ...now,
      settings: { ...now.settings, autonomy: "propose" },
    }),
  ).toMatchObject({
    step: "needs-you",
    kind: "policy",
    reason: "Verified and ready. Waiting for you",
    patch: { decision: { kind: "ask" } },
  });
  expect(
    decideNextStep(certain({ pr: { failingChecks: ["test"] } })),
  ).toMatchObject({
    step: "transition",
    to: "investigating",
    patch: {
      round: 2,
      sendBack: { kind: "check-failed", detail: "Check test failed on PR #12" },
    },
  });
});

test("veto elapses into merging; merging merges only the verified head", () => {
  expect(decideNextStep(inVeto({ deadline: iso(1) }))).toEqual({
    step: "none",
  });
  expect(decideNextStep(inVeto({ deadline: iso(-1) }))).toMatchObject({
    step: "transition",
    to: "deploying",
    phase: "merging",
    detail: "Veto window elapsed",
  });
  expect(decideNextStep(merging({}))).toEqual({ step: "merge" });
  expect(decideNextStep(merging({ headSha: "fff9999" }))).toEqual({
    step: "needs-you",
    kind: "merge",
    reason: "PR #12 changed after verification",
  });
  expect(
    decideNextStep(
      merging({ pendingChecks: ["test"] }, { mergingSince: iso(-1_300_000) }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "merge",
    reason: "Checks are still running on PR #12 after 20 min",
  });
  expect(decideNextStep(merging({ pendingChecks: ["test"] }))).toEqual({
    step: "none",
  });
  expect(decideNextStep(merging({ failingChecks: ["test"] }))).toMatchObject({
    step: "transition",
    to: "investigating",
    patch: {
      round: 2,
      sendBack: { kind: "check-failed", detail: "Check test failed on PR #12" },
    },
  });
});

test("merging: a recorded merge moves on; someone else's merge is checked", () => {
  expect(decideNextStep(merging({}, { merge: mergedRecord }))).toEqual({
    step: "transition",
    to: null,
    phase: "deploying",
    detail: "Merged PR #12",
  });
  expect(
    decideNextStep(
      merging(
        {},
        {
          merge: {
            ...mergedRecord,
            status: "refused",
            detail: "GitHub refused the merge",
          },
        },
      ),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "merge",
    reason: "GitHub refused the merge",
  });
  expect(
    decideNextStep(merging({ state: "MERGED", mergeCommitSha: "9f9f9f9" })),
  ).toMatchObject({
    step: "transition",
    to: null,
    phase: "deploying",
    detail: "PR #12 was already merged",
    patch: {
      merge: { status: "merged", sha: VERIFIED, mergedSha: "9f9f9f9" },
    },
  });
  expect(
    decideNextStep(merging({ state: "MERGED", headSha: "fff9999" })),
  ).toEqual({
    step: "needs-you",
    kind: "merge",
    reason: "PR #12 was merged with changes after verification",
  });
  expect(decideNextStep(merging({ fetchedAt: iso(-31_000) }))).toEqual({
    step: "fetch-pr",
    purpose: "merge",
  });
});

test("deploying: runs each step once and never re-runs an interrupted one", () => {
  expect(decideNextStep(deploying([]))).toEqual({
    step: "run-action",
    actionId: "deploy",
    purpose: "plan",
  });
  expect(
    decideNextStep(
      deploying(
        [actionRun({ id: "act-1", actionId: "deploy", status: "running" })],
        new Set(["act-1"]),
      ),
    ),
  ).toEqual({ step: "none" });
  expect(
    decideNextStep(
      deploying(
        [actionRun({ id: "act-1", actionId: "deploy", status: "running" })],
        new Set(),
      ),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "interrupted",
    reason:
      "Sessions restarted while Deploy was running. Check production before going on.",
  });
  expect(
    decideNextStep(
      deploying([actionRun({ actionId: "deploy", status: "interrupted" })]),
    ),
  ).toMatchObject({ step: "needs-you", kind: "interrupted" });
  expect(
    decideNextStep(
      deploying([
        actionRun({ actionId: "deploy", status: "failed", detail: "Exit 1" }),
      ]),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "action-failed",
    reason: "Deploy failed: Exit 1",
  });
  expect(
    decideNextStep(
      deploying([
        actionRun({
          actionId: "deploy",
          status: "unknown",
          detail: "The Runner disconnected while the action ran",
        }),
      ]),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "action-failed",
    reason: "Deploy: The Runner disconnected while the action ran",
  });
  expect(
    decideNextStep(
      deploying([actionRun({ actionId: "deploy", status: "ok" })]),
    ),
  ).toEqual({ step: "start-watch" });
  const unmerged = deploying([]);
  unmerged.incident.response!.merge = undefined;
  expect(decideNextStep(unmerged)).toEqual({
    step: "needs-you",
    kind: "merge",
    reason: "No merge commit to deploy for PR #12",
  });
});

test("watching: green resolves, a red deadline rolls back, then the next round", () => {
  const green = new Map([["sig-a", evaluation("ok", iso(-60_000))]]);
  expect(
    decideNextStep(
      watching({ startedAt: iso(-120_000), deadline: iso(480_000) }, green),
    ),
  ).toEqual({
    step: "resolve",
    fixedBy: "agents",
    detail: "Search back to normal after the release",
  });
  expect(
    decideNextStep(
      watching({ startedAt: iso(-120_000), deadline: iso(480_000) }, green, {
        ownerTouched: true,
      }),
    ),
  ).toMatchObject({ step: "resolve", fixedBy: "agents-with-you" });
  // Green since before the watch started: not yet proof of the release.
  const before = new Map([["sig-a", evaluation("ok", iso(-200_000))]]);
  expect(
    decideNextStep(
      watching({ startedAt: iso(-120_000), deadline: iso(480_000) }, before),
    ),
  ).toEqual({ step: "none" });
  const stillRed = new Map([["sig-a", evaluation("failing", iso(-3_600_000))]]);
  expect(
    decideNextStep(
      watching({ startedAt: iso(-600_000), deadline: iso(-1) }, stillRed),
    ),
  ).toEqual({
    step: "transition",
    to: "rolled-back",
    phase: "rolling-back",
    detail: "Search still failing after the watch window",
  });
  expect(decideNextStep(rollingBack([]))).toEqual({
    step: "run-action",
    actionId: "rollback",
    purpose: "auto-rollback",
  });
  expect(
    decideNextStep(
      rollingBack([
        actionRun({
          actionId: "rollback",
          purpose: "auto-rollback",
          status: "ok",
        }),
      ]),
    ),
  ).toMatchObject({
    step: "transition",
    to: "investigating",
    patch: {
      round: 2,
      sendBack: {
        kind: "rolled-back",
        detail: "Search was still failing 10 min after the release",
      },
    },
  });
  expect(
    decideNextStep(
      rollingBack(
        [
          actionRun({
            actionId: "rollback",
            purpose: "auto-rollback",
            status: "ok",
            round: 2,
          }),
        ],
        { round: 2 },
      ),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "rounds",
    reason: "Rolled back after 2 rounds",
  });
  expect(
    decideNextStep(
      rollingBack([
        actionRun({
          actionId: "rollback",
          purpose: "auto-rollback",
          status: "failed",
          detail: "Exit 2",
        }),
      ]),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "action-failed",
    reason: "Rollback failed: Exit 2",
  });
  const noRollback = watching(
    { startedAt: iso(-600_000), deadline: iso(-1) },
    stillRed,
  );
  expect(
    decideNextStep({
      ...noRollback,
      settings: { ...defaultSettings, actions: [deployAction] },
    }),
  ).toEqual({
    step: "needs-you",
    kind: "no-action",
    reason:
      "Search is still failing after the release and there is no rollback action",
  });
});

test("rollback-first: the rollback goes to the veto while the investigator reads the release", () => {
  const rf = rollbackFirst();
  expect(decideNextStep(rf)).toEqual({
    step: "start-agent",
    role: "investigator",
    round: 1,
    attempt: 1,
  });
  expect(
    decideNextStep(rollbackFirst({ agents: [run("investigator")] })),
  ).toMatchObject({ step: "open-veto" });
  expect(decideNextStep(rollbackFirstWatching({ deadline: iso(-1) }))).toEqual({
    step: "needs-you",
    kind: "action-failed",
    reason: "The rollback did not bring Search back",
  });
  // Deploying a rollback-first candidate runs the rollback, not a deploy.
  expect(
    decideNextStep(
      view({
        incident: incident(
          "deploying",
          response({
            phase: "deploying",
            candidate: rollbackCandidate,
            agents: [run("investigator")],
          }),
        ),
        agents: live({ "child-1": "running" }),
      }),
    ),
  ).toEqual({
    step: "run-action",
    actionId: "rollback",
    purpose: "rollback-first",
  });
});

test("rollback-first: the parallel investigator is best effort and never holds the rollback", () => {
  // No model: the rollback still starts, and the investigator is skipped.
  const noModels = {
    error: "No model provider is configured for incident agents",
  };
  expect(
    decideNextStep(
      view({
        incident: incident("investigating"),
        settings: {
          ...defaultSettings,
          releases: [{ at: iso(-600_000), source: "hook", ref: "abc1234" }],
        },
        models: noModels,
      }),
    ),
  ).toEqual({ step: "init", rollbackFirst: true });
  expect(decideNextStep({ ...rollbackFirst(), models: noModels })).toEqual({
    step: "skip-parallel-investigator",
    outcome: "unavailable",
    reason: "No model provider is configured for incident agents",
  });
  // The month's budget is used up: refused, the rollback goes on.
  expect(decideNextStep({ ...rollbackFirst(), monthCostUsd: 200 })).toEqual({
    step: "skip-parallel-investigator",
    outcome: "refused",
    reason: "Agents stopped at the $200 monthly budget",
  });
  // A passing gate refusal: the rollback goes on, the investigator is
  // tried again once the retry time comes.
  expect(
    decideNextStep(
      rollbackFirst({
        parallelInvestigatorRetryAt: iso(30_000),
        decision: undefined,
      }),
    ),
  ).toMatchObject({ step: "open-veto" });
  expect(
    decideNextStep(
      rollbackFirst({
        parallelInvestigatorRetryAt: iso(-1),
        decision: undefined,
      }),
    ),
  ).toEqual({
    step: "start-agent",
    role: "investigator",
    round: 1,
    attempt: 1,
  });
  // Once skipped, the rollback path goes on without it.
  for (const outcome of ["unavailable", "refused"] as const)
    expect(
      decideNextStep(
        rollbackFirst({ parallelInvestigator: outcome, decision: undefined }),
      ),
    ).toMatchObject({ step: "open-veto" });
});

test("kill switch before the rollback ran: needs you, the release is still out", () => {
  const paused = rollingBack([], { ownerRollback: { by: "Bo", at: iso(0) } });
  const step = decideNextStep({
    ...paused,
    settings: { ...paused.settings, agentsPaused: true },
  });
  expect(step).toMatchObject({
    step: "needs-you",
    kind: "action-failed",
    reason:
      "Agents were paused before the rollback ran; the release is still out",
    via: "investigating",
    patch: { phase: "investigating", round: 2 },
  });
  expect(step.step === "needs-you" && step.patch).toHaveProperty(
    "ownerRollback",
    undefined,
  );
});

test("kill switch after the rollback ran: the next round, then paused", () => {
  const done = rollingBack([
    actionRun({
      id: "act-1",
      actionId: "rollback",
      purpose: "auto-rollback",
      status: "ok",
    }),
  ]);
  const step = decideNextStep({
    ...done,
    settings: { ...done.settings, agentsPaused: true },
  });
  expect(step).toMatchObject({
    step: "transition",
    to: "investigating",
    phase: "investigating",
    detail: "Rolled back",
    patch: { round: 2, sendBack: { kind: "rolled-back" } },
  });
  // The next advance pauses the new round.
  const next = view({
    incident: incident("investigating", response({ round: 2 })),
    settings: { ...done.settings, agentsPaused: true },
  });
  expect(decideNextStep(next)).toMatchObject({
    step: "transition",
    to: "paused",
    phase: "paused",
  });
  // A rollback that failed or was interrupted: the release is still out.
  for (const [status, detail, word] of [
    ["failed", "Exit 1", "failed"],
    [
      "interrupted",
      "Sessions restarted while this was running",
      "was interrupted",
    ],
  ] as const) {
    const bad = rollingBack([
      actionRun({
        id: "act-1",
        actionId: "rollback",
        purpose: "auto-rollback",
        status,
        detail,
      }),
    ]);
    expect(
      decideNextStep({
        ...bad,
        settings: { ...bad.settings, agentsPaused: true },
      }),
    ).toMatchObject({
      step: "needs-you",
      kind: "action-failed",
      reason: `Agents were paused after the rollback ${word} (${detail}); the release is still out`,
      via: "investigating",
      patch: { phase: "investigating", round: 2 },
    });
  }
});

test("documenting: an investigator running for over 2 h is stopped", () => {
  const overdue = documenting(
    { files: ["docs/incidents/2026-10-20-search.md"] },
    {
      agents: [
        run("investigator", {
          status: "running",
          turnSentAt: iso(-7_200_001),
        }),
      ],
    },
  );
  expect(
    decideNextStep({ ...overdue, agents: live({ "child-1": "running" }) }),
  ).toEqual({
    step: "cancel-agents",
    reason: "The investigator ran for 2 h without finishing",
    for: "timeout",
  });
});

test("documenting: with agents paused the note PR is left open, never merged", () => {
  const paused = documenting({
    files: ["docs/incidents/2026-10-20-search.md"],
  });
  expect(
    decideNextStep({
      ...paused,
      settings: { ...paused.settings, agentsPaused: true },
    }),
  ).toMatchObject({
    step: "transition",
    phase: "done",
    detail: "Note PR #13 is waiting for you: agents are paused",
  });
});

test("documenting: a notes-only PR merges, a code PR is left for review, nobody is woken", () => {
  expect(
    decideNextStep(
      documenting({
        files: [
          "docs/incidents/2026-10-20-search.md",
          "docs/incidents/runbook.md",
        ],
      }),
    ),
  ).toEqual({ step: "merge-note" });
  expect(
    decideNextStep(
      documenting({
        files: ["src/search.ts", "docs/incidents/2026-10-20-search.md"],
      }),
    ),
  ).toMatchObject({
    step: "transition",
    phase: "done",
    detail: "PR #13 has code changes, so it is left open for review",
  });
  expect(
    decideNextStep(
      documenting({ requiredApprovals: 1, files: ["docs/incidents/x.md"] }),
    ),
  ).toMatchObject({
    step: "transition",
    phase: "done",
    detail: "Branch protection requires a review on PR #13",
  });
});

test("documenting: the fix PR carried the note, or there is none, or it waits", () => {
  expect(
    decideNextStep(
      documenting(
        {},
        {
          candidate: candidate({ pr: prSnapshot() }),
          merge: mergedRecord,
        },
      ),
    ),
  ).toEqual({
    step: "transition",
    to: null,
    phase: "done",
    detail: "Note merged with the fix",
    patch: {
      note: { prUrl: "https://github.com/acme/web/pull/12", merged: true },
    },
  });
  expect(
    decideNextStep(
      documenting({}, { agents: [run("investigator", { status: "done" })] }),
    ),
  ).toMatchObject({
    phase: "done",
    patch: { note: { merged: false, detail: "No note PR was opened" } },
  });
  expect(
    decideNextStep(
      documenting(
        {},
        {
          note: { prUrl: "https://github.com/acme/web/pull/13", merged: false },
        },
      ),
    ),
  ).toEqual({ step: "fetch-pr", purpose: "note" });
  const notes = ["docs/incidents/x.md"];
  expect(
    decideNextStep(documenting({ files: notes, pendingChecks: ["test"] })),
  ).toEqual({ step: "none" });
  expect(
    decideNextStep(
      documenting(
        { files: notes, pendingChecks: ["test"] },
        { documentingSince: iso(-1_300_000) },
      ),
    ),
  ).toMatchObject({
    phase: "done",
    detail: "Note PR #13 is waiting for checks",
  });
  const propose = documenting({ files: notes });
  expect(
    decideNextStep({
      ...propose,
      settings: { ...propose.settings, autonomy: "propose" },
    }),
  ).toMatchObject({ phase: "done", detail: "Note PR #13 is waiting for you" });
  expect(
    decideNextStep(documenting({ files: notes, state: "MERGED" })),
  ).toMatchObject({ phase: "done", detail: "Note merged" });
  // Still investigating: wait for it to finish.
  expect(
    decideNextStep({
      ...documenting({ files: notes }),
      agents: live({ "child-1": "running" }),
    }),
  ).toEqual({ step: "none" });
});

test("kill switch during a veto: paused, and the countdown never fires", () => {
  const v = inVeto({ deadline: iso(-1) });
  const out = decideNextStep({
    ...v,
    settings: { ...v.settings, agentsPaused: true },
  });
  expect(out).toMatchObject({
    step: "transition",
    to: "paused",
    patch: { pausedFrom: "veto", veto: undefined },
  });
});

test("manual rollback: offered while watching and after resolve, run with its own purpose", () => {
  const w = watching(
    { startedAt: iso(-60_000), deadline: iso(540_000) },
    new Map([["sig-a", evaluation("failing", iso(-3_600_000))]]),
  );
  expect(manualRollbackAvailable(w.incident, w.settings)).toBe(true);
  expect(nextActionFor(w.incident, w.settings)).toMatchObject({
    kind: "watching",
    options: ["roll-back"],
  });
  const resolved = {
    ...w.incident,
    state: "resolved" as const,
    response: { ...w.incident.response!, phase: "done" as const },
  };
  expect(manualRollbackAvailable(resolved, w.settings)).toBe(true);
  expect(nextActionFor(resolved, w.settings)).toEqual({
    kind: "done",
    detail: "Resolved",
    options: ["roll-back"],
  });
  const rf = rollbackFirstWatching({ deadline: iso(60_000) });
  expect(manualRollbackAvailable(rf.incident, rf.settings)).toBe(false);
  const owner = rollingBack([], {
    ownerRollback: { by: "Bo", at: iso(0) },
    state: "investigating",
  });
  expect(decideNextStep(owner)).toEqual({
    step: "run-action",
    actionId: "rollback",
    purpose: "owner-rollback",
  });
  expect(
    decideNextStep(
      rollingBack(
        [
          actionRun({
            actionId: "rollback",
            purpose: "owner-rollback",
            status: "ok",
            round: 2,
          }),
        ],
        {
          ownerRollback: { by: "Bo", at: iso(0) },
          state: "investigating",
          round: 2,
        },
      ),
    ),
  ).toMatchObject({
    step: "transition",
    to: null,
    phase: "investigating",
    patch: {
      round: 3,
      ownerRollback: undefined,
      sendBack: { kind: "rolled-back", detail: "Bo rolled back the release" },
    },
  });
});

// ── Recovered before any agent ran ───────────────────────────────────────

const MIN = 60_000;
const NO_SANDBOX = "Agents can't start: this project has no sandbox";

function setupIncident(
  over: Partial<IncidentResponse> = {},
  state: IncidentState = "needs-you",
): Incident {
  return incident(
    state,
    response({
      phase: state === "paused" ? "paused" : "needs-you",
      needsYou: {
        kind: "setup",
        reason: NO_SANDBOX,
        since: iso(MIN),
        resumePhase: "investigating",
        retryable: false,
        fix: "sandboxes",
      },
      ...over,
    }),
  );
}

/** Opened at 0, signal passing since `okSince`, decided at `now`. */
function recoveredView(
  okSince: number,
  now: number,
  over: Partial<ResponseView> = {},
): ResponseView {
  return view({
    now: NOW + now,
    incident: setupIncident(),
    evaluations: new Map([["sig-a", evaluation("ok", iso(okSince))]]),
    passes: new Map([["sig-a", 3]]),
    setup: { ready: false, fix: "sandboxes" },
    ...over,
  });
}

test("recovered: closes without action once its signals pass for 5 min", () => {
  expect(decideNextStep(recoveredView(10 * MIN, 15 * MIN))).toEqual({
    step: "transition",
    to: "closed-without-action",
    phase: "done",
    detail:
      "Recovered on its own before any agent ran: Search passing since 12:10 UTC",
    fixedBy: "recovered",
  });
  // Not yet 5 min of passing.
  expect(decideNextStep(recoveredView(10 * MIN, 15 * MIN - 1))).toEqual({
    step: "none",
  });
  // Still failing.
  expect(
    decideNextStep(
      recoveredView(10 * MIN, 60 * MIN, {
        evaluations: new Map([["sig-a", evaluation("failing", iso(-MIN))]]),
      }),
    ),
  ).toEqual({ step: "none" });
});

test("recovered: needs two passing checks in a row, or the rule's count", () => {
  const passes = (n: number) => new Map([["sig-a", n]]);
  expect(
    decideNextStep(recoveredView(0, 30 * MIN, { passes: passes(1) })),
  ).toEqual({ step: "none" });
  expect(
    decideNextStep(recoveredView(0, 30 * MIN, { passes: passes(2) })),
  ).toMatchObject({ to: "closed-without-action", fixedBy: "recovered" });
  const strict: Signal = {
    ...httpSignal,
    rule: { kind: "consecutive", failures: 3, recoveries: 4 },
  };
  const signals = new Map([["sig-a", strict]]);
  expect(
    decideNextStep(recoveredView(0, 30 * MIN, { signals, passes: passes(3) })),
  ).toEqual({ step: "none" });
  expect(
    decideNextStep(recoveredView(0, 30 * MIN, { signals, passes: passes(4) })),
  ).toMatchObject({ to: "closed-without-action" });
  // Without the counts the view did not look: nothing closes.
  expect(
    decideNextStep(recoveredView(0, 30 * MIN, { passes: undefined })),
  ).toEqual({ step: "none" });
});

test("recovered: every own signal, passing since after it opened, outside maintenance", () => {
  const other: Signal = { ...httpSignal, id: "sig-b", name: "Checkout" };
  const provider: Signal = {
    ...httpSignal,
    id: "sig-p",
    name: "Upstream",
    provider: true,
  };
  const two = setupIncident();
  two.signalIds = ["sig-a", "sig-b", "sig-p"];
  const signals = new Map([
    ["sig-a", httpSignal],
    ["sig-b", other],
    ["sig-p", provider],
  ]);
  const passes = new Map([
    ["sig-a", 2],
    ["sig-b", 2],
    ["sig-p", 0],
  ]);
  const both = (b: SignalEvaluation) =>
    recoveredView(5 * MIN, 30 * MIN, {
      incident: two,
      signals,
      passes,
      evaluations: new Map([
        ["sig-a", evaluation("ok", iso(5 * MIN))],
        ["sig-b", b],
        // A provider's own trouble is not the incident's.
        ["sig-p", evaluation("external", iso(0), "sig-p")],
      ]),
    });
  expect(
    decideNextStep(both(evaluation("failing", iso(MIN), "sig-b"))),
  ).toEqual({ step: "none" });
  // The last to recover sets the clock.
  expect(
    decideNextStep(both(evaluation("ok", iso(26 * MIN), "sig-b"))),
  ).toEqual({ step: "none" });
  expect(
    decideNextStep(both(evaluation("ok", iso(25 * MIN), "sig-b"))),
  ).toMatchObject({
    to: "closed-without-action",
    detail:
      "Recovered on its own before any agent ran: Search, Checkout passing since 12:25 UTC",
  });
  // Passing since before it opened: it never recovered.
  expect(decideNextStep(recoveredView(-MIN, 30 * MIN))).toEqual({
    step: "none",
  });
  expect(
    decideNextStep(
      recoveredView(0, 30 * MIN, {
        evaluations: new Map([
          ["sig-a", { ...evaluation("ok", iso(0)), inMaintenance: true }],
        ]),
      }),
    ),
  ).toEqual({ step: "none" });
});

test("recovered: never once an agent ran or anything was proposed, run or merged", () => {
  const close = (r: Partial<IncidentResponse>) =>
    decideNextStep(
      recoveredView(0, 30 * MIN, {
        incident: setupIncident(r),
      }),
    );
  expect(close({})).toMatchObject({ to: "closed-without-action" });
  expect(close({ agents: [run("investigator", { status: "error" })] })).toEqual(
    { step: "none" },
  );
  expect(
    close({
      candidate: {
        round: 1,
        plan: { pr: false, actions: ["rollback"] },
        check: { kind: "after-deploy", reason: "Rolling back" },
        claims: [],
        notePath: "docs/incidents/x.md",
        runbookPaths: [],
        rollbackFirst: true,
      },
    }),
  ).toEqual({ step: "none" });
  expect(close({ actionRuns: [actionRun({ actionId: "rollback" })] })).toEqual({
    step: "none",
  });
  expect(
    close({
      merge: {
        ghRepo: "acme/app",
        number: 7,
        sha: "abc",
        status: "merged",
        at: iso(0),
      },
    }),
  ).toEqual({ step: "none" });
});

test("recovered: only setup, budget or the kill switch before any agent", () => {
  const kind = (k: "budget" | "policy" | "agent-error" | "stopped") =>
    decideNextStep(
      recoveredView(0, 30 * MIN, {
        incident: setupIncident({
          needsYou: {
            kind: k,
            reason: "x",
            since: iso(MIN),
            resumePhase: "investigating",
          },
        }),
      }),
    );
  expect(kind("budget")).toMatchObject({ to: "closed-without-action" });
  expect(kind("policy")).toEqual({ step: "none" });
  expect(kind("agent-error")).toEqual({ step: "none" });
  expect(kind("stopped")).toEqual({ step: "none" });
  // Paused before any agent started: closes too, kill switch on or not.
  const paused = setupIncident({ needsYou: undefined }, "paused");
  for (const agentsPaused of [true, false])
    expect(
      decideNextStep(
        recoveredView(0, 30 * MIN, {
          incident: paused,
          settings: { ...defaultSettings, agentsPaused },
        }),
      ),
    ).toMatchObject({ to: "closed-without-action", fixedBy: "recovered" });
  // An open incident still working is the fix loop's, never closed here.
  expect(
    decideNextStep(
      recoveredView(0, 30 * MIN, {
        incident: incident("investigating", response({})),
      }),
    ),
  ).not.toMatchObject({ to: "closed-without-action" });
});

test("setup: Try again follows whether the agents could start now", () => {
  // Still no sandbox: nothing to write.
  expect(
    decideNextStep(
      recoveredView(0, MIN, {
        evaluations: new Map([["sig-a", evaluation("failing", iso(0))]]),
      }),
    ),
  ).toEqual({ step: "none" });
  const ready = decideNextStep(
    recoveredView(0, MIN, {
      evaluations: new Map([["sig-a", evaluation("failing", iso(0))]]),
      setup: { ready: true },
    }),
  );
  expect(ready).toEqual({
    step: "transition",
    to: null,
    phase: "needs-you",
    detail: "Agents can start now",
    patch: {
      needsYou: {
        kind: "setup",
        reason: NO_SANDBOX,
        since: iso(MIN),
        resumePhase: "investigating",
      },
    },
  });
  // A model went missing meanwhile: the place to fix it moves.
  expect(
    decideNextStep(
      recoveredView(0, MIN, {
        evaluations: new Map([["sig-a", evaluation("failing", iso(0))]]),
        setup: { ready: false, fix: "providers" },
      }),
    ),
  ).toMatchObject({
    patch: { needsYou: { retryable: false, fix: "providers" } },
  });
  // A record from before readiness was tracked, and ready: left alone.
  const legacy = setupIncident({
    needsYou: {
      kind: "setup",
      reason: "Incident agents could not start: offline",
      since: iso(MIN),
      resumePhase: "investigating",
    },
  });
  expect(
    decideNextStep(
      recoveredView(0, MIN, {
        incident: legacy,
        evaluations: new Map([["sig-a", evaluation("failing", iso(0))]]),
        setup: { ready: true },
      }),
    ),
  ).toEqual({ step: "none" });
});

test("setup: options and next action follow retryable and fix", () => {
  const ny = (over: Partial<NonNullable<IncidentResponse["needsYou"]>>) =>
    response({
      phase: "needs-you",
      needsYou: {
        kind: "setup",
        reason: NO_SANDBOX,
        since: iso(0),
        resumePhase: "investigating",
        ...over,
      },
    });
  expect(needsYouOptions("setup", ny({ retryable: false }))).toEqual([
    "resolve",
    "close",
  ]);
  expect(needsYouOptions("setup", ny({}))).toEqual([
    "retry",
    "resolve",
    "close",
  ]);
  expect(
    nextActionFor(
      incident("needs-you", ny({ retryable: false, fix: "sandboxes" })),
      defaultSettings,
    ),
  ).toEqual({
    kind: "needs-you",
    reason: NO_SANDBOX,
    needsYou: "setup",
    fix: "sandboxes",
    options: ["resolve", "close"],
  });
});

// ── Proof that can only come after release ─────────────────────────────────

const afterDeployCheck = {
  kind: "after-deploy" as const,
  reason: "A request now can't tell before from after",
};

function obs(offsetMs: number, result: "ok" | "fail") {
  return { at: iso(offsetMs), result, detail: result };
}

/** Failed, passed, failed and passed again: the signal comes and goes. */
const flapping = [
  obs(-50 * 60_000, "fail"),
  obs(-49 * 60_000, "fail"),
  obs(-48 * 60_000, "ok"),
  obs(-20 * 60_000, "fail"),
  obs(-19 * 60_000, "fail"),
  obs(-18 * 60_000, "ok"),
];

test("proving: a passing baseline goes on to the verifier when the fix can only be proven after release", () => {
  const passing = proofResult({
    round: 1,
    baseline: "passes",
    candidate: "after-deploy",
  });
  const proving = (c: CandidateState) =>
    view({
      incident: incident(
        "fix-ready",
        response({ phase: "proving", candidate: c, proof: passing }),
      ),
      evaluations: new Map([["sig-a", evaluation("ok", iso(-60_000))]]),
    });
  expect(
    decideNextStep(proving(candidate({ check: afterDeployCheck }))),
  ).toEqual({ step: "fetch-pr", purpose: "verify" });
  expect(
    decideNextStep(
      proving(candidate({ check: afterDeployCheck, pr: prSnapshot() })),
    ),
  ).toEqual({
    step: "transition",
    to: null,
    phase: "verifying",
    detail:
      "Proof measured: the problem is not happening now and the fix can only be proven after release, so the verifier judges what it can prove",
    patch: { proof: { ...passing, deferred: "after-release" } },
  });
});

test("proving: a passing baseline goes on to the verifier when the signal comes and goes", () => {
  const passing = proofResult({
    round: 1,
    baseline: "passes",
    candidate: "passes",
  });
  const step = decideNextStep(
    view({
      incident: incident(
        "fix-ready",
        response({
          phase: "proving",
          candidate: candidate({ pr: prSnapshot() }),
          proof: passing,
        }),
      ),
      evaluations: new Map([["sig-a", evaluation("ok", iso(-60_000))]]),
      primaryRecent: flapping,
    }),
  );
  expect(step).toMatchObject({
    step: "transition",
    phase: "verifying",
    patch: { proof: { deferred: "intermittent" } },
  });
});

test("proving: a one-off problem that stopped still asks, and Send it back is not offered when it would spend the last round at the same gate", () => {
  const stopped = decideNextStep(
    view({
      incident: incident(
        "fix-ready",
        response({
          phase: "proving",
          candidate: candidate({ pr: prSnapshot() }),
          proof: proofResult({
            round: 1,
            baseline: "passes",
            candidate: "passes",
          }),
        }),
      ),
      evaluations: new Map([["sig-a", evaluation("ok", iso(-60_000))]]),
      primaryRecent: [obs(-5 * 60_000, "fail"), obs(-4 * 60_000, "ok")],
    }),
  );
  expect(stopped).toMatchObject({ step: "needs-you", kind: "proof-stopped" });
  const waiting = (round: number, maxRounds: number) =>
    response({
      round,
      maxRounds,
      phase: "needs-you",
      needsYou: {
        kind: "proof-stopped",
        reason: "x",
        since: iso(0),
        resumePhase: "proving",
      },
    });
  expect(needsYouOptions("proof-stopped", waiting(1, 2))).toEqual([
    "resolve",
    "close",
  ]);
  expect(needsYouOptions("proof-stopped", waiting(1, 3))).toEqual([
    "send-back",
    "resolve",
    "close",
  ]);
  expect(
    nextActionFor(
      incident("needs-you", waiting(1, 2)),
      defaultProjectSettings("acme"),
    ),
  ).toMatchObject({
    kind: "needs-you",
    reason: expect.stringContaining("would spend the last round"),
  });
});

function deferredVerifying(report: VerifierReport, round = 1): ResponseView {
  return view({
    incident: incident(
      "fix-ready",
      response({
        phase: "verifying",
        round,
        candidate: candidate({
          check: afterDeployCheck,
          pr: prSnapshot({ headSha: "abc1234" }),
        }),
        proof: {
          ...proofResult({
            round,
            baseline: "passes",
            candidate: "after-deploy",
          }),
          deferred: "after-release",
        },
        agents: [
          run("investigator", { round, status: "done" }),
          run("verifier", { round, status: "done", report }),
        ],
      }),
    ),
    evaluations: new Map([["sig-a", evaluation("ok", iso(-60_000))]]),
  });
}

test("verifying a fix proven after release: certain with the proof accepted goes on to the policy", () => {
  expect(
    decideNextStep(deferredVerifying({ ...goodVerifier, proofAccepted: true })),
  ).toMatchObject({
    step: "transition",
    phase: "deciding",
    patch: { verdict: { verdict: "certain", verifiedSha: "abc1234" } },
  });
});

test("verifying a fix proven after release: unproven asks the owner to merge and watch, close or send back", () => {
  const unproven = {
    ...goodVerifier,
    verdict: "not-certain" as const,
    reasons: ["Only the release can show the slow verdicts are gone"],
    proofAccepted: false,
  };
  const step = decideNextStep(deferredVerifying(unproven));
  expect(step).toMatchObject({
    step: "needs-you",
    kind: "unproven",
    patch: {
      verdict: {
        verdict: "not-certain",
        verifiedSha: "abc1234",
        reasons: [
          "Only the release can show the slow verdicts are gone",
          "The verifier did not accept proving this after release",
        ],
      },
    },
  });
  if (step.step !== "needs-you") throw new Error("expected needs-you");
  expect(step.reason).toContain("after release");
  expect(step.reason).not.toContain("problem stopped");
  const r = response({
    phase: "needs-you",
    candidate: candidate({ pr: prSnapshot() }),
    verdict: step.patch!.verdict,
  });
  expect(needsYouOptions("unproven", r)).toEqual([
    "approve",
    "release-watch",
    "send-back",
    "resolve",
    "close",
  ]);
  // A refuted claim is the fix's own problem: the investigator gets it back.
  expect(
    decideNextStep(
      deferredVerifying({
        ...unproven,
        claims: [{ ...unproven.claims[0]!, status: "refuted" }],
      }),
    ),
  ).toMatchObject({ step: "transition", phase: "investigating" });
});

// ── A waiting card whose signal failed again ───────────────────────────────

function waitingOn(
  kind: "proof-stopped" | "unproven",
  over: Partial<Incident> = {},
  c: CandidateState = candidate({ pr: prSnapshot() }),
): ResponseView {
  return view({
    incident: incident(
      "needs-you",
      response({
        phase: "needs-you",
        candidate: c,
        proof: proofResult({
          round: 1,
          baseline: "passes",
          candidate: "passes",
        }),
        needsYou: {
          kind,
          reason:
            kind === "proof-stopped"
              ? "The problem stopped before the fix could be proven"
              : "The fix can only be proven after release: Only the release can show it",
          since: iso(-30 * 60_000),
          resumePhase: "proving",
        },
      }),
      { lastProblemAt: iso(-40 * 60_000), resumeState: "fix-ready", ...over },
    ),
    evaluations: new Map([["sig-a", evaluation("ok", iso(-60_000))]]),
  });
}

test("a proof that stopped is measured again once the signal fails again", () => {
  expect(waitingMayBeStale(waitingOn("proof-stopped").incident)).toBe(false);
  expect(decideNextStep(waitingOn("proof-stopped"))).toEqual({ step: "none" });
  const back = waitingOn("proof-stopped", { lastProblemAt: iso(-5 * 60_000) });
  expect(waitingMayBeStale(back.incident)).toBe(true);
  expect(decideNextStep(back)).toEqual({
    step: "transition",
    to: "fix-ready",
    phase: "proving",
    detail: "Search failed again at 11:55 UTC: measuring the fix again",
    patch: { needsYou: undefined, proof: undefined },
  });
});

test("a proof that stopped on a fix only a release can prove goes on to the verifier", () => {
  const legacy = waitingOn(
    "proof-stopped",
    {},
    candidate({ check: afterDeployCheck, pr: prSnapshot() }),
  );
  expect(waitingMayBeStale(legacy.incident)).toBe(true);
  expect(decideNextStep(legacy)).toMatchObject({
    step: "transition",
    to: "fix-ready",
    phase: "proving",
    patch: { needsYou: undefined, proof: undefined },
  });
});

test("an unproven fix whose signal failed again says so, once per return", () => {
  const back = waitingOn("unproven", { lastProblemAt: iso(-5 * 60_000) });
  const step = decideNextStep(back);
  expect(step).toEqual({
    step: "needs-you",
    kind: "unproven",
    reason:
      "The fix can only be proven after release: Only the release can show it (Search failed again at 11:55 UTC)",
    failedAgainAt: iso(-5 * 60_000),
  });
  // Said again later, the newer time replaces the older one.
  const r = back.incident.response!;
  const again = decideNextStep({
    ...back,
    incident: {
      ...back.incident,
      lastProblemAt: iso(-60_000),
      response: {
        ...r,
        needsYou: {
          ...r.needsYou!,
          reason: (step as { reason: string }).reason,
          since: iso(-4 * 60_000),
        },
      },
    },
  });
  expect(again).toMatchObject({
    reason:
      "The fix can only be proven after release: Only the release can show it (Search failed again at 11:59 UTC)",
  });
});

test("the needs-you card names the incident's open pull requests", () => {
  const r = response({
    phase: "needs-you",
    candidate: candidate({ pr: prSnapshot() }),
    needsYou: {
      kind: "no-candidate",
      reason: "No fix found: the logs are out of reach",
      since: iso(0),
      resumePhase: "investigating",
      prs: [
        {
          url: "https://github.com/acme/web/pull/12",
          number: 12,
          sessionId: "child-1",
        },
        {
          url: "https://github.com/acme/web/pull/14",
          number: 14,
          sessionId: "child-3",
        },
      ],
    },
  });
  expect(
    nextActionFor(incident("needs-you", r), defaultProjectSettings("acme")),
  ).toMatchObject({
    reason:
      "No fix found: the logs are out of reach. Open pull requests: #12, #14.",
  });
  const one = {
    ...r,
    needsYou: { ...r.needsYou!, prs: r.needsYou!.prs!.slice(0, 1) },
  };
  expect(
    nextActionFor(incident("needs-you", one), defaultProjectSettings("acme")),
  ).toMatchObject({
    reason: "No fix found: the logs are out of reach. Open pull request: #12.",
  });
});

test("an agent stopped while the sandbox image was still being built starts again, a few times", () => {
  const building =
    "Sandbox unavailable: Building the sandbox image after an update";
  const base = {
    phase: "verifying" as const,
    candidate: candidate({ pr: prSnapshot() }),
    proof: proofResult({ round: 1, baseline: "fails", candidate: "passes" }),
  };
  const verifierFailed = (attempt: number, error: string) =>
    view({
      incident: incident(
        "fix-ready",
        response({
          ...base,
          agents: [
            run("investigator", { status: "done" }),
            run("verifier", { attempt }),
          ],
        }),
      ),
      agents: new Map([
        ["child-1", { status: "done", costUsd: 0, tokens: 0 }],
        ["child-2", { status: "error", costUsd: 0, tokens: 0, error }],
      ]),
    });
  // Transient setup: no person needed, a new attempt joins the build.
  expect(decideNextStep(verifierFailed(1, building))).toEqual({
    step: "start-agent",
    role: "verifier",
    round: 1,
    attempt: 2,
  });
  // Bounded: a build that never finishes reaches the owner.
  expect(decideNextStep(verifierFailed(3, building))).toEqual({
    step: "needs-you",
    kind: "agent-error",
    reason: `The verifier stopped: ${building}`,
  });
  // A failed build is the existing refusal: the owner decides.
  const refused =
    "Sandbox unavailable: the sandbox image localhost/opensession-sandbox:0123456789abcdef is missing. Requalify This machine (container) in Workspace → Sandboxes.";
  expect(decideNextStep(verifierFailed(1, refused))).toEqual({
    step: "needs-you",
    kind: "agent-error",
    reason: `The verifier stopped: ${refused}`,
  });
  // The investigator is the same.
  expect(
    decideNextStep(
      view({
        incident: incident(
          "investigating",
          response({
            agents: [run("investigator", { status: "error", error: building })],
          }),
        ),
      }),
    ),
  ).toEqual({
    step: "start-agent",
    role: "investigator",
    round: 1,
    attempt: 2,
  });
});

test("Deploy the fix is offered on an unproven card only when it can work; else the card says why", () => {
  const unproven = (pr: Partial<PrSnapshot>) =>
    response({
      phase: "needs-you",
      candidate: candidate({ pr: prSnapshot(pr) }),
      verdict: {
        round: 1,
        at: iso(0),
        verdict: "not-certain",
        reasons: ["Only the release can show it"],
        verifiedSha: "abc1234",
      },
      needsYou: {
        kind: "unproven",
        reason:
          "The fix can only be proven after release: Only the release can show it",
        since: iso(0),
        resumePhase: "verifying",
      },
    });
  // Checks pass and the project deploys: every way out.
  expect(needsYouOptions("unproven", unproven({}), defaultSettings)).toEqual([
    "approve",
    "release-watch",
    "send-back",
    "resolve",
    "close",
  ]);
  // A required check fails: merging would only send it back.
  const failing = unproven({ failingChecks: ["ci-success"] });
  expect(needsYouOptions("unproven", failing, defaultSettings)).toEqual([
    "release-watch",
    "send-back",
    "resolve",
    "close",
  ]);
  expect(
    nextActionFor(incident("needs-you", failing), defaultSettings),
  ).toMatchObject({
    reason:
      "The fix can only be proven after release: Only the release can show it. Deploy the fix isn't offered: check ci-success fails on PR #12.",
  });
  // No deploy action: nothing would release the merged fix.
  const manual = { ...defaultSettings, actions: [] };
  expect(needsYouOptions("unproven", unproven({}), manual)).toEqual([
    "release-watch",
    "send-back",
    "resolve",
    "close",
  ]);
  expect(
    nextActionFor(incident("needs-you", unproven({})), manual),
  ).toMatchObject({
    reason:
      "The fix can only be proven after release: Only the release can show it. Deploy the fix isn't offered: no deploy action is declared for acme.",
  });
});

test("checks GitHub Actions never ran: a setup problem before any verifier, resumed once they run", () => {
  const blocked =
    "the job was not started because recent account payments have failed";
  const provingWith = (pr: Partial<PrSnapshot>) =>
    view({
      incident: incident(
        "fix-ready",
        response({
          phase: "proving",
          candidate: candidate({ pr: prSnapshot(pr) }),
          proof: proofResult({
            round: 1,
            baseline: "fails",
            candidate: "passes",
          }),
          agents: [run("investigator", { round: 1, status: "done" })],
        }),
      ),
    });
  expect(
    decideNextStep(
      provingWith({ failingChecks: ["test"], actionsBlocked: blocked }),
    ),
  ).toEqual({
    step: "needs-you",
    kind: "setup",
    reason: `GitHub Actions can't run for acme/web (${blocked})`,
  });
  // Red for the code's own reasons: the verifier goes ahead as before.
  expect(
    decideNextStep(provingWith({ failingChecks: ["test"] })),
  ).toMatchObject({ step: "transition", phase: "verifying" });

  // The card waits; the pull request is read again now and then.
  const waiting = (pr: Partial<PrSnapshot>) =>
    view({
      incident: incident(
        "needs-you",
        response({
          phase: "needs-you",
          candidate: candidate({ pr: prSnapshot(pr) }),
          proof: proofResult({
            round: 1,
            baseline: "fails",
            candidate: "passes",
          }),
          agents: [run("investigator", { round: 1, status: "done" })],
          needsYou: {
            kind: "setup",
            reason: `GitHub Actions can't run for acme/web (${blocked})`,
            since: iso(-60_000),
            resumePhase: "proving",
          },
        }),
        { resumeState: "fix-ready" },
      ),
      setup: { ready: true },
    });
  expect(
    decideNextStep(
      waiting({ failingChecks: ["test"], actionsBlocked: blocked }),
    ),
  ).toEqual({ step: "none" });
  expect(
    decideNextStep(
      waiting({
        failingChecks: ["test"],
        actionsBlocked: blocked,
        fetchedAt: iso(-700_000),
      }),
    ),
  ).toEqual({ step: "fetch-pr", purpose: "verify" });
  // The checks ran: back to proving, where the verifier starts.
  expect(decideNextStep(waiting({ failingChecks: [] }))).toMatchObject({
    step: "transition",
    to: "fix-ready",
    phase: "proving",
    detail: "GitHub Actions runs for acme/web again",
    patch: { needsYou: undefined },
  });
});

test("a failure folded into a waiting card names the part that failed", () => {
  const back = waitingOn("unproven", { lastProblemAt: iso(-5 * 60_000) });
  const named = {
    ...back,
    primaryRecent: [
      { at: iso(-7 * 60_000), result: "fail" as const, detail: "search: slow" },
      { at: iso(-6 * 60_000), result: "fail" as const, detail: "search: slow" },
      { at: iso(-5 * 60_000), result: "fail" as const, detail: "search: slow" },
      {
        at: iso(-4 * 60_000),
        result: "ok" as const,
        detail: "All components operational",
      },
    ],
  };
  expect(decideNextStep(named)).toEqual({
    step: "needs-you",
    kind: "unproven",
    reason:
      "The fix can only be proven after release: Only the release can show it (Search failed again at 11:55 UTC: search: slow)",
    failedAgainAt: iso(-5 * 60_000),
  });
});

test("a different part failing is shown apart from the incident's cause, without asking the owner again", () => {
  const back = waitingOn("unproven", { lastProblemAt: iso(-5 * 60_000) });
  const r = back.incident.response!;
  const other: ResponseView = {
    ...back,
    incident: {
      ...back.incident,
      response: {
        ...r,
        openedOn: { at: iso(-3_600_000), detail: "search: slow" },
      },
    },
    primaryRecent: [
      { at: iso(-6 * 60_000), result: "fail", detail: "betterfare: down" },
      { at: iso(-5 * 60_000), result: "fail", detail: "betterfare: down" },
    ],
  };
  const step = decideNextStep(other);
  expect(step).toEqual({
    step: "transition",
    to: null,
    phase: "needs-you",
    detail:
      "A different part failed at 11:55 UTC: betterfare: down. This incident is about search",
    patch: {
      needsYou: { ...r.needsYou!, failedAgainAt: iso(-5 * 60_000) },
      otherFailures: [{ at: iso(-5 * 60_000), detail: "betterfare: down" }],
    },
  });
  // Handled: nothing more until the signal fails again.
  const handled = {
    ...other.incident,
    response: {
      ...other.incident.response!,
      ...(step as { patch: Partial<IncidentResponse> }).patch,
    },
  } as Incident;
  expect(waitingMayBeStale(handled)).toBe(false);
  // The card keeps its own reason and lists the other part apart.
  expect(nextActionFor(handled, defaultSettings)).toMatchObject({
    reason: expect.stringContaining(
      "Only the release can show it. Another part failed meanwhile: betterfare: down at 11:55 UTC.",
    ),
  });
});

test("without a recorded opening check, the one in the recent checks at the open tells the parts apart", () => {
  const back = waitingOn("unproven", {
    lastProblemAt: iso(-5 * 60_000),
    openedAt: iso(-20 * 60_000),
  });
  const step = decideNextStep({
    ...back,
    primaryRecent: [
      { at: iso(-21 * 60_000), result: "fail", detail: "search: slow" },
      { at: iso(-5 * 60_000), result: "fail", detail: "betterfare: down" },
    ],
  });
  expect(step).toMatchObject({
    step: "transition",
    phase: "needs-you",
    detail:
      "A different part failed at 11:55 UTC: betterfare: down. This incident is about search",
  });
});
