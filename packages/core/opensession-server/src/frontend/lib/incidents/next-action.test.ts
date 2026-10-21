import { expect, test } from "bun:test";
import { DECISION_COPY } from "../../../shared/incident-decision-copy";
import type {
  AgentRun,
  IncidentResponse,
  ProofResult,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import type { Incident, IncidentState } from "../../../shared/incidents";
import { ApiError } from "../api/request";
import { clockTime } from "../time";
import {
  decisionErrorText,
  decisionFromAnswer,
  incidentDecisionKey,
  nextCard,
  orderButtons,
} from "./next-action";

const NOW = Date.parse("2026-10-20T12:31:12Z");
const settings: RedactedProjectSettings = {
  project: "acme",
  agentsPaused: false,
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
