import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import {
  MCP_CALL_TOOL,
  mcpLabelParts,
} from "@tellahq/opensession-protocol/tool-presentation";
import { checkQuotes, matchToolCall, provenanceOf } from "./tool-calls";

const SESSION = "os-inv";

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 27, 12, 0, clock)).toISOString();
}

/** A tool call and its result, the way Claude transcripts store them. */
function claudeCall(
  useId: string,
  toolName: string,
  result: string,
  toolInput: unknown = {},
): TranscriptEntry[] {
  return [
    {
      id: useId,
      type: "tool_use",
      content: "",
      timestamp: at(),
      toolName,
      toolInput,
      toolUseId: useId,
    },
    {
      id: `tr-${useId}`,
      type: "tool_result",
      content: result,
      timestamp: at(),
      toolUseId: useId,
    },
  ];
}

/** A tool call and its result, the way pi transcripts store them. */
function piCall(
  useId: string,
  toolName: string,
  result: string,
  toolInput: unknown = {},
): TranscriptEntry[] {
  return [
    {
      id: useId,
      type: "tool_use",
      content: "",
      timestamp: at(),
      toolName,
      toolInput,
      toolUseId: useId,
    },
    {
      id: `${useId}-result`,
      type: "tool_result",
      content: result,
      timestamp: at(),
    },
  ];
}

function match(
  tail: TranscriptEntry[],
  ref: { tool: string; nth?: number; contains?: string },
) {
  return matchToolCall(tail, SESSION, { nth: 1, ...ref });
}

describe("matchToolCall", () => {
  test("nth 1 is the most recent call of that tool", () => {
    const tail = [
      ...claudeCall("toolu_a", "Bash", "first"),
      ...claudeCall("toolu_r", "Read", "file"),
      ...claudeCall("toolu_b", "Bash", "second"),
      ...claudeCall("toolu_c", "Bash", "third"),
    ];
    const first = match(tail, { tool: "Bash", nth: 1 });
    expect(typeof first).not.toBe("string");
    if (typeof first === "string") return;
    expect(first.useId).toBe("toolu_c");
    expect(first.resultId).toBe("tr-toolu_c");
    expect(first.sessionId).toBe(SESSION);
    expect(first.tool).toBe("Bash");
    expect(first.at).toBe(tail[6]!.timestamp);
    expect(first.provenance).toEqual({ kind: "shell" });

    const third = match(tail, { tool: "Bash", nth: 3 });
    expect(typeof third !== "string" && third.useId).toBe("toolu_a");
    expect(match(tail, { tool: "Bash", nth: 4 })).toBe(
      "No 4th Bash call in your session.",
    );
  });

  test("names match raw, canonical and MCP tool part", () => {
    const useOf = (tail: TranscriptEntry[], tool: string) => {
      const ref = match(tail, { tool });
      return typeof ref === "string" ? ref : ref.useId;
    };
    expect(useOf(claudeCall("toolu_1", "Bash", "ok"), "bash")).toBe("toolu_1");
    expect(useOf(piCall("call_1", "read", "ok"), "Read")).toBe("call_1");
    expect(
      useOf(
        claudeCall(
          "toolu_2",
          "mcp__opensession-incident-access__host_command",
          "ok",
          { runner: "prod-1", program: "journalctl" },
        ),
        "host_command",
      ),
    ).toBe("toolu_2");
    expect(
      useOf(piCall("call_2", "datadog_query_logs", "ok"), "query_logs"),
    ).toBe("call_2");

    const dispatched = piCall("call_3", MCP_CALL_TOOL, "ok", {
      name: "mcp__grafana__query_loki_logs",
      arguments: {},
    });
    const ref = match(dispatched, { tool: "query_loki_logs" });
    expect(typeof ref).not.toBe("string");
    if (typeof ref === "string") return;
    expect(ref.useId).toBe("call_3");
    expect(ref.tool).toBe("mcp__grafana__query_loki_logs");
    expect(ref.provenance).toEqual({
      kind: "connector",
      label: mcpLabelParts("grafana", "query_loki_logs").slice(0, -1).join(" "),
    });
  });

  test("results pair by toolUseId, tr- and -result ids", () => {
    const claude = match(claudeCall("toolu_1", "Bash", "ok"), {
      tool: "Bash",
    });
    expect(typeof claude !== "string" && claude.resultId).toBe("tr-toolu_1");

    const pi = match(piCall("call_9", "bash", "ok"), { tool: "Bash" });
    expect(typeof pi !== "string" && pi.resultId).toBe("call_9-result");

    const byUseId: TranscriptEntry[] = [
      {
        id: "use-7",
        type: "tool_use",
        content: "",
        timestamp: at(),
        toolName: "Bash",
        toolInput: {},
        toolUseId: "use-7",
      },
      {
        id: "result-row-7",
        type: "tool_result",
        content: "ok",
        timestamp: at(),
        toolUseId: "use-7",
      },
    ];
    const paired = match(byUseId, { tool: "Bash" });
    expect(typeof paired !== "string" && paired.resultId).toBe("result-row-7");
  });

  test("a call without a result yet is skipped", () => {
    const tail: TranscriptEntry[] = [
      ...claudeCall("toolu_1", "Bash", "done"),
      {
        id: "toolu_2",
        type: "tool_use",
        content: "",
        timestamp: at(),
        toolName: "Bash",
        toolInput: {},
        toolUseId: "toolu_2",
      },
    ];
    const ref = match(tail, { tool: "Bash" });
    expect(typeof ref !== "string" && ref.useId).toBe("toolu_1");
  });

  test("contains searches the cleaned result", () => {
    const tail = [
      ...claudeCall("toolu_1", "Bash", "\u001b[32mGET /api 503\u001b[0m"),
      ...claudeCall("toolu_2", "Bash", "GET /health 200"),
    ];
    const ref = match(tail, { tool: "Bash", contains: "GET /api 503" });
    expect(typeof ref !== "string" && ref.useId).toBe("toolu_1");
    expect(match(tail, { tool: "Bash", contains: "nothing" })).toBe(
      "No Bash call in your session has that text in its result.",
    );
    expect(
      match(tail, { tool: "Bash", nth: 2, contains: "GET /api 503" }),
    ).toBe("No 2nd Bash call in your session has that text in its result.");
  });

  test("show_findings calls are never a source", () => {
    const marker = "acme checkout timeout";
    const tail = [
      ...claudeCall("toolu_1", "Bash", "unrelated"),
      ...claudeCall(
        "toolu_2",
        "mcp__opensession-incident-access__show_findings",
        `Saved: ${marker}`,
        { blocks: [{ lines: [marker] }] },
      ),
      ...piCall("call_3", "opensession-incident-access_show_findings", marker),
      ...piCall("call_4", MCP_CALL_TOOL, marker, {
        name: "opensession-incident-access_show_findings",
        arguments: {},
      }),
    ];
    for (const tool of ["Bash", "show_findings"]) {
      expect(typeof match(tail, { tool, contains: marker })).toBe("string");
    }
    expect(typeof match(tail, { tool: "show_findings" })).toBe("string");
  });
});

