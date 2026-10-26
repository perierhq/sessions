import { expect, test } from "bun:test";
import { DECISION_COPY } from "../../../shared/incident-decision-copy";
import {
  type AgentRun,
  type IncidentResponse,
  type InvestigatorReport,
  NEXT_STEP_TARGETS,
  type NextStep,
  type OwnerDecision,
  OWNER_DECISIONS,
  type ProofResult,
  type RedactedProjectSettings,
  SEND_BACK_NOTE_MAX,
} from "../../../shared/incident-response";
import type {
  Incident,
  IncidentState,
  SignalView,
} from "../../../shared/incidents";
import { ApiError } from "../api/request";
import { clockTime } from "../time";
import {
  decisionErrorText,
  decisionFromAnswer,
  decisionNotes,
  incidentDecisionKey,
  type ChoiceCard,
  NEXT_STEP_SECTION,
  nextCard,
  orderButtons,
  pickFromAnswer,
  recoveryLine,
} from "./next-action";

const NOW = Date.parse("2026-10-20T12:31:12Z");
const settings: RedactedProjectSettings = {
  project: "acme",
  agentsPaused: false,
  incidentsPaused: false,
  autonomy: "deploy-after-veto",
  vetoMs: 600_000,
  watchMs: 600_000,
  maxRounds: 2,
  neverWithoutYou: [],
  budget: { perIncidentUsd: 20, perMonthUsd: 200 },
  agents: {},
  productionRunners: [],
  actions: [],
  releases: [],
};
const response = (over: Partial<IncidentResponse>): IncidentResponse => ({
  phase: "veto",
  round: 2,
  maxRounds: 2,
  agents: [],
  actionRuns: [],
  costUsd: 3.8,
  ownerTouched: false,
  next: { kind: "working", detail: "" },
  ledger: [],
  droppedLedger: 0,
  startedAt: "2026-10-20T10:45:00Z",
  updatedAt: "2026-10-20T12:27:00Z",
  ...over,
});
const inc = (
  state: IncidentState,
  over?: Partial<IncidentResponse>,
): Incident => {
  const incident: Incident = {
    id: "inc-1",
    project: "acme",
    title: "Search",
    state,
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    openedAt: "2026-10-20T10:41:00Z",
    updatedAt: "2026-10-20T12:27:00Z",
    lastProblemAt: "2026-10-20T12:27:00Z",
    findings: [],
    events: [],
    droppedEvents: 0,
  };
  if (over) incident.response = response(over);
  return incident;
};
const deadline = "2026-10-20T12:37:00Z";
const sample = (result: "ok" | "fail") => ({
  at: "2026-10-20T12:20:00Z",
  result,
  detail: "",
});
const proof: ProofResult = {
  round: 2,
  at: "2026-10-20T12:20:00Z",
  baseline: { verdict: "fails", samples: Array(3).fill(sample("fail")) },
  candidate: {
    kind: "request",
    verdict: "passes",
    samples: Array(12).fill(sample("ok")),
  },
};
const verifier = (over: Partial<AgentRun>): AgentRun => ({
  role: "verifier",
  round: 2,
  attempt: 1,
  sessionId: "ver-2",
  model: "m",
  provider: "p",
  workspace: { kind: "sandbox", provider: "local" },
  accessSummary: "",
  accessRevision: "",
  status: "done",
  startedAt: "2026-10-20T12:00:00Z",
  turnSentAt: "2026-10-20T12:00:00Z",
  costUsd: 0,
  tokens: 0,
  reminded: false,
  ...over,
});
const base = {
  settings,
  primaryName: "Search",
  now: NOW,
};

