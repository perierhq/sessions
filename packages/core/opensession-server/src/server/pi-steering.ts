import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PiSdk } from "./pi-runtime-binding";

/** Activate exactly the tools backed by custom definitions. Pi falls back to
 * its unrestricted built-ins for enabled names without a custom override, so
 * the enabled-name list must never be maintained separately. */
export function piToolNames(
  customTools: readonly Pick<ToolDefinition<any, any, any>, "name">[],
): string[] {
  return customTools.map((tool) => tool.name);
}

export const PI_STEER_TOOL_SKIP =
  "Skipped because new steering instructions arrived. Read them before choosing the next tool.";

/**
 * Pi polls its steer queue after an assistant message's whole tool batch. That
 * is too late for Open Session's step-boundary contract: a model can emit a
 * long batch, leaving a steer parked behind several not-yet-started tools.
 *
 * Force each batch to execute sequentially and turn every not-yet-started call
 * into a cheap result once a steer is waiting. Pi can then satisfy the model
 * protocol's one-result-per-call requirement and inject the steer without
 * starting stale work.
 */
export function piSteeringBoundaryTools(
  tools: readonly ToolDefinition<any, any, any>[],
  steeringPending: () => boolean,
): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (steeringPending()) {
        // A codemode script's call (pi ids those `<parent>/<n>`) rejects
        // instead, so the script stops rather than reading the notice as data.
        if (isPiNestedToolCall(toolCallId)) throw new Error(PI_STEER_TOOL_SKIP);
        return {
          content: [{ type: "text", text: PI_STEER_TOOL_SKIP }],
          details: {},
        };
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  }));
}

/** The part of pi's Agent a steer interrupt reads and drives. */
export type PiSteerInterruptTarget = {
  readonly state: {
    readonly streamingMessage?: { role: string; content?: unknown };
    readonly pendingToolCalls: ReadonlySet<string>;
  };
  hasQueuedMessages(): boolean;
  abort(): void;
};

/** Whether an assistant message has started anything a person would lose:
 *  reply text or a tool call. Thinking alone does not count. */
export function piResponseHasOutput(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((raw) => {
    const block = raw as { type?: string; text?: unknown } | null;
    if (!block || typeof block !== "object") return false;
    if (block.type === "toolCall") return true;
    return (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    );
  });
}

/**
 * Pi polls its steer queue only between model responses, so a steer sent
 * while the model is still thinking waits for that whole response. With high
 * effort that is often most of a minute, and the person's message sits
 * unread.
 *
 * While the response is still only thinking, cut it short: abort just the
 * agent's current model request, never the session. AgentSession's post-run
 * loop sees the queued steer and continues at once, so the model starts over
 * with the steer in view. Once the response has written reply text or a tool
 * call, it is left to finish, and the steer lands at the next step as before.
 * Running tools are never touched. Returns whether it aborted.
 */
export function interruptPiThinkingForSteer(
  agent: PiSteerInterruptTarget,
): boolean {
  const streaming = agent.state.streamingMessage;
  if (streaming?.role !== "assistant") return false;
  if (piResponseHasOutput(streaming.content)) return false;
  if (agent.state.pendingToolCalls.size > 0) return false;
  if (!agent.hasQueuedMessages()) return false;
  agent.abort();
  return true;
}

/** Pi assigns `<parent id>/<n>` to calls a tool makes through
 *  `ctx.executeTool()`, which is how codemode scripts call tools. */
export function isPiNestedToolCall(toolCallId: string): boolean {
  return toolCallId.includes("/");
}

export const PI_CODEMODE_TOOL = "codemode";

/**
 * Pi's codemode tool: the model writes one JavaScript script that calls the
 * run's other tools, in parallel if it likes, and only the script's output
 * reaches the context. Scripts run in a QuickJS sandbox with no file system
 * or network, and can call only the run's active tools, so every call still
 * goes through our guarded definitions and their audit. Pi registers it
 * through an extension; intercept that registration to give it the same
 * steering boundary as every other tool. `models: false` keeps pi's model
 * catalog and classifier calls out of scripts.
 */
export function piCodemodeExtension(
  sdk: Pick<PiSdk, "createCodemodeExtension">,
  steeringPending: () => boolean,
): ExtensionFactory {
  const register = sdk.createCodemodeExtension({ mode: "on", models: false });
  return (pi) =>
    register(
      new Proxy(pi, {
        get(target, key) {
          if (key === "registerTool") {
            return (tool: ToolDefinition<any, any, any>) =>
              target.registerTool(
                piSteeringBoundaryTools([tool], steeringPending)[0]!,
              );
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
}
