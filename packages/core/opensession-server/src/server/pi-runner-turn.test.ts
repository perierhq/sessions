/**
 * Characterization tests for one runPi turn, driven through a scripted fake
 * pi SDK (no network, no real engine). They pin what the runner does today
 * with the events pi emits: the stream it yields, the transcript lines it
 * persists, how it steers, and how the turn ends or is torn down. They are a
 * safety net for splitting pi-runner.ts, so they assert current behaviour as
 * it is; a `characterization:` comment marks behaviour that may be
 * surprising but is pinned on purpose.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cancelPiRun,
  isPiSessionBusy,
  PI_STATE_DIR,
  retractPiSteer,
  runPi,
  steerPiRun,
} from "./pi-runner";
import { EMPTY_REPLY_RETRY_PROMPT } from "./auto-continue";
import { createSdkMcpServer } from "./inprocess-mcp";
import { __setCodexAccountsPathForTest } from "./codex-accounts";
import { wrapContext } from "./prompt-context";
import { PI_TURN_CHECKPOINT_FILE } from "./pi-turn-checkpoint";
import { setTranscriptForwarder } from "./transcript-forward";

const MODEL = "pi/openai/gpt-6.1-sol";

type AnyEvent = Record<string, any>;
type Emit = (event: AnyEvent) => void;

/** One assistant message_end as pi emits it. */
const assistantEnd = (
  content: unknown[],
  extra: Record<string, unknown> = {},
): AnyEvent => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "stop",
    content,
    timestamp: Date.now(),
    ...extra,
  },
});

const usage = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  cost = 0,
) => ({ input, output, cacheRead, cacheWrite, cost: { total: cost } });

const textDelta = (delta: unknown, type = "text_delta"): AnyEvent => ({
  type: "message_update",
  assistantMessageEvent: { type, delta },
});

/** Poll until `check` holds; throws after `ms` so a hang fails loudly. */
const waitFor = async (check: () => boolean, what: string, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
};

interface ScriptCtx {
  emit: Emit;
  /** Every engine call so far, in order. */
  log: string[];
  /** The fake AgentSession, for scripts that mutate its state. */
  session: FakeSession;
  /** Text handed to this prompt()/continue() call. */
  text: string;
  /** 0-based count of prompt() calls so far, including this one. */
  index: number;
  /** Resolves once session.abort() has been called. */
  untilAborted: () => Promise<void>;
  /** Resolves once agent.abort() (the steer interrupt) has been called. */
  untilAgentAborted: () => Promise<void>;
}

interface FakeSession {
  sessionId: string;
  sessionManager: unknown;
  pendingMessageCount: number;
  queue: string[];
  agent: {
    state: {
      streamingMessage?: { role: string; content?: unknown };
      pendingToolCalls: Set<string>;
    };
    hasQueuedMessages(): boolean;
    abort(): void;
    continue(): Promise<void>;
  };
  [key: string]: unknown;
}

interface Script {
  /** Drives one session.prompt() call. */
  onPrompt?: (ctx: ScriptCtx) => void | Promise<void>;
  /** Drives one agent.continue() call (the steer drain). */
  onContinue?: (ctx: ScriptCtx) => void | Promise<void>;
  /** Runs inside createAgentSession before the session exists. */
  beforeCreate?: () => void | Promise<void>;
  lastAssistantText?: () => string;
}

/**
 * A fake pi SDK whose session is driven by `script`. Modelled on the fake in
 * pi-runner.test.ts ("runPi pi/openai account wiring"), plus an agent that
 * interruptPiThinkingForSteer can read and a steer queue that pi's
 * pendingMessageCount reflects. `log` records every engine call in order.
 */
