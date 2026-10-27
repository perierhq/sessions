import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import {
  MCP_CALL_TOOL,
  mcpLabelParts,
} from "@tellahq/opensession-protocol/tool-presentation";
import { FINDINGS_LIMITS } from "../../../shared/findings";
import {
  type MatchCache,
  checkQuotes,
  matchToolCall,
  prepareQuotes,
  provenanceOf,
  quoteSource,
} from "./tool-calls";

const SESSION = "os-inv";
const ACCESS = "mcp__opensession-incident-access__";
const PI_ACCESS = "opensession-incident-access_";

/** A host_command answer the way the access server returns it. */
function hostAnswer(fields: Record<string, unknown>): string {
  return JSON.stringify(
    {
      ok: true,
      runner: "prod-1",
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      truncated: false,
      ...fields,
    },
    null,
    2,
  );
}

/** A quote check over a Bash call with this output. */
function bash(content: string, command = "cat /var/log/acme/app.log") {
  return { toolName: "Bash", input: { command }, content };
}

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

describe("matchToolCall and the access server", () => {
  test("contains searches a host_command's output, not its JSON", () => {
    const tail = claudeCall(
      "toolu_1",
      `${ACCESS}host_command`,
      hostAnswer({
        stdout: "ts=1 \u001b[31mERROR\u001b[0m db timeout\nts=2 ok\n",
      }),
      { runner: "rn-prod", program: "journalctl" },
    );
    const ref = match(tail, {
      tool: "host_command",
      contains: "ERROR db timeout",
    });
    expect(typeof ref).not.toBe("string");
    if (typeof ref === "string") return;
    expect(ref.provenance).toEqual({ kind: "host", label: "prod-1" });
    // Text of the envelope is not output.
    expect(
      typeof match(tail, { tool: "host_command", contains: '"exitCode": 0' }),
    ).toBe("string");
  });

  test("a refused host_command is no host and has no text to match", () => {
    const refusal = JSON.stringify(
      { ok: false, error: "prod-9 is not one of this agent's hosts" },
      null,
      2,
    );
    const tail = claudeCall("toolu_1", `${ACCESS}host_command`, refusal, {
      runner: "prod-9",
      program: "ls",
    });
    const ref = match(tail, { tool: "host_command" });
    expect(typeof ref).not.toBe("string");
    if (typeof ref === "string") return;
    expect(ref.provenance).toEqual({ kind: "tool", label: "host_command" });
    expect(
      match(tail, { tool: "host_command", contains: "prod-9 is not one" }),
    ).toBe("No host_command call in your session has that text in its result.");
  });

  test("an error result gives no provenance from its input", () => {
    const tail = claudeCall("toolu_1", `${ACCESS}egress_fetch`, "", {
      url: "https://evil.example.test/",
    });
    tail[1] = {
      ...tail[1]!,
      isError: true,
      content: JSON.stringify({ ok: true, status: 200, body: "fine" }),
    };
    const ref = match(tail, { tool: "egress_fetch" });
    expect(typeof ref !== "string" && ref.provenance).toEqual({
      kind: "tool",
      label: "egress_fetch",
    });
  });

  test("a call pairs with the first result after it", () => {
    const use = (id: string): TranscriptEntry => ({
      id,
      type: "tool_use",
      content: "",
      timestamp: at(),
      toolName: "Bash",
      toolInput: {},
      toolUseId: id,
    });
    const result = (
      id: string,
      content: string,
      toolUseId?: string,
    ): TranscriptEntry => ({
      id,
      type: "tool_result",
      content,
      timestamp: at(),
      ...(toolUseId ? { toolUseId } : {}),
    });
    const tail: TranscriptEntry[] = [
      result("stale-row", "acme stale output", "toolu_1"),
      use("toolu_1"),
      result("tr-toolu_1", "acme first answer"),
      result("late-row", "acme second answer", "toolu_1"),
    ];
    const ref = match(tail, { tool: "Bash" });
    expect(typeof ref !== "string" && ref.resultId).toBe("tr-toolu_1");
    expect(typeof match(tail, { tool: "Bash", contains: "stale" })).toBe(
      "string",
    );
    // A result before the call never answers it.
    expect(typeof match(tail.slice(0, 2), { tool: "Bash" })).toBe("string");
  });

  test("a miss in a clamped result says the result was cut", () => {
    const tail = claudeCall("toolu_1", "Bash", "acme head of a long log");
    tail[1] = { ...tail[1]!, contentClamped: true, contentLength: 900_000 };
    expect(match(tail, { tool: "Bash", contains: "tail of the log" })).toBe(
      "No Bash call in your session has that text in its result. Some Bash results were cut short, so text near their end can't be found.",
    );
    // A hit is a hit.
    expect(
      typeof match(tail, { tool: "Bash", contains: "head of a long" }),
    ).not.toBe("string");
  });

  test("contains with no text once cleaned matches nothing", () => {
    const tail = claudeCall("toolu_1", "Bash", "acme output");
    expect(match(tail, { tool: "Bash", contains: "\u001b[0m\u200b " })).toBe(
      '"contains" has no text once cleaned.',
    );
  });
});

