import { describe, expect, test } from "bun:test";
import {
  FINDING_KINDS,
  type FindingBlock,
  type ToolRef,
} from "../../../shared/findings";
import {
  briefLine,
  FINDINGS_CATALOG,
  FINDINGS_EXAMPLE,
  findingsBrief,
  REF_CATALOG,
} from "./catalog";
import { REF_TYPES, validateFindings } from "./validate";

const NOW = Date.parse("2026-10-27T12:00:00Z");

const toolRef = (tool: string): ToolRef => ({
  type: "tool",
  sessionId: "os-inv",
  useId: "toolu_1",
  resultId: "tr-toolu_1",
  tool,
  at: "2026-10-27T11:40:00.000Z",
  provenance: { kind: "host", label: "prod-1" },
});

describe("findings catalog", () => {
  test("the example passes the validator with zero notes", () => {
    const out = validateFindings(FINDINGS_EXAMPLE, {
      keepFrom: new Map(),
      nowMs: NOW,
    });
    expect(out.notes).toEqual([]);
    expect(out.blocks.length).toBe(FINDINGS_EXAMPLE.blocks.length);
    const kinds = out.blocks.map((b) => b.block.kind);
    for (const kind of ["question", "timeline", "log", "hypothesis"])
      expect(kinds).toContain(kind as (typeof kinds)[number]);
  });

  test("every kind and ref type is briefed once", () => {
    expect(FINDINGS_CATALOG.map((k) => k.kind)).toEqual([...FINDING_KINDS]);
    expect(REF_CATALOG.map((r) => r.type)).toEqual([...REF_TYPES]);
    const brief = findingsBrief("investigator").join("\n");
    for (const k of FINDINGS_CATALOG)
      expect(brief.split(`\n- ${k.kind}: `).length).toBe(2);
    for (const r of REF_CATALOG) expect(brief).toContain(r.shape);
  });

  test("the investigator's brief", () => {
    const lines = findingsBrief("investigator");
    expect(lines[0]).toBe("## Findings");
    const brief = lines.join("\n");
    for (const s of [
      "show_findings",
      "Start early with a question or a timeline and refine it as you learn.",
      "Prefer a few precise blocks: 3 to 8, at most 12.",
      "Quote log lines exactly as the tool printed them; lines that aren't in the result are dropped.",
      '{"id": "…", "keep": true}',
      'If you never called show_findings, put the same list under "findings" in your incident-report block.',
      "80",
      "600",
      "40 lines",
      "31 days",
      "They count toward the block's 64 KB, so keep them short there.",
      "Times are ISO 8601 with a time zone, like 2026-10-27T10:00:00Z.",
    ])
      expect(brief).toContain(s);
    expect(brief).toContain("```json\n");
    expect(brief).toContain(JSON.stringify(FINDINGS_EXAMPLE, null, 2));
  });

  test("the verifier's brief", () => {
    const lines = findingsBrief("verifier");
    expect(lines[0]).toBe("## Findings");
    const brief = lines.join("\n");
    expect(brief).toContain('Your blocks show as "from the verifier".');
    expect(brief).toContain(
      "Your claim checks set each hypothesis's status; you don't set it.",
    );
    expect(brief).toContain("show_findings");
    expect(brief).not.toContain('{"id": "…", "keep": true}');
    expect(brief).not.toContain("Start early with a question or a timeline");
  });

  test("brief lines without prose show only id, kind and refs", () => {
    const hypothesis: FindingBlock = {
      id: "slow-db",
      kind: "hypothesis",
      size: "half",
      statement: "PROSE-MARKER",
      confidence: "high",
      evidence: [
        toolRef("host_command"),
        { type: "commit", sha: "abc1234".padEnd(40, "0"), repo: "acme" },
      ],
      claims: ["The pool is too small.", "The deploy shrank it."],
    };
    expect(briefLine(hypothesis, { prose: false })).toBe(
      "- slow-db · hypothesis · 2 claims, 1 tool call, 1 commit",
    );
    expect(briefLine(hypothesis, { prose: true })).toBe(
      "- slow-db · hypothesis · 2 claims, 1 tool call, 1 commit — PROSE-MARKER",
    );

    const log: FindingBlock = {
      id: "errors",
      kind: "log",
      size: "full",
      source: toolRef("host_command"),
      lines: Array.from({ length: 12 }, (_, i) => `line ${i} at acme`),
      highlight: [0],
      dropped: 0,
    };
    expect(briefLine(log, { prose: false })).toBe(
      "- errors · log · host_command call, 12 lines",
    );

    const signal: FindingBlock = {
      id: "window",
      kind: "signal",
      size: "full",
      signalId: "sig-a",
      from: "2026-10-27T14:00:00.000Z",
      to: "2026-10-27T15:00:00.000Z",
      markers: [],
    };
    expect(briefLine(signal, { prose: false })).toBe(
      "- window · signal · sig-a 14:00–15:00 UTC",
    );

    const pr: FindingBlock = {
      id: "deploy",
      kind: "change",
      size: "full",
      change: {
        type: "pr",
        number: 12,
        url: "https://github.com/acme/web/pull/12",
        sessionId: "os-inv",
      },
      why: "WHY-MARKER",
    };
    expect(briefLine(pr, { prose: false })).toBe("- deploy · change · PR #12");

    const commit: FindingBlock = {
      id: "deploy",
      kind: "change",
      size: "full",
      change: { type: "commit", sha: "abc1234".padEnd(40, "f"), repo: "acme" },
      why: "WHY-MARKER",
    };
    expect(briefLine(commit, { prose: false })).toBe(
      "- deploy · change · commit abc1234",
    );

    const question: FindingBlock = {
      id: "unknown",
      kind: "question",
      size: "full",
      text: "ASK-MARKER",
      wouldAnswer: "ANSWER-MARKER",
    };
    expect(briefLine(question, { prose: false })).toBe("- unknown · question");
  });

  test("brief lines keep prose to one short line, title first", () => {
    const question: FindingBlock = {
      id: "unknown",
      kind: "question",
      size: "full",
      title: "Is the  replica\nback?",
      text: "ASK-MARKER",
      wouldAnswer: "ANSWER-MARKER",
    };
    expect(briefLine(question, { prose: true })).toBe(
      "- unknown · question — Is the replica back?",
    );
    const long: FindingBlock = {
      ...question,
      title: undefined,
      text: "x".repeat(200),
    };
    const line = briefLine(long, { prose: true });
    expect(line.split(" — ")[1]?.length).toBe(120);
    expect(line.endsWith("…")).toBe(true);
  });

  test("timeline, compare and claims lines summarise their data", () => {
    const timeline: FindingBlock = {
      id: "when",
      kind: "timeline",
      size: "full",
      events: [
        {
          at: "2026-10-27T11:02:00.000Z",
          text: "EVENT-MARKER",
          ref: { type: "release", at: "2026-10-27T11:02:00.000Z" },
        },
        { at: "2026-10-27T11:05:00.000Z", text: "EVENT-MARKER" },
      ],
    };
    expect(briefLine(timeline, { prose: false })).toBe(
      "- when · timeline · 2 events, 1 release",
    );
    const compare: FindingBlock = {
      id: "before-after",
      kind: "compare",
      size: "full",
      sides: [
        {
          label: "LABEL-MARKER",
          signal: {
            signalId: "sig-a",
            from: "2026-10-26T14:00:00.000Z",
            to: "2026-10-27T15:00:00.000Z",
          },
        },
        {
          label: "LABEL-MARKER",
          log: {
            source: toolRef("Bash"),
            lines: ["one line from acme"],
            highlight: [],
            dropped: 0,
          },
        },
      ],
    };
    expect(briefLine(compare, { prose: false })).toBe(
      "- before-after · compare · sig-a 2026-10-26 14:00–2026-10-27 15:00 UTC vs Bash call, 1 line",
    );
    expect(
      briefLine(
        { id: "checks", kind: "claims", size: "full" },
        { prose: true },
      ),
    ).toBe("- checks · claims");
  });
});