function scriptedSdk(script: Script) {
  const log: string[] = [];
  const prompts: string[] = [];
  const promptOptions: unknown[] = [];
  let aborted = false;
  let agentAborted = false;
  const abortWaiters: Array<() => void> = [];
  const agentAbortWaiters: Array<() => void> = [];
  let session: FakeSession | undefined;

  const sdk = {
    ModelRuntime: {
      create: async () => ({
        getModel: (_provider: string, id: string) => ({ id, name: id }),
        registerProvider: () => {},
        setRuntimeApiKey: async () => {},
      }),
    },
    SettingsManager: { inMemory: () => ({}) },
    // Codemode registers only when a turn has custom tools (an MCP catalog).
    createCodemodeExtension: () => () => {},
    DefaultResourceLoader: class {
      async reload() {}
      getSkills() {
        return { skills: [] };
      }
    },
    SessionManager: { create: () => ({}), open: () => ({}) },
    createAgentSession: async ({ sessionManager }: any) => {
      log.push("createAgentSession");
      await script.beforeCreate?.();
      let listener: Emit = () => {};
      const ctxFor = (text: string): ScriptCtx => ({
        emit: (event) => listener(event),
        log,
        session: session!,
        text,
        index: prompts.length - 1,
        untilAborted: () =>
          aborted
            ? Promise.resolve()
            : new Promise((resolve) => abortWaiters.push(resolve)),
        untilAgentAborted: () =>
          agentAborted
            ? Promise.resolve()
            : new Promise((resolve) => agentAbortWaiters.push(resolve)),
      });
      const fake: FakeSession = {
        sessionId: `fake-pi-${crypto.randomUUID()}`,
        sessionManager,
        pendingMessageCount: 0,
        queue: [],
        systemPrompt: "",
        state: { tools: [] },
        agent: {
          state: { pendingToolCalls: new Set() },
          hasQueuedMessages: () => fake.queue.length > 0,
          abort: () => {
            log.push("agent.abort");
            agentAborted = true;
            for (const resolve of agentAbortWaiters.splice(0)) resolve();
          },
          continue: async () => {
            log.push("agent.continue");
            await script.onContinue?.(ctxFor(""));
          },
        },
        setSteeringMode: (mode: string) => log.push(`setSteeringMode:${mode}`),
        subscribe: (fn: Emit) => {
          listener = fn;
          return () => {
            log.push("unsubscribe");
            listener = () => {};
          };
        },
        prompt: async (text: string, options: unknown) => {
          log.push("prompt");
          prompts.push(text);
          promptOptions.push(options);
          await script.onPrompt?.(ctxFor(text));
        },
        steer: async (text: string) => {
          log.push(`steer:${text}`);
          fake.queue.push(text);
          fake.pendingMessageCount = fake.queue.length;
        },
        clearQueue: () => {
          log.push("clearQueue");
          fake.queue.length = 0;
          fake.pendingMessageCount = 0;
        },
        abort: async () => {
          log.push("abort");
          aborted = true;
          for (const resolve of abortWaiters.splice(0)) resolve();
        },
        abortRetry: () => log.push("abortRetry"),
        dispose: () => log.push("dispose"),
        getLastAssistantText: () => script.lastAssistantText?.() ?? "",
      };
      session = fake;
      return { session: fake };
    },
  };
  return {
    sdk,
    log,
    prompts,
    promptOptions,
    session: () => session,
  };
}

/** Pi delivering one queued steer: the user message_end it emits. */
const deliverSteer = (ctx: ScriptCtx, text = ctx.session.queue[0]!) => {
  const index = ctx.session.queue.indexOf(text);
  if (index >= 0) ctx.session.queue.splice(index, 1);
  ctx.session.pendingMessageCount = ctx.session.queue.length;
  ctx.emit({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  });
};