describe("provenanceOf", () => {
  test("provenance by tool", () => {
    expect(
      provenanceOf("mcp__opensession-incident-access__host_command", {
        runner: "prod-1",
      }),
    ).toEqual({ kind: "host", label: "prod-1" });
    expect(
      provenanceOf("opensession-incident-access_host_command", {
        runner: "prod-1",
      }),
    ).toEqual({ kind: "host", label: "prod-1" });
    expect(provenanceOf("host_command", { runner: "prod-1" })).toEqual({
      kind: "host",
      label: "prod-1",
    });
    expect(
      provenanceOf("mcp__opensession-incident-access__egress_fetch", {
        url: "https://api.example.test/x",
      }),
    ).toEqual({ kind: "fetch", label: "api.example.test" });
    expect(provenanceOf("WebFetch", { url: "https://example.test/a" })).toEqual(
      { kind: "fetch", label: "example.test" },
    );
    expect(
      provenanceOf("web_fetch", { url: "https://docs.example.test/" }),
    ).toEqual({ kind: "fetch", label: "docs.example.test" });
    expect(provenanceOf("web_search", { query: "acme" })).toEqual({
      kind: "web",
    });
    expect(provenanceOf("WebSearch", {})).toEqual({ kind: "web" });
    expect(
      provenanceOf("mcp__opensession-incident-access__call_credential", {
        credential: "stripe",
      }),
    ).toEqual({ kind: "connector", label: "stripe" });
    expect(provenanceOf("mcp__datadog__query_logs", {})).toEqual({
      kind: "connector",
      label: mcpLabelParts("datadog", "query_logs").slice(0, -1).join(" "),
    });
    expect(
      provenanceOf(MCP_CALL_TOOL, {
        name: "mcp__datadog__query_logs",
        arguments: {},
      }),
    ).toEqual({
      kind: "connector",
      label: mcpLabelParts("datadog", "query_logs").slice(0, -1).join(" "),
    });
    expect(provenanceOf("Bash", { command: "ls" })).toEqual({ kind: "shell" });
    expect(provenanceOf("codemode", {})).toEqual({ kind: "shell" });
    expect(provenanceOf("Read", {})).toEqual({ kind: "workspace" });
    expect(provenanceOf("Grep", {})).toEqual({ kind: "workspace" });
    expect(provenanceOf("Glob", {})).toEqual({ kind: "workspace" });
    expect(provenanceOf("Task", {})).toEqual({ kind: "tool", label: "Task" });
  });
});

describe("checkQuotes", () => {
  test("a quote matches a source line with ANSI escapes, CRLF and trailing spaces", () => {
    const result = "ts=1 \u001b[31mERROR\u001b[0m db timeout   \r\nnext";
    expect(checkQuotes(result, ["ERROR db timeout"], [0])).toEqual({
      lines: ["ERROR db timeout"],
      highlight: [0],
      dropped: 0,
    });
  });

  test("a quote must sit inside one line", () => {
    const result = "ts=1 \u001b[31mERROR\u001b[0m db timeout   \r\nnext";
    expect(checkQuotes(result, ["timeout next"], [])).toEqual({
      lines: [],
      highlight: [],
      dropped: 1,
    });
  });

  test("a quote needs 8 non-space characters", () => {
    const result = "x a b c d y";
    expect(checkQuotes(result, ["a b c d"], [])).toEqual({
      lines: [],
      highlight: [],
      dropped: 1,
    });
  });

  test("highlights follow the kept lines", () => {
    const result = [
      "acme-web GET /checkout 503",
      "acme-web upstream example.test timed out",
    ].join("\n");
    expect(
      checkQuotes(
        result,
        [
          "invented line that never printed",
          "GET /checkout 503",
          "upstream example.test timed out",
        ],
        [0, 2],
      ),
    ).toEqual({
      lines: ["GET /checkout 503", "upstream example.test timed out"],
      highlight: [1],
      dropped: 1,
    });
  });
});