test("veto: deploy time, proof, policy footnote, soft then danger", () => {
  const card = nextCard({
    ...base,
    incident: inc("veto", {
      next: {
        kind: "veto",
        deadline,
        rule: "Deploy after veto, from the project settings",
      },
      proof,
      veto: { startedAt: "2026-10-20T12:27:00Z", deadline },
    }),
  });
  expect(card).toMatchObject({
    mode: "shell",
    tone: "yellow",
    pulse: false,
    eyebrow: "Next",
    headline: `Deploys the fix at ${clockTime(deadline)}`,
    body: "The verifier is certain: 12 of 12 checks pass with the fix, 3 of 3 fail without it",
    footnote:
      "Rolls back by itself if Search still fails 10 min after. Deploy after veto, from the project settings",
  });
  expect(
    card?.mode === "shell" &&
      card.buttons.map((b) => [b.label, b.weight, b.decision, b.countdownTo]),
  ).toEqual([
    ["Deploy now", "soft", "deploy-now", undefined],
    ["Stop", "danger", "stop", deadline],
  ]);
  expect(card?.mode === "shell" && card.buttons[0]).toMatchObject({
    undoLabel: "Undo deploy",
    pendingLabel: "Deploying…",
  });
});

test("veto: a verifier on the same provider is named; rollback first says so", () => {
  const card = nextCard({
    ...base,
    incident: inc("veto", {
      next: { kind: "veto", deadline, rule: "Rule" },
      proof,
      agents: [verifier({ independence: "same-provider" })],
      candidate: {
        round: 2,
        plan: { pr: false, actions: [] },
        check: { kind: "after-deploy", reason: "" },
        claims: [],
        notePath: "",
        runbookPaths: [],
        rollbackFirst: true,
      },
    }),
  });
  expect(card).toMatchObject({
    eyebrow: "Next",
    headline: `Rolls back at ${clockTime(deadline)}`,
    body: "The verifier is certain: 12 of 12 checks pass with the fix, 3 of 3 fail without it (same provider, different model)",
    footnote: "Rule",
  });
  expect(card?.mode === "shell" && card.buttons[0]).toMatchObject({
    label: "Roll back now",
    undoLabel: "Undo roll back",
    pendingLabel: "Rolling back…",
  });
});

test("veto: after-deploy proof", () => {
  const card = nextCard({
    ...base,
    incident: inc("veto", {
      next: { kind: "veto", deadline, rule: "Rule" },
      proof: {
        ...proof,
        candidate: {
          kind: "after-deploy",
          verdict: "after-deploy",
          samples: [],
        },
      },
    }),
  });
  expect(card).toMatchObject({
    body: "The verifier is certain. The signal decides once it is out",
  });
});

test("working pulses and offers to pause", () => {
  const card = nextCard({
    ...base,
    incident: inc("investigating", {
      phase: "investigating",
      round: 1,
      next: { kind: "working", detail: "Looking at 2.3.0's changes" },
    }),
  });
  expect(card).toMatchObject({
    mode: "shell",
    tone: "yellow",
    pulse: true,
    eyebrow: "Round 1 · investigating",
    headline: "Looking at 2.3.0's changes",
    body: "Nothing changes in production without a veto window first",
    buttons: [{ kind: "pause-agents", weight: "soft", label: "Pause agents" }],
  });
  expect(
    nextCard({
      ...base,
      settings: null,
      incident: inc("investigating", {
        phase: "proving",
        next: { kind: "working", detail: "x" },
      }),
    }),
  ).toMatchObject({ eyebrow: "Round 2 · measuring the fix", body: "" });
});

test("needs you: only Send it back asks for a note, in the card", () => {
  const card = nextCard({
    ...base,
    incident: inc("needs-you", {
      next: {
        kind: "needs-you",
        reason: "Stopped by Ada",
        needsYou: "stopped",
        options: ["send-back", "close"],
      },
    }),
  });
  expect(card).toMatchObject({
    mode: "choice",
    decisions: ["send-back", "close"],
    notes: {
      "Send it back": {
        label: "Note for the investigator",
        maxLength: SEND_BACK_NOTE_MAX,
      },
    },
  });
  // Every other decision is complete on its own.
  expect(
    decisionNotes(OWNER_DECISIONS.filter((d) => d !== "send-back")),
  ).toEqual({});
});