describe("runPi turn characterization (scripted fake SDK)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-turn-"));
  const cfgPath = join(dir, "pi.json");
  const storePath = join(dir, "codex-accounts.json");
  let prevCfg: string | undefined;
  let prevStore = "";
  let previousSdkPromise: unknown;
  let forwarded: Array<{ engineSessionId: string; line: AnyEvent }> = [];
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  let key = "";
  let accountId = "";

  beforeAll(() => {
    writeFileSync(cfgPath, JSON.stringify({ enabled: true }));
    prevCfg = process.env.OPENSESSION_PI_CONFIG;
    process.env.OPENSESSION_PI_CONFIG = cfgPath;
    prevStore = __setCodexAccountsPathForTest(storePath);
  });
  afterAll(() => {
    if (prevCfg === undefined) delete process.env.OPENSESSION_PI_CONFIG;
    else process.env.OPENSESSION_PI_CONFIG = prevCfg;
    __setCodexAccountsPathForTest(prevStore);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A fresh strict-pinned API-key account per test: a usage-limit terminal
    // sidelines the account it ran on, which must not leak into the next test.
    accountId = `acct-${crypto.randomUUID()}`;
    writeFileSync(
      storePath,
      JSON.stringify({
        accounts: [
          {
            id: accountId,
            name: "org-key",
            kind: "api_key",
            value: "test-runtime-key",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    key = `pi-turn-${crypto.randomUUID()}`;
    forwarded = [];
    setTranscriptForwarder((engineSessionId, lines) => {
      for (const line of lines) forwarded.push({ engineSessionId, line });
    });
    warn = spyOn(console, "warn").mockImplementation(() => {});
    previousSdkPromise = (globalThis as any).__piSdkPromise;
  });
  afterEach(() => {
    (globalThis as any).__piSdkPromise = previousSdkPromise;
    setTranscriptForwarder(undefined);
    warn.mockRestore();
    rmSync(join(PI_STATE_DIR, "sessions", key), {
      recursive: true,
      force: true,
    });
  });

  const turnOpts = (extra: Record<string, unknown> = {}) => ({
    prompt: "hi",
    cwd: dir,
    mode: "ask" as const,
    mcpServers: [],
    journal: { kind: "prompt" },
    accountId,
    accountStrict: true,
    disableLocalWorkspaceTools: true,
    // Map-only unified id: transcript lines persist (through the forwarder)
    // without a journal or a store write.
    transcriptSessionId: key,
    ...extra,
  });

  /** console.warn lines from markCodexExhausted: the account was sidelined. */
  const sidelineWarnings = () =>
    warn.mock.calls
      .map(([message]: unknown[]) => String(message))
      .filter((message: string) => message.includes("marked exhausted"));

  const installSdk = (sdk: unknown) => {
    (globalThis as any).__piSdkPromise = Promise.resolve(sdk);
  };

  const runTurn = async (
    script: Script,
    extra: Record<string, unknown> = {},
  ) => {
    const fake = scriptedSdk(script);
    installSdk(fake.sdk);
    const events: AnyEvent[] = [];
    for await (const event of runPi(turnOpts(extra) as any, MODEL)) {
      events.push(event as AnyEvent);
    }
    // The turn's own lines, keyed by the pi session id. The context log also
    // forwards (under the unified id); that is not this file's concern.
    const piSessionId = fake.session()?.sessionId;
    const lines = forwarded
      .filter((f) => f.engineSessionId === piSessionId)
      .map((f) => f.line);
    return { ...fake, events, lines };
  };

  // ── 1. Text and thinking deltas ──────────────────────────────────────────
  test("text and thinking deltas stream as text_chunk in arrival order", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(textDelta("Let me ", "thinking_delta"));
        ctx.emit(textDelta("think. "));
        // Ignored: other assistant event kinds and non-string deltas.
        ctx.emit(textDelta("{", "toolcall_delta"));
        ctx.emit(textDelta(42));
        ctx.emit({ type: "message_update" });
        ctx.emit(textDelta("Done.", "thinking_delta"));
        ctx.emit(assistantEnd([{ type: "text", text: "Done." }]));
      },
      lastAssistantText: () => "Done.",
    });
    const piSessionId = turn.session()!.sessionId;
    expect(turn.events).toEqual([
      { type: "init", sessionId: piSessionId, provider: "pi", model: MODEL },
      // Thinking and reply text stream in arrival order, each with its kind
      // (no blockId: these deltas carry no content index).
      { type: "text_chunk", text: "Let me ", kind: "reasoning" },
      { type: "text_chunk", text: "think. ", kind: "text" },
      { type: "text_chunk", text: "Done.", kind: "reasoning" },
      // No usage on any message: done carries no usage field at all.
      {
        type: "done",
        sessionId: piSessionId,
        result: "Done.",
        provider: "pi",
        model: MODEL,
      },
    ]);
    // The engine gets the fenced session context, then the prompt.
    expect(turn.prompts).toHaveLength(1);
    expect(turn.prompts[0]).toStartWith(
      '<opensession:context source="session">',
    );
    expect(turn.prompts[0]).toEndWith("\n\nhi");
    expect(turn.promptOptions[0]).toEqual({
      images: undefined,
      expandPromptTemplates: false,
    });
    expect(turn.log).toEqual([
      "createAgentSession",
      "setSteeringMode:all",
      "prompt",
      "unsubscribe",
      "dispose",
    ]);
  });

  // ── 2. Tool execution events ─────────────────────────────────────────────
  test("tool start/end stream as cards; nested calls are skipped, results are cut at 500 chars", async () => {
    const long = "x".repeat(600);
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "codemode",
          args: { script: "1" },
        });
        // A codemode script's own call: no live card.
        ctx.emit({
          type: "tool_execution_start",
          toolCallId: "call-1/1",
          parentToolCallId: "call-1",
          toolName: "read",
          args: { path: "a.txt" },
        });
        ctx.emit({
          type: "tool_execution_end",
          toolCallId: "call-1/1",
          parentToolCallId: "call-1",
          result: { content: [{ type: "text", text: "nested" }] },
        });
        ctx.emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          result: {
            content: [
              { type: "text", text: long },
              { type: "image", data: "QUJD" },
              { type: "image", data: "REVG", mimeType: "image/jpeg" },
            ],
          },
        });
        // Missing name, args and result.
        ctx.emit({ type: "tool_execution_start", toolCallId: 7 });
        ctx.emit({ type: "tool_execution_end", toolCallId: 7 });
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    expect(turn.events.filter((e) => e.type.startsWith("tool_"))).toEqual([
      {
        type: "tool_use",
        toolName: "codemode",
        toolInput: { script: "1" },
        toolUseId: "call-1",
      },
      {
        type: "tool_result",
        toolUseId: "call-1",
        content: `${"x".repeat(500)}...`,
        images: ["data:image/png;base64,QUJD", "data:image/jpeg;base64,REVG"],
      },
      { type: "tool_use", toolName: "tool", toolInput: {}, toolUseId: "7" },
      { type: "tool_result", toolUseId: "7", content: "" },
    ]);
    // Execution events persist nothing; only message_end does.
    expect(turn.lines.map((l) => l.type)).toEqual(["user", "assistant"]);
  });

  // ── 3. Assistant message_end ─────────────────────────────────────────────
  test("assistant message_end persists its blocks and emits cumulative usage", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(
          assistantEnd(
            [
              { type: "thinking", thinking: "plan" },
              { type: "text", text: "Hello" },
              { type: "toolCall", id: "c1", name: "bash", arguments: { x: 1 } },
            ],
            {
              stopReason: "toolUse",
              usage: usage(10, 2, 3, 4, 0.5),
              timestamp: Date.parse("2030-01-01T00:00:00.000Z"),
            },
          ),
        );
        // No usage, or a malformed one: no snapshot, nothing counted.
        ctx.emit(assistantEnd([], { stopReason: "toolUse" }));
        ctx.emit(
          assistantEnd([], { stopReason: "toolUse", usage: { input: "1" } }),
        );
        ctx.emit(
          assistantEnd([{ type: "text", text: "Bye" }], {
            usage: usage(20, 5, 1, 0, 0.25),
          }),
        );
      },
      lastAssistantText: () => "Bye",
    });
    const snapshots = turn.events.filter((e) => e.type === "usage_snapshot");
    expect(snapshots).toEqual([
      {
        type: "usage_snapshot",
        usage: {
          costUsd: 0.5,
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          contextTokens: 17,
        },
      },
      {
        type: "usage_snapshot",
        usage: {
          costUsd: 0.75,
          inputTokens: 30,
          outputTokens: 7,
          cacheReadTokens: 4,
          cacheCreationTokens: 4,
          // The latest request's context, not a sum.
          contextTokens: 21,
        },
      },
    ]);
    expect(turn.events.at(-1)).toEqual({
      type: "done",
      sessionId: turn.session()!.sessionId,
      result: "Bye",
      provider: "pi",
      model: MODEL,
      usage: snapshots[1]!.usage,
    });
    const [user, thinking, hello, toolUse, bye] = turn.lines;
    expect(turn.lines).toHaveLength(5);
    expect(user).toEqual({
      type: "user",
      uuid: expect.any(String),
      timestamp: expect.any(String),
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    expect(thinking).toEqual({
      type: "assistant",
      uuid: expect.any(String),
      timestamp: "2030-01-01T00:00:00.000Z",
      isReasoning: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "plan" }],
        model: "gpt-6.1-sol",
      },
    });
    // Prose blocks of one message share a minted id with a -bN suffix.
    expect(hello).toEqual({
      type: "assistant",
      uuid: `${thinking!.uuid}-b1`,
      timestamp: "2030-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        model: "gpt-6.1-sol",
      },
    });
    // Tool calls key on the model's block id.
    expect(toolUse).toEqual({
      type: "assistant",
      uuid: "c1-use",
      timestamp: "2030-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "bash", input: { x: 1 } },
        ],
      },
    });
    expect(bye).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "text", text: "Bye" }] },
    });
  });

  // ── 4. stopReason error / aborted ────────────────────────────────────────
  test("an error-stopped message persists nothing and the terminal error carries usage", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(
          assistantEnd([{ type: "text", text: "partial" }], {
            stopReason: "error",
            errorMessage: "socket hang up",
            usage: usage(5, 1),
          }),
        );
      },
    });
    expect(turn.events.slice(1)).toEqual([
      {
        type: "usage_snapshot",
        usage: {
          costUsd: 0,
          inputTokens: 5,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 5,
        },
      },
      {
        type: "error",
        content: "pi: socket hang up",
        provider: "pi",
        model: MODEL,
        usage: {
          costUsd: 0,
          inputTokens: 5,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 5,
        },
      },
    ]);
    expect(turn.lines.map((l) => l.type)).toEqual(["user"]);
  });

  test("an aborted message without a cancel persists its partial and ends in error", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(
          assistantEnd([{ type: "text", text: "partial" }], {
            stopReason: "aborted",
          }),
        );
      },
    });
    expect(turn.events.at(-1)).toEqual({
      type: "error",
      content: "pi: run ended with stopReason aborted",
      provider: "pi",
      model: MODEL,
    });
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual([
      "hi",
      "partial",
    ]);
  });

  // ── 5. toolResult message_end ────────────────────────────────────────────
  test("a toolResult message persists as <id>-result with text, images and isError", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        for (const message of [
          {
            role: "toolResult",
            toolCallId: "c1",
            isError: true,
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
              { type: "image", data: "AAA", mimeType: "image/gif" },
            ],
            timestamp: Date.parse("2030-01-01T00:00:00.000Z"),
          },
          {
            role: "toolResult",
            toolCallId: "c2",
            content: "plain",
            timestamp: Date.parse("2030-01-01T00:00:01.000Z"),
          },
          // No toolCallId: dropped.
          { role: "toolResult", content: "orphan" },
        ]) {
          ctx.emit({ type: "message_end", message });
        }
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    expect(turn.lines.slice(1, 3)).toEqual([
      {
        type: "user",
        uuid: "c1-result",
        timestamp: "2030-01-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "c1",
              content: [
                { type: "text", text: "line 1\nline 2" },
                {
                  type: "image",
                  source: { type: "url", url: "data:image/gif;base64,AAA" },
                },
              ],
              is_error: true,
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "c2-result",
        timestamp: "2030-01-01T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c2", content: "plain" },
          ],
        },
      },
    ]);
    expect(turn.lines).toHaveLength(4);
    // No stream event for a toolResult message.
    expect(turn.events.map((e) => e.type)).toEqual(["init", "done"]);
  });

  // ── 6. Compaction ────────────────────────────────────────────────────────
  test("compaction_end folds its usage but leaves contextTokens alone", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(
          assistantEnd([{ type: "text", text: "a" }], {
            stopReason: "toolUse",
            usage: usage(10, 2, 3, 4, 0.5),
          }),
        );
        ctx.emit({
          type: "compaction_end",
          aborted: false,
          result: { summary: "Earlier work", usage: usage(100, 20, 5, 6, 1) },
        });
        // Ignored: an aborted compaction, and one with no summary.
        ctx.emit({
          type: "compaction_end",
          aborted: true,
          result: { summary: "x", usage: usage(1000, 0) },
        });
        // characterization: usage from a summary-less compaction is dropped.
        ctx.emit({
          type: "compaction_end",
          aborted: false,
          result: { usage: usage(1000, 0) },
        });
      },
    });
    const snapshots = turn.events
      .filter((e) => e.type === "usage_snapshot")
      .map((e) => e.usage);
    expect(snapshots).toEqual([
      {
        costUsd: 0.5,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        contextTokens: 17,
      },
      {
        costUsd: 1.5,
        inputTokens: 110,
        outputTokens: 22,
        cacheReadTokens: 8,
        cacheCreationTokens: 10,
        contextTokens: 17,
      },
    ]);
    expect(turn.events.at(-1)).toMatchObject({
      type: "done",
      usage: snapshots[1],
    });
    expect(turn.lines.at(-1)).toEqual({
      type: "user",
      uuid: expect.any(String),
      timestamp: expect.any(String),
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<compaction-summary>Earlier work</compaction-summary>",
          },
        ],
      },
    });
    expect(turn.lines).toHaveLength(3);
  });

  // ── 7. Transient auto-retry ──────────────────────────────────────────────
  test("a transient auto-retry becomes a visible, persisted notice", async () => {
    const error = `503 upstream ${"e".repeat(400)}`;
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit({
          type: "auto_retry_start",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 2_500,
          errorMessage: error,
        });
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    const notice = `pi auto-retry 2/3 in 3s — ${error.slice(0, 300)}`;
    expect(turn.events.filter((e) => e.type === "runner_notice")).toEqual([
      { type: "runner_notice", text: notice },
    ]);
    expect(turn.lines[1]).toEqual({
      type: "user",
      uuid: expect.any(String),
      timestamp: expect.any(String),
      message: {
        role: "user",
        content: [
          { type: "text", text: `<runner-notice>${notice}</runner-notice>` },
        ],
      },
    });
    expect(turn.log).not.toContain("abortRetry");
  });

  // ── 7b. A bound MCP server that can't be listed ─────────────────────────
  test("a bound MCP server that can't be listed becomes a visible, persisted notice", async () => {
    const broken = createSdkMcpServer({ name: "acme", tools: [] });
    broken.instance.connect = async () => {
      throw new Error('Streamable HTTP error: {"error": "invalid_token"}');
    };
    const turn = await runTurn(
      {
        onPrompt: (ctx) => {
          ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
        },
      },
      { inProcessMcp: { acme: broken } },
    );
    const notice =
      'MCP server "acme" is not available in this session: Streamable HTTP error: {"error": "invalid_token"}';
    expect(turn.events.filter((e) => e.type === "runner_notice")).toEqual([
      { type: "runner_notice", text: notice },
    ]);
    expect(turn.lines[1]).toEqual({
      type: "user",
      uuid: expect.any(String),
      timestamp: expect.any(String),
      message: {
        role: "user",
        content: [
          { type: "text", text: `<runner-notice>${notice}</runner-notice>` },
        ],
      },
    });
  });

  // ── 8. Usage-limit auto-retry ────────────────────────────────────────────
  test("a usage-limit auto-retry is cut short with abortRetry on the next microtask", async () => {
    const limit = "Codex error: The usage limit has been reached";
    let syncAbortRetry: boolean | undefined;
    let microtaskAbortRetry: boolean | undefined;
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        ctx.emit({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2_000,
          errorMessage: limit,
        });
        syncAbortRetry = ctx.log.includes("abortRetry");
        await Promise.resolve();
        microtaskAbortRetry = ctx.log.includes("abortRetry");
        ctx.emit(
          assistantEnd([], {
            stopReason: "error",
            errorMessage: limit,
            usage: usage(0, 0),
          }),
        );
      },
    });
    expect(syncAbortRetry).toBe(false);
    expect(microtaskAbortRetry).toBe(true);
    expect(turn.events.filter((e) => e.type === "runner_notice")).toEqual([]);
    expect(turn.lines.map((l) => l.type)).toEqual(["user"]);
    expect(turn.events.at(-1)).toEqual({
      type: "error",
      content: `pi: ${limit}`,
      provider: "pi",
      model: MODEL,
      usage: {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 0,
      },
      usageLimitExhausted: true,
    });
    // The in-band limit sidelines the account; the strict pin never rotates.
    expect(turn.events.filter((e) => e.type === "init")).toHaveLength(1);
    expect(sidelineWarnings()).toHaveLength(1);
  });

  // ── 9. Empty finishes ────────────────────────────────────────────────────
  test("an empty finish is retried once, then leaves a chip", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(assistantEnd([], { usage: usage(1, 0) }));
      },
    });
    expect(turn.prompts).toHaveLength(2);
    expect(turn.prompts[1]).toBe(
      wrapContext(EMPTY_REPLY_RETRY_PROMPT, "auto-continue"),
    );
    expect(turn.promptOptions[1]).toEqual({ expandPromptTemplates: false });
    expect(turn.events.filter((e) => e.type !== "usage_snapshot")).toEqual([
      expect.objectContaining({ type: "init" }),
      {
        type: "runner_notice",
        text: "Model returned an empty response — asking it once more to finish its reply",
      },
      {
        type: "done",
        sessionId: turn.session()!.sessionId,
        // characterization: an empty last assistant text becomes undefined.
        result: undefined,
        provider: "pi",
        model: MODEL,
        usage: expect.objectContaining({ inputTokens: 2 }),
      },
    ]);
    // characterization: the "asking once more" notice is stream-only; only
    // the final chip is persisted.
    expect(turn.lines.slice(1)).toEqual([
      {
        type: "user",
        uuid: expect.any(String),
        timestamp: expect.any(String),
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<runner-notice>The model ended this turn with an empty response (no text or tool calls) and an automatic retry produced nothing too. Send another message to continue.</runner-notice>",
            },
          ],
        },
      },
    ]);
  });

  test("an empty finish followed by a real reply leaves no chip", async () => {
    const turn = await runTurn({
      onPrompt: (ctx) => {
        ctx.emit(
          assistantEnd(ctx.index === 0 ? [] : [{ type: "text", text: "Here" }]),
        );
      },
      lastAssistantText: () => "Here",
    });
    expect(turn.prompts).toHaveLength(2);
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual([
      "hi",
      "Here",
    ]);
    expect(turn.events.at(-1)).toMatchObject({ type: "done", result: "Here" });
  });

  // ── 10. Steer delivery ───────────────────────────────────────────────────
  test("a delivered steer emits steer_delivered and persists under its steer id", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        // The prompt's own echo is not a steer.
        ctx.emit({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: ctx.text }],
          },
        });
        ctx.emit(
          assistantEnd([{ type: "text", text: "working" }], {
            stopReason: "toolUse",
          }),
        );
        expect(steerPiRun(key, "also check docs", undefined, "s1")).toBe(true);
        // A repeat of the same steer id is accepted without queueing again.
        expect(steerPiRun(key, "also check docs", undefined, "s1")).toBe(true);
        expect(steerPiRun(key, "and tests")).toBe(true);
        await waitFor(() => ctx.session.queue.length === 2, "two steers");
        deliverSteer(ctx);
        deliverSteer(ctx);
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
      lastAssistantText: () => "ok",
    });
    expect(turn.log.filter((entry) => entry.startsWith("steer:"))).toEqual([
      "steer:also check docs",
      "steer:and tests",
    ]);
    expect(turn.log).not.toContain("agent.abort");
    // Only a steer with an id gets a delivery receipt.
    expect(turn.events.filter((e) => e.type === "steer_delivered")).toEqual([
      { type: "steer_delivered", steerId: "s1" },
    ]);
    expect(turn.lines.map((l) => [l.type, l.message.content[0].text])).toEqual([
      ["user", "hi"],
      ["assistant", "working"],
      ["user", "also check docs"],
      ["user", "and tests"],
      ["assistant", "ok"],
    ]);
    expect(turn.lines[2]).toEqual({
      type: "user",
      uuid: "s1",
      timestamp: expect.any(String),
      message: {
        role: "user",
        content: [{ type: "text", text: "also check docs" }],
      },
    });
    expect(turn.lines[3]!.uuid).not.toBe("s1");
    // Once the turn is over nothing is steerable.
    expect(steerPiRun(key, "late")).toBe(false);
  });

  // ── 11. Retraction ───────────────────────────────────────────────────────
  test("retracting a queued steer rebuilds pi's queue in the original order", async () => {
    let secondRetract: boolean | undefined;
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        steerPiRun(key, "a", undefined, "s1");
        steerPiRun(key, "b", undefined, "s2");
        steerPiRun(key, "c", undefined, "s3");
        await waitFor(() => ctx.session.queue.length === 3, "three steers");
        expect(retractPiSteer(key, "s2")).toBe(true);
        secondRetract = retractPiSteer(key, "s2");
        await waitFor(
          () => ctx.log.filter((e) => e.startsWith("steer:")).length === 5,
          "queue rebuild",
        );
        expect(ctx.session.queue).toEqual(["a", "c"]);
        deliverSteer(ctx);
        deliverSteer(ctx);
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    expect(secondRetract).toBe(false);
    expect(turn.log.slice(turn.log.indexOf("prompt") + 1, -2)).toEqual([
      "steer:a",
      "steer:b",
      "steer:c",
      "clearQueue",
      "steer:a",
      "steer:c",
    ]);
    expect(turn.events.filter((e) => e.type === "steer_delivered")).toEqual([
      { type: "steer_delivered", steerId: "s1" },
      { type: "steer_delivered", steerId: "s3" },
    ]);
  });

  test("a steer retracted while still staging never reaches pi", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        steerPiRun(key, "a", undefined, "s1");
        expect(retractPiSteer(key, "s1")).toBe(true);
        await waitFor(() => ctx.log.includes("clearQueue"), "clearQueue");
        // The retraction frees the id: the same steer is accepted again.
        expect(steerPiRun(key, "a", undefined, "s1")).toBe(true);
        await waitFor(() => ctx.session.queue.length === 1, "re-steer");
        deliverSteer(ctx);
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    expect(turn.log.slice(turn.log.indexOf("prompt") + 1, -2)).toEqual([
      "clearQueue",
      "steer:a",
    ]);
    expect(turn.events.filter((e) => e.type === "steer_delivered")).toEqual([
      { type: "steer_delivered", steerId: "s1" },
    ]);
  });

  // ── 12. Steer during a thinking-only response ────────────────────────────
  test("a steer during a thinking-only response aborts the request and drops the thinking", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        const agent = ctx.session.agent;
        agent.state.streamingMessage = {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }],
        };
        ctx.emit({ type: "message_start", message: { role: "assistant" } });
        ctx.emit(textDelta("hmm", "thinking_delta"));
        steerPiRun(key, "do X instead", undefined, "s1");
        await ctx.untilAgentAborted();
        agent.state.streamingMessage = undefined;
        ctx.emit(
          assistantEnd([{ type: "thinking", thinking: "hmm" }], {
            stopReason: "aborted",
          }),
        );
        deliverSteer(ctx);
        ctx.emit({ type: "message_start", message: { role: "assistant" } });
        ctx.emit(assistantEnd([{ type: "text", text: "doing X" }]));
      },
      lastAssistantText: () => "doing X",
    });
    // The agent's request is cut, never the session.
    expect(turn.log.slice(turn.log.indexOf("prompt") + 1, -2)).toEqual([
      "steer:do X instead",
      "agent.abort",
    ]);
    expect(turn.lines.map((l) => [l.type, l.message.content[0].text])).toEqual([
      ["user", "hi"],
      ["user", "do X instead"],
      ["assistant", "doing X"],
    ]);
    expect(turn.events.at(-1)).toMatchObject({
      type: "done",
      result: "doing X",
    });
  });

  test("a steer queued before the first token cuts the response at message_start", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        steerPiRun(key, "wait", undefined, "s1");
        await waitFor(() => ctx.session.queue.length === 1, "steer");
        expect(ctx.log).not.toContain("agent.abort");
        ctx.session.agent.state.streamingMessage = {
          role: "assistant",
          content: [],
        };
        ctx.emit({ type: "message_start", message: { role: "assistant" } });
        expect(ctx.log).toContain("agent.abort");
        ctx.session.agent.state.streamingMessage = undefined;
        // The cut message carried output after all: it still persists.
        ctx.emit(
          assistantEnd([{ type: "text", text: "half" }], {
            stopReason: "aborted",
          }),
        );
        deliverSteer(ctx);
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual([
      "hi",
      "half",
      "wait",
      "ok",
    ]);
  });

  test("a steer while the response already has text does not interrupt it", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        ctx.session.agent.state.streamingMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
        };
        ctx.emit({ type: "message_start", message: { role: "assistant" } });
        steerPiRun(key, "also", undefined, "s1");
        await waitFor(() => ctx.session.queue.length === 1, "steer");
        ctx.session.agent.state.streamingMessage = undefined;
        ctx.emit(assistantEnd([{ type: "text", text: "Answer" }]));
        deliverSteer(ctx);
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
      },
    });
    expect(turn.log).not.toContain("agent.abort");
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual([
      "hi",
      "Answer",
      "also",
      "ok",
    ]);
  });

  // ── 13. Steer drain ──────────────────────────────────────────────────────
  test("a steer still queued when the prompt settles drives agent.continue at most twice", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
        steerPiRun(key, "late", undefined, "s1");
        await waitFor(() => ctx.session.queue.length === 1, "steer");
      },
      // pi never delivers it.
      onContinue: () => {},
      lastAssistantText: () => "ok",
    });
    expect(turn.log.slice(turn.log.indexOf("prompt") + 1)).toEqual([
      "steer:late",
      "agent.continue",
      "agent.continue",
      "unsubscribe",
      "dispose",
    ]);
    // characterization: an undelivered steer still ends the turn as done
    // (it is only audited as steer_undelivered).
    expect(turn.events.filter((e) => e.type === "steer_delivered")).toEqual([]);
    expect(turn.events.at(-1)).toMatchObject({ type: "done", result: "ok" });
  });

  // ── 14. Cancel before the session exists ─────────────────────────────────
  test("a cancel while createAgentSession is pending never prompts and ends quietly", async () => {
    const turn = await runTurn({
      beforeCreate: () => {
        expect(cancelPiRun(key)).toBe(true);
      },
    });
    // characterization: init is still emitted and the user line still
    // persisted; there is no terminal event.
    expect(turn.events).toEqual([
      {
        type: "init",
        sessionId: turn.session()!.sessionId,
        provider: "pi",
        model: MODEL,
      },
    ]);
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual(["hi"]);
    expect(turn.prompts).toEqual([]);
    expect(turn.log).toEqual([
      "createAgentSession",
      "setSteeringMode:all",
      "abort",
      "unsubscribe",
      "dispose",
    ]);
    expect(isPiSessionBusy(key)).toBe(false);
    expect(isPiSessionBusy(turn.session()!.sessionId)).toBe(false);
  });

  // ── 15. Cancel mid-prompt ────────────────────────────────────────────────
  test("a cancel mid-prompt aborts the session, keeps the partial and ends quietly", async () => {
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        ctx.emit({ type: "message_start", message: { role: "assistant" } });
        ctx.emit(textDelta("par"));
        expect(cancelPiRun(key)).toBe(true);
        await ctx.untilAborted();
        ctx.emit(
          assistantEnd([{ type: "text", text: "partial" }], {
            stopReason: "aborted",
            usage: usage(3, 1),
          }),
        );
      },
    });
    expect(turn.events.map((e) => e.type)).toEqual([
      "init",
      // The assistant message_start opens the model phase.
      "phase",
      "text_chunk",
      "usage_snapshot",
    ]);
    expect(turn.log.slice(turn.log.indexOf("prompt") + 1)).toEqual([
      "abort",
      "unsubscribe",
      "dispose",
    ]);
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual([
      "hi",
      "partial",
    ]);
    expect(isPiSessionBusy(key)).toBe(false);
    // A cancelled turn discards its checkpoint rather than flushing it.
    expect(
      existsSync(join(PI_STATE_DIR, "sessions", key, PI_TURN_CHECKPOINT_FILE)),
    ).toBe(false);
  });

  // ── 16. Consumer teardown ────────────────────────────────────────────────
  test("a consumer .return() aborts and disposes the session and clears the registry", async () => {
    const fake = scriptedSdk({
      onPrompt: async (ctx) => {
        ctx.emit({ type: "message_start", message: { role: "assistant" } });
        ctx.emit(textDelta("streaming"));
        await ctx.untilAborted();
      },
    });
    installSdk(fake.sdk);
    const turn = runPi(turnOpts() as any, MODEL);
    expect((await turn.next()).value).toMatchObject({ type: "init" });
    expect((await turn.next()).value).toMatchObject({
      type: "phase",
      phase: "model",
    });
    expect((await turn.next()).value).toEqual({
      type: "text_chunk",
      text: "streaming",
      kind: "text",
    });
    const piSessionId = fake.session()!.sessionId;
    expect(isPiSessionBusy(key)).toBe(true);
    expect(isPiSessionBusy(piSessionId)).toBe(true);
    expect(await turn.return(undefined)).toEqual({
      done: true,
      value: undefined,
    });
    expect(fake.log.slice(fake.log.indexOf("prompt") + 1)).toEqual([
      "abort",
      "dispose",
    ]);
    // characterization: the teardown path never unsubscribes from pi.
    expect(fake.log).not.toContain("unsubscribe");
    expect(isPiSessionBusy(key)).toBe(false);
    expect(isPiSessionBusy(piSessionId)).toBe(false);
    // A turn torn down mid-run flushes its checkpoint for the next turn.
    const checkpoint = JSON.parse(
      readFileSync(
        join(PI_STATE_DIR, "sessions", key, PI_TURN_CHECKPOINT_FILE),
        "utf8",
      ),
    );
    expect(checkpoint).toMatchObject({
      version: 1,
      piSessionId,
      reply: { text: "streaming" },
      tools: {},
    });
  });

  // ── 17. createAgentSession throws ────────────────────────────────────────
  test.each([
    { message: "socket closed", flagged: false, limit: false },
    // characterization: the pi/openai classifier reads a bare 429 as a
    // usage limit, so this unflagged throw still ends flagged.
    { message: "429 Too Many Requests", flagged: false, limit: true },
    {
      message: "Codex error: The usage limit has been reached",
      flagged: false,
      limit: true,
    },
    { message: "pi/openai: pool is dry", flagged: true, limit: true },
  ])(
    "createAgentSession throwing %j: classifier sets the flag, only the thrown flag sidelines",
    async ({ message, flagged, limit }) => {
      const turn = await runTurn({
        beforeCreate: () => {
          const error = new Error(message) as Error & {
            usageLimitExhausted?: boolean;
          };
          if (flagged) error.usageLimitExhausted = true;
          throw error;
        },
      });
      expect(turn.events).toEqual([
        {
          type: "error",
          content: `pi: ${message}`,
          provider: "pi",
          model: MODEL,
          ...(limit ? { usageLimitExhausted: true } : {}),
        },
      ]);
      expect(sidelineWarnings()).toHaveLength(flagged ? 1 : 0);
      expect(turn.log).toEqual(["createAgentSession"]);
      expect(isPiSessionBusy(key)).toBe(false);
    },
  );

  // ── 18. Resume miss ──────────────────────────────────────────────────────
  test("a resume whose pi session file is gone bridges the transcript into a handoff", async () => {
    const turn = await runTurn(
      {
        onPrompt: (ctx) => {
          ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
        },
      },
      {
        sessionId: `pi-gone-${crypto.randomUUID()}`,
        seedTranscriptEntries: [
          {
            id: "e1",
            type: "user",
            content: "earlier question",
            timestamp: "2030-01-01T00:00:00.000Z",
          },
          {
            id: "e2",
            type: "assistant",
            content: "earlier answer",
            timestamp: "2030-01-01T00:00:01.000Z",
          },
        ],
      },
    );
    const notice =
      "Pi couldn't resume the previous engine session. Continuing in a fresh one with the recent transcript.";
    expect(turn.events.map((e) => e.type)).toEqual([
      "init",
      "runner_notice",
      "done",
    ]);
    expect(turn.events[1]).toEqual({ type: "runner_notice", text: notice });
    expect(turn.lines.map((l) => l.message.content[0].text)).toEqual([
      "hi",
      `<runner-notice>${notice}</runner-notice>`,
      "ok",
    ]);
    const parts = turn.prompts[0]!.split("\n\n<opensession:context");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toStartWith('<opensession:context source="session">');
    expect(parts[1]).toStartWith(' source="handoff">');
    expect(parts[1]).toContain("earlier question");
    expect(parts[1]).toContain("earlier answer");
    expect(parts[1]).toEndWith("</opensession:context>\n\nhi");
  });

  test("a resume miss with no transcript to bridge starts fresh without a notice", async () => {
    const turn = await runTurn(
      {
        onPrompt: (ctx) => {
          ctx.emit(assistantEnd([{ type: "text", text: "ok" }]));
        },
      },
      {
        sessionId: `pi-gone-${crypto.randomUUID()}`,
        seedTranscriptEntries: [],
      },
    );
    expect(turn.events.map((e) => e.type)).toEqual(["init", "done"]);
    expect(turn.prompts[0]).not.toContain('source="handoff"');
  });
});
