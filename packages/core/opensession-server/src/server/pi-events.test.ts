/**
 * The live half of pi's event mapping: phase frames, reasoning/text deltas
 * with stable block ids, and the early tool card. Drives the mapper with the
 * event shapes pi emits for one model → tool → model turn; no engine runs.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createPiEventMapper, piToolSummary } from "./pi-events";
import { PiTurnLedger } from "./pi-turn-ledger";
import type { StreamEvent } from "./run-events";
import type { TranscriptEntry } from "./types";

const T0 = 1_760_000_000_000;
const T1 = T0 + 9_000;

function harness(opts: { cutBySteer?: boolean } = {}) {
  const pushed: StreamEvent[] = [];
  const persisted: TranscriptEntry[] = [];
  const steering = {
    interruptForSteer() {},
    consumeCut: () => opts.cutBySteer === true,
    takeDelivered: () => undefined,
  };
  const mapper = createPiEventMapper({
    push: (ev) => pushed.push(ev),
    ledger: new PiTurnLedger({}, Date.now()),
    persist: (entries) => persisted.push(...entries),
    appendLines: () => {},
    steering: steering as any,
    checkpointWriter: () => undefined,
    prompt: "Check the repo",
    promptForEngine: "Check the repo",
    modelID: "claude-test",
    isUsageLimit: () => false,
    abortRetry: () => {},
    auditBase: {},
  });
  const emit = (ev: Record<string, unknown>) => mapper.handle(ev as any);
  return { pushed, persisted, emit };
}

const thinkingBlock = { type: "thinking", thinking: "I should list it." };
const toolBlock = {
  type: "toolCall",
  id: "toolu_1",
  name: "bash",
  arguments: { command: "ls -la\n  && git status" },
};
const textBlock = { type: "text", text: "Here it is." };

/** pi's events for: think → call bash → (bash runs) → reply. */
function playTurn(emit: (ev: Record<string, unknown>) => void) {
  const first = {
    role: "assistant",
    timestamp: T0,
    content: [] as unknown[],
  };
  emit({ type: "message_start", message: first });
  first.content.push({ type: "thinking", thinking: "" });
  const update = (ame: Record<string, unknown>) =>
    emit({
      type: "message_update",
      message: first,
      assistantMessageEvent: { ...ame, partial: first },
    });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "I should " });
  update({ type: "thinking_delta", contentIndex: 0, delta: "list it." });
  first.content[0] = thinkingBlock;
  update({
    type: "thinking_end",
    contentIndex: 0,
    content: "I should list it.",
  });
  first.content.push({
    type: "toolCall",
    id: "toolu_1",
    name: "bash",
    arguments: {},
  });
  update({ type: "toolcall_start", contentIndex: 1 });
  update({ type: "toolcall_delta", contentIndex: 1, delta: '{"command":' });
  first.content[1] = toolBlock;
  update({ type: "toolcall_end", contentIndex: 1, toolCall: toolBlock });
  emit({
    type: "message_end",
    message: { ...first, stopReason: "toolUse" },
  });
  emit({
    type: "tool_execution_start",
    toolCallId: "toolu_1",
    toolName: "bash",
    args: toolBlock.arguments,
  });
  emit({
    type: "tool_execution_end",
    toolCallId: "toolu_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "README.md" }] },
    isError: false,
  });
  emit({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "toolu_1",
      content: [{ type: "text", text: "README.md" }],
      timestamp: T0 + 5_000,
    },
  });
  const second = {
    role: "assistant",
    timestamp: T1,
    content: [] as unknown[],
  };
  emit({ type: "message_start", message: second });
  second.content.push({ type: "text", text: "" });
  emit({
    type: "message_update",
    message: second,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Here it is.",
      partial: second,
    },
  });
  second.content[0] = textBlock;
  emit({
    type: "message_end",
    message: { ...second, stopReason: "stop" },
  });
  emit({ type: "agent_end", messages: [], willRetry: false });
}

