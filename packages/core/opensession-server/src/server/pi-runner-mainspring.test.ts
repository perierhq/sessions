/**
 * runPi with Claude routed through Mainspring, driven through a scripted fake
 * pi SDK (no network). Pins the routing switch, the session affinity the
 * binding registers, the 429/401/503 terminals and the opt-in fallback to
 * the direct accounts. The fake-SDK shape follows pi-runner-turn.test.ts.
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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PI_STATE_DIR, runPi } from "./pi-runner";
import { saveMainspringSettings } from "./mainspring";
import { isTransientRunError } from "./runner-shared";
import { __clearJsonFileCacheForTest } from "./shared/json-file-cache";
import { setTranscriptForwarder } from "./transcript-forward";

const MODEL = "pi/anthropic/claude-sonnet-5-5";
const KEY = "sk-ms-runner-secret-wxyz";

type AnyEvent = Record<string, any>;
type Emit = (event: AnyEvent) => void;

interface Script {
  /** Drives one session.prompt() call; `fetch` runs one request through the
   *  agent's stream function, so the Mainspring hooks see its response. */
  onPrompt?: (ctx: {
    emit: Emit;
    index: number;
    request: (response: Response) => Promise<void>;
    payload: (body: unknown) => Promise<unknown>;
  }) => void | Promise<void>;
}

function scriptedSdk(script: Script) {
  const registered: Array<[string, any]> = [];
  const runtimeKeys: Array<[string, string]> = [];
  let prompts = 0;
  const sdk = {
    ModelRuntime: {
      create: async () => ({
        getModel: (provider: string, id: string) => ({
          id,
          name: id,
          provider,
          api: "anthropic-messages",
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        getModels: () => [],
        registerProvider: (provider: string, config: any) => {
          registered.push([provider, config]);
        },
        setRuntimeApiKey: async (provider: string, key: string) => {
          runtimeKeys.push([provider, key]);
        },
      }),
    },
    SettingsManager: { inMemory: () => ({}) },
    createCodemodeExtension: () => () => {},
    DefaultResourceLoader: class {
      async reload() {}
      getSkills() {
        return { skills: [] };
      }
    },
    SessionManager: { create: () => ({}), open: () => ({}) },
    createAgentSession: async ({ sessionManager }: any) => {
      let listener: Emit = () => {};
      const agent: any = {
        state: { pendingToolCalls: new Set() },
        hasQueuedMessages: () => false,
        abort: () => {},
        continue: async () => {},
        // The base stream function: hands the response the script gives it
        // to whatever fetch the hooks installed.
        streamFunction: async (_model: any, _ctx: any, options: any) =>
          options?.fetch?.("https://mainspring.example.test/v1/messages"),
      };
      const fake: any = {
        sessionId: `fake-pi-${crypto.randomUUID()}`,
        sessionManager,
        pendingMessageCount: 0,
        systemPrompt: "",
        state: { tools: [] },
        agent,
        setSteeringMode: () => {},
        subscribe: (fn: Emit) => {
          listener = fn;
          return () => {
            listener = () => {};
          };
        },
        prompt: async () => {
          const index = prompts++;
          await script.onPrompt?.({
            emit: (event) => listener(event),
            index,
            request: async (response) => {
              await agent.streamFunction(
                { provider: "mainspring", api: "anthropic-messages" },
                {},
                { fetch: async () => response },
              );
            },
            payload: async (body) =>
              agent.onPayload?.(body, {
                provider: "mainspring",
                api: "anthropic-messages",
              }),
          });
        },
        steer: async () => {},
        clearQueue: () => {},
        abort: async () => {},
        abortRetry: () => {},
        dispose: () => {},
        getLastAssistantText: () => "Done.",
      };
      return { session: fake };
    },
  };
  return { sdk, registered, runtimeKeys };
}

const errorEnd = (errorMessage: string): AnyEvent => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [],
    timestamp: Date.now(),
  },
});

const doneEnd: AnyEvent = {
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "Done." }],
    timestamp: Date.now(),
  },
};