test("needs you: several ways forward go to AskCard, one goes to a primary button", () => {
  const many = nextCard({
    ...base,
    incident: inc("needs-you", {
      next: {
        kind: "needs-you",
        reason: "Agents stopped at the $20 budget for this incident",
        needsYou: "budget",
        options: ["retry", "close", "stop"],
      },
    }),
  });
  expect(many).toEqual({
    mode: "choice",
    eyebrow: "Needs you",
    decisions: ["retry", "close"],
    question: {
      header: "Needs you",
      question: "Agents stopped at the $20 budget for this incident",
      multiSelect: false,
      options: [DECISION_COPY.retry, DECISION_COPY.close],
    },
    // Try again and Close without action need nothing more.
    notes: {},
    picks: {
      "Try again": { kind: "decision", decision: "retry" },
      "Close without action": { kind: "decision", decision: "close" },
    },
    // Nothing to tell the investigator without Send it back.
    freeText: null,
  });
  const one = nextCard({
    ...base,
    incident: inc("needs-you", {
      next: {
        kind: "needs-you",
        reason: "PR #12 needs a review",
        needsYou: "protection",
        rule: "Branch protection",
        options: ["approve", "stop"],
      },
    }),
  });
  expect(one).toMatchObject({
    tone: "blue",
    eyebrow: "Needs you",
    headline: "PR #12 needs a review",
    footnote: "Branch protection",
  });
  expect(
    one?.mode === "shell" && one.buttons.map((b) => [b.label, b.weight]),
  ).toEqual([
    ["Deploy the fix", "primary"],
    ["Stop", "soft"],
  ]);
  expect(
    one?.mode === "shell" && orderButtons(one.buttons).map((b) => b.weight),
  ).toEqual(["soft", "primary"]);
});

test("paused, provider, watching, done", () => {
  expect(
    nextCard({
      ...base,
      settings: { ...settings, agentsPaused: true },
      incident: inc("investigating", {
        next: { kind: "working", detail: "x" },
      }),
    }),
  ).toMatchObject({
    eyebrow: "Paused",
    headline: "Agents are paused for acme",
    body: "Signals keep running. Nothing changes until you resume",
    buttons: [{ kind: "resume-agents", label: "Resume" }],
  });
  expect(
    nextCard({
      ...base,
      incident: inc("waiting-on-provider", {
        next: {
          kind: "info",
          detail: "Waiting for Status",
          rule: "Provider signal",
        },
      }),
    }),
  ).toMatchObject({
    tone: "faint",
    eyebrow: "Nothing to fix on our side",
    headline: "Waiting for Status",
    footnote: "Provider signal",
    buttons: [],
  });
  expect(
    nextCard({
      ...base,
      incident: inc("watching", {
        next: {
          kind: "watching",
          deadline: "2026-10-20T13:11:00Z",
          options: [],
        },
      }),
    }),
  ).toMatchObject({
    tone: "green",
    headline: `Watching until ${clockTime("2026-10-20T13:11:00Z")}, then it closes`,
    body: "Nothing for you to do",
    buttons: [],
  });
  const watchRollBack = nextCard({
    ...base,
    incident: inc("watching", {
      next: {
        kind: "watching",
        deadline: "2026-10-20T13:11:00Z",
        options: ["roll-back"],
      },
    }),
  });
  expect(
    watchRollBack?.mode === "shell" &&
      watchRollBack.buttons.map((b) => [
        b.label,
        b.weight,
        b.decision,
        b.confirm?.destructive,
      ]),
  ).toEqual([["Roll back", "soft", "roll-back", true]]);
  expect(
    nextCard({
      ...base,
      incident: inc("resolved", {
        next: { kind: "done", detail: "Resolved", options: [] },
      }),
    }),
  ).toBeNull();
  expect(
    nextCard({
      ...base,
      incident: inc("resolved", {
        next: { kind: "done", detail: "Resolved", options: ["roll-back"] },
      }),
    }),
  ).toMatchObject({
    eyebrow: "Fixed",
    headline: "The fix is out and Search passes",
    body: "Roll back if the release broke something else",
    buttons: [{ decision: "roll-back", weight: "soft" }],
  });
  expect(
    nextCard({ ...base, settings: null, incident: inc("investigating") }),
  ).toBeNull();
  expect(
    nextCard({
      ...base,
      incident: inc("closed-without-action", {
        next: { kind: "info", detail: "x" },
      }),
    }),
  ).toBeNull();
});

