/**
 * What a Pi turn was doing when its process died.
 *
 * Pi writes a message to its session file only when the message ends, so a
 * run host that dies mid-turn loses two things: the reply it was streaming,
 * and the result of every tool still running. On resume Pi's provider layer
 * then fills each missing result with a bare "No result provided", and the
 * model cannot tell whether a `git push` or a deploy ran.
 *
 * While a turn runs, the runner keeps a small checkpoint next to Pi's session
 * file: the streamed reply text and each running tool's output so far,
 * written at most once a second. A turn that ends while its process is alive
 * deletes it. The next turn that opens the same Pi session reads it and
 * repairs the session before the model sees it: every call left without a
 * result gets an explicit "interrupted" result with the output it had
 * produced, and the cut-off reply is handed back to the model, because Pi
 * drops aborted assistant messages from the context it sends.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "fs/promises";
import {
  LEGACY_MCP_SEARCH_TOOL,
  MCP_SEARCH_TOOL,
} from "@tellahq/opensession-protocol/tool-presentation";

export const PI_TURN_CHECKPOINT_FILE = "turn-checkpoint.json";

/** Tail kept from a running tool's output. */
const TOOL_OUTPUT_TAIL = 4_000;
/** Tail kept from the streamed reply. */
const REPLY_TAIL = 8_000;
const WRITE_INTERVAL_MS = 1_000;

/** Tools that only read, so running one again after a crash is harmless.
 *  The legacy search name stays for checkpoints written before the rename. */
export const PI_REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
  MCP_SEARCH_TOOL,
  LEGACY_MCP_SEARCH_TOOL,
]);

export interface PiTurnCheckpoint {
  version: 1;
  piSessionId: string;
  updatedAt: string;
  /** The assistant message being streamed when the checkpoint was written. */
  reply?: { id: string; text: string; startedAt: string };
  /** Top-level tool calls that had started and not ended. */
  tools: Record<string, { toolName: string; output: string }>;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && block.type === "text"
        ? String(block.text ?? "")
        : "",
    )
    .join("");
}

export interface PiTurnCheckpointWriter {
  observe(event: unknown): void;
  /** Write any pending change now. */
  flush(): Promise<void>;
  /** The turn ended with its process alive: nothing to recover. */
  discard(): Promise<void>;
}

export function createPiTurnCheckpointWriter(
  path: string,
  piSessionId: string,
  intervalMs = WRITE_INTERVAL_MS,
): PiTurnCheckpointWriter {
  let reply: PiTurnCheckpoint["reply"];
  const tools: PiTurnCheckpoint["tools"] = {};
  let dirty = false;
  let discarded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Writes are serialized so a slow write can never land after a newer one
  // or after discard().
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>) => {
    chain = chain.then(op).catch((error) => {
      console.warn("[pi-checkpoint] write failed:", error);
    });
    return chain;
  };

  const write = () => {
    timer = undefined;
    if (!dirty || discarded) return chain;
    dirty = false;
    const snapshot: PiTurnCheckpoint = {
      version: 1,
      piSessionId,
      updatedAt: new Date().toISOString(),
      ...(reply?.text ? { reply: { ...reply } } : {}),
      tools: structuredClone(tools),
    };
    const body = JSON.stringify(snapshot);
    return enqueue(async () => {
      if (discarded) return;
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, path);
    });
  };

  const changed = () => {
    if (discarded) return;
    dirty = true;
    if (!timer) {
      timer = setTimeout(write, intervalMs);
      (timer as { unref?: () => void }).unref?.();
    }
  };

  return {
    observe(raw) {
      const event = raw as Record<string, any> | null;
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "message_start":
          if (event.message?.role === "assistant") {
            reply = {
              id: randomUUID(),
              text: "",
              startedAt: new Date().toISOString(),
            };
          }
          break;
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (
            reply &&
            delta?.type === "text_delta" &&
            typeof delta.delta === "string"
          ) {
            reply.text = tail(reply.text + delta.delta, REPLY_TAIL);
            changed();
          }
          break;
        }
        case "message_end":
          if (event.message?.role === "assistant" && reply) {
            reply = undefined;
            changed();
          }
          break;
        case "tool_execution_start":
          if (event.parentToolCallId || !event.toolCallId) break;
          tools[String(event.toolCallId)] = {
            toolName: String(event.toolName || "tool"),
            output: "",
          };
          changed();
          break;
        case "tool_execution_update": {
          const tool = tools[String(event.toolCallId)];
          if (event.parentToolCallId || !tool) break;
          const text = contentText(event.partialResult?.content);
          if (text) {
            tool.output = tail(text, TOOL_OUTPUT_TAIL);
            changed();
          }
          break;
        }
        case "tool_execution_end":
          if (event.parentToolCallId) break;
          if (delete tools[String(event.toolCallId)]) changed();
          break;
      }
    },
    flush() {
      if (timer) clearTimeout(timer);
      return write();
    },
    discard() {
      discarded = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      return enqueue(() => rm(path, { force: true }));
    },
  };
}

