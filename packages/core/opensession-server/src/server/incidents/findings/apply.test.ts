import { expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import type { FindingBlock, FindingsSet } from "../../../shared/findings";
import type {
  AgentRun,
  IncidentResponse,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import {
  type ApplyDeps,
  type ApplyRequest,
  TOOL_REFS_PER_CALL,
  applyFindings,
} from "./apply";
import { upsertFindingSet } from "./store";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const AT = "2026-10-27T10:00:00.000Z";

const LOG = [
  "2026-10-27T11:58:01Z api.example.test GET /search 200 41ms",
  "2026-10-27T11:58:02Z api.example.test GET /search 503 30012ms",
  "2026-10-27T11:58:03Z \u001b[31mERROR\u001b[0m db timeout after 30s   ",
  "2026-10-27T11:58:04Z api.example.test GET /search 503 30008ms",
  "2026-10-27T11:58:05Z replica pool: 0 of 2 healthy",
].join("\r\n");
const REAL = "ERROR db timeout after 30s";

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    role: "investigator",
    round: 1,
    attempt: 1,
    sessionId: "os-inv",
    model: "m",
    provider: "p",
    workspace: {} as AgentRun["workspace"],
    accessSummary: "",
    accessRevision: "",
    status: "running",
    startedAt: AT,
    turnSentAt: AT,
    costUsd: 0,
    tokens: 0,
    reminded: false,
    ...over,
  };
}

function incident(response: Partial<IncidentResponse> = {}): Incident {
  return {
    id: "inc-1",
    project: "acme",
    state: "open",
    signalIds: ["sig-a"],
    events: [],
    updatedAt: AT,
    response: {
      round: 1,
      agents: [run()],
      actionRuns: [],
      ledger: [],
      updatedAt: AT,
      ...response,
    },
  } as unknown as Incident;
}

/** A host_command call and its result as the in-process MCP server stores
 *  it (the JSON the tool returns). */
function hostCall(useId: string, stdout: string): TranscriptEntry[] {
  return [
    {
      id: useId,
      type: "tool_use",
      content: "",
      timestamp: AT,
      toolName: "mcp__opensession-incident-access__host_command",
      toolInput: { runner: "prod-1", program: "journalctl" },
      toolUseId: useId,
    },
    {
      id: `${useId}-result`,
      type: "tool_result",
      content: JSON.stringify(
        {
          ok: true,
          runner: "prod-1",
          exitCode: 0,
          timedOut: false,
          stdout,
          stderr: "",
          truncated: false,
        },
        null,
        2,
      ),
      timestamp: AT,
    },
  ];
}

function bashCall(useId: string, output: string): TranscriptEntry[] {
  return [
    {
      id: useId,
      type: "tool_use",
      content: "",
      timestamp: AT,
      toolName: "Bash",
      toolInput: { command: "echo" },
      toolUseId: useId,
    },
    {
      id: `tr-${useId}`,
      type: "tool_result",
      content: output,
      timestamp: AT,
      toolUseId: useId,
    },
  ];
}

interface Harness {
  deps: ApplyDeps;
  state: () => Incident;
  calls: { getIncident: number; save: number; tails: string[] };
}

