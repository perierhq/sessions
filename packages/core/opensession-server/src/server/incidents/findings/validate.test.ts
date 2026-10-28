import { describe, expect, test } from "bun:test";
import { FINDING_KINDS, type FindingBlock } from "../../../shared/findings";
import {
  parseRefInput,
  validateFindings,
  type ValidateContext,
} from "./validate";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const ctx: ValidateContext = { keepFrom: new Map(), nowMs: NOW };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function run(blocks: unknown[], c: ValidateContext = ctx) {
  return validateFindings({ blocks }, c);
}

/** The draft of the one block in `blocks`, or undefined when it was dropped. */
function only(blocks: unknown[]) {
  const out = run(blocks);
  const first = out.blocks[0];
  return {
    block: first && !first.kept ? first.block : undefined,
    notes: out.notes,
  };
}

const toolRef = { type: "tool", tool: "host_command" };

const FIXTURES: Record<
  (typeof FINDING_KINDS)[number],
  Record<string, unknown>
> = {
  hypothesis: {
    id: "slow-db",
    kind: "hypothesis",
    title: "The database is slow",
    statement: "The acme database pool is too small for the new traffic.",
    confidence: "medium",
    evidence: [{ type: "ledger", id: "led_1" }],
    claims: ["The pool is too small."],
  },
  timeline: {
    id: "when",
    kind: "timeline",
    events: [
      { at: iso(NOW - 2 * HOUR), text: "Release v1.2.0 went out" },
      {
        at: iso(NOW - HOUR),
        text: "Errors started",
        ref: { type: "observation", signal: "sig-a", at: iso(NOW - HOUR) },
      },
    ],
  },
  signal: {
    id: "window",
    kind: "signal",
    signal: "sig-a",
    lane: "p95",
    from: iso(NOW - 3 * HOUR),
    to: iso(NOW - HOUR),
    markers: [{ at: iso(NOW - 2 * HOUR), label: "deploy" }],
  },
  log: {
    id: "errors",
    kind: "log",
    source: toolRef,
    lines: ["ERROR db timeout on api.example.test"],
    highlight: [0],
  },
  change: {
    id: "deploy",
    kind: "change",
    pr: 42,
    why: "It lowered the pool size.",
  },
  claims: { id: "checks", kind: "claims" },
  compare: {
    id: "before-after",
    kind: "compare",
    sides: [
      {
        label: "before deploy",
        signal: {
          signal: "sig-a",
          from: iso(NOW - 4 * HOUR),
          to: iso(NOW - 2 * HOUR),
        },
      },
      {
        label: "after",
        log: { source: toolRef, lines: ["ERROR db timeout again"] },
      },
    ],
  },
  question: {
    id: "unknown",
    kind: "question",
    text: "Did traffic grow before the release?",
    wouldAnswer: "The load balancer's request counts for the last week.",
  },
};

const EXPECTED: Record<(typeof FINDING_KINDS)[number], unknown> = {
  hypothesis: {
    id: "slow-db",
    kind: "hypothesis",
    title: "The database is slow",
    size: "full",
    statement: "The acme database pool is too small for the new traffic.",
    confidence: "medium",
    evidence: [{ type: "ledger", id: "led_1" }],
    claims: ["The pool is too small."],
  },
  timeline: {
    id: "when",
    kind: "timeline",
    size: "full",
    events: [
      { at: iso(NOW - 2 * HOUR), text: "Release v1.2.0 went out" },
      {
        at: iso(NOW - HOUR),
        text: "Errors started",
        ref: { type: "observation", signal: "sig-a", at: iso(NOW - HOUR) },
      },
    ],
  },
  signal: {
    id: "window",
    kind: "signal",
    size: "full",
    signalId: "sig-a",
    lane: "p95",
    from: iso(NOW - 3 * HOUR),
    to: iso(NOW - HOUR),
    markers: [{ at: iso(NOW - 2 * HOUR), label: "deploy" }],
  },
  log: {
    id: "errors",
    kind: "log",
    size: "full",
    source: { type: "tool", tool: "host_command", nth: 1 },
    lines: ["ERROR db timeout on api.example.test"],
    highlight: [0],
    dropped: 0,
  },
  change: {
    id: "deploy",
    kind: "change",
    size: "full",
    change: { type: "pr", number: 42 },
    why: "It lowered the pool size.",
  },
  claims: { id: "checks", kind: "claims", size: "full" },
  compare: {
    id: "before-after",
    kind: "compare",
    size: "full",
    sides: [
      {
        label: "before deploy",
        signal: {
          signalId: "sig-a",
          from: iso(NOW - 4 * HOUR),
          to: iso(NOW - 2 * HOUR),
        },
      },
      {
        label: "after",
        log: {
          source: { type: "tool", tool: "host_command", nth: 1 },
          lines: ["ERROR db timeout again"],
          highlight: [],
          dropped: 0,
        },
      },
    ],
  },
  question: {
    id: "unknown",
    kind: "question",
    size: "full",
    text: "Did traffic grow before the release?",
    wouldAnswer: "The load balancer's request counts for the last week.",
  },
};

