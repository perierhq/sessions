import { expect, test } from "bun:test";
import type { ReportProblem } from "../../../shared/incident-response";
import {
  REPORT_FENCE,
  plainReportProblem,
  checkKnowledge,
  effectiveVerdict,
  extractReportBlock,
  parseInvestigatorReport,
  parseVerifierReport,
  reportFindingsInput,
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
  ).toMatchObject({
    error: "End with exactly one incident-report block",
    problem: "unreadable",
  });
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
  expect(
    parseInvestigatorReport(`${fence(good)}\n${filler}`, ctx),
  ).toMatchObject({ error: "No incident-report block", problem: "missing" });
  expect(
    parseInvestigatorReport(
      fence({ ...good, cause: "y".repeat(70 * 1024) }),
      ctx,
    ),
  ).toMatchObject({
    error: "The incident-report block is too large",
    problem: "unreadable",
  });
});
test("a report's own error key is just an unknown key", () => {
  const r = parseInvestigatorReport(fence({ ...good, error: "x" }), ctx);
  expect("role" in r && r.role).toBe("investigator");
});
test("the findings key is read raw and the report still parses", () => {
  const findings = {
    blocks: [
      { id: "unknown", kind: "question", text: "Why only some users?" },
      { id: "when", keep: true },
    ],
  };
  const withFindings = fence({ ...good, findings });
  const without = parseInvestigatorReport(fence(good), ctx);
  expect(parseInvestigatorReport(withFindings, ctx)).toEqual(without);
  expect(reportFindingsInput(withFindings)).toEqual(findings);
  // Any JSON value is passed on raw, for the validator to judge.
  expect(reportFindingsInput(fence({ ...good, findings: "x" }))).toBe("x");
  expect(reportFindingsInput(fence(good))).toBeUndefined();
  expect(
    reportFindingsInput(`${withFindings}\n\n${withFindings}`),
  ).toBeUndefined();
  expect(reportFindingsInput("no block")).toBeUndefined();
  expect(
    reportFindingsInput("```incident-report\n{not json\n```"),
  ).toBeUndefined();
  expect(reportFindingsInput("```incident-report\n[1]\n```")).toBeUndefined();
  const huge = fence({
    ...good,
    findings,
    pad: "x".repeat(64 * 1024),
  });
  expect(reportFindingsInput(huge)).toBeUndefined();
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
  ["no block", "just text", "No incident-report block", "missing"],
  [
    "bad json",
    "```incident-report\n{nope\n```",
    "not valid JSON",
    "unreadable",
  ],
  [
    "not an object",
    "```incident-report\n[1]\n```",
    "JSON object",
    "unreadable",
  ],
  ["no summary", fence({ ...good, summary: "" }), "summary", "conclusion"],
  ["no cause", fence({ ...good, cause: undefined }), "cause", "conclusion"],
  [
    "empty table",
    fence({ ...good, attempts: [] }),
    "The evidence table is empty",
    "evidence",
  ],
  [
    "no usable row",
    fence({ ...good, attempts: [{ cost: "free", evidence: "x" }, "row"] }),
    "No row of attempts has a step",
    "evidence",
  ],
  [
    "no candidate decision",
    fence({ ...good, candidate: undefined }),
    "Set candidate",
    "decision",
  ],
  [
    "unclear pr flag",
    fence({ ...good, candidate: { pr: "maybe", actions: [] } }),
    "candidate.pr",
    "decision",
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
    "check",
  ],
  [
    "no check for a candidate",
    fence({ ...good, check: undefined }),
    "check field",
    "check",
  ],
  [
    "unknown action",
    fence({ ...good, candidate: { pr: false, actions: ["scale-up"] } }),
    'Unknown action "scale-up"',
    "action",
  ],
  [
    "deploy without the PR",
    fence({ ...good, candidate: { pr: false, actions: ["deploy"] } }),
    "Deploy runs only with the PR",
    "action",
  ],
  [
    "empty candidate",
    fence({ ...good, candidate: { pr: false, actions: [] } }),
    "candidate",
    "decision",
  ],
  [
    "note path with a candidate",
    fence({ ...good, notePath: "notes.md" }),
    "notePath",
    "note",
  ],
])("rejects %s", (_name, text, message, problem) => {
  expect(parseInvestigatorReport(text, ctx)).toMatchObject({
    error: expect.stringContaining(message),
    problem: problem as ReportProblem,
  });
});
test("request checks need an http signal", () => {
  expect(
    parseInvestigatorReport(fence(good), { ...ctx, signalOrigin: null }),
  ).toMatchObject({
    error: "A request check needs an http signal",
    problem: "check",
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
  expect(parseVerifierReport(fence(v), { claims })).toMatchObject({
    error: 'Check every claim: missing "B"',
    problem: "claims",
  });
  expect(
    parseVerifierReport(fence({ ...v, verdict: undefined }), { claims }),
  ).toMatchObject({
    error:
      'The verdict field must be certain or not-certain; Check every claim: missing "B"',
    problem: "conclusion",
  });
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
  ).toMatchObject({
    error:
      "A request check must use GET or HEAD unless the signal sends that method to that path",
    problem: "check",
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
  ).toMatchObject({ error: expect.stringContaining("GET or HEAD") });
});
test("a candidate needs claims; a source outside the table is dropped", () => {
  expect(
    parseInvestigatorReport(fence({ ...good, claims: [] }), ctx),
  ).toMatchObject({
    error: "Give at least one claim for the candidate",
    problem: "claims",
  });
  const warnings: string[] = [];
  const uncited = parseInvestigatorReport(
    fence({
      ...good,
      claims: [{ text: "x", source: "https://elsewhere.example.test/" }],
    }),
    { ...ctx, warnings },
  );
  expect("error" in uncited ? uncited.error : uncited.claims).toEqual([
    { text: "x" },
  ]);
  expect(warnings).toEqual([
    "Claim 1 cites a source that is not in the evidence table; dropped the source",
  ]);
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
test("the cause keeps its paragraphs and inline code", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      cause:
        "The upstream refuses the default client.  \r\n\r\n\r\n\n- `curl -A app` gets 200\t\n- the default gets 403",
    }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.cause).toBe(
    "The upstream refuses the default client.\n\n- `curl -A app` gets 200\n- the default gets 403",
  );
});
test("claim texts keep inline code; the verifier's plain quotes still match", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      claims: [{ ...good.claims[0], text: "Run `curl -A app` and see 200" }],
    }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.claims[0]?.text).toBe("Run `curl -A app` and see 200");
  // The verifier reads claims from a data block, where backticks are quotes.
  for (const quoted of [
    "Run `curl -A app` and see 200",
    "Run 'curl -A app' and see 200",
  ]) {
    const v = parseVerifierReport(
      fence({
        role: "verifier",
        verdict: "certain",
        reasons: [],
        proofAccepted: true,
        claims: [{ text: quoted, status: "verified", evidence: "seen" }],
      }),
      { claims: r.claims },
    );
    expect("error" in v ? v.error : v.claims[0]?.text).toBe(
      "Run `curl -A app` and see 200",
    );
  }
});