function harness(
  start: Incident = incident(),
  over: Partial<ApplyDeps> = {},
): Harness {
  let state = structuredClone(start);
  const transcripts: Record<string, TranscriptEntry[]> = {
    "os-inv": [...hostCall("call_1", LOG), ...bashCall("toolu_2", LOG)],
    "os-other": bashCall("toolu_9", "E2E-OTHER marker printed"),
  };
  const calls = { getIncident: 0, save: 0, tails: [] as string[] };
  const deps: ApplyDeps = {
    lookupCommitIn: async () => null,
    hasObservation: async () => true,
    observationTimes: async () => [Date.parse(AT)],
    releases: async () => [],
    ghRepoOf: () => "acme/web",
    now: () => NOW,
    getIncident: async () => {
      calls.getIncident += 1;
      return structuredClone(state);
    },
    transcriptTail: async (sessionId) => {
      calls.tails.push(sessionId);
      return transcripts[sessionId] ?? [];
    },
    fullEntry: async (sessionId, entryId) =>
      (transcripts[sessionId] ?? []).find((e) => e.id === entryId) ?? null,
    save: async (_id, next) => {
      calls.save += 1;
      const response = state.response;
      if (!response)
        return { saved: null, notes: ["This incident has no agents yet."] };
      const out = upsertFindingSet(response.findingSets, next);
      if (out.saved) response.findingSets = out.sets;
      return { saved: out.saved, notes: out.notes };
    },
    ...over,
  };
  return { deps, state: () => state, calls };
}

function request(over: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    incidentId: "inc-1",
    role: "investigator",
    sessionId: "os-inv",
    source: "tool",
    input: { blocks: [] },
    ...over,
  };
}

const question = (id: string) => ({
  id,
  kind: "question",
  text: "Why does acme's search slow down?",
  wouldAnswer: "The replica pool's history.",
});

function storedSet(over: Partial<FindingsSet> = {}): FindingsSet {
  return {
    role: "investigator",
    round: 1,
    attempt: 1,
    sessionId: "os-inv",
    source: "tool",
    updatedAt: AT,
    calls: 1,
    blocks: [],
    notes: [],
    ...over,
  };
}

const savedSet = (h: Harness, round = 1) =>
  h
    .state()
    .response?.findingSets?.find(
      (s) => s.role === "investigator" && s.round === round,
    );

test("a log block keeps real lines and drops invented ones", async () => {
  const h = harness();
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          {
            id: "errors",
            kind: "log",
            source: { type: "tool", tool: "host_command" },
            lines: [REAL, "invented line that never printed"],
            highlight: [0],
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.saved).toBe(true);
  expect(out.blocks).toBe(1);
  expect(out.text).toContain(
    "- Block `errors`: 1 line couldn't be found in the source.",
  );
  expect(out.text.split("\n")[0]).toBe(
    "Saved 1 block for round 1. It is on the incident page now.",
  );
  const block = savedSet(h)?.blocks[0];
  if (block?.kind !== "log") throw new Error("expected a log block");
  expect(block.lines).toEqual([REAL]);
  expect(block.highlight).toEqual([0]);
  expect(block.dropped).toBe(1);
  expect(block.source.provenance).toEqual({ kind: "host", label: "prod-1" });
  expect(block.source.sessionId).toBe("os-inv");
  expect(block.source.resultId).toBe("call_1-result");
});

test("the result text lists what was saved and the notes", async () => {
  const h = harness();
  const out = await applyFindings(
    request({ input: { blocks: [question("a"), question("b")] } }),
    h.deps,
  );
  expect(out.text).toBe(
    "Saved 2 blocks for round 1. They are on the incident page now.\nNo notes.",
  );
});

test("only the calling agent's own session is searched", async () => {
  const h = harness();
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          question("q"),
          {
            id: "l",
            kind: "log",
            source: { type: "tool", tool: "Bash", contains: "E2E-OTHER" },
            lines: ["E2E-OTHER marker printed"],
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.notes).toContain(
    "Block `l`: No Bash call in your session has that text in its result.",
  );
  expect(savedSet(h)?.blocks.map((b) => b.id)).toEqual(["q"]);
  expect(h.calls.tails).toEqual(["os-inv"]);
});

test("a session that is not the incident's agent is refused", async () => {
  const h = harness();
  const out = await applyFindings(
    request({ sessionId: "os-other", input: { blocks: [question("q")] } }),
    h.deps,
  );
  expect(out).toEqual({
    saved: false,
    blocks: 0,
    notes: [],
    text: "This session is not an agent of incident inc-1.",
  });
  expect(h.calls.save).toBe(0);
  const wrongRole = await applyFindings(
    request({ role: "verifier", input: { blocks: [question("q")] } }),
    h.deps,
  );
  expect(wrongRole.text).toBe(
    "This session is not an agent of incident inc-1.",
  );
  expect(h.calls.save).toBe(0);
});