afterEach(() => {
  delete process.env.OPENSESSION_STREAM_TIMING;
});

describe("pi live events", () => {
  test("phase frames follow model → tool → model → idle in order", () => {
    const { pushed, emit } = harness();
    playTurn(emit);
    const phases = pushed.filter((ev) => ev.type === "phase");
    expect(phases.map((ev) => ev.phase)).toEqual([
      "model",
      "tool",
      // The last tool ended: pi calls the model next (or ends the turn).
      "model",
      // The request's message_start restates it with its precise start.
      "model",
      "idle",
    ]);
    // A model phase starts when its request did (pi's message timestamp).
    expect(phases[0].since).toBe(T0);
    expect(phases[3].since).toBe(T1);
    expect(phases[1].tool).toEqual({
      id: "toolu_1",
      name: "bash",
      summary: "ls -la ⏎ && git status",
    });
    expect(phases[1].toolCount).toBe(1);
    // The tool phase sits between the tool card and its result.
    const order = pushed.map((ev) => ev.type);
    expect(order.indexOf("tool_use")).toBeLessThan(
      order.indexOf("phase", order.indexOf("tool_use")),
    );
    expect(order.lastIndexOf("phase")).toBe(order.length - 1);
  });

  test("parallel tools keep the tool phase on one that is still running", () => {
    const { pushed, emit } = harness();
    emit({
      type: "message_start",
      message: { role: "assistant", timestamp: T0, content: [] },
    });
    for (const [id, command] of [
      ["a", "pnpm install"],
      ["b", "grep -r foo"],
    ])
      emit({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "bash",
        args: { command },
      });
    emit({
      type: "tool_execution_end",
      toolCallId: "b",
      toolName: "bash",
      result: { content: [] },
      isError: false,
    });
    const tools = pushed
      .filter((ev) => ev.type === "phase" && ev.phase === "tool")
      .map((ev) => [ev.tool?.id, ev.toolCount]);
    expect(tools).toEqual([
      ["a", 1],
      ["b", 2],
      ["a", 1],
    ]);
    // The last tool to end hands back to the model at once: pi opens the
    // next request (its headers can take a while) or ends the turn. A
    // finished tool must not keep ticking until then.
    const before = pushed.length;
    const endedAt = Date.now();
    emit({
      type: "tool_execution_end",
      toolCallId: "a",
      toolName: "bash",
      result: { content: [] },
      isError: false,
    });
    const after = pushed.slice(before).filter((ev) => ev.type === "phase");
    expect(after.map((ev) => ev.phase)).toEqual(["model"]);
    expect(after[0]!.since).toBeGreaterThanOrEqual(endedAt);
  });

  test("reasoning and text deltas carry their kind and the durable row's id", () => {
    const { pushed, persisted, emit } = harness();
    playTurn(emit);
    const chunks = pushed.filter((ev) => ev.type === "text_chunk");
    expect(chunks.map((ev) => [ev.kind, ev.text])).toEqual([
      ["reasoning", "I should "],
      ["reasoning", "list it."],
      ["text", "Here it is."],
    ]);
    const thought = persisted.find(
      (entry) => entry.type === "assistant" && entry.isReasoning,
    );
    const reply = persisted.find(
      (entry) => entry.type === "assistant" && !entry.isReasoning,
    );
    expect(thought?.content).toBe("I should list it.");
    expect(reply?.content).toBe("Here it is.");
    expect(chunks[0].blockId).toBe(thought!.id);
    expect(chunks[1].blockId).toBe(thought!.id);
    expect(chunks[2].blockId).toBe(reply!.id);
    // Two messages, two ids.
    expect(thought!.id).not.toBe(reply!.id);
  });

  test("a later block's id carries its content index", () => {
    const { pushed, persisted, emit } = harness();
    const msg = {
      role: "assistant",
      timestamp: T0,
      content: [thinkingBlock, toolBlock, textBlock],
    };
    emit({ type: "message_start", message: msg });
    emit({
      type: "message_update",
      message: msg,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 2,
        delta: "Here it is.",
        partial: msg,
      },
    });
    emit({ type: "message_end", message: { ...msg, stopReason: "stop" } });
    const chunk = pushed.find((ev) => ev.type === "text_chunk");
    const reply = persisted.find(
      (entry) => entry.type === "assistant" && !entry.isReasoning,
    );
    expect(chunk?.blockId).toMatch(/-b2$/);
    expect(chunk?.blockId).toBe(reply!.id);
  });

  test("a tool card goes out when the model starts writing the call", () => {
    const { pushed, persisted, emit } = harness();
    let persistedAtCard = -1;
    const order: string[] = [];
    const push = pushed.push.bind(pushed);
    pushed.push = (...evs: StreamEvent[]) => {
      for (const ev of evs) {
        order.push(ev.type);
        if (ev.type === "tool_call_start") persistedAtCard = persisted.length;
      }
      return push(...evs);
    };
    playTurn(emit);
    const early = pushed.find((ev) => ev.type === "tool_call_start");
    expect(early).toEqual({
      type: "tool_call_start",
      toolUseId: "toolu_1",
      toolName: "bash",
    });
    // Before the message ended (nothing persisted yet) and before the tool ran.
    expect(persistedAtCard).toBe(0);
    expect(order.indexOf("tool_call_start")).toBeLessThan(
      order.indexOf("tool_use"),
    );
    // The durable tool row has the card's id.
    expect(persisted.find((entry) => entry.type === "tool_use")?.id).toBe(
      "toolu_1",
    );
  });

  test("the timing log stays silent unless its flag is on", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const off = harness();
      playTurn(off.emit);
      const timingLines = () =>
        log.mock.calls.filter((call) =>
          String(call[0]).startsWith("[stream-timing]"),
        );
      expect(timingLines()).toHaveLength(0);

      process.env.OPENSESSION_STREAM_TIMING = "1";
      const on = harness();
      playTurn(on.emit);
      const lines = timingLines().map((call) =>
        JSON.parse(String(call[0]).slice("[stream-timing] ".length)),
      );
      expect(lines.map((line) => line.event)).toEqual([
        "model_message",
        "model_message",
      ]);
      expect(lines[0].requestStartedAt).toBe(T0);
      expect(lines[0].updates.map((u: unknown[]) => u[1])).toEqual([
        "thinking_start",
        "thinking_delta",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
      ]);
      // The frames themselves do not change with the flag.
      const strip = (evs: StreamEvent[]) =>
        evs.map(({ blockId: _b, since: _s, ...rest }) => rest);
      expect(strip(on.pushed)).toEqual(strip(off.pushed));
    } finally {
      log.mockRestore();
    }
  });

  test("an errored message that pi retries is discarded, early card included", () => {
    const { pushed, persisted, emit } = harness();
    const message = {
      role: "assistant",
      timestamp: T0,
      content: [] as unknown[],
    };
    emit({ type: "message_start", message });
    message.content.push({ type: "thinking", thinking: "" });
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "I should list it.",
        partial: message,
      },
    });
    message.content.push({
      type: "toolCall",
      id: "toolu_9",
      name: "bash",
      arguments: {},
    });
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: message,
      },
    });
    emit({
      type: "message_end",
      message: { ...message, stopReason: "error", errorMessage: "overloaded" },
    });
    const blockId = pushed.find((ev) => ev.type === "text_chunk")?.blockId;
    expect(blockId).toBeString();
    expect(persisted).toEqual([]);
    expect(pushed.filter((ev) => ev.type === "discard")).toEqual([
      { type: "discard", messageId: blockId, toolUseIds: ["toolu_9"] },
    ]);
  });

  test("a message cut by a steer before any output is discarded", () => {
    const { pushed, persisted, emit } = harness({ cutBySteer: true });
    const message = {
      role: "assistant",
      timestamp: T0,
      content: [] as unknown[],
    };
    emit({ type: "message_start", message });
    message.content.push({ type: "thinking", thinking: "" });
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "I should",
        partial: message,
      },
    });
    message.content[0] = { type: "thinking", thinking: "I should" };
    emit({
      type: "message_end",
      message: { ...message, stopReason: "aborted" },
    });
    const blockId = pushed.find((ev) => ev.type === "text_chunk")?.blockId;
    expect(persisted).toEqual([]);
    expect(pushed.filter((ev) => ev.type === "discard")).toEqual([
      { type: "discard", messageId: blockId },
    ]);
  });

  test("a persisted message is never discarded", () => {
    const { pushed, emit } = harness();
    playTurn(emit);
    expect(pushed.some((ev) => ev.type === "discard")).toBe(false);
  });

  test("pi's retry backoff and compaction are a wait, never Thinking", () => {
    const { pushed, emit } = harness();
    const lastPhase = () => pushed.filter((ev) => ev.type === "phase").at(-1);
    emit({
      type: "message_start",
      message: { role: "assistant", timestamp: T0, content: [] },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: T0,
        content: [],
        stopReason: "error",
        errorMessage: "overloaded",
      },
    });
    emit({ type: "agent_end", messages: [], willRetry: true });
    expect(lastPhase()?.phase).toBe("model");
    emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 8_000,
      errorMessage: "overloaded",
    });
    expect(lastPhase()).toMatchObject({ phase: "wait", reason: "retry" });
    // The retried request opens: back to the model.
    emit({
      type: "message_start",
      message: { role: "assistant", timestamp: T1, content: [] },
    });
    expect(lastPhase()).toEqual({ type: "phase", phase: "model", since: T1 });

    emit({ type: "compaction_start", reason: "overflow" });
    expect(lastPhase()).toMatchObject({ phase: "wait", reason: "compaction" });
    emit({
      type: "compaction_end",
      reason: "overflow",
      aborted: false,
      willRetry: true,
    });
    // A compaction that retries keeps waiting until the request opens.
    expect(lastPhase()?.phase).toBe("wait");
    emit({ type: "compaction_start", reason: "threshold" });
    emit({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
    });
    expect(lastPhase()?.phase).toBe("idle");
  });

  test("a tool summary is one short line", () => {
    expect(piToolSummary("bash", { command: "a\n  b" })).toBe("a ⏎ b");
    expect(piToolSummary("read", { path: "src/x.ts" })).toBe("src/x.ts");
    expect(piToolSummary("bash", { command: "x".repeat(300) })).toHaveLength(
      120,
    );
    expect(piToolSummary("bash", undefined)).toBe("");
  });

  test("a tool summary masks credentials before it is shown", () => {
    const summary = (command: string) => piToolSummary("bash", { command });
    expect(
      summary('curl -H "Authorization: Bearer abc.def-123" https://x.test'),
    ).toBe('curl -H "Authorization: Bearer ***" https://x.test');
    expect(summary("GH_TOKEN=ghx123 OPENAI_API_KEY='k 1' gh pr list")).toBe(
      "GH_TOKEN=*** OPENAI_API_KEY=*** gh pr list",
    );
    expect(summary("AWS_SECRET_ACCESS_KEY=abc DB_PASSWORD=pw make")).toBe(
      "AWS_SECRET_ACCESS_KEY=*** DB_PASSWORD=*** make",
    );
    expect(
      summary(`echo ghp_${"a".repeat(36)} github_pat_${"B1_".repeat(10)}`),
    ).toBe("echo *** ***");
    expect(
      summary(`export K=sk-ant-${"x".repeat(30)}; slack xoxb-1234-abcdefghij`),
    ).toBe("export K=***; slack ***");
    expect(
      summary("git push https://x-access-token:t0k3n@github.com/acme/app.git"),
    ).toBe("git push https://github.com/acme/app.git");
    // Ordinary words that merely contain the names stay.
    expect(summary("grep -r token_count src")).toBe("grep -r token_count src");
    expect(summary('echo "count token frequencies"')).toBe(
      'echo "count token frequencies"',
    );
  });
});
