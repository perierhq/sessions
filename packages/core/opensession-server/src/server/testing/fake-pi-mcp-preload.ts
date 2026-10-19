/**
 * Preload for a run host under test (runner-host/host-mcp-relay.test.ts):
 * swaps pi's SDK for a scripted one, so host.ts → runAgent → pi-runner run
 * for real with no model.
 *
 * The one prompt starts `opensession-a_wait` and leaves it in flight, calls
 * `opensession-b_echo` through the model's MCP call tool, and ends the turn
 * with the echo's text. The codex account store is pointed at
 * FAKE_PI_ACCOUNTS before anything reads it.
 */
import { MCP_CALL_TOOL } from "@tellahq/opensession-protocol/tool-presentation";
import { __setCodexAccountsPathForTest } from "../codex-accounts";

__setCodexAccountsPathForTest(process.env.FAKE_PI_ACCOUNTS!);

type Emit = (event: Record<string, unknown>) => void;

const sdk = {
  ModelRuntime: {
    create: async () => ({
      getModel: (_provider: string, id: string) => ({ id, name: id }),
      registerProvider: () => {},
      setRuntimeApiKey: async () => {},
    }),
  },
  SettingsManager: { inMemory: () => ({}) },
  DefaultResourceLoader: class {
    async reload() {}
    getSkills() {
      return { skills: [] };
    }
  },
  SessionManager: { create: () => ({}), open: () => ({}) },
  // Pi's codemode extension; the fake loader never runs it.
  createCodemodeExtension: () => () => {},
  // The run's local workspace tools; never called here.
  ...Object.fromEntries(
    ["Read", "Write", "Edit", "Grep", "Find", "Ls"].map((name) => [
      `create${name}ToolDefinition`,
      () => ({
        name: name.toLowerCase(),
        label: name,
        description: name,
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [], details: undefined }),
      }),
    ]),
  ),
  createAgentSession: async ({ sessionManager, customTools }: any) => {
    let listener: Emit = () => {};
    let reply = "";
    const callTool = customTools.find((t: any) => t.name === MCP_CALL_TOOL);
    const session = {
      sessionId: `fake-pi-${crypto.randomUUID()}`,
      sessionManager,
      pendingMessageCount: 0,
      systemPrompt: "",
      state: { tools: [] },
      agent: {
        state: { pendingToolCalls: new Set() },
        hasQueuedMessages: () => false,
        abort: () => {},
        continue: async () => {},
      },
      setSteeringMode: () => {},
      subscribe: (fn: Emit) => {
        listener = fn;
        return () => {
          listener = () => {};
        };
      },
      prompt: async () => {
        // Left in flight: the turn's end must cancel it in the gateway.
        void callTool
          .execute("tc-wait", { name: "opensession-a_wait", arguments: {} })
          .catch(() => {});
        const result = await callTool.execute("tc-echo", {
          name: "opensession-b_echo",
          arguments: { value: "via host" },
        });
        reply = result.content[0].text;
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: reply }],
            timestamp: Date.now(),
          },
        });
      },
      steer: async () => {},
      clearQueue: () => {},
      abort: async () => {},
      abortRetry: () => {},
      dispose: () => {},
      getLastAssistantText: () => reply,
    };
    return { session };
  },
};

(globalThis as any).__piSdkPromise = Promise.resolve(sdk);