const searchLogs = {
  title: "Give it the search service's logs",
  why: "The cause is only in logs it cannot reach",
  kind: "open-settings",
  payload: "access",
};
const askAgain = {
  title: "Check the proxy's 407s first",
  why: "A 407 is the cheapest of the three to rule out",
  kind: "send-back",
  payload: "Look at the proxy's 407 responses before the 452s and 429s.",
};
const providerSide = {
  title: "Close as the provider's problem",
  why: "Every candidate is on the provider's side",
  kind: "close-provider",
};

test("keeps valid next steps in order", () => {
  const r = parseInvestigatorReport(
    fence({ ...good, nextSteps: [searchLogs, askAgain, providerSide] }),
    ctx,
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.nextSteps).toEqual([
    {
      kind: "open-settings",
      title: searchLogs.title,
      why: searchLogs.why,
      payload: "access",
    },
    {
      kind: "send-back",
      title: askAgain.title,
      why: askAgain.why,
      payload: askAgain.payload,
    },
    {
      kind: "close-provider",
      title: providerSide.title,
      why: providerSide.why,
    },
  ]);
});

test("a report without next steps has none", () => {
  const r = parseInvestigatorReport(fence({ ...good, nextSteps: [] }), ctx);
  if ("error" in r) throw new Error(r.error);
  expect(r).not.toHaveProperty("nextSteps");
});