test("decision errors", () => {
  expect(
    decisionErrorText(new ApiError("Already deploying", 409), "Stop"),
  ).toBe("Already deploying");
  expect(decisionErrorText(new ApiError("x", 401), "Stop")).toBe(
    "Sign in to decide",
  );
  expect(decisionErrorText(new Error("network down"), "Deploy now")).toBe(
    "Couldn't deploy now: network down",
  );
});

test("answers map back to decisions", () => {
  expect(decisionFromAnswer("Try again", ["retry", "close"])).toBe("retry");
  expect(decisionFromAnswer(" try again ", ["retry", "close"])).toBe("retry");
  // Text that only starts with a label is a note, not that option.
  expect(
    decisionFromAnswer("Close without action, thanks", ["retry", "close"]),
  ).toBeNull();
  expect(decisionFromAnswer("buy proxies", ["retry", "close"])).toBeNull();
});

test("deploy-now key for the shared deferred store", () => {
  expect(incidentDecisionKey("inc-1")).toBe("incident:inc-1:deploy-now");
});

// ── Agents never started ─────────────────────────────────────────────────

const NO_SANDBOX = "Agents can't start: this project has no sandbox";
const signal = (
  state: "ok" | "failing" | "unknown",
  since: string,
  over: Partial<SignalView> = {},
): SignalView => ({
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  source: { kind: "http", url: "https://acme.example.test/search" },
  rule: { kind: "consecutive", failures: 3 },
  severity: "major",
  createdBy: "Ada",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  evaluation: {
    signalId: over.id ?? "sig-a",
    state,
    since,
    at: "2026-10-20T12:31:00Z",
    reason: state,
    inMaintenance: false,
  },
  ...over,
});
const setup = (
  over: { retry?: boolean; fix?: "sandboxes" | "providers" } = {},
): Incident => {
  const needsYou: NonNullable<IncidentResponse["needsYou"]> = {
    kind: "setup",
    reason: NO_SANDBOX,
    since: "2026-10-20T10:42:00Z",
    resumePhase: "investigating",
  };
  const next: Extract<IncidentResponse["next"], { kind: "needs-you" }> = {
    kind: "needs-you",
    reason: NO_SANDBOX,
    needsYou: "setup",
    options: over.retry ? ["retry", "resolve", "close"] : ["resolve", "close"],
  };
  if (!over.retry) needsYou.retryable = false;
  if (over.fix) {
    needsYou.fix = over.fix;
    next.fix = over.fix;
  }
  return inc("needs-you", { phase: "needs-you", costUsd: 0, needsYou, next });
};
const labels = (card: ReturnType<typeof nextCard>) =>
  card?.mode === "shell"
    ? orderButtons(card.buttons).map((b) => [b.label, b.weight])
    : null;

test("setup: the place to fix it is the answer, no Try again until it can work", () => {
  const card = nextCard({
    ...base,
    incident: setup({ fix: "sandboxes" }),
    signals: [signal("failing", "2026-10-20T10:41:00Z")],
  });
  expect(card).toMatchObject({
    mode: "shell",
    tone: "blue",
    eyebrow: "Needs you",
    headline: NO_SANDBOX,
    body: "Search is still failing. The incident closes by itself 5 min after it recovers",
  });
  expect(labels(card)).toEqual([
    ["Mark as fixed", "soft"],
    ["Close without action", "soft"],
    ["Set up a sandbox", "primary"],
  ]);
  expect(
    card?.mode === "shell" &&
      card.buttons.find((b) => b.kind === "open-settings")?.section,
  ).toBe("sandboxes");
  expect(
    labels(
      nextCard({
        ...base,
        incident: setup({ fix: "providers" }),
        signals: [],
      }),
    )?.at(-1),
  ).toEqual(["Set up a model provider", "primary"]);
  // Ready now: Try again is the answer and the settings link goes.
  expect(
    labels(nextCard({ ...base, incident: setup({ retry: true }) })),
  ).toEqual([
    ["Mark as fixed", "soft"],
    ["Close without action", "soft"],
    ["Try again", "primary"],
  ]);
});

