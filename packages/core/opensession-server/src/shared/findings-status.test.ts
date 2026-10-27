import { expect, test } from "bun:test";
import { claimRows, hypothesisStatus, roundReports } from "./findings-status";
import type {
  AgentRun,
  ClaimCheck,
  InvestigatorReport,
  VerifierReport,
} from "./incident-response";

const T = "2026-10-27T12:00:00.000Z";

const investigator = (claims: string[]): InvestigatorReport => ({
  role: "investigator",
  summary: "",
  cause: "The acme pool is too small.",
  readFirst: [],
  attempts: [],
  candidate: null,
  check: { kind: "after-deploy", reason: "" },
  claims: claims.map((text) => ({ text })),
  notePath: "",
  runbookPaths: [],
});

const verifier = (claims: ClaimCheck[]): VerifierReport => ({
  role: "verifier",
  verdict: "not-certain",
  reasons: [],
  claims,
  proofAccepted: false,
});

const check = (
  text: string,
  status: ClaimCheck["status"],
  evidence = "",
): ClaimCheck => ({ text, status, evidence });

const run = (over: Partial<AgentRun>): AgentRun => ({
  role: "investigator",
  round: 1,
  attempt: 1,
  sessionId: "os-inv",
  model: "m",
  provider: "p",
  workspace: { kind: "sandbox", provider: "local" },
  accessSummary: "",
  accessRevision: "",
  status: "done",
  startedAt: T,
  turnSentAt: T,
  costUsd: 0,
  tokens: 0,
  reminded: false,
  ...over,
});

const A = "The acme pool is too small.";
const B = "Retries pile up on example.test.";

test("no verifier yet is unchecked", () => {
  expect(hypothesisStatus([A], undefined)).toBe("unchecked");
  expect(hypothesisStatus([], undefined)).toBe("unchecked");
});

test("all verified is verified; any refuted is refuted; the rest can't tell", () => {
  expect(
    hypothesisStatus(
      [A, B],
      verifier([check(A, "verified"), check(B, "verified")]),
    ),
  ).toBe("verified");
  expect(
    hypothesisStatus(
      [A, B],
      verifier([check(A, "verified"), check(B, "refuted")]),
    ),
  ).toBe("refuted");
  expect(
    hypothesisStatus(
      [A, B],
      verifier([check(A, "verified"), check(B, "unverifiable")]),
    ),
  ).toBe("cant-tell");
  expect(hypothesisStatus([A, B], verifier([check(A, "verified")]))).toBe(
    "cant-tell",
  );
  expect(hypothesisStatus([], verifier([check(A, "verified")]))).toBe(
    "cant-tell",
  );
});

test("claims match the way the verifier's quotes do", () => {
  expect(
    hypothesisStatus(
      ["The \u201cpool\u201d is small"],
      verifier([check('the "pool" is  small.', "verified")]),
    ),
  ).toBe("verified");
  expect(
    claimRows(
      investigator(["The \u2018pool\u2019 is small"]),
      verifier([check("the 'pool' IS small.", "refuted", "saw 40 slots")]),
    ),
  ).toEqual([
    {
      text: "The \u2018pool\u2019 is small",
      status: "refuted",
      evidence: "saw 40 slots",
    },
  ]);
});

test("claim rows follow the investigator's claims", () => {
  expect(
    claimRows(investigator([A, B]), verifier([check(A, "verified", "saw it")])),
  ).toEqual([
    { text: A, status: "verified", evidence: "saw it" },
    { text: B, status: "unchecked" },
  ]);
  expect(claimRows(investigator([A]), undefined)).toEqual([
    { text: A, status: "unchecked" },
  ]);
  expect(claimRows(undefined, verifier([check(A, "verified")]))).toEqual([]);
});

test("a check with no evidence leaves the row without it", () => {
  const [row] = claimRows(
    investigator([A]),
    verifier([check(A, "unverifiable")]),
  );
  expect(row).toEqual({ text: A, status: "unverifiable" });
  expect(row && "evidence" in row).toBe(false);
});

test("round reports take the newest attempt with a report", () => {
  const first = investigator([A]);
  const second = investigator([B]);
  const checks = verifier([check(B, "verified")]);
  const r = {
    agents: [
      run({ attempt: 1, report: first }),
      run({ attempt: 2, report: second, sessionId: "os-inv-2" }),
      run({ attempt: 3, sessionId: "os-inv-3", status: "running" }),
      run({ round: 2, attempt: 1, report: investigator(["later"]) }),
      run({ role: "verifier", sessionId: "os-ver", report: checks }),
    ],
  };
  expect(roundReports(r, 1)).toEqual({
    investigator: second,
    verifier: checks,
  });
  expect(roundReports(r, 3)).toEqual({});
  expect(roundReports(undefined, 1)).toEqual({});
});