describe("provenanceOf", () => {
  const ok = (content: string) => ({ content });
  test("provenance by tool", () => {
    expect(
      provenanceOf(
        `${ACCESS}host_command`,
        { runner: "prod-1" },
        ok(hostAnswer({})),
      ),
    ).toEqual({ kind: "host", label: "prod-1" });
    expect(
      provenanceOf(
        MCP_CALL_TOOL,
        {
          name: `${PI_ACCESS}host_command`,
          arguments: { runner: "prod-1" },
        },
        ok(hostAnswer({})),
      ),
    ).toEqual({ kind: "host", label: "prod-1" });
    expect(
      provenanceOf(
        `${ACCESS}egress_fetch`,
        { url: "https://api.example.test/x" },
        ok(JSON.stringify({ ok: true, status: 200, body: "{}" })),
      ),
    ).toEqual({ kind: "fetch", label: "api.example.test" });
    expect(
      provenanceOf("WebFetch", { url: "https://example.test/a" }, ok("page")),
    ).toEqual({ kind: "fetch", label: "example.test" });
    expect(
      provenanceOf(
        "web_fetch",
        { url: "https://docs.example.test/" },
        ok("page"),
      ),
    ).toEqual({ kind: "fetch", label: "docs.example.test" });
    expect(provenanceOf("web_search", { query: "acme" }, ok("x"))).toEqual({
      kind: "web",
    });
    expect(provenanceOf("WebSearch", {}, ok("x"))).toEqual({ kind: "web" });
    expect(
      provenanceOf(
        `${ACCESS}call_credential`,
        { credential: "stripe" },
        ok(JSON.stringify({ status: 200, body: "{}" })),
      ),
    ).toEqual({ kind: "connector", label: "stripe" });
    const datadog = mcpLabelParts("datadog", "query_logs")
      .slice(0, -1)
      .join(" ");
    expect(provenanceOf("mcp__datadog__query_logs", {}, ok("x"))).toEqual({
      kind: "connector",
      label: datadog,
    });
    expect(
      provenanceOf(
        MCP_CALL_TOOL,
        { name: "mcp__datadog__query_logs", arguments: {} },
        ok("x"),
      ),
    ).toEqual({ kind: "connector", label: datadog });
    expect(
      provenanceOf(
        MCP_CALL_TOOL,
        { name: "datadog_query_logs", arguments: {} },
        ok("x"),
      ),
    ).toEqual({ kind: "connector", label: datadog });
    expect(provenanceOf("Bash", { command: "ls" }, ok("x"))).toEqual({
      kind: "shell",
    });
    expect(provenanceOf("codemode", {}, ok("x"))).toEqual({ kind: "shell" });
    expect(provenanceOf("Read", {}, ok("x"))).toEqual({ kind: "workspace" });
    expect(provenanceOf("Grep", {}, ok("x"))).toEqual({ kind: "workspace" });
    expect(provenanceOf("Glob", {}, ok("x"))).toEqual({ kind: "workspace" });
    expect(provenanceOf("Task", {}, ok("x"))).toEqual({
      kind: "tool",
      label: "Task",
    });
  });

  test("the host label comes from the server's answer, not the agent's input", () => {
    // The agent named the Runner by id; the answer names it.
    expect(
      provenanceOf(
        `${ACCESS}host_command`,
        { runner: "rn-prod", ssh: "db-1" },
        ok(hostAnswer({ runner: "prod-1", ssh: "db-1" })),
      ),
    ).toEqual({ kind: "host", label: "db-1 via prod-1" });
    // An answer without a runner name says nothing about the host.
    expect(
      provenanceOf(
        `${ACCESS}host_command`,
        { runner: "prod-1" },
        ok(JSON.stringify({ ok: true, stdout: "x", stderr: "" })),
      ),
    ).toEqual({ kind: "tool", label: "host_command" });
  });

  test("a refused or failed access call gives no host, fetch or connector", () => {
    const quiet = (tool: string) => ({ kind: "tool" as const, label: tool });
    const refused = [
      JSON.stringify(
        { ok: false, error: "prod-9 is not one of this agent's hosts" },
        null,
        2,
      ),
      "Access refused: this session no longer works on incident inc-1",
      "not json at all",
      JSON.stringify(["ok", true]),
    ];
    for (const content of refused) {
      expect(
        provenanceOf(
          `${ACCESS}host_command`,
          { runner: "prod-9" },
          ok(content),
        ),
      ).toEqual(quiet("host_command"));
      expect(
        provenanceOf(
          `${ACCESS}egress_fetch`,
          { url: "https://evil.example.test/" },
          ok(content),
        ),
      ).toEqual(quiet("egress_fetch"));
    }
    expect(
      provenanceOf(
        `${ACCESS}call_credential`,
        { credential: "made-up" },
        ok(JSON.stringify({ error: "made-up is not granted to this agent" })),
      ),
    ).toEqual(quiet("call_credential"));
    // An error result is refused even when its text looks like a success.
    expect(
      provenanceOf(
        `${ACCESS}host_command`,
        { runner: "prod-1" },
        { content: hostAnswer({}), isError: true },
      ),
    ).toEqual(quiet("host_command"));
    // No result at all.
    expect(
      provenanceOf(`${ACCESS}host_command`, { runner: "prod-1" }, null),
    ).toEqual(quiet("host_command"));
  });

  test("bare names are not the access server's tools", () => {
    expect(
      provenanceOf("host_command", { runner: "prod-1" }, ok(hostAnswer({}))),
    ).toEqual({ kind: "tool", label: "host_command" });
    expect(
      provenanceOf(
        "egress_fetch",
        { url: "https://api.example.test/" },
        ok(JSON.stringify({ ok: true, status: 200, body: "" })),
      ),
    ).toEqual({ kind: "tool", label: "egress_fetch" });
    // pi's flat name counts only inside its tool_call dispatcher.
    expect(
      provenanceOf(
        `${PI_ACCESS}host_command`,
        { runner: "prod-1" },
        ok(hostAnswer({})),
      ),
    ).toEqual({ kind: "tool", label: `${PI_ACCESS}host_command` });
  });

  test("connectors are MCP calls only, not built-ins that look like one", () => {
    expect(provenanceOf("write_stdin", { chars: "" }, ok("x"))).toEqual({
      kind: "shell",
    });
    expect(provenanceOf("read_file", { path: "a" }, ok("x"))).toEqual({
      kind: "workspace",
    });
    expect(provenanceOf("list_dir", { path: "." }, ok("x"))).toEqual({
      kind: "workspace",
    });
    // A flat name is a connector only for a server the caller knows.
    expect(provenanceOf("datadog_query_logs", {}, ok("x"))).toEqual({
      kind: "tool",
      label: "datadog_query_logs",
    });
    expect(
      provenanceOf("datadog_query_logs", {}, ok("x"), {
        mcpServers: ["datadog"],
      }),
    ).toEqual({
      kind: "connector",
      label: mcpLabelParts("datadog", "query_logs").slice(0, -1).join(" "),
    });
  });
});

