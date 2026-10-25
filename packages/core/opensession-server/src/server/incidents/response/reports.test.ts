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
  actionIds: new Set(["rollback", "deploy"]),
  actionKinds: new Map([
    ["rollback", "rollback" as const],
    ["deploy", "deploy" as const],
  ]),
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
  ).toBeNull();
  expect(extractReportBlock('a\n```incident-report\n{"a":2}\n```')).toBe(
    '{"a":2}',
  );
  expect(extractReportBlock("````incident-report\n```inner```\n````")).toBe(
    "```inner```",
  );
});
test("exactly one report block, so quoted content cannot override it", () => {
  expect(
    parseInvestigatorReport(
      `${fence({ role: "investigator" })}\nlater\n${fence(good)}`,
      ctx,
    ),
  ).toEqual({ error: "End with exactly one incident-report block" });
  const r = parseInvestigatorReport(`Quoted earlier.\n${fence(good)}`, ctx);
  expect("error" in r ? r.error : r.candidate).toEqual({
    pr: true,
    actions: [],
  });
});
test("only the end of a long message is read, and blocks are bounded", () => {
  const filler = `${"x".repeat(1000)}\n`.repeat(300);
  const tail = parseInvestigatorReport(`${filler}${fence(good)}`, ctx);
  expect("error" in tail ? tail.error : tail.role).toBe("investigator");
  // A block that sits before the last 256 KB is not seen.
  expect(parseInvestigatorReport(`${fence(good)}\n${filler}`, ctx)).toEqual({
    error: "No incident-report block",
  });
  expect(
    parseInvestigatorReport(
      fence({ ...good, cause: "y".repeat(70 * 1024) }),
      ctx,
    ),
  ).toEqual({ error: "The incident-report block is too large" });
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
      attempts: [{ ...good.attempts[0], extra: 1 }, good.attempts[1]],
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
const reportWithResults = (...results: unknown[]) => ({
  ...good,
  attempts: results.map((result, i) => ({
    step: `Step ${i + 1}`,
    cost: "free",
    ...(result === undefined ? {} : { result }),
    evidence: "Looked at it",
  })),
  claims: [{ text: "A fact" }],
});
const withResults = (...results: unknown[]) =>
  fence(reportWithResults(...results));
test("a step that only gathered context is informative", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(withResults("informative", "confirmed"), {
    ...ctx,
    warnings,
  });
  if ("error" in r) throw new Error(r.error);
  expect(r.attempts.map((a) => a.result)).toEqual(["informative", "confirmed"]);
  expect(warnings).toEqual([]);
});
test("results are matched without case, spacing or underscores", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(
    withResults(
      "Ruled out",
      "ruled_out",
      " CONFIRMED ",
      "Inconclusive",
      "Informative",
      "context",
    ),
    { ...ctx, warnings },
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.attempts.map((a) => a.result)).toEqual([
    "ruled-out",
    "ruled-out",
    "confirmed",
    "inconclusive",
    "informative",
    "informative",
  ]);
  expect(r.attempts.map((a) => a.evidence)).toEqual(
    Array(6).fill("Looked at it"),
  );
  expect(warnings).toEqual([]);
});
test("an unknown result keeps the report, as inconclusive with a warning", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(
    withResults("confirmed", "partly-useful", undefined),
    { ...ctx, warnings },
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.attempts[0]).toEqual({
    step: "Step 1",
    cost: "free",
    result: "confirmed",
    evidence: "Looked at it",
  });
  expect(r.attempts[1]).toEqual({
    step: "Step 2",
    cost: "free",
    result: "inconclusive",
    evidence: 'Looked at it\n(Reported result: "partly-useful")',
  });
  expect(r.attempts[2]).toMatchObject({
    result: "inconclusive",
    evidence: "Looked at it\n(Reported result: none)",
  });
  expect(warnings).toEqual([
    'Attempt 2 (Step 2) had result "partly-useful", not one of ruled-out, confirmed, inconclusive, informative; recorded as inconclusive',
    "Attempt 3 (Step 3) had result none, not one of ruled-out, confirmed, inconclusive, informative; recorded as inconclusive",
  ]);
});
test("a repaired result stays within the evidence limit", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      attempts: [
        {
          ...good.attempts[0],
          result: "x".repeat(500),
          evidence: "e".repeat(1000),
        },
      ],
      claims: [{ text: "A fact" }],
    }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  const evidence = r.attempts[0].evidence;
  expect(evidence.length).toBe(1000);
  expect(evidence).toEndWith(`\n(Reported result: "${"x".repeat(59)}\u2026")`);
});
test("no warnings are kept from a report that is refused", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(
    fence({ ...reportWithResults("maybe"), notePath: "notes.md" }),
    { ...ctx, warnings },
  );
  expect(r).toMatchObject({ error: expect.stringContaining("notePath") });
  expect(warnings).toEqual([]);
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
    "deploy as an action",
    fence({ ...good, candidate: { pr: false, actions: ["deploy"] } }),
    "Deploy runs only with the PR",
  ],
  [
    "duplicate action",
    fence({
      ...good,
      candidate: { pr: false, actions: ["rollback", "rollback"] },
    }),
    'List each action once: "rollback"',
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
test("request checks read unless the signal itself sends that request", () => {
  const post = (url: string) =>
    fence({
      ...good,
      check: { kind: "request", source: { kind: "http", url, method: "POST" } },
    });
  expect(
    parseInvestigatorReport(post("https://acme.example.test/search"), ctx),
  ).toEqual({
    error:
      "A request check must use GET or HEAD unless the signal sends that method to that path",
  });
  const same = parseInvestigatorReport(
    post("https://acme.example.test/search?q=y"),
    { ...ctx, signalRequest: { method: "POST", path: "/search" } },
  );
  expect("error" in same ? same.error : same.check.kind).toBe("request");
  expect(
    parseInvestigatorReport(post("https://acme.example.test/admin"), {
      ...ctx,
      signalRequest: { method: "POST", path: "/search" },
    }),
  ).toEqual({ error: expect.stringContaining("GET or HEAD") });
});
test("a candidate needs claims, and each claim cites a source from the table", () => {
  expect(parseInvestigatorReport(fence({ ...good, claims: [] }), ctx)).toEqual({
    error: "Give at least one claim for the candidate",
  });
  expect(
    parseInvestigatorReport(
      fence({
        ...good,
        claims: [{ text: "x", source: "https://elsewhere.example.test/" }],
      }),
      ctx,
    ),
  ).toEqual({
    error: "Claim 1 cites a source that is not in the evidence table",
  });
  const none = parseInvestigatorReport(
    fence({
      ...good,
      candidate: null,
      noCandidateReason: "Needs a bigger plan",
      claims: [],
    }),
    ctx,
  );
  expect("error" in none ? none.error : none.claims).toEqual([]);
});
test("terminal escapes, bidi and zero-width characters are stripped", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      summary: "\u001b[31mUpstream\u001b[0m\u202e blocks\u200b us\nnow",
      cause: "Line one\u0007\r\nLine two\u2066",
    }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.summary).toBe("Upstream blocks us now");
  expect(r.cause).toBe("Line one\nLine two");
});
test("claim texts carry no backticks, so the verifier can quote them exactly", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      claims: [{ ...good.claims[0], text: "Run `curl -A app` and see 200" }],
    }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.claims[0]?.text).toBe("Run 'curl -A app' and see 200");
  const v = parseVerifierReport(
    fence({
      role: "verifier",
      verdict: "certain",
      reasons: [],
      proofAccepted: true,
      claims: [
        {
          text: "Run `curl -A app` and see 200",
          status: "verified",
          evidence: "seen",
        },
      ],
    }),
    { claims: r.claims },
  );
  expect("error" in v ? v.error : v.claims[0]?.status).toBe("verified");
});
