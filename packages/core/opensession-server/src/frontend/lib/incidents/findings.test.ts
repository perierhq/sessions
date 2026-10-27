import { expect, test } from "bun:test";
import {
  FINDINGS_COPY,
  type FindingBlock,
  type FindingsSet,
} from "../../../shared/findings";
import type {
  AgentRole,
  AgentRun,
  Claim,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { clockTime } from "../time";
import {
  findingSpans,
  findingsPage,
  sourceTarget,
  timelineRows,
} from "./findings";

const T = (hm: string) => `2026-10-27T${hm}:00.000Z`;

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
  startedAt: T("12:01"),
  turnSentAt: T("12:01"),
  costUsd: 0,
  tokens: 0,
  reminded: false,
  ...over,
});

const invRun = (round: number, claims: Claim[]): AgentRun =>
  run({
    round,
    report: {
      role: "investigator",
      summary: "",
      cause: "The pool is too small.",
      readFirst: [],
      attempts: [],
      candidate: null,
      check: { kind: "after-deploy", reason: "" },
      claims,
      notePath: "",
      runbookPaths: [],
    },
  });

const question = (
  id: string,
  size: "full" | "half" = "full",
): FindingBlock => ({
  id,
  kind: "question",
  size,
  text: `What about ${id}?`,
  wouldAnswer: "A look at the acme logs.",
});

const set = (
  role: AgentRole,
  round: number,
  blocks: FindingBlock[],
  over: Partial<FindingsSet> = {},
): FindingsSet => ({
  role,
  round,
  attempt: 1,
  sessionId: role === "investigator" ? "os-inv" : "os-ver",
  source: "tool",
  updatedAt: T("12:15"),
  calls: 1,
  blocks,
  notes: [],
  ...over,
});

const response = (over: Partial<IncidentResponse>): IncidentResponse => ({
  phase: "investigating",
  round: 1,
  maxRounds: 3,
  agents: [],
  actionRuns: [],
  costUsd: 0,
  ownerTouched: false,
  next: { kind: "working", detail: "" },
  ledger: [],
  droppedLedger: 0,
  startedAt: T("12:00"),
  updatedAt: T("12:00"),
  ...over,
});

type PageIncident = Pick<Incident, "state" | "response">;
const open = (r: IncidentResponse): PageIncident => ({
  state: "investigating",
  response: r,
});

const keys = (inc: PageIncident) =>
  findingsPage(inc)?.items.map((item) => item.key);

test("no sets, or only empty sets, give null", () => {
  expect(findingsPage({ state: "investigating" })).toBeNull();
  expect(findingsPage(open(response({})))).toBeNull();
  expect(
    findingsPage(
      open(
        response({
          findingSets: [set("investigator", 1, []), set("verifier", 1, [])],
        }),
      ),
    ),
  ).toBeNull();
});

test("investigator blocks come first, then the verifier's", () => {
  const inc = open(
    response({
      findingSets: [
        set("verifier", 1, [question("c")]),
        set("investigator", 1, [question("a"), question("b")]),
      ],
    }),
  );
  expect(keys(inc)).toEqual(["investigator:a", "investigator:b", "verifier:c"]);
});

test("round selection keeps the previous round until the new investigator shows findings", () => {
  const r1 = set("investigator", 1, [question("a")]);
  const first = findingsPage(open(response({ round: 2, findingSets: [r1] })));
  expect(first?.round).toBe(1);
  expect(first?.underWay).toBe(2);

  const verifierOnly = findingsPage(
    open(
      response({
        round: 2,
        findingSets: [r1, set("verifier", 2, [question("v")])],
      }),
    ),
  );
  expect(verifierOnly?.round).toBe(1);
  expect(verifierOnly?.underWay).toBe(2);

  const switched = findingsPage(
    open(
      response({
        round: 2,
        findingSets: [r1, set("investigator", 2, [question("b")])],
      }),
    ),
  );
  expect(switched?.round).toBe(2);
  expect(switched?.underWay).toBeNull();
  expect(switched?.items.map((i) => i.key)).toEqual(["investigator:b"]);
});

test("closed incident never says under way", () => {
  const page = findingsPage({
    state: "resolved",
    response: response({
      round: 2,
      findingSets: [set("investigator", 1, [question("a")])],
    }),
  });
  expect(page?.round).toBe(1);
  expect(page?.underWay).toBeNull();
});

test("earlier rounds are listed for details", () => {
  const inc = open(
    response({
      round: 2,
      findingSets: [
        set("investigator", 1, [question("a")]),
        set("investigator", 2, [question("b")]),
      ],
    }),
  );
  expect(findingsPage(inc)?.earlierRounds).toEqual([1]);

  const earlier = findingsPage(inc, { round: 1 });
  expect(earlier?.round).toBe(1);
  expect(earlier?.underWay).toBeNull();
  expect(earlier?.items.map((i) => i.key)).toEqual(["investigator:a"]);
});