test("a superseded or cancelled run is refused", async () => {
  for (const over of [
    { supersededBy: "os-new" },
    { status: "cancelled" as const },
  ]) {
    const h = harness(incident({ agents: [run(over)] }));
    const out = await applyFindings(
      request({ input: { blocks: [question("q")] } }),
      h.deps,
    );
    expect(out.text).toBe("This session no longer works on incident inc-1.");
    expect(h.calls.save).toBe(0);
  }
});

test("input over 128 KB is refused before anything is read", async () => {
  const h = harness();
  const out = await applyFindings(
    request({
      input: { blocks: [{ ...question("q"), text: "x".repeat(140_000) }] },
    }),
    h.deps,
  );
  expect(out.saved).toBe(false);
  expect(out.text).toBe(
    "The findings are over 128 KB; nothing saved. Send fewer or shorter blocks.",
  );
  expect(h.calls.getIncident).toBe(0);
});

test("zero valid blocks changes nothing, an empty list clears", async () => {
  const h = harness(incident({ findingSets: [storedSet({ blocks: [] })] }));
  const out = await applyFindings(
    request({ input: { blocks: [{ id: "a", kind: "chart" }] } }),
    h.deps,
  );
  expect(out.saved).toBe(false);
  expect(out.text.split("\n")[0]).toBe("Nothing saved: no block was valid.");
  expect(out.text).toContain('- Block `a`: unknown kind "chart".');
  expect(h.calls.save).toBe(0);

  const cleared = await applyFindings(
    request({ input: { blocks: [] } }),
    h.deps,
  );
  expect(cleared.saved).toBe(true);
  expect(cleared.text.split("\n")[0]).toBe(
    "Cleared your findings for round 1.",
  );
  expect(savedSet(h)?.blocks).toEqual([]);
  expect(savedSet(h)?.calls).toBe(2);
});

test("keep carries a block from the previous round", async () => {
  const when: FindingBlock = {
    id: "when",
    kind: "timeline",
    size: "full",
    events: [{ at: AT, text: "Search started timing out." }],
  };
  const h = harness(
    incident({
      round: 2,
      agents: [run(), run({ round: 2, sessionId: "os-inv-2" })],
      findingSets: [storedSet({ blocks: [when] })],
    }),
  );
  const out = await applyFindings(
    request({
      sessionId: "os-inv-2",
      input: { blocks: [{ id: "when", keep: true }] },
    }),
    h.deps,
  );
  expect(out.saved).toBe(true);
  expect(savedSet(h, 2)?.blocks).toEqual([when]);
  expect(savedSet(h, 2)?.sessionId).toBe("os-inv-2");
});

test("kept blocks are not resolved again", async () => {
  const errors: FindingBlock = {
    id: "errors",
    kind: "log",
    size: "full",
    source: {
      type: "tool",
      sessionId: "os-inv",
      useId: "gone",
      resultId: "gone-result",
      tool: "Bash",
      at: AT,
      provenance: { kind: "shell" },
    },
    lines: ["a line from a call no longer in the tail"],
    highlight: [],
    dropped: 0,
  };
  const h = harness(
    incident({ findingSets: [storedSet({ blocks: [errors] })] }),
  );
  const out = await applyFindings(
    request({ input: { blocks: [{ id: "errors", keep: true }] } }),
    h.deps,
  );
  expect(out.notes).toEqual([]);
  expect(savedSet(h)?.blocks).toEqual([errors]);
  expect(h.calls.tails).toEqual([]);
});