describe("validateFindings", () => {
  test("input must be an object with a blocks list", () => {
    expect(validateFindings("x", ctx)).toEqual({
      blocks: [],
      notes: ['Send {"blocks": [...]}.'],
      cleared: false,
    });
    expect(validateFindings({ blocks: "x" }, ctx).notes).toEqual([
      'Send {"blocks": [...]}.',
    ]);
    expect(validateFindings({ blocks: [] }, ctx)).toEqual({
      blocks: [],
      notes: [],
      cleared: true,
    });
  });

  test("a valid block of each kind passes unchanged", () => {
    const out = run(FINDING_KINDS.map((k) => FIXTURES[k]));
    expect(out.notes).toEqual([]);
    expect(out.cleared).toBe(false);
    expect(out.blocks).toHaveLength(8);
    expect(out.blocks.map((d) => d.kept)).toEqual(Array(8).fill(false));
    expect(out.blocks.map((d) => d.block)).toEqual(
      FINDING_KINDS.map((k) => EXPECTED[k]) as never,
    );
    const half = only([{ ...FIXTURES.question, size: "half" }]);
    expect(half.block?.size).toBe("half");
  });

  test("unknown kind is dropped with the kinds listed", () => {
    expect(only([{ id: "a", kind: "chart" }])).toEqual({
      block: undefined,
      notes: [
        'Block `a`: unknown kind "chart". Use one of: hypothesis, timeline, signal, log, change, claims, compare, question.',
      ],
    });
  });

  test("bad or duplicate ids", () => {
    expect(only([{ ...FIXTURES.claims, id: "Bad Id" }]).notes).toEqual([
      "Block 1: id must be lowercase letters, digits and dashes, at most 40.",
    ]);
    const out = run([
      { id: "a", kind: "claims" },
      { id: "a", kind: "question", text: "Why is acme slow today?" },
    ]);
    expect(out.blocks.map((d) => d.block.kind)).toEqual(["claims"]);
    expect(out.notes).toEqual([
      "Block `a`: the id is used twice; kept the first.",
    ]);
  });

  test("more than 12 blocks keeps the first 12", () => {
    const blocks = Array.from({ length: 13 }, (_, i) => ({
      id: `b${i + 1}`,
      kind: "claims",
    }));
    const out = run(blocks);
    expect(out.blocks.map((d) => d.block.id)).toEqual(
      blocks.slice(0, 12).map((b) => b.id),
    );
    expect(out.notes).toEqual(["Kept the first 12 blocks."]);
  });

  test("text is cleaned and clipped", () => {
    const title = only([
      { ...FIXTURES.claims, id: "a", title: "x".repeat(100) },
    ]);
    expect(title.block?.title).toHaveLength(80);
    expect(title.notes).toEqual(["Block `a`: title cut to 80 characters."]);

    const clean = only([
      { ...FIXTURES.hypothesis, statement: "\u001b[31mred\u001b[0m\u200b" },
    ]);
    expect(clean.block).toMatchObject({ statement: "red" });
    expect(clean.notes).toEqual([]);

    const why = only([{ ...FIXTURES.change, why: "w".repeat(700) }]);
    expect((why.block as { why: string }).why).toHaveLength(600);
    expect(why.notes).toEqual(["Block `deploy`: why cut to 600 characters."]);
  });

  test("hypothesis needs a statement and a confidence", () => {
    const { statement: _s, ...noStatement } = FIXTURES.hypothesis;
    const missing = only([noStatement]);
    expect(missing.block).toBeUndefined();
    expect(missing.notes).toEqual(["Block `slow-db`: statement is required."]);

    expect(
      only([{ ...FIXTURES.hypothesis, id: "h", confidence: "sure" }]),
    ).toEqual({
      block: undefined,
      notes: ["Block `h`: confidence must be low, medium or high."],
    });

    const claims = ["a1", "a2", "a3", "a4", "a5", "a6"].map(
      (c) => `Claim ${c} holds`,
    );
    const many = only([{ ...FIXTURES.hypothesis, id: "h", claims }]);
    expect((many.block as { claims: string[] }).claims).toEqual(
      claims.slice(0, 5),
    );
    expect(many.notes).toEqual(["Block `h`: kept the first 5 claims."]);
  });

  test("hypothesis evidence keeps the refs that parse", () => {
    const out = only([
      {
        ...FIXTURES.hypothesis,
        id: "h",
        evidence: [
          { type: "ledger", id: "led_1" },
          { type: "pr", number: "7" },
          ...Array.from({ length: 10 }, (_, i) => ({
            type: "event",
            id: `ev_${i}`,
          })),
        ],
      },
    ]);
    const evidence = (out.block as { evidence: unknown[] }).evidence;
    expect(evidence).toHaveLength(10);
    expect(evidence[0]).toEqual({ type: "ledger", id: "led_1" });
    expect(out.notes).toEqual([
      "Block `h`: evidence 2 left off: a pr reference needs a PR number.",
      "Block `h`: kept the first 10 evidence references.",
    ]);
  });

  test("timeline caps and needs times", () => {
    const events = Array.from({ length: 31 }, (_, i) => ({
      at: iso(NOW - (40 - i) * 60_000),
      text: `Event ${i + 1}`,
    }));
    const capped = only([{ id: "t", kind: "timeline", events }]);
    expect((capped.block as { events: unknown[] }).events).toHaveLength(30);
    expect(capped.notes).toEqual(["Block `t`: kept the first 30 events."]);

    const bad = only([
      {
        id: "t",
        kind: "timeline",
        events: [
          { at: "yesterday", text: "Something" },
          { at: iso(NOW - HOUR), text: "y".repeat(150) },
        ],
      },
    ]);
    const kept = (bad.block as { events: Array<{ text: string }> }).events;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toHaveLength(140);
    expect(bad.notes).toEqual([
      'Block `t`: event 1 dropped: "at" must be an ISO time.',
      "Block `t`: event 2 text cut to 140 characters.",
    ]);

    expect(only([{ id: "t", kind: "timeline", events: [] }]).notes).toEqual([
      "Block `t`: a timeline needs at least one event.",
    ]);
  });

  test("signal window must be real and is clamped to 31 days", () => {
    const base = { id: "w", kind: "signal", signal: "sig-a" };
    expect(
      only([{ ...base, from: iso(NOW - HOUR), to: iso(NOW - 2 * HOUR) }]),
    ).toEqual({
      block: undefined,
      notes: ['Block `w`: "to" must be after "from".'],
    });

    const long = only([{ ...base, from: iso(NOW - 40 * DAY), to: iso(NOW) }]);
    expect(long.block).toMatchObject({
      from: iso(NOW - 31 * DAY),
      to: iso(NOW),
      markers: [],
    });
    expect(long.notes).toEqual(["Block `w`: window cut to 31 days."]);

    expect(
      only([{ ...base, from: iso(NOW + HOUR), to: iso(NOW + 2 * HOUR) }]),
    ).toEqual({
      block: undefined,
      notes: ["Block `w`: the window is in the future."],
    });

    const markers = Array.from({ length: 11 }, (_, i) => ({
      at: iso(NOW - 2 * HOUR + i * 60_000),
      label: `m${i}`,
    }));
    const many = only([
      { ...base, from: iso(NOW - 3 * HOUR), to: iso(NOW - HOUR), markers },
    ]);
    expect((many.block as { markers: unknown[] }).markers).toHaveLength(10);
    expect(many.notes).toEqual(["Block `w`: kept the first 10 markers."]);
  });

  test("a marker may cite a release, an observation or an event", () => {
    const base = {
      id: "w",
      kind: "signal",
      signal: "sig-a",
      from: iso(NOW - 3 * HOUR),
      to: iso(NOW - HOUR),
    };
    const at = iso(NOW - 2 * HOUR);
    const out = only([
      {
        ...base,
        markers: [
          { at, label: "release", ref: { type: "release", at } },
          {
            at,
            label: "first error",
            ref: { type: "observation", signal: "sig-a", at },
          },
          { at, label: "paged", ref: { type: "event", id: "ev_1" } },
          { at, label: "guess" },
          { at, label: "a PR", ref: { type: "pr", number: 12 } },
          { at, label: "broken", ref: { type: "release" } },
        ],
      },
    ]);
    expect(
      (out.block as Extract<FindingBlock, { kind: "signal" }>).markers,
    ).toEqual([
      { at, label: "release", ref: { type: "release", at } },
      {
        at,
        label: "first error",
        ref: { type: "observation", signal: "sig-a", at },
      },
      { at, label: "paged", ref: { type: "event", id: "ev_1" } },
      { at, label: "guess" },
      { at, label: "a PR" },
      { at, label: "broken" },
    ]);
    expect(out.notes).toEqual([
      "Block `w`: marker 5 reference left off: a marker can cite a release, an observation or an event.",
      'Block `w`: marker 6 reference left off: a release reference needs "at" as an ISO time.',
    ]);
  });

  test("log caps lines and highlight", () => {
    const lines = Array.from({ length: 41 }, (_, i) => `line ${i} of acme`);
    const many = only([{ id: "l", kind: "log", source: toolRef, lines }]);
    expect((many.block as { lines: string[] }).lines).toEqual(
      lines.slice(0, 40),
    );
    expect(many.notes).toEqual(["Block `l`: kept the first 40 lines."]);

    const long = only([
      { id: "l", kind: "log", source: toolRef, lines: ["z".repeat(600)] },
    ]);
    expect((long.block as { lines: string[] }).lines[0]).toBe("z".repeat(500));
    expect(long.notes).toEqual(["Block `l`: line 1 cut to 500 characters."]);

    const hl = only([
      {
        id: "l",
        kind: "log",
        source: toolRef,
        lines: ["ERROR db timeout"],
        highlight: [0, 99],
      },
    ]);
    expect((hl.block as { highlight: number[] }).highlight).toEqual([0]);

    expect(
      only([
        {
          id: "l",
          kind: "log",
          source: { type: "ledger", id: "led_1" },
          lines: ["ERROR db timeout"],
        },
      ]),
    ).toEqual({
      block: undefined,
      notes: ['Block `l`: source must be a {"type":"tool"} reference.'],
    });
  });

  test("change needs exactly one of pr or commit", () => {
    expect(
      only([{ id: "c", kind: "change", pr: 4, commit: "abc1234", why: "x" }])
        .block,
    ).toBeUndefined();
    expect(
      only([{ id: "c", kind: "change", commit: "xyz", why: "x" }]),
    ).toEqual({
      block: undefined,
      notes: ["Block `c`: commit must be 7 to 40 hex characters."],
    });
    expect(
      only([{ id: "c", kind: "change", pr: 0, why: "x" }]).block,
    ).toBeUndefined();
    expect(
      only([{ id: "c", kind: "change", commit: "ABC1234DEF", why: "x" }]).block,
    ).toMatchObject({ change: { type: "commit", sha: "abc1234def" } });
  });

  test("a change may cite one file and a line in it", () => {
    expect(
      only([
        {
          id: "c",
          kind: "change",
          pr: 4,
          why: "x",
          file: "src/db.ts",
          line: 12,
        },
      ]),
    ).toEqual({
      block: {
        id: "c",
        kind: "change",
        size: "full",
        change: { type: "pr", number: 4 },
        why: "x",
        file: "src/db.ts",
        line: 12,
      },
      notes: [],
    });
    expect(
      only([{ id: "c", kind: "change", pr: 4, why: "x", file: "a\nb" }]),
    ).toMatchObject({
      block: { change: { type: "pr", number: 4 } },
      notes: ["Block `c`: file must be one path in the change; left out."],
    });
    const lineOnly = only([
      { id: "c", kind: "change", pr: 4, why: "x", line: 3 },
    ]);
    expect(lineOnly.block).not.toHaveProperty("line");
    expect(lineOnly.notes).toEqual([
      "Block `c`: line needs a file and a whole number from 1; left out.",
    ]);
  });

  test("compare needs two sides, each a signal or a log", () => {
    const [before, after] = FIXTURES.compare.sides as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(
      only([{ id: "c", kind: "compare", sides: [before] }]).block,
    ).toBeUndefined();
    expect(
      only([
        {
          id: "c",
          kind: "compare",
          sides: [before, { ...after, signal: before.signal }],
        },
      ]).block,
    ).toBeUndefined();
    const clipped = only([
      {
        id: "c",
        kind: "compare",
        sides: [{ ...before, label: "l".repeat(50) }, after],
      },
    ]);
    const sides = (clipped.block as { sides: Array<{ label: string }> }).sides;
    expect(sides[0]?.label).toHaveLength(40);
    expect(clipped.notes).toEqual([
      "Block `c`: side 1 label cut to 40 characters.",
    ]);
  });

  test("keep copies the stored block", () => {
    const stored: FindingBlock = {
      id: "a",
      kind: "question",
      size: "half",
      text: "Is acme's cache warm?",
      wouldAnswer: "",
    };
    const out = run(
      [
        { id: "a", keep: true },
        { id: "zz", keep: true },
      ],
      { keepFrom: new Map([["a", stored]]), nowMs: NOW },
    );
    expect(out.blocks).toEqual([{ kept: true, block: stored }]);
    expect(out.notes).toEqual(["Block `zz`: nothing to keep under that id."]);
  });
  test("notes are capped", () => {
    const out = run(Array.from({ length: 60 }, () => ({ id: "Bad Id" })));
    expect(out.notes).toHaveLength(41);
    expect(out.notes[39]).toBe(
      "Block 40: id must be lowercase letters, digits and dashes, at most 40.",
    );
    expect(out.notes[40]).toBe("…and 20 more.");
    // At the cap exactly, nothing is added.
    expect(
      run(Array.from({ length: 40 }, () => ({ id: "Bad Id" }))).notes,
    ).toHaveLength(40);
  });

  test("values repeated in notes are clipped", () => {
    const kind = "k".repeat(200);
    expect(only([{ id: "a", kind }]).notes).toEqual([
      `Block \`a\`: unknown kind "${"k".repeat(39)}…". Use one of: hypothesis, timeline, signal, log, change, claims, compare, question.`,
    ]);
    const type = `\u001b[31m${"t".repeat(100)}`;
    const ref = parseRefInput({ type });
    expect(ref).toBe(
      `unknown reference type "${"t".repeat(39)}…". Use one of: observation, ledger, event, action, release, pr, commit, tool, block.`,
    );
    const log = only([
      {
        id: "l",
        kind: "log",
        source: { type: "tool", tool: "Bash" },
        lines: ["acme-api ERROR pool exhausted"],
        highlight: [{ x: "h".repeat(100) }],
      },
    ]);
    const note = log.notes.find((n) => n.includes("highlight"));
    expect(note).toBe(
      `Block \`l\`: highlight ${JSON.stringify({ x: "h".repeat(100) }).slice(0, 39)}… is not one of the lines; ignored.`,
    );
  });

  test("clipping never splits a surrogate pair", () => {
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const title = only([
      {
        ...FIXTURES.claims,
        id: "a",
        title: `${"x".repeat(78)}\u{1F600}${"y".repeat(10)}`,
      },
    ]).block?.title;
    expect(title).toBe(`${"x".repeat(78)}…`);
    const line = only([
      {
        id: "l",
        kind: "log",
        source: { type: "tool", tool: "Bash" },
        lines: [`${"x".repeat(499)}\u{1F600}tail`],
      },
    ]).block;
    const kept = line?.kind === "log" ? line.lines[0] : undefined;
    expect(kept).toBe("x".repeat(499));
    expect(lone.test(title ?? "")).toBe(false);
    const kind = `${"k".repeat(38)}\u{1F600}${"k".repeat(10)}`;
    expect(lone.test(only([{ id: "a", kind }]).notes[0]!)).toBe(false);
  });
});

