import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_WEB_SEARCH_TYPE,
  MAX_FINDINGS_CHARS,
  MAX_PAUSE_CONTINUATIONS,
  anthropicSupportsDynamicFiltering,
  createWebSearchTool,
  findingsFromBlocks,
  formatFindings,
  injectWebSearchTool,
  resolveSearchProviders,
  runWebSearch,
  searchWithModel,
  webSearchEnabled,
  webSearchServerTool,
  type SearchRuntime,
} from "./pi-web-search";

const haiku = {
  id: "claude-haiku-5-5",
  api: "anthropic-messages",
  provider: "anthropic",
};

describe("server tool shaping", () => {
  test("Anthropic gets the newest search tool, capped and without raw results", () => {
    expect(
      webSearchServerTool("anthropic-messages", "claude-haiku-5-5"),
    ).toEqual({
      type: ANTHROPIC_WEB_SEARCH_TYPE,
      name: "web_search",
      max_uses: 5,
      response_inclusion: "excluded",
    });
    expect(ANTHROPIC_WEB_SEARCH_TYPE).toBe("web_search_20260318");
  });

  test("models older than Claude 4.6 call the tool directly", () => {
    for (const id of [
      "claude-haiku-4-5",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "claude-opus-4-1",
    ]) {
      expect(anthropicSupportsDynamicFiltering(id)).toBe(false);
      expect(
        webSearchServerTool("anthropic-messages", id)?.allowed_callers,
      ).toEqual(["direct"]);
    }
  });

  test("4.6 and newer, and unknown ids, keep dynamic filtering", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-sonnet-4-7",
      "claude-haiku-5-5",
      "claude-opus-5",
      "claude-next",
    ]) {
      expect(anthropicSupportsDynamicFiltering(id)).toBe(true);
      expect(
        webSearchServerTool("anthropic-messages", id)?.allowed_callers,
      ).toBeUndefined();
    }
  });

  test("a forced direct call adds allowed_callers on any model", () => {
    expect(
      webSearchServerTool("anthropic-messages", "claude-haiku-5-5", {
        direct: true,
      })?.allowed_callers,
    ).toEqual(["direct"]);
  });

  test("OpenAI Responses APIs get their search tool; others none", () => {
    expect(webSearchServerTool("openai-codex-responses", "gpt-6-luna")).toEqual(
      { type: "web_search" },
    );
    expect(webSearchServerTool("openai-responses", "gpt-6-luna")).toEqual({
      type: "web_search",
    });
    expect(webSearchServerTool("openai-completions", "x")).toBeNull();
    expect(webSearchServerTool(undefined, "x")).toBeNull();
  });

  test("the side request carries only the server tool", () => {
    const tool = { type: "web_search" };
    const out = injectWebSearchTool(
      {
        model: "m",
        tools: [{ name: "web_search", input_schema: {} }],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: "q" }],
      },
      tool,
    ) as Record<string, unknown>;
    expect(out.tools).toEqual([tool]);
    expect(out.tool_choice).toBeUndefined();
    expect(out.messages).toEqual([{ role: "user", content: "q" }]);
  });

  test("a continuation resends the paused assistant turn and its container", () => {
    const blocks = [{ type: "text", text: "partial" }];
    const out = injectWebSearchTool(
      { messages: [{ role: "user", content: "q" }] },
      { type: "x" },
      { content: blocks, container: "cont_1" },
    ) as Record<string, unknown>;
    expect(out.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: blocks },
    ]);
    expect(out.container).toBe("cont_1");
  });
});

type Script = {
  events?: unknown[];
  text?: string;
  stopReason?: string;
  errorMessage?: string;
};

function scriptedRuntime(scripts: Script[]) {
  const payloads: Record<string, unknown>[] = [];
  const runtime: SearchRuntime = {
    async completeSimple(model, _context, options) {
      const script = scripts[Math.min(payloads.length, scripts.length - 1)]!;
      const base = {
        model: model.id,
        messages: [{ role: "user", content: "q" }],
      };
      const payload = ((await options?.onPayload?.(base, model)) ??
        base) as Record<string, unknown>;
      payloads.push(payload);
      for (const event of script.events ?? [])
        await options?.onProviderStreamEvent?.(event, model);
      return {
        role: "assistant",
        content: script.text ? [{ type: "text", text: script.text }] : [],
        stopReason: script.stopReason ?? "stop",
        ...(script.errorMessage ? { errorMessage: script.errorMessage } : {}),
      };
    },
  };
  return { runtime, payloads };
}

function response(
  blocks: Array<Record<string, unknown>>,
  stop: string,
  searches = 0,
): unknown[] {
  const events: unknown[] = [
    { type: "message_start", message: { id: "m", usage: {} } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
      for (const citation of (block.citations as unknown[]) ?? [])
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "citations_delta", citation },
        });
    } else if (block.type === "server_tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { ...block, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { server_tool_use: { web_search_requests: searches } },
  });
  return events;
}