test("an unknown kind or target is dropped, not the report", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(
    fence({
      ...good,
      nextSteps: [
        { title: "Raise the budget", kind: "raise-budget", payload: "100" },
        { ...searchLogs, payload: "billing" },
        { ...searchLogs, title: "" },
        "Pause the worker",
        { ...askAgain, extra: 1 },
      ],
    }),
    { ...ctx, warnings },
  );
  if ("error" in r) throw new Error(r.error);
  expect(r.nextSteps?.map((s) => s.kind)).toEqual(["send-back"]);
  expect(r.nextSteps?.[0]).not.toHaveProperty("extra");
  expect(warnings).toEqual([
    'Next step 1 (Raise the budget) had kind "raise-budget", not one of send-back, open-settings, close-provider; dropped',
    `Next step 2 (${searchLogs.title}) opens "billing", not one of access, production, signals, models, sandbox; dropped`,
    "Next step 3 had no title; dropped",
    "Next step 4 was not an object; dropped",
  ]);
});

test("next steps past three are dropped, and long text is cut", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(
    fence({
      ...good,
      nextSteps: [
        { ...askAgain, title: "x".repeat(200), why: "y\n".repeat(300) },
        { ...askAgain, payload: undefined },
        { ...searchLogs, payload: " Production " },
        providerSide,
        providerSide,
      ],
    }),
    { ...ctx, warnings },
  );
  if ("error" in r) throw new Error(r.error);
  const steps = r.nextSteps ?? [];
  expect(steps).toHaveLength(3);
  expect(steps[0]!.title).toHaveLength(60);
  expect(steps[0]!.title.endsWith("…")).toBe(true);
  expect(steps[0]!.why.length).toBeLessThanOrEqual(200);
  expect(steps[0]!.why).not.toContain("\n");
  // A send-back without a note sends its title.
  expect(steps[1]).toMatchObject({
    kind: "send-back",
    payload: askAgain.title,
  });
  expect(steps[2]).toMatchObject({
    kind: "open-settings",
    payload: "production",
  });
  expect(warnings).toEqual(["Only 3 next steps are kept; dropped 2 more"]);
});

test("next steps that are not a list never refuse the report", () => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(
    fence({ ...good, nextSteps: { kind: "send-back" } }),
    { ...ctx, warnings },
  );
  if ("error" in r) throw new Error(r.error);
  expect(r).not.toHaveProperty("nextSteps");
  expect(warnings).toEqual(["nextSteps was not a list; dropped"]);
});

test("the verifier's report never carries next steps", () => {
  const r = parseVerifierReport(
    fence({
      role: "verifier",
      verdict: "certain",
      reasons: [],
      proofAccepted: false,
      claims: [{ text: "A", status: "verified", evidence: "seen" }],
      nextSteps: [askAgain],
    }),
    { claims: [{ text: "A" }] },
  );
  if ("error" in r) throw new Error(r.error);
  expect(r).not.toHaveProperty("nextSteps");
});

// Rules that used to refuse a report and now repair it with a warning.
const parsedWith = (report: unknown) => {
  const warnings: string[] = [];
  const r = parseInvestigatorReport(fence(report), { ...ctx, warnings });
  if ("error" in r) throw new Error(r.error);
  return { r, warnings };
};