test("setup: says when the signal passes again and when the incident closes", () => {
  const since = "2026-10-20T12:28:00Z";
  const closes = new Date(Date.parse(since) + 300_000).toISOString();
  expect(
    nextCard({
      ...base,
      incident: setup({ fix: "sandboxes" }),
      signals: [signal("ok", since)],
    }),
  ).toMatchObject({
    body: `Search is passing again since ${clockTime(since)}. The incident closes by itself at ${clockTime(closes)} if it stays green`,
  });
  // Past the window, waiting for the next check or tick.
  expect(
    recoveryLine(setup(), [signal("ok", "2026-10-20T12:00:00Z")], NOW),
  ).toBe(
    `Search is passing again since ${clockTime("2026-10-20T12:00:00Z")}. The incident closes by itself soon if it stays green`,
  );
  // Several signals: the last to recover sets the time; a provider is not one.
  const other = signal("ok", since, { id: "sig-b", name: "Checkout" });
  const provider = signal("failing", since, {
    id: "sig-p",
    name: "Upstream",
    provider: true,
  });
  const two = setup();
  two.signalIds = ["sig-a", "sig-b", "sig-p"];
  expect(
    recoveryLine(
      two,
      [signal("ok", "2026-10-20T12:10:00Z"), other, provider],
      NOW,
    ),
  ).toBe(
    `All 2 signals are passing again since ${clockTime(since)}. The incident closes by itself at ${clockTime(closes)} if it stays green`,
  );
  expect(
    recoveryLine(two, [signal("unknown", since), other, provider], NOW),
  ).toBe(
    "Search has no recent checks. The incident closes by itself 5 min after it recovers",
  );
});

test("the signal line only where it closes by itself", () => {
  const sig = [signal("ok", "2026-10-20T12:28:00Z")];
  // An agent ran: nothing closes by itself.
  const ran = setup();
  ran.response!.agents = [verifier({ role: "investigator", status: "error" })];
  expect(recoveryLine(ran, sig, NOW)).toBeNull();
  // A policy question is not a setup problem.
  expect(
    recoveryLine(
      inc("needs-you", {
        needsYou: {
          kind: "policy",
          reason: "x",
          since: "2026-10-20T12:00:00Z",
          resumePhase: "deciding",
        },
      }),
      sig,
      NOW,
    ),
  ).toBeNull();
  // Signals not loaded yet.
  expect(recoveryLine(setup(), [], NOW)).toBeNull();
  // Budget before any agent: the choice becomes buttons with the line.
  const budget = inc("needs-you", {
    phase: "needs-you",
    needsYou: {
      kind: "budget",
      reason: "Agents stopped at the $200 monthly budget",
      since: "2026-10-20T12:00:00Z",
      resumePhase: "investigating",
    },
    next: {
      kind: "needs-you",
      reason: "Agents stopped at the $200 monthly budget",
      needsYou: "budget",
      options: ["retry", "resolve", "close"],
    },
  });
  const card = nextCard({ ...base, incident: budget, signals: sig });
  expect(card).toMatchObject({
    mode: "shell",
    body: expect.stringContaining("Search is passing again since"),
  });
  expect(labels(card)?.map(([, weight]) => weight)).toEqual([
    "soft",
    "soft",
    "soft",
  ]);
  // Paused before any agent: the line rides under the paused card.
  expect(
    nextCard({
      ...base,
      incident: inc("paused", { phase: "paused" }),
      signals: [signal("failing", "2026-10-20T10:41:00Z")],
    }),
  ).toMatchObject({
    eyebrow: "Paused",
    footnote:
      "Search is still failing. The incident closes by itself 5 min after it recovers",
  });
});