describe("quoteSource", () => {
  const ansi = "\u001b[31mERROR\u001b[0m db timeout   ";
  test("an access answer is quoted by its output, not its JSON", () => {
    const content = hostAnswer({
      stdout: `ts=1 ${ansi}\r\nts=2 retry scheduled\n`,
      stderr: "warn: acme pool at 95%",
    });
    expect(
      quoteSource(`${ACCESS}host_command`, { runner: "prod-1" }, content),
    ).toBe(`ts=1 ${ansi}\r\nts=2 retry scheduled\n\nwarn: acme pool at 95%`);
    expect(
      quoteSource(
        MCP_CALL_TOOL,
        { name: `${PI_ACCESS}host_command`, arguments: {} },
        content,
      ),
    ).toContain("ts=2 retry scheduled");
    expect(
      quoteSource(
        `${ACCESS}egress_fetch`,
        { url: "https://api.example.test/x" },
        JSON.stringify({ ok: true, status: 503, body: "upstream down" }),
      ),
    ).toBe("upstream down");
    expect(
      quoteSource(
        `${ACCESS}call_credential`,
        { credential: "stripe" },
        JSON.stringify({ status: 200, body: '{"acme":1}' }),
      ),
    ).toBe('{"acme":1}');
  });

  test("a failed access call has nothing to quote", () => {
    for (const content of [
      JSON.stringify({ ok: false, error: "ERROR db timeout on prod-9" }),
      "Access refused: ERROR db timeout",
      "{not json",
    ])
      expect(
        quoteSource(`${ACCESS}host_command`, { runner: "prod-9" }, content),
      ).toBeNull();
    expect(
      quoteSource(
        `${ACCESS}call_credential`,
        { credential: "x" },
        JSON.stringify({ error: "x is not granted to this agent" }),
      ),
    ).toBeNull();
  });

  test("other tools are quoted by their plain text", () => {
    expect(quoteSource("Bash", { command: "ls" }, "a\nb")).toBe("a\nb");
    expect(
      quoteSource(
        "host_command",
        {},
        JSON.stringify({ ok: true, stdout: "x" }),
      ),
    ).toBe(JSON.stringify({ ok: true, stdout: "x" }));
  });
});