test("attempts out of cost order are sorted cheapest-first, never refused", () => {
  const { r, warnings } = parsedWith({
    ...good,
    attempts: [
      { ...good.attempts[1], step: "Cheap one" },
      { ...good.attempts[0], step: "Free one" },
      { ...good.attempts[1], step: "Expensive one", cost: "expensive" },
      { ...good.attempts[0], step: "Free two" },
    ],
  });
  expect(r.attempts.map((a) => `${a.cost} ${a.step}`)).toEqual([
    "free Free one",
    "free Free two",
    "cheap Cheap one",
    "expensive Expensive one",
  ]);
  expect(warnings).toEqual([
    "The attempts were not cheapest-first; sorted by cost",
  ]);
});

test("costs are matched loosely; an unknown cost is recorded as expensive", () => {
  const { r, warnings } = parsedWith({
    ...good,
    attempts: [
      { ...good.attempts[0], cost: " Free " },
      { ...good.attempts[1], cost: "LOW" },
      { ...good.attempts[1], step: "Odd", cost: "medium" },
    ],
  });
  expect(r.attempts.map((a) => a.cost)).toEqual(["free", "cheap", "expensive"]);
  expect(warnings).toEqual([
    'Attempt 3 (Odd) had cost "medium", not one of free, cheap, expensive; recorded as expensive',
  ]);
});

test("repeated, stepless and long attempts are repaired", () => {
  const { r, warnings } = parsedWith({
    ...good,
    attempts: [
      good.attempts[0],
      good.attempts[0],
      { cost: "free", result: "confirmed", evidence: "No step" },
      { ...good.attempts[1], step: "s".repeat(250), evidence: "" },
    ],
  });
  expect(r.attempts).toHaveLength(2);
  expect(r.attempts[1].step).toHaveLength(200);
  expect(r.attempts[1].step).toEndWith("\u2026");
  expect(r.attempts[1].evidence).toBe("No evidence given.");
  expect(warnings).toEqual([
    "Attempt 2 (Read earlier notes) repeated an earlier attempt; dropped",
    "Attempt 3 had no step; dropped",
    "Attempt 4's step was longer than 200 characters; cut",
    `Attempt 4 (${"s".repeat(199)}\u2026) had no evidence`,
  ]);
});

test("a bad attempt source is dropped, not the report", () => {
  const { r, warnings } = parsedWith({
    ...good,
    attempts: [
      { ...good.attempts[0], source: "/etc/passwd" },
      good.attempts[1],
    ],
  });
  expect(r.attempts[0]).not.toHaveProperty("source");
  expect(warnings).toEqual([
    "Attempt 1 had a source that is not an http(s) URL or a repository path; dropped the source",
  ]);
});

test("a long summary or cause is cut", () => {
  const { r, warnings } = parsedWith({
    ...good,
    summary: "s".repeat(300),
    cause: "c".repeat(1200),
  });
  expect(r.summary).toHaveLength(200);
  expect(r.cause).toHaveLength(1000);
  expect(warnings).toEqual([
    "summary was longer than 200 characters; cut",
    "cause was longer than 1000 characters; cut",
  ]);
});

test("role, readFirst and runbookPaths are repaired, not refused", () => {
  const { r, warnings } = parsedWith({
    ...good,
    role: "verifier",
    readFirst: [
      { path: "./docs/incidents/runbook.md", found: "yes" },
      { path: "docs/incidents/runbook.md", found: true },
      { path: "README.md" },
    ],
    runbookPaths: ["docs/runbook.md"],
  });
  expect(r.readFirst).toEqual([
    { path: "docs/incidents/runbook.md", found: true },
  ]);
  expect(r.runbookPaths).toEqual(["docs/incidents/runbook.md"]);
  expect(warnings).toEqual([
    'role was "verifier"; read as investigator',
    "readFirst entry 2 (docs/incidents/runbook.md) was listed twice; kept once",
    "readFirst entry 3 needs a path and found; dropped",
    'runbookPaths "docs/runbook.md" is not docs/incidents/runbook.md or docs/incidents/runbooks/<slug>.md; dropped',
    "runbookPaths named no runbook; read as docs/incidents/runbook.md",
  ]);
  const unread = parsedWith({ ...good, readFirst: undefined });
  expect(unread.r.readFirst).toEqual([]);
  expect(unread.warnings).toEqual([
    "readFirst was missing",
    "readFirst did not list docs/incidents/runbook.md",
  ]);
});