const signal = new AbortController().signal;

describe("the Anthropic request loop", () => {
  test("pause_turn resends the paused turn until the answer arrives", async () => {
    const first = [
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "acme" },
      },
    ];
    const second = [{ type: "text", text: "Still looking." }];
    const third = [
      {
        type: "text",
        text: "Acme ships on Fridays.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.test/acme",
            title: "Acme",
          },
        ],
      },
    ];
    const { runtime, payloads } = scriptedRuntime([
      { events: response(first, "pause_turn", 1) },
      { events: response(second, "pause_turn", 1) },
      { events: response(third, "end_turn", 2), text: "ignored" },
    ]);
    const result = await searchWithModel({
      runtime,
      model: haiku,
      query: "acme",
      signal,
    });
    expect(payloads).toHaveLength(3);
    expect(payloads[0]!.tools).toEqual([
      webSearchServerTool("anthropic-messages", "claude-haiku-5-5"),
    ]);
    const resent = (payloads[2]!.messages as Array<{ content: unknown }>)[1]!;
    expect(resent).toEqual({
      role: "assistant",
      content: [
        {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "web_search",
          input: { query: "acme" },
        },
        { type: "text", text: "Still looking." },
      ],
    });
    expect(result).toMatchObject({ ok: true, searches: 4, continuations: 2 });
    if (!result.ok) throw new Error("expected findings");
    expect(result.text).toContain("Acme ships on Fridays.");
    expect(result.text).toContain("[Acme](https://example.test/acme)");
  });

  test("stops after three continuations and returns what exists", async () => {
    const { runtime, payloads } = scriptedRuntime([
      {
        events: response(
          [{ type: "text", text: "Partial answer." }],
          "pause_turn",
          1,
        ),
      },
    ]);
    const result = await searchWithModel({
      runtime,
      model: haiku,
      query: "acme",
      signal,
    });
    expect(payloads).toHaveLength(1 + MAX_PAUSE_CONTINUATIONS);
    expect(result).toMatchObject({ ok: true, continuations: 3 });
    if (result.ok) expect(result.text).toContain("Partial answer.");
  });

  test("a 400 asking for allowed_callers retries once with direct calls", async () => {
    const { runtime, payloads } = scriptedRuntime([
      {
        stopReason: "error",
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"set allowed_callers to [\\"direct\\"] for this model"}}',
      },
      { events: response([{ type: "text", text: "Done." }], "end_turn", 1) },
    ]);
    const result = await searchWithModel({
      runtime,
      model: haiku,
      query: "acme",
      signal,
    });
    expect(payloads).toHaveLength(2);
    expect(
      (payloads[0]!.tools as Array<Record<string, unknown>>)[0]!
        .allowed_callers,
    ).toBeUndefined();
    expect(
      (payloads[1]!.tools as Array<Record<string, unknown>>)[0]!
        .allowed_callers,
    ).toEqual(["direct"]);
    expect(result).toMatchObject({ ok: true, text: "Done.", searches: 1 });
  });

  test("other errors fail the attempt without a retry", async () => {
    const { runtime, payloads } = scriptedRuntime([
      { stopReason: "error", errorMessage: "529 overloaded" },
    ]);
    const result = await searchWithModel({
      runtime,
      model: haiku,
      query: "acme",
      signal,
    });
    expect(payloads).toHaveLength(1);
    expect(result).toEqual({ ok: false, error: "529 overloaded", searches: 0 });
  });

  test("OpenAI reads pi's text and makes one request", async () => {
    const { runtime, payloads } = scriptedRuntime([
      { text: "See [Acme](https://example.test/a)." },
    ]);
    const result = await searchWithModel({
      runtime,
      model: {
        id: "gpt-6-luna",
        api: "openai-codex-responses",
        provider: "openai-codex",
      },
      query: "acme",
      signal,
    });
    expect(payloads[0]!.tools).toEqual([{ type: "web_search" }]);
    expect(result).toMatchObject({
      ok: true,
      text: "See [Acme](https://example.test/a).",
    });
  });
});