describe("checkQuotes", () => {
  test("a quote matches a source line with ANSI escapes, CRLF and trailing spaces", () => {
    const result = "ts=1 \u001b[31mERROR\u001b[0m db timeout   \r\nnext";
    expect(checkQuotes(bash(result), ["ERROR db timeout"], [0])).toEqual({
      lines: ["ERROR db timeout"],
      highlight: [0],
      dropped: 0,
      notes: [],
    });
  });

  test("a quote must sit inside one line", () => {
    const result = "ts=1 \u001b[31mERROR\u001b[0m db timeout   \r\nnext";
    expect(checkQuotes(bash(result), ["timeout next"], [])).toEqual({
      lines: [],
      highlight: [],
      dropped: 1,
      notes: [],
    });
  });

  test("a quote needs 8 non-space characters", () => {
    const result = "x a b c d y";
    expect(checkQuotes(bash(result), ["a b c d"], [])).toEqual({
      lines: [],
      highlight: [],
      dropped: 1,
      notes: [],
    });
  });

  test("highlights follow the kept lines", () => {
    const result = [
      "acme-web GET /checkout 503",
      "acme-web upstream example.test timed out",
    ].join("\n");
    expect(
      checkQuotes(
        bash(result),
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
      notes: [],
    });
  });

  test("quotes are checked against a host_command's output, not its JSON", () => {
    const content = hostAnswer({
      stdout:
        "2026-10-27T12:00:01Z acme-api \u001b[31mERROR\u001b[0m pool exhausted   \r\n" +
        "2026-10-27T12:00:02Z acme-api retrying in 5s\n",
      stderr: "\u001b[33mwarn\u001b[0m: replica lag 40s on db.example.test",
    });
    const call = {
      toolName: `${ACCESS}host_command`,
      input: { runner: "rn-prod", program: "journalctl" },
      content,
    };
    expect(
      checkQuotes(
        call,
        [
          "acme-api ERROR pool exhausted",
          "warn: replica lag 40s on db.example.test",
          // Spans two output lines: never one line of the output.
          "pool exhausted 2026-10-27T12:00:02Z acme-api",
          // Only in the JSON envelope, not the output.
          '"exitCode": 0,',
        ],
        [0, 2],
      ),
    ).toEqual({
      lines: [
        "acme-api ERROR pool exhausted",
        "warn: replica lag 40s on db.example.test",
      ],
      highlight: [0],
      dropped: 2,
      notes: [],
    });
  });

  test("a failed call has nothing to quote", () => {
    const call = {
      toolName: `${ACCESS}host_command`,
      input: { runner: "prod-9" },
      content: JSON.stringify({
        ok: false,
        error: "acme-api ERROR pool exhausted on prod-9",
      }),
    };
    const out = checkQuotes(call, ["acme-api ERROR pool exhausted"], [0]);
    expect(out).toMatchObject({ lines: [], highlight: [], dropped: 1 });
    expect(out.notes).toEqual([
      "That call failed, so it has no output to quote.",
    ]);
  });

  test("a quote the call itself sent is not evidence", () => {
    const call = bash(
      "acme-api ERROR pool exhausted\nacme-api ERROR pool exhausted twice",
      'echo "acme-api ERROR pool exhausted"',
    );
    const out = checkQuotes(
      call,
      ["acme-api ERROR pool exhausted", "ERROR pool exhausted twice"],
      [],
    );
    expect(out.lines).toEqual(["ERROR pool exhausted twice"]);
    expect(out.dropped).toBe(1);
    expect(out.notes).toEqual([
      "1 line is in the call's own input, so its output can't prove it.",
    ]);
    // Inside a dispatcher's arguments too.
    const dispatched = {
      toolName: MCP_CALL_TOOL,
      input: {
        name: "mcp__acme__run",
        arguments: { script: ["x", { say: "acme-api ERROR pool exhausted" }] },
      },
      content: "acme-api ERROR pool exhausted",
    };
    expect(
      checkQuotes(dispatched, ["acme-api ERROR pool exhausted"], []).lines,
    ).toEqual([]);
  });

  test("only the head of a very large result is searched", () => {
    const head = "acme-api ERROR pool exhausted\n";
    const late = "acme-api ERROR found after the cut";
    const filler = `${"x".repeat(1023)}\n`.repeat(
      Math.ceil(FINDINGS_LIMITS.sourceBytes / 1024),
    );
    const out = checkQuotes(
      bash(`${head}${filler}${late}`),
      ["acme-api ERROR pool exhausted", late],
      [],
    );
    expect(out.lines).toEqual(["acme-api ERROR pool exhausted"]);
    expect(out.dropped).toBe(1);
    expect(out.notes).toEqual([
      "Only the first 1 MB of the result was searched.",
    ]);
  });

  test("lines are split before they are cleaned", () => {
    // An unterminated OSC sequence would swallow the following lines if the
    // whole result were cleaned at once.
    const result = "\u001b]0;acme title\nacme-api ERROR pool exhausted\n";
    expect(
      checkQuotes(bash(result), ["acme-api ERROR pool exhausted"], []).lines,
    ).toEqual(["acme-api ERROR pool exhausted"]);
    const cr = "acme-api first line here\racme-api second line here";
    expect(
      checkQuotes(bash(cr), ["first line here", "second line here"], []).lines,
    ).toEqual(["first line here", "second line here"]);
  });

  test("composed and decomposed accents match", () => {
    const source = "acme caf\u0065\u0301 order failed";
    const quote = "caf\u00e9 order failed";
    const out = checkQuotes(bash(source), [quote], []);
    expect(out.dropped).toBe(0);
    expect(out.lines).toEqual([quote.normalize("NFC")]);
    const reverse = checkQuotes(bash(quote), [source.slice(5)], []);
    expect(reverse.dropped).toBe(0);
  });

  test("marks and format characters don't count toward the minimum", () => {
    // Four check marks, each with a variation selector: 8 code points, 4
    // visible characters.
    const marks = "\u2714\ufe0e".repeat(4);
    expect(checkQuotes(bash(`x ${marks} y`), [marks], []).dropped).toBe(1);
    // Soft hyphens (format characters) between short words.
    const joined = "ab\u00adcd\u00adef\u00ad";
    expect(checkQuotes(bash(`x ${joined} y`), [joined], []).dropped).toBe(1);
  });
});