describe("parseRefInput", () => {
  test("refs parse", () => {
    expect(parseRefInput({ type: "tool", tool: "Bash" })).toEqual({
      type: "tool",
      tool: "Bash",
      nth: 1,
    });
    expect(
      parseRefInput({ type: "tool", tool: "Bash", nth: 2, contains: "503" }),
    ).toEqual({ type: "tool", tool: "Bash", nth: 2, contains: "503" });
    expect(typeof parseRefInput({ type: "tool", tool: "Bash", nth: 0 })).toBe(
      "string",
    );
    expect(parseRefInput({ type: "commit", sha: "ABC1234" })).toEqual({
      type: "commit",
      sha: "abc1234",
    });
    expect(parseRefInput({ type: "pr", number: "7" })).toBe(
      "a pr reference needs a PR number.",
    );
    expect(parseRefInput({ type: "pr", number: 7 })).toEqual({
      type: "pr",
      number: 7,
    });
    expect(parseRefInput({ type: "nope" })).toBe(
      'unknown reference type "nope". Use one of: observation, ledger, event, action, release, pr, commit, tool, block.',
    );
    expect(parseRefInput("x")).toBe(
      'a reference must be an object like {"type": "tool", "tool": "Bash"}.',
    );
    expect(
      parseRefInput({
        type: "observation",
        signal: "sig-a",
        lane: "p95",
        at: "2026-10-27T11:00:00Z",
      }),
    ).toEqual({
      type: "observation",
      signal: "sig-a",
      lane: "p95",
      at: "2026-10-27T11:00:00.000Z",
    });
    expect(parseRefInput({ type: "release", at: NOW, ref: "v1" })).toBe(
      'a release reference needs "at" as an ISO time.',
    );
    expect(parseRefInput({ type: "block", id: "slow-db" })).toEqual({
      type: "block",
      id: "slow-db",
    });
    expect(typeof parseRefInput({ type: "block", id: "Bad" })).toBe("string");
    expect(parseRefInput({ type: "event", id: "ev_1" })).toEqual({
      type: "event",
      id: "ev_1",
    });
  });
  test("times need a zone", () => {
    const obs = (at: string) =>
      parseRefInput({ type: "observation", signal: "sig-a", at });
    for (const at of [
      "2026-10-27T11:00:00",
      "2026-10-27",
      "2026-10-27 11:00:00",
      "2026-10-27T11:00:00+0200",
    ])
      expect(typeof obs(at)).toBe("string");
    expect(obs("2026-10-27T11:00:00+02:00")).toEqual({
      type: "observation",
      signal: "sig-a",
      at: "2026-10-27T09:00:00.000Z",
    });
    expect(obs("2026-10-27T11:00Z")).toEqual({
      type: "observation",
      signal: "sig-a",
      at: "2026-10-27T11:00:00.000Z",
    });
    expect(obs("2026-10-27T11:00:00.250-05:30")).toEqual({
      type: "observation",
      signal: "sig-a",
      at: "2026-10-27T16:30:00.250Z",
    });
    const tl = only([
      {
        id: "t",
        kind: "timeline",
        events: [{ at: "2026-10-27T11:00:00", text: "No zone given here" }],
      },
    ]);
    expect(tl.block).toBeUndefined();
  });

  test("contains must keep some text once cleaned", () => {
    expect(
      typeof parseRefInput({
        type: "tool",
        tool: "Bash",
        contains: "\u001b[0m\u200b \u2060",
      }),
    ).toBe("string");
  });
});