const steps: NextStep[] = [
  {
    kind: "open-settings",
    title: "Let agents read the search logs",
    why: "They say which of the three it is",
    payload: "access",
  },
  {
    kind: "send-back",
    title: "Check the proxy's 407s first",
    why: "The cheapest to rule out",
    payload: "Rule out the 407s first.",
  },
  {
    kind: "close-provider",
    title: "Close as the provider's problem",
    why: "Every candidate is on the provider's side",
  },
];
const report = (nextSteps: NextStep[]): InvestigatorReport => ({
  role: "investigator",
  summary: "Search fails",
  cause: "Only the search service's logs say",
  readFirst: [{ path: "docs/incidents/runbook.md", found: true }],
  attempts: [],
  candidate: null,
  noCandidateReason: "Out of reach",
  check: { kind: "after-deploy", reason: "Nothing to deploy" },
  claims: [],
  notePath: "docs/incidents/2026-10-20-search.md",
  runbookPaths: ["docs/incidents/runbook.md"],
  nextSteps,
});
const suggesting = (
  options: OwnerDecision[],
  nextSteps: NextStep[] = steps,
  round = 2,
): ChoiceCard => {
  const card = nextCard({
    ...base,
    incident: inc("needs-you", {
      phase: "needs-you",
      agents: [
        verifier({
          role: "investigator",
          round,
          sessionId: "inv",
          report: report(nextSteps),
        }),
      ],
      next: {
        kind: "needs-you",
        reason: "No fix found",
        needsYou: "no-candidate",
        options,
      },
    }),
  });
  if (card?.mode !== "choice") throw new Error("Not a choice card");
  return card;
};

test("needs you: the investigator's steps lead, then the fixed decisions", () => {
  const card = suggesting(["send-back", "resolve", "close"]);
  expect(card.mode).toBe("choice");
  expect(card.question.options).toEqual([
    {
      label: "Let agents read the search logs",
      description: "They say which of the three it is",
    },
    {
      label: "Check the proxy's 407s first",
      description: "The cheapest to rule out",
    },
    {
      label: "Close as the provider's problem",
      description: "Every candidate is on the provider's side",
    },
    DECISION_COPY["send-back"],
    DECISION_COPY.resolve,
    DECISION_COPY.close,
  ]);
  expect(card.groups).toEqual([
    { label: "Suggested by the investigator", count: 3 },
    { count: 3, quiet: true },
  ]);
  expect(card.picks).toEqual({
    "Let agents read the search logs": { kind: "settings", section: "access" },
    "Check the proxy's 407s first": {
      kind: "decision",
      decision: "send-back",
    },
    "Close as the provider's problem": { kind: "decision", decision: "close" },
    "Send it back": { kind: "decision", decision: "send-back" },
    "Mark as fixed": { kind: "decision", decision: "resolve" },
    "Close without action": { kind: "decision", decision: "close" },
  });
  expect(card.notes["Check the proxy's 407s first"]).toEqual({
    label: "Note for the investigator",
    placeholder: "What should it look at or try differently?",
    maxLength: SEND_BACK_NOTE_MAX,
    initial: "Rule out the 407s first.",
  });
  expect(card.freeText).toEqual({
    label: "Tell the investigator",
    placeholder: "Tell the investigator…",
    maxLength: SEND_BACK_NOTE_MAX,
  });
  expect(pickFromAnswer(" close as the provider's problem", card)).toEqual({
    kind: "decision",
    decision: "close",
  });
  expect(pickFromAnswer("Something typed", card)).toBeNull();
});

test("needs you: a step whose decision is not offered is left out", () => {
  // No Send it back and no Close: only the settings step is left, and
  // nothing can be typed to the investigator.
  const card = suggesting(["retry", "resolve"]);
  expect(card.question.options?.map((o) => o.label)).toEqual([
    "Let agents read the search logs",
    "Try again",
    "Mark as fixed",
  ]);
  expect(card.freeText).toBeNull();
  // One decision and a suggestion is still a choice.
  expect(suggesting(["resolve"]).mode).toBe("choice");
});