test("a shared cache cleans each tail result once across contains searches", () => {
  let reads = 0;
  const result = {
    id: "tr-toolu_1",
    type: "tool_result",
    timestamp: "2026-10-27T10:00:00.000Z",
    toolUseId: "toolu_1",
    get content() {
      reads += 1;
      return "api.example.test GET /search 503\nreplica pool: 0 of 2 healthy";
    },
  } as unknown as TranscriptEntry;
  const tail: TranscriptEntry[] = [
    {
      id: "toolu_1",
      type: "tool_use",
      content: "",
      timestamp: "2026-10-27T10:00:00.000Z",
      toolName: "Bash",
      toolInput: { command: "cat app.log" },
      toolUseId: "toolu_1",
    },
    result,
  ];
  const cache: MatchCache = new Map();
  for (const contains of ["GET /search 503", "0 of 2 healthy", "not there"])
    matchToolCall(tail, SESSION, { tool: "Bash", nth: 1, contains }, { cache });
  expect(reads).toBe(1);
  reads = 0;
  for (const contains of ["GET /search 503", "0 of 2 healthy"])
    matchToolCall(tail, SESSION, { tool: "Bash", nth: 1, contains });
  expect(reads).toBe(2);
});

test("prepared quotes check the same as the call they came from", () => {
  const call = bash(
    "2026-10-27T11:58:03Z \u001b[31mERROR\u001b[0m db timeout after 30s\r\nok",
    "echo ERROR db timeout",
  );
  const lines = ["ERROR db timeout after 30s", "made up line, never printed"];
  expect(checkQuotes(prepareQuotes(call), lines, [0, 1])).toEqual(
    checkQuotes(call, lines, [0, 1]),
  );
  const failed = { ...call, toolName: `${ACCESS}host_command`, content: "{}" };
  expect(checkQuotes(prepareQuotes(failed), lines, [])).toEqual(
    checkQuotes(failed, lines, []),
  );
});