describe("findings", () => {
  test("keeps the answer after the last search, not the narration before it", () => {
    const text = findingsFromBlocks([
      { type: "text", text: "Let me search." },
      { type: "server_tool_use", id: "s", name: "web_search", input: {} },
      {
        type: "web_search_tool_result",
        tool_use_id: "s",
        content: [
          {
            type: "web_search_result",
            url: "https://example.test/r",
            title: "R",
          },
        ],
      },
      { type: "text", text: "The answer is " },
      { type: "text", text: "[42](https://example.test/r)." },
    ]);
    expect(text).toBe("The answer is [42](https://example.test/r).");
  });

  test("lists sources from results when the text has no links", () => {
    const text = findingsFromBlocks([
      { type: "server_tool_use", id: "s", name: "web_search", input: {} },
      {
        type: "web_search_tool_result",
        tool_use_id: "s",
        content: [
          {
            type: "web_search_result",
            url: "https://example.test/one",
            title: "One",
          },
          {
            type: "web_search_result",
            url: "https://example.test/one",
            title: "One again",
          },
        ],
      },
      { type: "text", text: "Plain answer." },
    ]);
    expect(text).toBe(
      "Plain answer.\n\nSources:\n- [One](https://example.test/one)",
    );
  });

  test("ignores code execution blocks", () => {
    expect(
      findingsFromBlocks([
        { type: "server_tool_use", id: "c", name: "code_execution", input: {} },
        { type: "code_execution_tool_result", tool_use_id: "c", content: {} },
        { type: "text", text: "Filtered answer." },
      ]),
    ).toBe("Filtered answer.");
  });

  test("caps findings at 8000 characters", () => {
    expect(MAX_FINDINGS_CHARS).toBe(8000);
    const out = formatFindings("x".repeat(9000));
    expect(out.startsWith("x".repeat(MAX_FINDINGS_CHARS))).toBe(true);
    expect(out.endsWith("[Findings truncated.]")).toBe(true);
    expect(formatFindings("  short  ")).toBe("short");
    expect(formatFindings("   ")).toBe("");
  });
});

describe("provider choice", () => {
  test("Automatic tries the session's provider first", () => {
    expect(resolveSearchProviders("anthropic", "auto")).toEqual({
      providers: ["anthropic", "openai"],
      strict: false,
    });
    expect(resolveSearchProviders("openai", "auto")).toEqual({
      providers: ["openai", "anthropic"],
      strict: false,
    });
    expect(resolveSearchProviders("xai-oauth", "auto")).toEqual({
      providers: ["anthropic", "openai"],
      strict: false,
    });
  });

  test("a specific provider is strict, and Off has none", () => {
    expect(resolveSearchProviders("anthropic", "openai")).toEqual({
      providers: ["openai"],
      strict: true,
    });
    expect(resolveSearchProviders("anthropic", "off")).toEqual({
      providers: [],
      strict: false,
    });
  });

  test("Automatic falls through to the next provider", async () => {
    const tried: string[] = [];
    const out = await runWebSearch(
      ["anthropic", "openai"],
      false,
      async (p) => {
        tried.push(p);
        return p === "anthropic"
          ? { ok: false, error: "no usable Claude account", searches: 0 }
          : { ok: true, text: "found", searches: 1, continuations: 0 };
      },
    );
    expect(tried).toEqual(["anthropic", "openai"]);
    expect(out).toBe("found");
  });

  test("a specific provider fails with a clear error instead of falling back", async () => {
    const tried: string[] = [];
    const run = runWebSearch(["openai"], true, async (p) => {
      tried.push(p);
      return {
        ok: false,
        error: "web search is not on this plan",
        searches: 0,
      };
    });
    await expect(run).rejects.toThrow(
      "The web search provider chosen in Settings (OpenAI) could not search: web search is not on this plan",
    );
    expect(tried).toEqual(["openai"]);
  });

  test("an empty answer counts as a failure", async () => {
    await expect(
      runWebSearch(["anthropic", "openai"], false, async () => ({
        ok: true,
        text: " ",
        searches: 0,
        continuations: 0,
      })),
    ).rejects.toThrow(
      "Web search failed on every provider (Claude: returned no findings; OpenAI: returned no findings)",
    );
  });

  test("no provider is a clear error", async () => {
    await expect(
      runWebSearch([], false, async () => {
        throw new Error("unreachable");
      }),
    ).rejects.toThrow("No connected provider can search the web");
  });
});

describe("availability", () => {
  test("off in Settings or denied by policy removes the tool", () => {
    expect(webSearchEnabled("auto", {})).toBe(true);
    expect(webSearchEnabled("anthropic", {})).toBe(true);
    expect(webSearchEnabled("off", {})).toBe(false);
    expect(webSearchEnabled("auto", { web_search: false })).toBe(false);
  });

  test("the tool takes only a query and returns the findings", async () => {
    const queries: string[] = [];
    const tool = createWebSearchTool({
      search: async (query) => {
        queries.push(query);
        return "findings";
      },
    });
    expect(tool.name).toBe("web_search");
    expect(Object.keys((tool.parameters as any).properties)).toEqual(["query"]);
    expect(tool.promptGuidelines?.join(" ")).toContain("web_search");
    const out = await (tool.execute as any)(
      "id",
      { query: "  acme  " },
      signal,
    );
    expect(queries).toEqual(["acme"]);
    expect(out.content).toEqual([{ type: "text", text: "findings" }]);
    await expect(
      (tool.execute as any)("id", { query: " " }, signal),
    ).rejects.toThrow("A search query is required.");
  });
});