/**
 * Read and remove the checkpoint a dead turn left for this Pi session. A
 * checkpoint for another Pi session (the session was replaced since) is
 * removed and ignored.
 */
export async function takePiTurnCheckpoint(
  path: string,
  piSessionId: string,
): Promise<PiTurnCheckpoint | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  await rm(path, { force: true }).catch(() => {});
  const checkpoint = parsed as PiTurnCheckpoint;
  if (
    checkpoint?.version !== 1 ||
    checkpoint.piSessionId !== piSessionId ||
    typeof checkpoint.tools !== "object" ||
    checkpoint.tools === null
  ) {
    return null;
  }
  return checkpoint;
}

/** The slice of Pi's SessionManager the repair needs. */
export interface PiSessionLog {
  getBranch(): Array<{ type: string; message?: any }>;
  appendMessage(message: any): string;
}

export interface DanglingToolCall {
  id: string;
  name: string;
}

/**
 * Tool calls of the session's last assistant message that have no result,
 * when that message is still the tail of the conversation (only its own tool
 * results follow it). Aborted and errored messages are skipped by Pi on
 * replay, so their calls need no result.
 */
export function danglingToolCalls(
  branch: ReturnType<PiSessionLog["getBranch"]>,
): DanglingToolCall[] {
  const answered = new Set<string>();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      if (message.toolCallId) answered.add(String(message.toolCallId));
      continue;
    }
    if (message.role !== "assistant") return [];
    if (message.stopReason === "aborted" || message.stopReason === "error")
      return [];
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter(
        (block: any) =>
          block?.type === "toolCall" &&
          block.id &&
          !answered.has(String(block.id)),
      )
      .map((block: any) => ({
        id: String(block.id),
        name: String(block.name || "tool"),
      }));
  }
  return [];
}

export function interruptedToolResultText(
  toolName: string,
  output: string | undefined,
): string {
  const head = PI_REPLAY_SAFE_TOOLS.has(toolName)
    ? `Interrupted: the run stopped unexpectedly while this call was running, so it returned no result. ${toolName} only reads, so it is safe to run again.`
    : `Interrupted: the run stopped unexpectedly while this call was running, so it returned no result. It may have partly or fully taken effect. Check its effects before running it again.`;
  return output?.trim()
    ? `${head}\n\nOutput before the interruption:\n${output}`
    : `${head}\n\nIt produced no output before the interruption.`;
}

export function interruptedReplyNote(text: string): string {
  return (
    "Your previous reply was cut off when the run stopped unexpectedly. " +
    "It is not in the conversation above. What you had written so far:\n" +
    `"""\n${text}\n"""\n` +
    "Continue from there rather than starting over."
  );
}

export interface PiTurnRepair {
  /** Results appended to the Pi session, in call order. */
  toolResults: Array<{ toolCallId: string; toolName: string; text: string }>;
  /** The reply the dead turn was streaming, if any. */
  reply?: { id: string; text: string; startedAt: string };
}

/**
 * Close every dangling tool call in the Pi session with an explicit
 * interrupted result. Without a log (Pi never flushed the session file) only
 * the reply is recovered.
 */
export function repairInterruptedPiTurn(
  log: PiSessionLog | null,
  checkpoint: PiTurnCheckpoint | null,
): PiTurnRepair {
  const repair: PiTurnRepair = { toolResults: [] };
  if (checkpoint?.reply?.text?.trim()) repair.reply = checkpoint.reply;
  if (!log) return repair;
  for (const call of danglingToolCalls(log.getBranch())) {
    const text = interruptedToolResultText(
      call.name,
      checkpoint?.tools[call.id]?.output,
    );
    log.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text }],
      isError: true,
      timestamp: Date.now(),
    });
    repair.toolResults.push({
      toolCallId: call.id,
      toolName: call.name,
      text,
    });
  }
  return repair;
}