test("repeated actions, a deploy beside the PR and action case are repaired", () => {
  const { r, warnings } = parsedWith({
    ...good,
    candidate: { pr: "true", actions: ["Rollback", "rollback", "deploy"] },
  });
  expect(r.candidate).toEqual({ pr: true, actions: ["rollback"] });
  expect(warnings).toEqual([
    'candidate.pr was "true"; read as true',
    'Action "Rollback" read as "rollback"',
    'Action "rollback" was listed twice; kept once',
    'Action "deploy" is a deploy, which runs with the PR; dropped from the actions',
  ]);
});

test("without a candidate, the reason, check and note are not required", () => {
  const { r, warnings } = parsedWith({
    ...good,
    candidate: null,
    check: { kind: "request", source: { kind: "http", url: "http://x.test" } },
    notePath: "notes.md",
    claims: [],
  });
  expect(r.noCandidateReason).toBeUndefined();
  expect(r.check).toEqual({
    kind: "after-deploy",
    reason: "No fix was proposed.",
  });
  expect(r.notePath).toBe("");
  expect(warnings).toEqual([
    "noCandidateReason was missing; the cause stands in for it",
    "Ignored the check, as there is no candidate: A request check must use the signal's own origin https://acme.example.test",
    'notePath "notes.md" is not docs/incidents/YYYY-MM-DD-<slug>.md; ignored, as there is no candidate',
  ]);
});

test("an after-deploy check kind is matched loosely and its reason filled in", () => {
  const { r, warnings } = parsedWith({
    ...good,
    check: { kind: "After_Deploy" },
  });
  expect(r.check).toEqual({ kind: "after-deploy", reason: "No reason given." });
  expect(warnings).toEqual(["check.reason was missing"]);
});

test("claims: a lone claim, bad sources and repeats are repaired", () => {
  const { r, warnings } = parsedWith({
    ...good,
    claims: {
      text: "Upstream returns 403 to the default user agent",
      source: "file:///etc/passwd",
    },
  });
  expect(r.claims).toEqual([
    { text: "Upstream returns 403 to the default user agent" },
  ]);
  expect(warnings).toEqual([
    "claims was not a list; read as a list of one",
    "Claim 1 had a source that is not an http(s) URL or a repository path; dropped the source",
  ]);
  const twice = parsedWith({
    ...good,
    claims: [good.claims[0], good.claims[0]],
  });
  expect(twice.r.claims).toEqual([good.claims[0]]);
  expect(twice.warnings).toEqual([
    "Claim 2 repeated an earlier claim; kept once",
  ]);
});

test("the verifier's report is repaired toward less certainty", () => {
  const claims = [
    { text: "Upstream returns 403." },
    { text: "B" },
    { text: "C" },
  ];
  const warnings: string[] = [];
  const v = parseVerifierReport(
    fence({
      role: "VERIFIER",
      verdict: "Not Certain",
      proofAccepted: "maybe",
      claims: [
        { text: "upstream  returns 403", status: "Verified", evidence: "seen" },
        { text: "B", status: "kinda", evidence: "half" },
        { text: "C", status: "verified" },
        { text: "C", status: "refuted", evidence: "no" },
        { text: "D", status: "verified", evidence: "extra" },
      ],
    }),
    { claims, warnings },
  );
  if ("error" in v) throw new Error(v.error);
  expect(v.verdict).toBe("not-certain");
  expect(v.reasons).toEqual(["The verifier gave no reason."]);
  expect(v.proofAccepted).toBe(false);
  expect(v.claims.map((c) => [c.text, c.status])).toEqual([
    ["Upstream returns 403.", "verified"],
    ["B", "unverifiable"],
    ["C", "refuted"],
  ]);
  expect(warnings).toEqual([
    'verdict was "Not Certain"; read as not-certain',
    "A not-certain verdict gave no reason",
    'proofAccepted was "maybe"; read as false',
    'Claim 2 had status "kinda", not one of verified, refuted, unverifiable; recorded as unverifiable',
    "Claim 3 had no evidence; recorded as unverifiable",
    "Claim 4 ruled on a claim twice; kept the less certain ruling",
    'Claim 5 ("D") is not one of the listed claims; dropped',
  ]);
  const unknown = parseVerifierReport(
    fence({
      verdict: "probably",
      reasons: ["Looks fine"],
      proofAccepted: true,
      claims: claims.map((c) => ({ ...c, status: "verified", evidence: "x" })),
    }),
    { claims },
  );
  expect("error" in unknown ? unknown.error : unknown.verdict).toBe(
    "not-certain",
  );
});

