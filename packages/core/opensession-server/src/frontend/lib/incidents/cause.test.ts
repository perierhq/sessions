import { expect, test } from "bun:test";
import type {
  AgentRun,
  Claim,
  IncidentResponse,
  Verdict,
} from "../../../shared/incident-response";
import { causeOf, sourceLabel } from "./cause";

const run = (over: Partial<AgentRun>): AgentRun => ({
  role: "investigator",
  round: 1,
  attempt: 1,
  sessionId: "s-1",
  model: "m",
  provider: "p",
  workspace: { kind: "sandbox", provider: "local" },
  accessSummary: "",
  accessRevision: "",
  status: "done",
  startedAt: "2026-10-20T10:45:00Z",
  turnSentAt: "2026-10-20T10:45:00Z",
  costUsd: 0,
  tokens: 0,
  reminded: false,
  ...over,
});
const inv = (round: number, cause: string, claims: Claim[] = []): AgentRun =>
  run({
    round,
    sessionId: `inv-${round}`,
    report: {
      role: "investigator",
      summary: "",
      cause,
      readFirst: [],
      attempts: [],
      candidate: null,
      check: { kind: "after-deploy", reason: "" },
      claims,
      notePath: "",
      runbookPaths: [],
    },
  });
const verdict = (round: number, v: Verdict["verdict"]): Verdict => ({
  round,
  at: "2026-10-20T12:00:00Z",
  verdict: v,
  reasons: [],
});
const response = (over: Partial<IncidentResponse>): IncidentResponse => ({
  phase: "veto",
  round: 2,
  maxRounds: 2,
  agents: [],
  actionRuns: [],
  costUsd: 0,
  ownerTouched: false,
  next: { kind: "working", detail: "" },
  ledger: [],
  droppedLedger: 0,
  startedAt: "2026-10-20T10:45:00Z",
  updatedAt: "2026-10-20T12:00:00Z",
  ...over,
});

test("newest investigator cause with provenance", () => {
  const r = response({
    agents: [
      inv(1, "Old idea"),
      inv(2, "The upstream wants the app's own user agent", [
        { text: "x", source: "notes/cause.md" },
        { text: "y", source: "https://www.example.test/acme/db-info/issues/3" },
      ]),
      run({ role: "verifier", round: 2 }),
    ],
    verdict: verdict(2, "certain"),
  });
  expect(causeOf(r)).toEqual({
    text: "The upstream wants the app's own user agent",
    source: {
      label: "example.test/acme/db-info",
      url: "https://www.example.test/acme/db-info/issues/3",
    },
    status: "verified",
  });
  expect(causeOf({ ...r, verdict: verdict(1, "certain") })?.status).toBe(
    "unverified",
  );
  expect(causeOf({ ...r, verdict: verdict(2, "not-certain") })?.status).toBe(
    "doubted",
  );
  expect(causeOf({ ...r, verdict: undefined })?.status).toBe("unverified");
  expect(causeOf(undefined)).toBeNull();
  expect(causeOf(response({ agents: [inv(1, "  ")] }))).toBeNull();
  expect(causeOf(response({ agents: [run({})] }))).toBeNull();
});

test("an empty newer cause does not hide an older one", () => {
  expect(
    causeOf(response({ agents: [inv(1, "First cause"), inv(2, "")] }))?.text,
  ).toBe("First cause");
});

test("non-http sources are not links", () => {
  const r = response({
    agents: [inv(1, "Cause", [{ text: "x", source: "javascript:alert(1)" }])],
  });
  expect(causeOf(r)?.source).toBeUndefined();
});

test("source labels", () => {
  expect(sourceLabel("https://www.example.test/acme/db-info/issues/3")).toBe(
    "example.test/acme/db-info",
  );
  expect(sourceLabel("https://example.test/")).toBe("example.test");
  const long = sourceLabel(
    `https://docs.example.test/${"a".repeat(30)}/${"b".repeat(30)}`,
  );
  expect(long).toHaveLength(40);
  expect(long.endsWith("…")).toBe(true);
});