test("needs you: steps from an earlier round, or repeating an option, are left out", () => {
  const earlier = suggesting(["send-back", "close"], steps, 1);
  expect(earlier.groups).toBeUndefined();
  expect(earlier.question.options).toEqual([
    DECISION_COPY["send-back"],
    DECISION_COPY.close,
  ]);
  const repeats = suggesting(
    ["send-back", "close"],
    [
      { kind: "close-provider", title: "Close without action", why: "" },
      { ...steps[1]!, title: "Check it" },
      { ...steps[1]!, title: "check it " },
    ],
  );
  expect(repeats.question.options?.map((o) => o.label)).toEqual([
    "Check it",
    "Send it back",
    "Close without action",
  ]);
});

test("every settings target opens a project settings section", () => {
  for (const target of NEXT_STEP_TARGETS)
    expect(NEXT_STEP_SECTION[target]).toBeTruthy();
  expect(NEXT_STEP_SECTION.signals).toBe("incidents");
  expect(NEXT_STEP_SECTION.sandbox).toBe("where");
});

test("closed without action, a flapping signal's card offers a stricter rule or a mute", () => {
  const signal: SignalView = {
    id: "sig-a",
    name: "Search",
    project: "acme",
    enabled: true,
    severity: "major",
    source: { kind: "http", url: "https://acme.example.test" },
    rule: { kind: "consecutive", failures: 3 },
    createdBy: "Ada",
    createdAt: "2026-10-19T12:00:00Z",
    updatedAt: "2026-10-19T12:00:00Z",
    evaluation: null,
  };
  const closed: Incident = {
    ...inc("closed-without-action", {
      next: { kind: "done", detail: "", options: [] },
    }),
    closedAt: "2026-10-20T12:00:00Z",
    quiet: { flaps: 6, lastAt: "2026-10-20T12:20:00Z" },
  };
  const card = nextCard({ ...base, incident: closed, signals: [signal] });
  expect(card).toMatchObject({
    mode: "shell",
    tone: "faint",
    eyebrow: "On and off",
    headline: "Search failed 7 times and passed again each time",
    body: "Closed without action. Make its rule stricter or mute it for a day",
  });
  expect(
    card?.mode === "shell" && card.buttons.map((b) => [b.kind, b.label]),
  ).toEqual([
    ["signal-fix", "Need 6 failures in a row"],
    ["signal-fix", "Mute for a day"],
  ]);
  // Its open pull requests are asked about first.
  const withPr: Incident = {
    ...closed,
    response: {
      ...closed.response!,
      openPrs: [
        {
          url: "https://github.com/acme/web/pull/465",
          number: 465,
          sessionId: "child-1",
        },
      ],
      next: { kind: "done", detail: "", options: ["close-prs", "keep-prs"] },
    },
  };
  expect(
    nextCard({ ...base, incident: withPr, signals: [signal] }),
  ).toMatchObject({ eyebrow: "Closed" });
  // Without the flaps it is a closed incident like any other: no card.
  expect(
    nextCard({
      ...base,
      incident: { ...closed, quiet: undefined },
      signals: [signal],
    }),
  ).toBeNull();
});

test("closed without action with a code fix still open asks what to do with it", () => {
  const open = (numbers: number[]) =>
    nextCard({
      ...base,
      incident: inc("closed-without-action", {
        openPrs: numbers.map((n) => ({
          url: `https://github.com/acme/web/pull/${n}`,
          number: n,
          sessionId: "child-1",
        })),
        next: {
          kind: "done",
          detail: "Closed without action",
          options: ["close-prs", "keep-prs"],
        },
      }),
    });
  expect(open([465])).toMatchObject({
    tone: "blue",
    eyebrow: "Closed",
    headline: "PR #465 from the investigator is still open",
    body: "It changes code, so Sessions left it for you to close or keep",
    buttons: [
      { decision: "close-prs", label: "Close on GitHub", weight: "primary" },
      { decision: "keep-prs", label: "Keep open", weight: "soft" },
    ],
  });
  expect(open([465, 469])).toMatchObject({
    headline: "PRs #465 and #469 from the investigator are still open",
    body: "They change code, so Sessions left them for you to close or keep",
  });
});