test("a refused report reads plainly for the owner", () => {
  expect(plainReportProblem("investigator", "conclusion")).toBe(
    "The investigator's report was missing its conclusion. Try again so it finishes the report.",
  );
  expect(plainReportProblem("investigator", "missing")).toBe(
    "The investigator finished without writing its report. Try again so it writes one.",
  );
  expect(plainReportProblem("investigator", "pr")).toBe(
    "The investigator proposed a fix but did not open a pull request. Try again so it opens one.",
  );
  expect(plainReportProblem("investigator", undefined)).toBe(
    "The investigator's report could not be used. Try again so it finishes the report.",
  );
  expect(plainReportProblem("verifier", "claims")).toBe(
    "The verifier's report did not rule on every claim",
  );
  expect(plainReportProblem("verifier", "pr")).toBe(
    "The verifier did not return a valid report",
  );
  for (const problem of [
    "missing",
    "unreadable",
    "conclusion",
    "evidence",
    "decision",
    "action",
    "check",
    "claims",
    "note",
    "pr",
  ] as const) {
    const copy = plainReportProblem("investigator", problem);
    expect(copy).toStartWith("The investigator");
    expect(copy).toMatch(/try again/i);
    expect(copy).not.toMatch(/incident-report|field|\[|attempts/);
  }
});

test("a refused report names every problem at once", () => {
  const r = parseInvestigatorReport(
    fence({
      ...good,
      summary: "",
      cause: " ",
      attempts: [],
      candidate: { pr: false, actions: ["scale-up", "restart-all"] },
      check: undefined,
      claims: [],
      notePath: "notes.md",
    }),
    ctx,
  );
  if (!("error" in r)) throw new Error("accepted");
  expect(r.issues.map((i) => i.rule)).toEqual([
    "summary",
    "cause",
    "attempts",
    "actions",
    "check",
    "claims",
    "note",
  ]);
  expect(r.issues[3]?.error).toBe('Unknown actions "scale-up", "restart-all"');
  // The first problem is the one the owner is told about.
  expect(r.problem).toBe("conclusion");
  expect(r.error).toBe(r.issues.map((i) => i.error).join("; "));
  // A candidate was meant, so a missing pull request belongs in the list.
  expect(r.candidate).toBe(true);

  // Without a candidate, what only a candidate needs is not asked for.
  const none = parseInvestigatorReport(
    fence({ ...good, summary: "", candidate: null, claims: [] }),
    ctx,
  );
  expect(none).toMatchObject({
    issues: [{ rule: "summary", problem: "conclusion" }],
    candidate: false,
  });

  const claims = [{ text: "A" }, { text: "B" }, { text: "C" }];
  const v = parseVerifierReport(
    fence({
      role: "verifier",
      claims: [{ text: "A", status: "verified", evidence: "seen" }],
    }),
    { claims },
  );
  if (!("error" in v)) throw new Error("accepted");
  expect(v.issues).toEqual([
    {
      rule: "verdict",
      problem: "conclusion",
      error: "The verdict field must be certain or not-certain",
    },
    {
      rule: "rulings",
      problem: "claims",
      error: 'Check every claim: missing "B", "C"',
    },
  ]);
});