test("two calls from one session apply in order", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness();
  const fullEntry = h.deps.fullEntry;
  let first = true;
  h.deps.fullEntry = async (sessionId, entryId) => {
    if (first) {
      first = false;
      await slow;
    }
    return fullEntry(sessionId, entryId);
  };
  const log = (id: string) => ({
    id,
    kind: "log",
    source: { type: "tool", tool: "Bash" },
    lines: [REAL],
  });
  const a = applyFindings(request({ input: { blocks: [log("a")] } }), h.deps);
  const b = applyFindings(request({ input: { blocks: [log("b")] } }), h.deps);
  await Promise.resolve();
  release();
  await Promise.all([a, b]);
  expect(savedSet(h)?.blocks.map((x) => x.id)).toEqual(["b"]);
  expect(savedSet(h)?.calls).toBe(2);
});

test("result entry missing from the store drops the log block with a note", async () => {
  const h = harness(undefined, { fullEntry: async () => null });
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          question("q"),
          {
            id: "errors",
            kind: "log",
            source: { type: "tool", tool: "host_command" },
            lines: [REAL],
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.notes).toContain(
    "Block `errors`: the source's result couldn't be read.",
  );
  expect(savedSet(h)?.blocks.map((b) => b.id)).toEqual(["q"]);
});

test("a log block with no line in the source is dropped", async () => {
  const h = harness();
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          question("q"),
          {
            id: "fake",
            kind: "log",
            source: { type: "tool", tool: "host_command" },
            lines: ["E2E-NEVER-PRINTED zzz"],
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.notes).toContain(
    "Block `fake`: none of the lines are in the source; left off.",
  );
  expect(savedSet(h)?.blocks.map((b) => b.id)).toEqual(["q"]);
});

test("compare log sides get the same quote check", async () => {
  const h = harness();
  const side = (label: string, lines: string[]) => ({
    label,
    log: { source: { type: "tool", tool: "host_command" }, lines },
  });
  await applyFindings(
    request({
      input: {
        blocks: [
          {
            id: "before-after",
            kind: "compare",
            sides: [
              side("before", [LOG.split("\r\n")[0]!.slice(21), "made up line"]),
              side("after", [REAL]),
            ],
          },
          {
            id: "gone",
            kind: "compare",
            sides: [side("before", ["made up line"]), side("after", [REAL])],
          },
        ],
      },
    }),
    h.deps,
  );
  const blocks = savedSet(h)?.blocks ?? [];
  expect(blocks.map((b) => b.id)).toEqual(["before-after"]);
  const compare = blocks[0];
  if (compare?.kind !== "compare") throw new Error("expected compare");
  const before = compare.sides[0];
  if (!("log" in before)) throw new Error("expected a log side");
  expect(before.log.lines).toHaveLength(1);
  expect(before.log.dropped).toBe(1);
  expect(before.log.source.resultId).toBe("call_1-result");
});

test("refs that fail inside evidence are left off; a failing change drops its block", async () => {
  const h = harness();
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          {
            id: "h",
            kind: "hypothesis",
            statement: "The replica pool emptied.",
            confidence: "medium",
            evidence: [
              { type: "pr", number: 99 },
              { type: "tool", tool: "host_command" },
              { type: "block", id: "deploy" },
            ],
          },
          { id: "deploy", kind: "change", pr: 99 },
        ],
      },
    }),
    h.deps,
  );
  const blocks = savedSet(h)?.blocks ?? [];
  expect(blocks.map((b) => b.id)).toEqual(["h"]);
  const h0 = blocks[0];
  if (h0?.kind !== "hypothesis") throw new Error("expected hypothesis");
  expect(h0.evidence.map((r) => r.type)).toEqual(["tool"]);
  expect(out.notes).toContain(
    "Block `h`: evidence 1 left off: PR #99 isn't one this incident's agents opened.",
  );
  expect(out.notes).toContain(
    'Block `h`: evidence 3 left off: No block "deploy" in your findings.',
  );
  expect(out.notes).toContain(
    "Block `deploy`: PR #99 isn't one this incident's agents opened.",
  );
});