test("an automatic claims block is added when the report has claims", () => {
  const claims = [
    { text: "The pool is too small." },
    { text: "Retries pile up." },
  ];
  const withClaims = findingsPage(
    open(
      response({
        agents: [invRun(1, claims)],
        findingSets: [set("investigator", 1, [question("a")])],
      }),
    ),
  );
  expect(withClaims?.items.at(-1)).toMatchObject({
    key: "auto:claims",
    auto: true,
    block: { id: "claims", kind: "claims", size: "full" },
  });

  const placed = findingsPage(
    open(
      response({
        agents: [invRun(1, claims)],
        findingSets: [
          set("investigator", 1, [question("a")]),
          set("verifier", 1, [{ id: "checks", kind: "claims", size: "full" }]),
        ],
      }),
    ),
  );
  expect(placed?.items.map((i) => i.key)).toEqual([
    "investigator:a",
    "verifier:checks",
  ]);

  const none = findingsPage(
    open(
      response({
        agents: [invRun(1, [])],
        findingSets: [set("investigator", 1, [question("a")])],
      }),
    ),
  );
  expect(none?.items.map((i) => i.key)).toEqual(["investigator:a"]);
});

test("hypothesis and claims items carry D1's placeholders", () => {
  const page = findingsPage(
    open(
      response({
        agents: [invRun(1, [{ text: "The pool is too small." }])],
        findingSets: [
          set("investigator", 1, [
            {
              id: "h",
              kind: "hypothesis",
              size: "full",
              statement: "The pool is too small.",
              confidence: "medium",
              evidence: [],
              claims: ["The pool is too small."],
            },
          ]),
        ],
      }),
    ),
  );
  expect(page?.items[0]?.status).toBe("unchecked");
  expect(page?.items[1]?.claims).toEqual([]);
});

test("half blocks pair up; a lone half spans full", () => {
  expect(findingSpans(["half", "half", "full", "half", "full"])).toEqual([
    "half",
    "half",
    "full",
    "full",
    "full",
  ]);
  expect(findingSpans(["half", "half", "half"])).toEqual([
    "half",
    "half",
    "full",
  ]);
  const page = findingsPage(
    open(
      response({
        findingSets: [
          set("investigator", 1, [question("a", "half")]),
          set("verifier", 1, [question("b", "half")]),
        ],
      }),
    ),
  );
  expect(page?.items.map((i) => i.span)).toEqual(["half", "half"]);
});

test("bylines name the role and the set's time", () => {
  const verifier = set("verifier", 1, [question("c")], {
    updatedAt: T("14:32"),
  });
  const page = findingsPage(
    open(
      response({
        findingSets: [set("investigator", 1, [question("a")]), verifier],
      }),
    ),
  );
  expect(page?.items[0]?.byline).toBe(
    FINDINGS_COPY.byline("investigator", clockTime(T("12:15"))),
  );
  expect(page?.items[1]?.byline).toBe(
    FINDINGS_COPY.byline("verifier", clockTime(verifier.updatedAt)),
  );
});

test("timeline adds the incident's own anchors and sorts by time", () => {
  const block: Extract<FindingBlock, { kind: "timeline" }> = {
    id: "when",
    kind: "timeline",
    size: "full",
    events: [
      { at: T("12:10"), text: "Errors climb on api.example.test" },
      { at: T("12:03"), text: "Deploy of acme/web" },
    ],
  };
  const r = response({
    agents: [run({ startedAt: T("12:01") })],
    proof: {
      round: 1,
      at: T("12:20"),
      baseline: { samples: [], verdict: "fails" },
      candidate: { kind: "request", samples: [], verdict: "passes" },
    },
    merge: {
      ghRepo: "acme/web",
      number: 12,
      sha: "a".repeat(40),
      status: "merged",
      at: T("12:30"),
    },
  });
  const rows = timelineRows(block, { openedAt: T("12:00"), response: r }, 1);
  expect(rows.map((row) => row.text)).toEqual([
    "Incident opened",
    "Investigator started",
    "Deploy of acme/web",
    "Errors climb on api.example.test",
    "Proof measured",
    "Merged",
  ]);
  expect(rows.map((row) => row.anchor)).toEqual([
    true,
    true,
    false,
    false,
    true,
    true,
  ]);

  const refused = timelineRows(
    block,
    {
      openedAt: T("12:00"),
      response: {
        ...r,
        merge: { ...r.merge!, status: "refused" },
        proof: { ...r.proof!, round: 2 },
      },
    },
    1,
  );
  expect(refused.map((row) => row.text)).toEqual([
    "Incident opened",
    "Investigator started",
    "Deploy of acme/web",
    "Errors climb on api.example.test",
  ]);
});

test("show source opens the owner of the data", () => {
  const incident = { project: "acme", response: response({}) };
  expect(
    sourceTarget(
      {
        type: "tool",
        sessionId: "os-inv",
        useId: "toolu_1",
        resultId: "tr-toolu_1",
        tool: "Bash",
        at: T("12:05"),
        provenance: { kind: "shell" },
      },
      incident,
    ),
  ).toEqual({ kind: "session", sessionId: "os-inv" });
  const url = "https://github.com/acme/web/pull/12";
  expect(
    sourceTarget(
      { type: "pr", number: 12, url, sessionId: "os-inv" },
      incident,
    ),
  ).toEqual({ kind: "pr", repo: "acme", number: 12, url });
  expect(sourceTarget({ type: "ledger", id: "led_1" }, incident)).toEqual({
    kind: "ledger",
    id: "led_1",
  });
  expect(
    sourceTarget(
      { type: "observation", signal: "sig-a", at: T("12:05") },
      incident,
    ),
  ).toBeNull();
});
