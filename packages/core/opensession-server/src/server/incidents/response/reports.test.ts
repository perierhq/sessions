import { expect, test } from "bun:test";
import {
  REPORT_FENCE,
  checkKnowledge,
  effectiveVerdict,
  extractReportBlock,
  parseInvestigatorReport,
  parseVerifierReport,
} from "./reports";

const fence = (o: unknown) =>
  `Done.\n\n\`\`\`incident-report\n${JSON.stringify(o)}\n\`\`\``;
const good = {
  role: "investigator",
  summary: "Upstream blocks our user agent",
  cause: "Bot protection rejects the default client.",
  readFirst: [{ path: "docs/incidents/runbook.md", found: true }],
  attempts: [
    {
      step: "Read earlier notes",
      cost: "free",
      result: "confirmed",
      evidence: "Same symptom on 2026-08-02",
    },
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
  notePath: "docs/incidents/2026-10-20-search-blocked.md",
  runbookPaths: ["docs/incidents/runbook.md"],
};
const ctx = {
  actionIds: new Set(["rollback"]),
  signalOrigin: "https://acme.example.test",
};

test("extracts only blocks tagged exactly incident-report", () => {
  expect(REPORT_FENCE).toBe("incident-report");
  expect(extractReportBlock("```json\n{}\n```")).toBeNull();
  expect(extractReportBlock("```incident-report-x\n{}\n```")).toBeNull();
  expect(
    extractReportBlock(
      'a\n```incident-report\n{"a":1}\n```\nb\n```incident-report\n{"a":2}\n```',
    ),
  ).toBe('{"a":2}');
  expect(extractReportBlock("````incident-report\n```inner```\n````")).toBe(
    "```inner```",
  );
});
test("parses the last report block", () => {
  const r = parseInvestigatorReport(
    `${fence({ role: "investigator" })}\nlater\n${fence(good)}`,
    ctx,
  );
  expect("error" in r ? r.error : r.candidate).toEqual({
    pr: true,
    actions: [],
  });
});
test("a report's own error key is just an unknown key", () => {
  const r = parseInvestigatorReport(fence({ ...good, error: "x" }), ctx);
  expect("role" in r && r.role).toBe("investigator");
});
test("drops unknown keys", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      extra: "x",
      attempts: [{ ...good.attempts[0], extra: 1 }],
    }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  expect(r).not.toHaveProperty("extra");
  expect(r.attempts[0]).not.toHaveProperty("extra");
  expect(r.check).toMatchObject({
    kind: "request",
    source: { url: "https://acme.example.test/search?q=x" },
  });
});
test.each([
  ["no block", "just text", "No incident-report block"],
  ["bad json", "```incident-report\n{nope\n```", "not valid JSON"],
  ["wrong role", fence({ ...good, role: "verifier" }), "role"],
  [
    "runbook not read",
    fence({ ...good, readFirst: [{ path: "README.md", found: true }] }),
    "readFirst",
  ],
  [
    "empty table",
    fence({ ...good, attempts: [] }),
    "The evidence table is empty",
  ],
  [
    "expensive first",
    fence({
      ...good,
      attempts: [{ ...good.attempts[1], cost: "expensive" }, good.attempts[0]],
    }),
    "Work cheapest-first: row 2 is free after expensive",
  ],
  [
    "foreign origin",
    fence({
      ...good,
      check: {
        kind: "request",
        source: { kind: "http", url: "http://127.0.0.1:8080/admin" },
      },
    }),
    "signal's own origin https://acme.example.test",
  ],
  [
    "unknown action",
    fence({ ...good, candidate: { pr: false, actions: ["scale-up"] } }),
    'Unknown action "scale-up"',
  ],
  [
    "empty candidate",
    fence({ ...good, candidate: { pr: false, actions: [] } }),
    "candidate",
  ],
  [
    "no candidate reason",
    fence({ ...good, candidate: null }),
    "noCandidateReason",
  ],
  ["note path", fence({ ...good, notePath: "notes.md" }), "notePath"],
  [
    "runbook path",
    fence({ ...good, runbookPaths: ["docs/runbook.md"] }),
    "runbookPaths",
  ],
  [
    "bad source",
    fence({ ...good, claims: [{ text: "x", source: "/etc/passwd" }] }),
    "source",
  ],
])("rejects %s", (_name, text, message) => {
  expect(parseInvestigatorReport(text, ctx)).toEqual({
    error: expect.stringContaining(message),
  });
});
test("request checks need an http signal", () => {
  expect(
    parseInvestigatorReport(fence(good), { ...ctx, signalOrigin: null }),
  ).toEqual({
    error: "A request check needs an http signal",
  });
  const after = parseInvestigatorReport(
    fence({
      ...good,
      candidate: null,
      noCandidateReason: "Needs a bigger plan",
      check: { kind: "after-deploy", reason: "Only shows in production" },
    }),
    { ...ctx, signalOrigin: null },
  );
  expect("error" in after ? after.error : after.noCandidateReason).toBe(
    "Needs a bigger plan",
  );
});
test("verifier must check every claim", () => {
  const claims = [{ text: "A" }, { text: "B" }];
  const v = {
    role: "verifier",
    verdict: "certain",
    reasons: [],
    proofAccepted: false,
    claims: [{ text: "A", status: "verified", evidence: "seen" }],
  };
  expect(parseVerifierReport(fence(v), { claims })).toEqual({
    error: 'Check every claim: missing "B"',
  });
  expect(
    parseVerifierReport(
      fence({
        ...v,
        verdict: "not-certain",
        claims: [
          ...v.claims,
          { text: "B", status: "verified", evidence: "seen" },
        ],
      }),
      { claims },
    ),
  ).toEqual({ error: expect.stringContaining("reasons") });
  const ok = parseVerifierReport(
    fence({
      ...v,
      claims: [...v.claims, { text: " B ", status: "refuted", evidence: "no" }],
    }),
    {
      claims,
    },
  );
  expect("error" in ok ? ok.error : ok.claims.map((c) => c.status)).toEqual([
    "verified",
    "refuted",
  ]);
});
test("effective verdict downgrades certainty Sessions cannot back", () => {
  const report = {
    role: "verifier" as const,
    verdict: "certain" as const,
    reasons: [],
    proofAccepted: false,
    claims: [
      { text: "A", status: "verified" as const, evidence: "x" },
      { text: "B", status: "unverifiable" as const, evidence: "no access" },
    ],
  };
  const proof = {
    round: 1,
    at: "x",
    baseline: { samples: [], verdict: "fails" as const },
    candidate: {
      kind: "request" as const,
      samples: [],
      verdict: "unclear" as const,
      refused: "Runner offline",
    },
  };
  expect(
    effectiveVerdict({
      report,
      proof,
      knowledge: { note: true, runbook: false },
    }),
  ).toEqual({
    verdict: "not-certain",
    reasons: [
      "Claim not verified: B",
      "The candidate check did not pass from production: Runner offline",
      "The runbook was not updated in the PR",
    ],
  });
  expect(
    effectiveVerdict({
      report: { ...report, claims: [report.claims[0]] },
      knowledge: { note: true, runbook: true },
      proof: {
        ...proof,
        candidate: { kind: "request", samples: [], verdict: "passes" },
      },
    }),
  ).toEqual({ verdict: "certain", reasons: [] });
  expect(
    effectiveVerdict({
      report: {
        ...report,
        verdict: "not-certain",
        reasons: ["Diff does not match"],
        claims: [report.claims[0]],
      },
      knowledge: { note: false, runbook: true },
      proof: {
        ...proof,
        baseline: { samples: [], verdict: "passes" },
        candidate: {
          kind: "after-deploy",
          samples: [],
          verdict: "after-deploy",
        },
      },
    }),
  ).toEqual({
    verdict: "not-certain",
    reasons: [
      "Diff does not match",
      "The baseline did not fail with the incident's signal",
      "The verifier did not accept proving this after release",
      "The incident note is missing from the PR",
    ],
  });
  expect(
    checkKnowledge(null, {
      notePath: "docs/incidents/2026-10-20-x.md",
      runbookPaths: ["docs/incidents/runbook.md"],
    }),
  ).toEqual({ note: false, runbook: false });
  expect(
    checkKnowledge(
      ["docs/incidents/2026-10-20-x.md", "docs/incidents/runbooks/search.md"],
      {
        notePath: "docs/incidents/2026-10-20-x.md",
        runbookPaths: [
          "docs/incidents/runbook.md",
          "docs/incidents/runbooks/search.md",
        ],
      },
    ),
  ).toEqual({ note: true, runbook: true });
});