test("a signal window without data drops its block", async () => {
  const h = harness(undefined, { hasObservation: async () => false });
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          question("q"),
          {
            id: "w",
            kind: "signal",
            signal: "sig-a",
            from: "2026-10-27T11:00:00Z",
            to: "2026-10-27T12:00:00Z",
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.notes).toContain(
    'Block `w`: No observations of "sig-a" in that window.',
  );
  expect(savedSet(h)?.blocks.map((b) => b.id)).toEqual(["q"]);
});

test("hypothesis claims are matched to the report", async () => {
  const h = harness();
  const hypothesis = (claims: string[]) => ({
    id: "h",
    kind: "hypothesis",
    statement: "The pool is too small.",
    confidence: "high",
    claims,
  });
  const out = await applyFindings(
    request({
      claims: ["The pool is too small."],
      input: { blocks: [hypothesis(["the pool is too small", "made up"])] },
    }),
    h.deps,
  );
  const block = savedSet(h)?.blocks[0];
  if (block?.kind !== "hypothesis") throw new Error("expected hypothesis");
  expect(block.claims).toEqual(["the pool is too small"]);
  expect(out.notes).toContain(
    'Block `h`: claim "made up" isn\'t in the report; left off.',
  );

  const none = await applyFindings(
    request({
      claims: ["The pool is too small."],
      input: { blocks: [hypothesis(["made up"])] },
    }),
    h.deps,
  );
  expect(none.notes).toContain(
    "Block `h`: none of its claims are in the report.",
  );
});

test("hypothesis claims default to the run's report", async () => {
  const report = {
    role: "investigator",
    claims: [{ text: "The pool is too small." }],
  } as AgentRun["report"];
  const h = harness(incident({ agents: [run({ report })] }));
  await applyFindings(
    request({
      input: {
        blocks: [
          {
            id: "h",
            kind: "hypothesis",
            statement: "The pool is too small.",
            confidence: "high",
            claims: ["The pool is too small", "made up"],
          },
        ],
      },
    }),
    h.deps,
  );
  const block = savedSet(h)?.blocks[0];
  if (block?.kind !== "hypothesis") throw new Error("expected hypothesis");
  expect(block.claims).toEqual(["The pool is too small"]);
});

test("report findings are skipped when the run already has a tool set", async () => {
  const h = harness(
    incident({ findingSets: [storedSet({ blocks: [], source: "tool" })] }),
  );
  const out = await applyFindings(
    request({
      source: "report",
      onlyIfNoToolSet: true,
      input: { blocks: [question("q")] },
    }),
    h.deps,
  );
  expect(out).toEqual({ saved: false, blocks: 0, notes: [], text: "" });
  expect(h.calls.save).toBe(0);

  const fresh = harness();
  const saved = await applyFindings(
    request({
      source: "report",
      onlyIfNoToolSet: true,
      input: { blocks: [question("q")] },
    }),
    fresh.deps,
  );
  expect(saved.saved).toBe(true);
  expect(savedSet(fresh)?.source).toBe("report");
});

test("the store's notes are appended to the reply", async () => {
  const h = harness(incident({ findingSets: [storedSet({ attempt: 2 })] }));
  const out = await applyFindings(
    request({ input: { blocks: [question("q")] } }),
    h.deps,
  );
  expect(out.saved).toBe(false);
  expect(out.text).toBe(
    "A newer attempt owns round 1's findings; nothing saved.",
  );
});

