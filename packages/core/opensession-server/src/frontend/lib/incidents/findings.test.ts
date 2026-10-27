import { expect, test } from "bun:test";
import {
  type ClaimRow,
  FINDINGS_COPY,
  type FindingBlock,
  type FindingsSet,
} from "../../../shared/findings";
import type {
  AgentRole,
  AgentRun,
  Claim,
  ClaimCheck,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { clockTime } from "../time";
import {
  changedKeys,
  type FindingItem,
  findingSpans,
  findingsPage,
  itemSource,
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

const POOL = "The pool is too small.";
const RETRIES = "Retries pile up on example.test.";

const hypothesis = (id: string, claims: string[]): FindingBlock => ({
  id,
  kind: "hypothesis",
  size: "full",
  statement: POOL,
  confidence: "medium",
  evidence: [],
  claims,
});

const verRun = (round: number, claims: ClaimCheck[], attempt = 1): AgentRun =>
  run({
    role: "verifier",
    round,
    attempt,
    sessionId: "os-ver",
    report: {
      role: "verifier",
      verdict: "not-certain",
      reasons: [],
      claims,
      proofAccepted: false,
    },
  });

test("hypothesis items carry the derived status", () => {
  const sets = [
    set("investigator", 1, [
      hypothesis("pool", [POOL]),
      hypothesis("both", [POOL, RETRIES]),
      hypothesis("none", []),
    ]),
  ];
  const statuses = (agents: AgentRun[], round = 1) =>
    findingsPage(open(response({ round, agents, findingSets: sets })))
      ?.items.filter((i) => i.block.kind === "hypothesis")
      .map((i) => i.status);

  const inv = invRun(1, [{ text: POOL }, { text: RETRIES }]);
  expect(statuses([inv])).toEqual(["unchecked", "unchecked", "unchecked"]);
  expect(
    statuses([
      inv,
      verRun(1, [
        {
          text: "the pool is too small",
          status: "verified",
          evidence: "40 slots",
        },
        { text: RETRIES, status: "refuted", evidence: "no retries" },
      ]),
    ]),
  ).toEqual(["verified", "refuted", "cant-tell"]);
  // Another round's verifier does not set this round's status.
  expect(
    statuses(
      [inv, verRun(2, [{ text: POOL, status: "verified", evidence: "x" }])],
      2,
    ),
  ).toEqual(["unchecked", "unchecked", "unchecked"]);
  // The newest verifier attempt with a report decides.
  expect(
    statuses([
      inv,
      verRun(1, [{ text: POOL, status: "refuted", evidence: "a" }], 1),
      verRun(1, [{ text: POOL, status: "verified", evidence: "b" }], 2),
    ]),
  ).toEqual(["verified", "cant-tell", "cant-tell"]);
});

test("claims items carry the rows", () => {
  const agents = [
    invRun(1, [{ text: POOL }, { text: RETRIES }]),
    verRun(1, [{ text: POOL, status: "verified", evidence: "saw it" }]),
  ];
  const rows: ClaimRow[] = [
    { text: POOL, status: "verified", evidence: "saw it" },
    { text: RETRIES, status: "unchecked" },
  ];
  const auto = findingsPage(
    open(
      response({
        agents,
        findingSets: [set("investigator", 1, [question("a")])],
      }),
    ),
  );
  expect(auto?.items.at(-1)?.key).toBe("auto:claims");
  expect(auto?.items.at(-1)?.claims).toEqual(rows);

  const placed = findingsPage(
    open(
      response({
        agents,
        findingSets: [
          set("investigator", 1, [question("a")]),
          set("verifier", 1, [{ id: "checks", kind: "claims", size: "full" }]),
        ],
      }),
    ),
  );
  expect(
    placed?.items.find((i) => i.key === "verifier:checks")?.claims,
  ).toEqual(rows);

  // A claims block placed before any report has no rows yet.
  const early = findingsPage(
    open(
      response({
        findingSets: [
          set("investigator", 1, [
            { id: "checks", kind: "claims", size: "full" },
          ]),
        ],
      }),
    ),
  );
  expect(early?.items[0]?.claims).toEqual([]);
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

test("an unchanged block keeps its key and gets no highlight", () => {
  const inc = open(
    response({
      findingSets: [
        set("investigator", 1, [question("a"), question("b")]),
        set("verifier", 1, [question("c")]),
      ],
    }),
  );
  const items = findingsPage(inc)!.items;
  expect(changedKeys(items, structuredClone(items)).size).toBe(0);

  // A new call rewrites the set's time: the bylines change, the blocks don't.
  const resent = findingsPage(
    open(
      response({
        findingSets: [
          set("investigator", 1, [question("a"), question("b")], {
            updatedAt: T("12:40"),
            calls: 2,
          }),
          set("verifier", 1, [question("c")]),
        ],
      }),
    ),
  )!.items;
  expect(resent.map((item) => item.key)).toEqual(
    items.map((item) => item.key),
  );
  expect(changedKeys(items, resent).size).toBe(0);

  const edited = structuredClone(items);
  const block = edited[0]!.block;
  if (block.kind === "question") block.text = "What changed in acme?";
  expect([...changedKeys(items, edited)]).toEqual(["investigator:a"]);

  const added: FindingItem[] = [
    ...structuredClone(items),
    { ...structuredClone(items[0]!), key: "investigator:new" },
  ];
  expect(changedKeys(items, added).has("investigator:new")).toBe(false);
  expect(changedKeys(null, items).size).toBe(0);
});

test("a block's source is its data: the quoted call, the PR, the first evidence that opens", () => {
  const tool = {
    type: "tool" as const,
    sessionId: "os-inv",
    useId: "toolu_1",
    resultId: "tr-toolu_1",
    tool: "Bash",
    at: T("12:05"),
    provenance: { kind: "shell" as const },
  };
  const pr = {
    type: "pr" as const,
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    sessionId: "os-inv",
  };
  const asItem = (block: FindingBlock): FindingItem => ({
    key: `investigator:${block.id}`,
    role: "investigator",
    block,
    span: "full",
    byline: "",
  });
  expect(
    itemSource(
      asItem({
        id: "errors",
        kind: "log",
        size: "full",
        source: tool,
        lines: ["ERROR acme db timeout"],
        highlight: [],
        dropped: 0,
      }),
    ),
  ).toEqual(tool);
  expect(
    itemSource(
      asItem({ id: "fix", kind: "change", size: "full", change: pr, why: "" }),
    ),
  ).toEqual(pr);
  expect(
    itemSource(
      asItem({
        id: "slow-db",
        kind: "hypothesis",
        size: "full",
        statement: "The pool is too small.",
        confidence: "medium",
        evidence: [
          { type: "observation", signal: "sig-a", at: T("12:05") },
          pr,
          tool,
        ],
        claims: [],
      }),
    ),
  ).toEqual(pr);
  expect(
    itemSource(
      asItem({
        id: "before-after",
        kind: "compare",
        size: "full",
        sides: [
          {
            label: "before",
            signal: { signalId: "sig-a", from: T("11:00"), to: T("12:00") },
          },
          {
            label: "after",
            log: {
              source: tool,
              lines: ["ERROR acme db timeout"],
              highlight: [],
              dropped: 0,
            },
          },
        ],
      }),
    ),
  ).toEqual(tool);
  expect(itemSource(asItem(question("q")))).toBeNull();
});
