import { expect, test } from "bun:test";
import type {
  CandidateState,
  IncidentAction,
  InvestigatorReport,
  ProofResult,
} from "../../../shared/incident-response";
import type {
  Incident,
  Observation,
  Signal,
  SignalEvaluation,
} from "../../../shared/incidents";
import {
  branchFor,
  buildInvestigatorPrompt,
  buildReminder,
  buildSendBackMessage,
  buildVerifierPrompt,
  notePathFor,
  runbookPathsFor,
  slugify,
} from "./prompts";

const incident: Incident = {
  id: "inc-1",
  project: "acme",
  title: "Search blocked by upstream",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: ["sig-a", "sig-b"],
  primarySignalId: "sig-a",
  openedAt: "2026-10-20T10:41:00.000Z",
  updatedAt: "2026-10-20T10:41:00.000Z",
  lastProblemAt: "2026-10-20T10:41:00.000Z",
  findings: [],
  events: [],
  droppedEvents: 0,
};
const signal: Signal = {
  id: "sig-a",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  runOn: "runner-prod",
  source: {
    kind: "http",
    url: "https://acme.example.test/search?q=x",
    headers: { Authorization: "Bearer s3cret" },
  },
  rule: { kind: "consecutive", failures: 3 },
  createdBy: "Ada",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const evaluation: SignalEvaluation = {
  signalId: "sig-a",
  state: "failing",
  since: "2026-10-20T10:38:00.000Z",
  at: "2026-10-20T10:41:00.000Z",
  reason: "3 failures in a row",
  inMaintenance: false,
};
const recent: Observation[] = [
  { at: "2026-10-20T10:39:00.000Z", result: "fail", detail: "403 Forbidden" },
  {
    at: "2026-10-20T10:39:00.000Z",
    result: "ok",
    detail: "side lane",
    lane: "eu",
  },
  { at: "2026-10-20T10:40:00.000Z", result: "fail", detail: "403 Forbidden" },
];
const rollbackAction: IncidentAction = {
  id: "rollback",
  kind: "rollback",
  label: "Roll back",
  runner: "runner-prod",
  command: "./rollback.sh {{previousRef}}",
  timeoutMs: 600_000,
  reversible: true,
  cost: { kind: "none" },
  needsSecret: false,
  scope: { services: [], paths: [], migrationPaths: [] },
};
const report: InvestigatorReport = {
  role: "investigator",
  summary: "Upstream blocks our user agent",
  cause: "Bot protection rejects the default client since Tuesday.",
  readFirst: [{ path: "docs/incidents/runbook.md", found: true }],
  attempts: [
    {
      step: "Request with app UA",
      cost: "cheap",
      result: "confirmed",
      evidence: "200 with app UA, 403 without, seen in the edge log",
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
  notePath: "docs/incidents/2026-10-20-search-blocked-by-upstream.md",
  runbookPaths: ["docs/incidents/runbooks/search.md"],
};
const candidate: CandidateState = {
  round: 1,
  plan: report.candidate!,
  check: report.check,
  claims: report.claims,
  notePath: report.notePath,
  runbookPaths: report.runbookPaths,
  prUrl: "https://github.com/acme/web/pull/12",
};
const proof: ProofResult = {
  round: 1,
  at: "2026-10-20T10:55:00.000Z",
  runner: "runner-prod",
  baseline: {
    verdict: "fails",
    samples: [
      { at: "2026-10-20T10:54:00.000Z", result: "fail", detail: "403" },
    ],
  },
  candidate: {
    kind: "request",
    verdict: "passes",
    samples: [{ at: "2026-10-20T10:54:30.000Z", result: "ok", detail: "200" }],
  },
};

test("paths, slugs, branches", () => {
  expect(slugify("Search: blocked by Upstream!!")).toBe(
    "search-blocked-by-upstream",
  );
  expect(slugify("!!!")).toBe("incident");
  expect(slugify("alpha beta gamma", 12)).toBe("alpha-beta");
  expect(notePathFor(incident)).toBe(
    "docs/incidents/2026-10-20-search-blocked-by-upstream.md",
  );
  expect(runbookPathsFor({ name: "Search API" })).toEqual([
    "docs/incidents/runbook.md",
    "docs/incidents/runbooks/search-api.md",
  ]);
  expect(branchFor(incident, "investigator", 1, 1)).toBe(
    "incident/2026-10-20-search-blocked-by-upstream",
  );
  expect(branchFor(incident, "investigator", 2, 3)).toBe(
    "incident/2026-10-20-search-blocked-by-upstream-a3",
  );
  expect(branchFor(incident, "verifier", 2, 1)).toBe(
    "incident/2026-10-20-search-blocked-by-upstream-verify-r2",
  );
  expect(branchFor(incident, "verifier", 1, 2)).toBe(
    "incident/2026-10-20-search-blocked-by-upstream-verify-r1-a2",
  );
});
test("investigator prompt: read first, cheapest-first, never secrets or commands", () => {
  const p = buildInvestigatorPrompt({
    incident,
    signal,
    otherSignals: [],
    evaluation,
    recent,
    baseBranch: "main",
    round: 1,
    maxRounds: 2,
    actions: [
      {
        ...rollbackAction,
        command: "./rollback.sh {{previousRef}} --token=zzz",
      },
    ],
  });
  expect(p).toStartWith("# Incident: Search blocked by upstream");
  expect(p).toContain("Round 1 of 2");
  expect(p).toContain(
    "Before anything else, read these and list each in readFirst, found or not:",
  );
  expect(p).toContain("docs/incidents/runbooks/search.md");
  expect(p).toContain(
    "Earlier incident notes: every docs/incidents/*.md whose front matter lists sig-a under signals, newest first, at most 10.",
  );
  expect(p).toContain("Work through the runbook's checklist cheapest-first");
  expect(p).toContain("Sessions runs every action itself.");
  expect(p).toContain(
    "rollback · rollback · Roll back · reversible · free · no secret",
  );
  expect(p).toContain(
    "docs/incidents/2026-10-20-search-blocked-by-upstream.md",
  );
  expect(p).toContain("https://acme.example.test");
  expect(p).toContain("2026-10-20T10:40:00.000Z · fail · 403 Forbidden");
  expect(p).not.toContain("side lane");
  expect(p).toContain(
    "End your final message with exactly one fenced block tagged incident-report.",
  );
  expect(p).not.toContain("s3cret");
  expect(p).not.toContain("--token=zzz");
  expect(p).not.toContain("rollback.sh");
});
test("investigator prompt: hook secrets, other signals, rollback-first", () => {
  const hook: Signal = {
    ...signal,
    id: "sig-b",
    name: "Errors",
    runOn: undefined,
    source: { kind: "webhook" },
    rule: { kind: "rate", windowMs: 300_000, atLeast: 5 },
    hookSecret: "h00ksecret",
  };
  const p = buildInvestigatorPrompt({
    incident,
    signal: hook,
    otherSignals: [signal],
    evaluation: null,
    recent: [],
    baseBranch: "main",
    round: 2,
    maxRounds: 2,
    actions: [
      {
        ...rollbackAction,
        id: "raise",
        kind: "run-once",
        label: "Raise budget",
        reversible: false,
        needsSecret: true,
        cost: { kind: "amount", usd: 12.5 },
      },
    ],
    rollbackFirst: { releaseAt: "2026-10-20T10:30:00.000Z" },
  });
  expect(p).not.toContain("h00ksecret");
  expect(p).toContain("request checks are not available for this signal");
  expect(p).toContain("Search");
  expect(p).toContain(
    "raise · run-once · Raise budget · not reversible · $12.5 · needs a secret",
  );
  expect(p).toContain(
    "A release at 10:30 UTC (no ref) went out shortly before this started. Sessions is rolling it back now. Find what in that release broke Errors, write the note and runbook update, and propose a fix PR if one is needed. It will not be deployed while the rollback holds.",
  );
  expect(p).toContain(
    "If the fix is an action rather than code, the PR contains only the note and the runbook update.",
  );
});
test("verifier prompt never carries the investigator's reasoning", () => {
  const p = buildVerifierPrompt({
    incident,
    signal,
    candidate,
    headSha: "abc1234",
    proof,
    mode: "ask",
    runnerLabel: "Production · acme",
    independence: "other-provider",
    round: 1,
  });
  expect(p).toStartWith("# Verify a fix for: Search blocked by upstream");
  expect(p).toContain(
    "You are the verifier. You did not see how this fix was found. Do not edit, commit or push anything.",
  );
  expect(p).toContain("https://github.com/acme/web/pull/12");
  expect(p).toContain("abc1234");
  expect(p).toContain("merge and deploy");
  expect(p).toContain(
    "## The proof Sessions measured from Production · acme with the incident's own signal",
  );
  expect(p).toContain("Check every claim and source below. Open each source.");
  expect(p).toContain(
    "Read the change with gh pr view https://github.com/acme/web/pull/12 --json files,headRefOid and gh pr checks https://github.com/acme/web/pull/12; you work read-only and cannot run the project's tests yourself.",
  );
  expect(p).toContain("Say certain only if all of this holds.");
  expect(p).toContain("Upstream returns 403 to the default user agent");
  expect(p).toContain("with the incident's own signal");
  expect(p).not.toContain(report.summary);
  expect(p).not.toContain(report.cause);
  expect(p).not.toContain(report.attempts[0].evidence);
  expect(p).not.toContain("s3cret");
  const code = buildVerifierPrompt({
    incident,
    signal,
    candidate: {
      ...candidate,
      plan: { pr: false, actions: ["rollback"] },
    },
    headSha: "abc1234",
    proof,
    mode: "code",
    runnerLabel: "Production · acme",
    independence: "same-provider",
    round: 2,
    actions: [rollbackAction],
  });
  expect(code).toContain("run the project's checks that cover the change");
  expect(code).not.toContain("cannot run the project's tests yourself");
  expect(code).toContain("Roll back");
  expect(code).not.toContain("merge and deploy");
});
test("send-back and reminder copy", () => {
  expect(
    buildSendBackMessage(2, 2, {
      kind: "not-certain",
      reasons: ["Claim not verified: B"],
    }),
  ).toBe(
    "The verifier was not certain (round 2 of 2):\n- Claim not verified: B\n\nUpdate the PR and the note, then end with a new incident-report block.",
  );
  expect(
    buildSendBackMessage(1, 2, {
      kind: "owner",
      by: "Ada",
      note: "Try the cache first",
    }),
  ).toBe(
    "Ada sent this back: Try the cache first\n\nUpdate the PR and the note, then end with a new incident-report block.",
  );
  expect(
    buildSendBackMessage(1, 2, {
      kind: "rolled-back",
      detail: "Search still failing",
    }),
  ).toStartWith("Your fix was released and rolled back: Search still failing");
  expect(
    buildSendBackMessage(1, 2, {
      kind: "reopened",
      detail: "Search failing again",
    }),
  ).toStartWith(
    "The incident reopened after it was resolved: Search failing again",
  );
  expect(
    buildSendBackMessage(1, 2, { kind: "check-failed", detail: "test" }),
  ).toStartWith("A required check failed on the PR: test");
  expect(buildReminder("The evidence table is empty")).toBe(
    "Your last message did not end with a valid incident-report block: The evidence table is empty. Reply with only the corrected block.",
  );
});