test("a failed call has nothing to quote", async () => {
  const h = harness();
  const failed = hostCall("call_2", "");
  failed[1]!.content = JSON.stringify({
    ok: false,
    error: "prod-2 is not one of this agent's hosts",
  });
  h.deps.transcriptTail = async () => failed;
  h.deps.fullEntry = async (_s, id) => failed.find((e) => e.id === id) ?? null;
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          question("q"),
          {
            id: "errors",
            kind: "log",
            source: { type: "tool", tool: "host_command" },
            lines: ["prod-2 is not one of this agent's hosts"],
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.notes).toContain(
    "Block `errors`: That call failed, so it has no output to quote.",
  );
  expect(out.notes).toContain(
    "Block `errors`: none of the lines are in the source; left off.",
  );
  expect(savedSet(h)?.blocks.map((b) => b.id)).toEqual(["q"]);
});

test("apply.ts imports no route module", async () => {
  // Routes import the incident stores; the findings tool reading a route's
  // constant would close an import cycle through them.
  const source = await Bun.file(new URL("./apply.ts", import.meta.url)).text();
  expect(source).not.toMatch(/from "(\.\.\/)+routes\//);
});

test("one call reads each cited result once", async () => {
  const h = harness();
  const read: string[] = [];
  const fullEntry = h.deps.fullEntry;
  h.deps.fullEntry = (sessionId, entryId) => {
    read.push(entryId);
    return fullEntry(sessionId, entryId);
  };
  const log = (id: string) => ({
    id,
    kind: "log",
    source: { type: "tool", tool: "host_command" },
    lines: [REAL],
  });
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          log("a"),
          log("b"),
          {
            id: "c",
            kind: "compare",
            sides: [
              { label: "before", log: log("x") },
              { label: "after", log: log("y") },
            ],
          },
        ],
      },
    }),
    h.deps,
  );
  expect(out.blocks).toBe(3);
  expect(read).toEqual(["call_1-result"]);
});

test("one call looks up at most 12 tool calls", async () => {
  const tail: TranscriptEntry[] = [];
  for (let i = 1; i <= 13; i++)
    tail.push(...bashCall(`toolu_b${i}`, `line ${i}: ${LOG}`));
  const h = harness(undefined, { transcriptTail: async () => tail });
  const ref = (nth: number) => ({ type: "tool", tool: "Bash", nth });
  const hypothesis = (id: string, nths: number[]) => ({
    id,
    kind: "hypothesis",
    statement: "The replica pool drained.",
    confidence: "medium",
    evidence: nths.map(ref),
  });
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          hypothesis("h1", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
          // A ref repeated within the call is one lookup.
          hypothesis("h2", [11, 12, 13, 1]),
        ],
      },
    }),
    h.deps,
  );
  expect(TOOL_REFS_PER_CALL).toBe(12);
  expect(out.notes).toEqual([
    'Block `h2`: evidence 3 left off: "Bash" call wasn\'t looked up: one call looks up at most 12 tool calls.',
  ]);
  const h2 = savedSet(h)?.blocks.find((b) => b.id === "h2");
  if (h2?.kind !== "hypothesis") throw new Error("expected a hypothesis");
  expect(h2.evidence.map((r) => (r.type === "tool" ? r.useId : ""))).toEqual([
    "toolu_b3",
    "toolu_b2",
    "toolu_b13",
  ]);
});

test("the reply lists at most 40 notes and counts the rest", async () => {
  const h = harness();
  const hypothesis = (id: string) => ({
    id,
    kind: "hypothesis",
    statement: "The replica pool drained.",
    confidence: "medium",
    evidence: Array.from({ length: 10 }, (_, i) => ({
      type: "ledger",
      id: `led_${id}_${i}`,
    })),
  });
  const out = await applyFindings(
    request({
      input: { blocks: ["h1", "h2", "h3", "h4", "h5"].map(hypothesis) },
    }),
    h.deps,
  );
  expect(out.saved).toBe(true);
  const lines = out.text.split("\n");
  expect(lines[1]).toBe("Notes:");
  expect(lines).toHaveLength(2 + 41);
  expect(lines.at(-1)).toBe("- …and 10 more.");
  expect(out.notes).toHaveLength(41);
});