describe("runPi through Mainspring (scripted fake SDK)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mainspring-"));
  const saved: Record<string, string | undefined> = {};
  let previousSdkPromise: unknown;
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  let key = "";

  beforeAll(() => {
    writeFileSync(join(dir, "pi.json"), JSON.stringify({ enabled: true }));
    for (const name of [
      "OPENSESSION_PI_CONFIG",
      "OPENSESSION_MODEL_PROVIDERS_CONFIG",
      "OPENSESSION_WORKSPACE_SECRETS_STORE",
    ])
      saved[name] = process.env[name];
    process.env.OPENSESSION_PI_CONFIG = join(dir, "pi.json");
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    key = `pi-mainspring-${crypto.randomUUID()}`;
    process.env.OPENSESSION_MODEL_PROVIDERS_CONFIG = join(
      dir,
      `${key}-providers.json`,
    );
    process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = join(
      dir,
      `${key}-secrets.json`,
    );
    __clearJsonFileCacheForTest();
    setTranscriptForwarder(() => {});
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

  const route = (extra: Record<string, unknown> = {}) =>
    saveMainspringSettings({
      url: "https://mainspring.example.test",
      key: KEY,
      routeClaude: true,
      ...extra,
    });

  const runTurn = async (
    script: Script,
    opts: Record<string, unknown> = {},
  ) => {
    const fake = scriptedSdk(script);
    (globalThis as any).__piSdkPromise = Promise.resolve(fake.sdk);
    const events: AnyEvent[] = [];
    for await (const event of runPi(
      {
        prompt: "hi",
        cwd: dir,
        mode: "ask",
        mcpServers: [],
        journal: { kind: "prompt" },
        disableLocalWorkspaceTools: true,
        transcriptSessionId: key,
        accountAffinityKey: key,
        ...opts,
      } as any,
      MODEL,
    ))
      events.push(event as AnyEvent);
    return { ...fake, events };
  };

  test("with the switch on, Claude registers Mainspring with the key and the session's X-Session-ID", async () => {
    await route();
    let payload: unknown;
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        payload = await ctx.payload({ model: "claude-sonnet-5-5" });
        await ctx.request(
          new Response("{}", {
            headers: { "x-mainspring-account": "alex@example.test" },
          }),
        );
        ctx.emit(doneEnd);
      },
    });
    expect(turn.events.at(-1)).toMatchObject({ type: "done" });
    expect(turn.registered.map(([provider]) => provider)).toEqual([
      "mainspring",
    ]);
    const [, config] = turn.registered[0]!;
    expect(config.baseUrl).toBe("https://mainspring.example.test");
    expect(config.api).toBe("anthropic-messages");
    expect(config.headers).toEqual({ "X-Session-ID": key });
    expect(turn.runtimeKeys).toEqual([["mainspring", KEY]]);
    expect(payload).toEqual({
      model: "claude-sonnet-5-5",
      metadata: { user_id: key },
    });
    // No turn event carries the key.
    expect(JSON.stringify(turn.events)).not.toContain(KEY);
  });

  test("with the switch off, Claude never reaches Mainspring", async () => {
    await route({ routeClaude: false });
    const turn = await runTurn({ onPrompt: (ctx) => ctx.emit(doneEnd) });
    expect(
      turn.registered.some(([provider]) => provider === "mainspring"),
    ).toBe(false);
    expect(
      turn.runtimeKeys.some(([provider]) => provider === "mainspring"),
    ).toBe(false);
  });

  test("a 429 ends as a usage limit with the resting copy and Retry-After as the reset", async () => {
    await route();
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        await ctx.request(
          new Response("{}", {
            status: 429,
            headers: { "retry-after": "7200" },
          }),
        );
        ctx.emit(
          errorEnd(
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"every Claude account is resting"}}',
          ),
        );
      },
    });
    const terminal = turn.events.at(-1)!;
    expect(terminal.type).toBe("error");
    expect(terminal.usageLimitExhausted).toBe(true);
    expect(terminal.content).toMatch(
      /^pi: Every Claude account in Mainspring is resting until [A-Z][a-z]{2} \d{1,2}, \d{1,2}(?::\d{2})?(?:am|pm) \(UTC\)\.$/,
    );
    // No silent move to the local accounts.
    expect(turn.registered.map(([provider]) => provider)).toEqual([
      "mainspring",
    ]);
  });

  test("a 401 says the key was refused and is not a usage limit", async () => {
    await route();
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        await ctx.request(new Response("{}", { status: 401 }));
        ctx.emit(
          errorEnd(
            '401 {"type":"error","error":{"type":"authentication_error"}}',
          ),
        );
      },
    });
    const terminal = turn.events.at(-1)!;
    expect(terminal.content).toStartWith("pi: Mainspring key was refused");
    expect(terminal.usageLimitExhausted).toBeUndefined();
  });

  test("a 503 is a retryable provider error", async () => {
    await route();
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        await ctx.request(new Response("{}", { status: 503 }));
        ctx.emit(errorEnd("503 no account connected"));
      },
    });
    const terminal = turn.events.at(-1)!;
    expect(terminal.content).toContain("Mainspring is unavailable (503)");
    expect(terminal.usageLimitExhausted).toBeUndefined();
  });

  test("a refused connection or a timeout is Mainspring unavailable, and retryable", async () => {
    await route();
    for (const failure of ["Connection error.", "Request timed out."]) {
      const turn = await runTurn({
        onPrompt: (ctx) => ctx.emit(errorEnd(failure)),
      });
      const terminal = turn.events.at(-1)!;
      expect(terminal.content).toContain(
        "Mainspring is unavailable: the connection was refused or timed out",
      );
      expect(isTransientRunError(String(terminal.content))).toBe(true);
      expect(terminal.usageLimitExhausted).toBeUndefined();
    }
  });

  test("with fallback on, a refused connection moves to the direct accounts", async () => {
    await route({ fallbackDirect: true });
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        if (ctx.index === 0)
          ctx.emit(errorEnd("connect ECONNREFUSED 10.0.0.2:8080"));
        else ctx.emit(doneEnd);
      },
    });
    expect(turn.events).toContainEqual({
      type: "runner_notice",
      text: "Mainspring couldn't serve this turn. Continuing on the direct Claude accounts.",
    });
  });

  test("with fallback on, a failed Mainspring turn moves to the direct accounts", async () => {
    await route({ fallbackDirect: true });
    const turn = await runTurn({
      onPrompt: async (ctx) => {
        if (ctx.index === 0) {
          await ctx.request(new Response("{}", { status: 503 }));
          ctx.emit(errorEnd("503 upstream failed"));
        } else ctx.emit(doneEnd);
      },
    });
    expect(turn.events).toContainEqual({
      type: "runner_notice",
      text: "Mainspring couldn't serve this turn. Continuing on the direct Claude accounts.",
    });
    // The second attempt never registered Mainspring again.
    expect(
      turn.registered.filter(([provider]) => provider === "mainspring"),
    ).toHaveLength(1);
    expect(
      turn.runtimeKeys.filter(([provider]) => provider === "mainspring"),
    ).toHaveLength(1);
  });

  test("a strict account pin keeps its direct account", async () => {
    await route();
    const turn = await runTurn(
      { onPrompt: (ctx) => ctx.emit(doneEnd) },
      { accountId: "acct-1", accountStrict: true },
    );
    expect(
      turn.registered.some(([provider]) => provider === "mainspring"),
    ).toBe(false);
  });

  test("pi/mainspring with nothing set up fails before any account is picked", async () => {
    const fake = scriptedSdk({});
    (globalThis as any).__piSdkPromise = Promise.resolve(fake.sdk);
    const events: AnyEvent[] = [];
    for await (const event of runPi(
      {
        prompt: "hi",
        cwd: dir,
        mode: "ask",
        mcpServers: [],
        journal: { kind: "prompt" },
        disableLocalWorkspaceTools: true,
        transcriptSessionId: key,
      } as any,
      "pi/mainspring/gpt-5.6-terra",
    ))
      events.push(event as AnyEvent);
    expect(events.at(-1)!.content).toContain("Mainspring is not set up");
    expect(fake.registered).toEqual([]);
  });
});
