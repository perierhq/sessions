import { expect, test } from "bun:test";
import type {
  AgentRun,
  IncidentResponse,
} from "../../../shared/incident-response";
import type {
  Incident,
  SignalEvaluation,
  SignalState,
  SignalView,
  StripResponse,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import { pageModel } from "./page-model";

const NOW = Date.parse("2026-10-20T12:31:00Z");

const responseFixture = (
  over: Partial<IncidentResponse> = {},
): IncidentResponse => ({
  phase: "veto",
  round: 1,
  maxRounds: 2,
  agents: [],
  actionRuns: [],
  costUsd: 0,
  ownerTouched: false,
  next: { kind: "working", detail: "" },
  ledger: [],
  droppedLedger: 0,
  startedAt: "2026-10-20T10:45:00Z",
  updatedAt: "2026-10-20T12:27:00Z",
  ...over,
});

const incidentFixture = (
  over: Partial<Omit<Incident, "response">> & {
    response?: Partial<IncidentResponse>;
  } = {},
): Incident => {
  const { response, ...rest } = over;
  const incident: Incident = {
    id: "inc-1",
    project: "acme",
    title: "Search down",
    state: "investigating",
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
    ...rest,
  };
  if (response) incident.response = responseFixture(response);
  return incident;
};

const signalFixture = (over: Partial<SignalView> = {}): SignalView => ({
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  source: { kind: "http", url: "https://acme.example.test" },
  intervalMs: 120_000,
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  evaluation: null,
  ...over,
});

const evalFixture = (state: SignalState): SignalEvaluation => ({
  signalId: "sig-a",
  state,
  since: "2026-10-20T10:41:00Z",
  at: "2026-10-20T12:30:00Z",
  reason: "HTTP 503",
  inMaintenance: false,
});

const run = (over: Partial<AgentRun>): AgentRun => ({
  role: "investigator",
  round: 1,
  attempt: 1,
  sessionId: "s",
  model: "m",
  provider: "p",
  workspace: { kind: "sandbox", provider: "local" },
  accessSummary: "",
  accessRevision: "",
  status: "done",
  startedAt: "2026-10-20T10:45:00Z",
  turnSentAt: "",
  costUsd: 0,
  tokens: 0,
  reminded: false,
  ...over,
});

const strip: StripResponse = {
  from: "2026-10-20T08:31:00Z",
  to: "2026-10-20T12:31:00Z",
  bucketMs: 120_000,
  lanes: [],
  markers: [],
  nextRunAt: "2026-10-20T12:31:48Z",
};

test("one signal: caption, live line, future markers", () => {
  const m = pageModel({
    incident: incidentFixture({
      state: "veto",
      response: {
        veto: {
          startedAt: "2026-10-20T12:27:00Z",
          deadline: "2026-10-20T12:37:00Z",
        },
      },
    }),
    signals: [
      signalFixture({
        id: "sig-a",
        name: "Search",
        evaluation: evalFixture("failing"),
      }),
    ],
    settings: null,
    strip,
    now: NOW,
  });
  expect(m.headline).toBe("Search is down");
  expect(m.dot).toEqual({ tone: "red", pulse: false });
  expect(m.stripTitle).toBe("Search · Check · every 2 min");
  expect(m.future).toEqual([{ at: "2026-10-20T12:37:00Z", label: "Deploys" }]);
  expect(m.liveLine).toEqual({
    tone: "red",
    text: "Live · next run in 48 s",
    nextRunAt: "2026-10-20T12:31:48Z",
  });
  expect(m.primaryName).toBe("Search");
  expect(m.primaryState).toBe("failing");
  expect(m.facts[0]).toBe(`since ${clockTime("2026-10-20T10:41:00Z")}`);
});

test("a deleted primary signal still renders", () => {
  const m = pageModel({
    incident: incidentFixture({ title: "Search" }),
    signals: [],
    settings: null,
    now: Date.now(),
  });
  expect(m.headline).toBe("Search");
  expect(m.dot.tone).toBe("faint");
  expect(m.stripTitle).toBe("Search");
  expect(m.liveLine).toBeNull();
  expect(
    m.laneMeta({ id: "sig-a", signalId: "sig-a", label: "sig-a", bars: [] })
      .kind,
  ).toBe("passfail");
});

test("several signals", () => {
  const m = pageModel({
    incident: incidentFixture({ signalIds: ["sig-a", "sig-b"] }),
    signals: [
      signalFixture({ id: "sig-a", intervalMs: 120_000 }),
      signalFixture({ id: "sig-b", name: "Api", intervalMs: 60_000 }),
    ],
    settings: null,
    now: Date.now(),
  });
  expect(m.stripTitle).toBe("2 signals · every minute");
  expect(m.facts.at(-1)).toBe("from Search and Api");
});

test("lane meta carries the threshold and the deadline days", () => {
  const m = pageModel({
    incident: incidentFixture({ signalIds: ["sig-a", "sig-b"] }),
    signals: [
      signalFixture({
        id: "sig-a",
        rule: { kind: "threshold", above: 800, forMs: 300_000 },
      }),
      signalFixture({
        id: "sig-b",
        source: { kind: "expiry", target: "tls", host: "acme.example.test" },
        rule: { kind: "deadline", warnDays: 14, failDays: 3 },
      }),
    ],
    settings: null,
    now: NOW,
  });
  const lane = (signalId: string) =>
    m.laneMeta({ id: signalId, signalId, label: signalId, bars: [] });
  expect(lane("sig-a")).toMatchObject({ kind: "value", threshold: 800 });
  expect(lane("sig-a").format(1200)).toBe("1.2 s");
  expect(lane("sig-b")).toMatchObject({
    kind: "days",
    warnDays: 14,
    failDays: 3,
  });
});

test("closed: ended, faint, no future", () => {
  const m = pageModel({
    incident: incidentFixture({
      state: "resolved",
      closedAt: "2026-10-20T12:50:00Z",
      fixedBy: "agents",
      response: {
        watch: {
          startedAt: "2026-10-20T12:40:00Z",
          deadline: "2026-10-20T12:50:00Z",
        },
      },
    }),
    signals: [signalFixture({ evaluation: evalFixture("ok") })],
    settings: null,
    now: NOW,
  });
  expect(m.liveLine).toEqual({
    tone: "faint",
    text: `Ended ${clockTime("2026-10-20T12:50:00Z")}`,
  });
  expect(m.future).toEqual([]);
  expect(m.headline).toBe("Search works again");
  expect(m.dot.tone).toBe("green");
});

test("rollback first and watch markers; working agents pulse", () => {
  const m = pageModel({
    incident: incidentFixture({
      state: "watching",
      response: {
        candidate: {
          round: 1,
          plan: { pr: false, actions: [] },
          check: { kind: "after-deploy", reason: "" },
          claims: [],
          notePath: "",
          runbookPaths: [],
          rollbackFirst: true,
        },
        veto: {
          startedAt: "2026-10-20T12:27:00Z",
          deadline: "2026-10-20T12:37:00Z",
        },
        watch: {
          startedAt: "2026-10-20T12:30:00Z",
          deadline: "2026-10-20T12:40:00Z",
        },
        agents: [
          run({ sessionId: "a", status: "running" }),
          run({ sessionId: "b", status: "waiting" }),
          run({ sessionId: "c", status: "done" }),
        ],
      },
    }),
    signals: [signalFixture({ evaluation: evalFixture("failing") })],
    settings: null,
    now: NOW,
  });
  expect(m.future.map((f) => f.label)).toEqual(["Rolls back", "Closes"]);
  expect(m.agentSessionIds).toEqual(["a", "b"]);
  expect(m.dot).toEqual({ tone: "yellow", pulse: true });
});