test("a tool call from a round that is over saves nothing", async () => {
  const h = harness(
    incident({
      round: 2,
      agents: [run(), run({ round: 2, sessionId: "os-inv-2" })],
    }),
  );
  const out = await applyFindings(
    request({ input: { blocks: [question("q")] } }),
    h.deps,
  );
  expect(out).toEqual({
    saved: false,
    blocks: 0,
    notes: [],
    text: "This round is over; nothing saved.",
  });
  expect(h.calls.save).toBe(0);
  // A final report still lands on its own round.
  const report = await applyFindings(
    request({ source: "report", input: { blocks: [question("q")] } }),
    h.deps,
  );
  expect(report.saved).toBe(true);
});

test("a store that fails becomes a reply, never a throw", async () => {
  const failing = async (): Promise<never> => {
    throw new Error("disk on fire");
  };
  for (const over of [{ getIncident: failing }, { save: failing }]) {
    const h = harness(undefined, over);
    const out = await applyFindings(
      request({ input: { blocks: [question("q")] } }),
      h.deps,
    );
    expect(out).toEqual({
      saved: false,
      blocks: 0,
      notes: [],
      text: "Couldn't save the findings right now.",
    });
  }
});

test("a kept block's reference to a block no longer in the set is left off", async () => {
  const when: FindingBlock = {
    id: "when",
    kind: "timeline",
    size: "full",
    events: [
      {
        at: AT,
        text: "Search started timing out.",
        ref: { type: "block", id: "gone", role: "investigator" },
      },
      {
        at: AT,
        text: "The pool drained.",
        ref: { type: "block", id: "q", role: "investigator" },
      },
    ],
  };
  const h: FindingBlock = {
    id: "h",
    kind: "hypothesis",
    size: "half",
    statement: "The pool is too small.",
    confidence: "high",
    claims: [],
    evidence: [
      { type: "block", id: "gone", role: "investigator" },
      { type: "ledger", id: "led_1" },
    ],
  };
  const harnessed = harness(
    incident({ findingSets: [storedSet({ blocks: [when, h] })] }),
  );
  const out = await applyFindings(
    request({
      input: {
        blocks: [
          { id: "when", keep: true },
          { id: "h", keep: true },
          question("q"),
        ],
      },
    }),
    harnessed.deps,
  );
  expect(out.notes).toEqual([
    'Block `when`: event 1 reference left off: No block "gone" in your findings.',
    'Block `h`: evidence 1 left off: No block "gone" in your findings.',
  ]);
  const saved = savedSet(harnessed)?.blocks;
  expect(saved?.[0]).toEqual({
    ...when,
    events: [{ at: AT, text: "Search started timing out." }, when.events[1]],
  } as FindingBlock);
  expect(saved?.[1]).toEqual({
    ...h,
    evidence: [{ type: "ledger", id: "led_1" }],
  });
});

test("the verifier's claims default to the candidate of its own round", async () => {
  const verifier = run({ role: "verifier", round: 2, sessionId: "os-ver" });
  const block = {
    id: "h",
    kind: "hypothesis",
    statement: "The pool is too small.",
    confidence: "high",
    claims: ["made up"],
  };
  for (const [round, expected] of [
    [1, ["made up"]],
    [2, []],
  ] as const) {
    const h = harness(
      incident({
        round: 2,
        agents: [run({ round: 2 }), verifier],
        candidate: {
          round,
          claims: [{ text: "The pool is too small." }],
        } as IncidentResponse["candidate"],
      }),
    );
    await applyFindings(
      request({
        role: "verifier",
        sessionId: "os-ver",
        input: { blocks: [block] },
      }),
      h.deps,
    );
    const saved = h
      .state()
      .response?.findingSets?.find((s) => s.role === "verifier")?.blocks[0];
    if (saved?.kind !== "hypothesis") throw new Error("expected hypothesis");
    expect(saved.claims).toEqual([...expected]);
  }
});
