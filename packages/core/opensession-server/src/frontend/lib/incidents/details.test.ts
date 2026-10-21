import { expect, test } from "bun:test";
import type {
  AccessPreview,
  IncidentAgentsAccessView,
} from "../../../shared/incident-access";
import type {
  AgentRole,
  AgentRun,
  CandidateState,
  IncidentResponse,
  VerifierReport,
} from "../../../shared/incident-response";
import type { Incident, IncidentSummary } from "../../../shared/incidents";
import type { PrDetails } from "../types";
import {
  agentsWorkspaceNote,
  detailRows,
  earlierIncidents,
  ledgerEntries,
  rowWrapsOnPhone,
} from "./details";

const NOW = Date.parse("2026-10-20T12:31:00Z");
const base: Incident = {
  id: "inc-1",
  project: "acme",
  title: "Search",
  state: "veto",
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
const summary = (over: Partial<IncidentSummary>): IncidentSummary => {
  const { events: _events, ...rest } = base;
  return { ...rest, eventCount: 0, ...over };
};
const run = (
  role: AgentRole,
  round: number,
  over: Partial<AgentRun> = {},
): AgentRun => ({
  role,
  round,
  attempt: 1,
  sessionId: `${role}-${round}`,
  model: "m",
  provider: "p",
  workspace: { kind: "sandbox", provider: "daytona" },
  accessSummary: "",
  accessRevision: "",
  status: "done",
  startedAt: "2026-10-20T10:45:00Z",
  endedAt: "2026-10-20T11:31:00Z",
  costUsd: 1.9,
  tokens: 0,
  turnSentAt: "",
  reminded: false,
  ...over,
});
const verifierReport = (
  verdict: VerifierReport["verdict"],
): VerifierReport => ({
  role: "verifier",
  verdict,
  reasons: [],
  claims: [],
  proofAccepted: false,
});
const candidate = (over: Partial<CandidateState>): CandidateState => ({
  round: 1,
  plan: { pr: true, actions: [] },
  check: { kind: "after-deploy", reason: "" },
  claims: [],
  notePath: "",
  runbookPaths: [],
  ...over,
});
const pr: PrDetails = {
  number: 437,
  title: "Send the app's user agent",
  url: "https://example.test/pr/437",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "fix/user-agent",
  additions: 84,
  deletions: 12,
  changedFiles: 2,
  reviewDecision: "",
  author: "acme-bot",
  body: "",
  checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
};
const response = (over: Partial<IncidentResponse>): IncidentResponse => ({
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
const withResponse = (over: Partial<IncidentResponse>): Incident => ({
  ...base,
  response: response(over),
});
const preview = (summaryText: string | null, error?: string): AccessPreview => {
  const view: AccessPreview = { access: null, tools: [], warnings: [] };
  if (error) view.error = error;
  if (summaryText !== null)
    view.access = {
      incidentId: "inc-1",
      project: "acme",
      role: "investigator",
      signalId: null,
      overrideApplied: false,
      defaults: true,
      connections: [],
      deniedTools: {},
      mode: "ask",
      repos: [],
      runners: [],
      hosts: [],
      credentials: [],
      model: null,
      egress: null,
      narrowed: [],
      revision: "",
      summary: summaryText,
    };
  return view;
};

test("the three fixed rows exist without plan 2", () => {
  const rows = detailRows({
    incident: base,
    earlier: [],
    pr: null,
    budgetUsd: null,
    access: null,
    now: NOW,
  });
  expect(rows.map((r) => [r.key, r.value])).toEqual([
    ["change", "No change yet"],
    ["cost", "No agents yet"],
    ["earlier", "None like this"],
  ]);
  expect(rows.map((r) => r.band)).toEqual(["Fix", "Agents", "History"]);
  expect(rows.every((r) => r.target === null)).toBe(true);
});

test("a full incident", () => {
  const incident = withResponse({
    round: 2,
    costUsd: 3.8,
    verdict: {
      round: 2,
      at: "2026-10-20T12:20:00Z",
      verdict: "certain",
      reasons: [],
    },
    note: { prUrl: "https://example.test/pr/437", merged: false },
    candidate: candidate({ prUrl: "https://example.test/pr/437" }),
    agents: [
      run("investigator", 1, { prUrl: "https://example.test/pr/437" }),
      run("investigator", 2, { prUrl: "https://example.test/pr/437" }),
      run("verifier", 1, { report: verifierReport("not-certain") }),
      run("verifier", 2, { independence: "same-provider" }),
    ],
  });
  const earlier = [
    summary({
      id: "inc-0",
      title: "Fingerprint block",
      state: "resolved",
      openedAt: "2026-10-09T10:00:00Z",
    }),
  ];
  const rows = detailRows({
    incident,
    earlier,
    pr,
    budgetUsd: 20,
    access: null,
    now: NOW,
  });
  expect(rows.map((r) => r.key)).toEqual([
    "change",
    "note",
    "investigator",
    "verifier",
    "cost",
    "earlier",
  ]);
  expect(rows[0]).toMatchObject({
    label: "PR #437 · Send the app's user agent",
    value: "checks pass",
    tone: "green",
    lines: { additions: 84, deletions: 12 },
    target: { kind: "pr", number: 437, branch: "fix/user-agent" },
  });
  expect(rows[1]!.value).toBe("Draft · merges with the fix");
  expect(rows[1]!.target).toEqual({
    kind: "url",
    url: "https://example.test/pr/437",
  });
  expect(rows[2]!.value).toBe("2 rounds · 1 h 32 min");
  expect(rows[2]!.target).toEqual({
    kind: "session",
    sessionId: "investigator-2",
  });
  expect(rows[3]!.value).toBe(
    "Certain · sent round 1 back · same provider, different model",
  );
  expect(rows[3]).toMatchObject({ tone: "green", emphasis: "Certain" });
  expect(rows[3]!.target).toEqual({ kind: "session", sessionId: "verifier-2" });
  expect(rows[4]!.value).toBe("$3.80");
  expect(rows[4]!.meter).toEqual({ pct: 19, of: "of $20" });
  expect(rows[4]!.target).toEqual({ kind: "sheet", sheet: "cost" });
  expect(rows[5]!.value).toBe("Fingerprint block");
  expect(rows[5]!.target).toEqual({ kind: "sheet", sheet: "earlier" });
});

test("a PR that has not loaded keeps its number from the link", () => {
  const incident = withResponse({
    costUsd: 0,
    agents: [
      run("investigator", 1, {
        prUrl: "https://github.com/acme/acme-api/pull/12",
        status: "running",
        endedAt: undefined,
      }),
    ],
  });
  const rows = detailRows({
    incident,
    earlier: [],
    pr: null,
    budgetUsd: null,
    access: null,
    now: NOW,
  });
  expect(rows[0]).toMatchObject({
    label: "PR #12",
    target: { kind: "url", url: "https://github.com/acme/acme-api/pull/12" },
  });
  expect(rows[1]).toMatchObject({
    key: "investigator",
    value: "working",
    tone: "yellow",
  });
});

test("a rollback first, checks failing and running, merged note", () => {
  const incident = withResponse({
    costUsd: 0,
    note: { prUrl: "https://example.test/pr/9", merged: true },
    candidate: candidate({ rollbackFirst: true }),
    agents: [],
  });
  const rows = detailRows({
    incident,
    earlier: [],
    pr: null,
    budgetUsd: null,
    access: null,
    now: NOW,
  });
  expect(rows[0]).toMatchObject({
    label: "Rollback",
    value: "rolls back to the last release",
    target: null,
  });
  expect(rows[1]!.value).toBe("Merged");

  const failing: PrDetails = {
    ...pr,
    checks: [
      { name: "a", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "b", status: "IN_PROGRESS", conclusion: "" },
    ],
  };
  const pending: PrDetails = {
    ...pr,
    checks: [{ name: "b", status: "IN_PROGRESS", conclusion: "" }],
  };
  const none: PrDetails = { ...pr, checks: [] };
  const withPr = withResponse({
    costUsd: 0,
    agents: [run("investigator", 1, { prUrl: "https://example.test/pr/437" })],
  });
  const change = (p: PrDetails) =>
    detailRows({
      incident: withPr,
      earlier: [],
      pr: p,
      budgetUsd: null,
      access: null,
      now: NOW,
    })[0]!;
  expect(change(failing)).toMatchObject({ value: "checks fail", tone: "red" });
  expect(change(pending)).toMatchObject({
    value: "checks running",
    tone: "yellow",
  });
  expect(change(none).value).toBe("");
});

test("one round, a not-certain verdict, the access row", () => {
  const incident = withResponse({
    costUsd: 1.9,
    verdict: {
      round: 1,
      at: "2026-10-20T12:20:00Z",
      verdict: "not-certain",
      reasons: [],
    },
    agents: [run("investigator", 1), run("verifier", 1)],
  });
  const access: IncidentAgentsAccessView = {
    incidentId: "inc-1",
    investigator: preview("Reads acme · asks before changes"),
    verifier: preview(null),
  };
  const rows = detailRows({
    incident,
    earlier: [],
    pr: null,
    budgetUsd: null,
    access,
    now: NOW,
  });
  expect(rows.map((r) => r.key)).toEqual([
    "change",
    "investigator",
    "verifier",
    "cost",
    "access",
    "earlier",
  ]);
  expect(rows[1]!.value).toBe("1 round · 46 min");
  expect(rows[2]).toMatchObject({ value: "Not certain", tone: "yellow" });
  expect(rows[3]!.meter).toBeUndefined();
  expect(rows[4]).toMatchObject({
    label: "Access",
    value: "Reads acme · asks before changes",
    target: { kind: "sheet", sheet: "access" },
  });

  const refused: IncidentAgentsAccessView = {
    ...access,
    investigator: preview(null, "No grants"),
  };
  const row = detailRows({
    incident,
    earlier: [],
    pr: null,
    budgetUsd: null,
    access: refused,
    now: NOW,
  }).find((r) => r.key === "access");
  expect(row).toMatchObject({ value: "No grants", tone: "red" });

  // A heads-up or a closed incident runs no agents: the server's refusal
  // there is no row at all.
  for (const state of ["heads-up", "resolved", "paused"] as const)
    expect(
      detailRows({
        incident: { ...incident, state },
        earlier: [],
        pr: null,
        budgetUsd: null,
        access: refused,
        now: NOW,
      }).some((r) => r.key === "access"),
    ).toBe(false);
});

test("earlier incidents: two titles and a count", () => {
  const earlier = ["A", "B", "C", "D"].map((title, i) =>
    summary({ id: `e${i}`, title, state: "resolved" }),
  );
  const rows = detailRows({
    incident: base,
    earlier,
    pr: null,
    budgetUsd: null,
    access: null,
    now: NOW,
  });
  expect(rows.at(-1)!.value).toBe("A, B and 2 more");
});

test("earlier incidents share a signal and are closed", () => {
  const all = [
    summary({ id: "inc-1", state: "veto" }),
    summary({
      id: "x",
      state: "resolved",
      signalIds: ["sig-b"],
      openedAt: "2026-10-01T00:00:00Z",
    }),
    summary({
      id: "y",
      state: "closed-without-action",
      openedAt: "2026-10-02T00:00:00Z",
    }),
    summary({ id: "z", state: "resolved", openedAt: "2026-10-05T00:00:00Z" }),
    summary({
      id: "open",
      state: "investigating",
      openedAt: "2026-10-06T00:00:00Z",
    }),
  ];
  expect(earlierIncidents(all, base).map((i) => i.id)).toEqual(["z", "y"]);
});

test("earlier incidents stop at five", () => {
  const all = Array.from({ length: 8 }, (_, i) =>
    summary({
      id: `r${i}`,
      state: "resolved",
      openedAt: `2026-10-0${i + 1}T00:00:00Z`,
    }),
  );
  expect(earlierIncidents(all, base).map((i) => i.id)).toEqual([
    "r7",
    "r6",
    "r5",
    "r4",
    "r3",
  ]);
});

test("the workspace note names a host run and nothing else", () => {
  const withAgents = (agents: AgentRun[]) => response({ agents });
  expect(
    agentsWorkspaceNote(
      withAgents([
        run("investigator", 1, {
          workspace: { kind: "host", user: "opensession-incident" },
        }),
      ]),
    ),
  ).toBe("Runs on this server, not in a sandbox");
  expect(
    agentsWorkspaceNote(
      withAgents([
        run("investigator", 1, {
          workspace: { kind: "sandbox", provider: "daytona" },
        }),
      ]),
    ),
  ).toBeNull();
  expect(
    agentsWorkspaceNote(
      withAgents([
        run("investigator", 1, {
          workspace: { kind: "host", user: "opensession-incident" },
        }),
        run("investigator", 2),
      ]),
    ),
  ).toBeNull();
  expect(agentsWorkspaceNote(undefined)).toBeNull();
});

test("the ledger lists runs newest first", () => {
  const ledger = response({
    agents: [
      run("investigator", 1),
      run("verifier", 1, {
        status: "error",
        error: "Model refused",
        startedAt: "2026-10-20T11:40:00Z",
        endedAt: "2026-10-20T11:50:00Z",
        costUsd: 0.4,
      }),
      run("investigator", 2, {
        status: "running",
        startedAt: "2026-10-20T12:00:00Z",
        endedAt: undefined,
      }),
    ],
  });
  const entries = ledgerEntries(ledger, NOW);
  expect(entries.map((e) => [e.status, e.meta])).toEqual([
    ["running", ["Investigator · round 2", "31 min", "$1.90"]],
    ["error", ["Verifier · round 1", "10 min", "$0.40"]],
    ["ok", ["Investigator · round 1", "46 min", "$1.90"]],
  ]);
  expect(entries[1]).toMatchObject({
    error: "Model refused",
    sessionId: "verifier-1",
  });
});

test("a row wraps its value on a phone only when both do not fit", () => {
  const row = (label: string, value: string) => ({ label, value });
  expect(rowWrapsOnPhone(row("Investigator", "2 rounds · 1 h 32 min"))).toBe(
    false,
  );
  expect(rowWrapsOnPhone(row("Earlier incidents", "x".repeat(300)))).toBe(true);
});

test("the Fix row falls back to the candidate's PR", () => {
  const rows = detailRows({
    incident: withResponse({
      candidate: candidate({
        // SAFETY: the Fix row reads only the snapshot's number and url.
        pr: {
          ghRepo: "acme/app",
          number: 512,
          url: "https://example.test/pr/512",
        } as CandidateState["pr"],
      }),
    }),
    earlier: [],
    pr: null,
    budgetUsd: null,
    access: null,
    now: NOW,
  });
  expect(rows[0]).toMatchObject({
    key: "change",
    label: "PR #512",
    target: { kind: "url", url: "https://example.test/pr/512" },
  });
});

test("a closed incident without a change says No change", () => {
  const rows = detailRows({
    incident: { ...base, state: "closed-without-action" },
    earlier: [],
    pr: null,
    budgetUsd: null,
    access: null,
    now: NOW,
  });
  expect(rows[0]).toMatchObject({ key: "change", value: "No change" });
});
