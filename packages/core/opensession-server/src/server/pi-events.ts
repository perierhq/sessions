import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  formatToolDetail,
  toolDetail,
} from "@tellahq/opensession-protocol/tool-presentation";
import { audit, summarizeText } from "./audit";
import { wrapContext } from "./prompt-context";
import {
  interruptedReplyNote,
  type PiTurnCheckpointWriter,
  type PiTurnRepair,
} from "./pi-turn-checkpoint";
import { transcriptLineCompactionSummary } from "./transcript-persistence";
import type { TranscriptEntry } from "./types";
import type { StreamEvent, StreamPhaseTool } from "./run-events";
import { nowIso } from "./pi-common";
import {
  assistantRenderableBlockCount,
  contentToTextAndImages,
  piAssistantBlockId,
  piAssistantTranscriptEntries,
} from "./pi-transcript";
import { ModelMessageTiming, streamTimingEnabled } from "./stream-timing";
import { piResponseHasOutput } from "./pi-steering";
import { piStreamEventRequiresAccountContinuation } from "./pi-account-walk";
import type { PiTurnLedger } from "./pi-turn-ledger";
import type { PiSteerController } from "./pi-steer-controller";

// ── Event pump: callback subscription → this generator's queue ──────────────

/** The queue between pi's callback subscription and the run's generator.
 *  push() records replay-unsafe output on the ledger and wakes the reader. */
export class PiEventPump {
  private readonly queue: StreamEvent[] = [];
  private waker: (() => void) | null = null;

  constructor(private readonly ledger: PiTurnLedger) {}

  push(ev: StreamEvent): void {
    if (piStreamEventRequiresAccountContinuation(ev))
      this.ledger.sawStreamedOutput = true;
    this.queue.push(ev);
    this.wake();
  }

  /** Resolve the pending wait(), if any. */
  wake(): void {
    const w = this.waker;
    this.waker = null;
    w?.();
  }

  take(): StreamEvent | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.queue.length;
  }

  /** Resolves on the next push() or wake(). */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waker = resolve;
    });
  }
}

/** Longest tool summary a phase frame carries. */
const TOOL_SUMMARY_MAX = 120;

/** One short line naming what a running tool does: the bash command, the
 *  path, the query. Empty when the input says nothing useful. */
export function piToolSummary(toolName: string, args: unknown): string {
  let line = "";
  try {
    line = formatToolDetail(toolDetail(toolName, args));
  } catch {}
  line = line.replace(/\s+/g, " ").trim();
  return line.length > TOOL_SUMMARY_MAX
    ? `${line.slice(0, TOOL_SUMMARY_MAX - 1)}…`
    : line;
}

/** The ids of the tool calls in an assistant message's content. */
function piToolCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block?.type === "toolCall" && block.id ? [String(block.id)] : [],
  );
}

/** A visible system row. */
export function piSystemEntry(content: string): TranscriptEntry {
  return {
    id: crypto.randomUUID(),
    type: "system",
    content,
    timestamp: nowIso(),
  };
}

/** The transcript rows and notice for an interrupted turn repaired at start:
 *  the unfinished reply, each interrupted tool result, then the notice. */
export function piTurnRepairEntries(
  turnRepair: PiTurnRepair,
  modelID: string,
): { entries: TranscriptEntry[]; notice: string; calls: number } {
  const recovered: TranscriptEntry[] = [];
  if (turnRepair.reply) {
    recovered.push(
      ...piAssistantTranscriptEntries(
        [{ type: "text", text: turnRepair.reply.text }],
        turnRepair.reply.startedAt,
        modelID,
        turnRepair.reply.id,
      ),
    );
  }
  for (const result of turnRepair.toolResults) {
    recovered.push({
      id: `${result.toolCallId}-result`,
      type: "tool_result",
      content: result.text,
      timestamp: nowIso(),
      toolUseId: result.toolCallId,
      isError: true,
    });
  }
  const calls = turnRepair.toolResults.length;
  const notice = [
    "The previous turn stopped unexpectedly.",
    turnRepair.reply ? "Its unfinished reply is kept above." : "",
    calls
      ? `${calls === 1 ? "1 tool call" : `${calls} tool calls`} it was running ${calls === 1 ? "is" : "are"} marked as interrupted.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  recovered.push(piSystemEntry(notice));
  return { entries: recovered, notice, calls };
}

/** What the ENGINE receives; journal/store keep the raw prompt. */
export function buildPiPromptForEngine(input: {
  sessionContext: string;
  resumeMissNote: string | null;
  turnRepair: PiTurnRepair | null;
  continuation: boolean;
  promptWithSkill: string;
}): string {
  const {
    sessionContext,
    resumeMissNote,
    turnRepair,
    continuation,
    promptWithSkill,
  } = input;
  return [
    wrapContext(sessionContext, "session"),
    ...(resumeMissNote ? [wrapContext(resumeMissNote, "handoff")] : []),
    ...(turnRepair?.reply
      ? [
          wrapContext(
            interruptedReplyNote(turnRepair.reply.text),
            "restart-recovery",
          ),
        ]
      : []),
    continuation
      ? wrapContext(
          "The previous account reached its usage limit. Continue the unfinished task from the existing conversation and completed tool results. Do not restart the task or repeat completed actions. Finish with a reply to the user.",
          "auto-continue",
        )
      : promptWithSkill,
  ].join("\n\n");
}

/** What the latest assistant message said about how the run ended. The
 *  fields are read at call time by the prompt loop and the terminal. */
export interface PiEventOutcome {
  // Final assistant outcome (stopReason error/aborted → terminal error).
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  // Renderable content blocks (real text or tool calls) of the LATEST
  // assistant message; -1 = none seen yet. Providers occasionally return a
  // well-formed completion with ZERO content blocks and stopReason "stop"
  // (2026-08-21 os-01a02486: GLM-5.3's pre-release OpenRouter route ended a
  // 10-minute turn on content:[] with all-zero usage). pi settles that as a
  // clean turn, so the session goes idle with no summary and the user has
  // to ask "done?". The pump loop retries such finishes once.
  lastAssistantRenderableBlocks: number;
}

export interface PiEventMapperDeps {
  push: (ev: StreamEvent) => void;
  ledger: PiTurnLedger;
  persist: (entries: TranscriptEntry[]) => void;
  appendLines: (lines: Record<string, unknown>[]) => void;
  steering: PiSteerController;
  /** Read per event: the writer exists only for unified sessions. */
  checkpointWriter: () => PiTurnCheckpointWriter | undefined;
  prompt: string;
  promptForEngine: string;
  modelID: string;
  isUsageLimit: (message: string) => boolean;
  /** Cancel pi's retry backoff; called on the microtask after the event. */
  abortRetry: () => void;
  auditBase: Record<string, unknown>;
}

export interface PiEventMapper {
  outcome: PiEventOutcome;
  /** The session.subscribe listener. */
  handle: (ev: AgentSessionEvent) => void;
}

// Content persistence rides message_end/compaction_end. entry_appended is
// deliberately unhandled: it fires ONLY for extension custom entries
// (dist agent-session.js emits it solely from the extension runtime's
// appendEntry helper), never for messages or compactions. The one
// extension here is codemode, whose `codemode-store` entries are script
// state for pi's own session file, not transcript content.
export function createPiEventMapper(deps: PiEventMapperDeps): PiEventMapper {
  const {
    push,
    ledger,
    persist: persistRunEntries,
    appendLines: appendRunLines,
    steering,
    checkpointWriter,
    prompt,
    promptForEngine,
    modelID,
    isUsageLimit,
    abortRetry,
    auditBase,
  } = deps;
  const outcome: PiEventOutcome = {
    lastStopReason: undefined,
    lastErrorMessage: undefined,
    lastAssistantRenderableBlocks: -1,
  };
  // The open assistant message's id, assigned at its message_start (pi's
  // messages carry none). Its blocks' live frames and durable entries both
  // derive their ids from it (piAssistantBlockId).
  let assistantMessageId: string | undefined;
  // Tool calls the open message started writing (early cards went out).
  let messageToolIds: string[] = [];
  let messageTiming: ModelMessageTiming | undefined;
  // Tools running now, in start order, for the "tool" phase frame.
  const runningTools = new Map<string, StreamPhaseTool & { since: number }>();
  const pushToolPhase = () => {
    const tools = [...runningTools.values()];
    const latest = tools[tools.length - 1];
    if (!latest) return;
    const { since, ...tool } = latest;
    push({
      type: "phase",
      phase: "tool",
      since,
      tool,
      toolCount: tools.length,
    });
  };
  const handle = (ev: AgentSessionEvent) => {
    try {
      checkpointWriter()?.observe(ev);
      switch (ev.type) {
        case "message_start": {
          const msg = (ev as any).message;
          if (msg?.role !== "assistant") break;
          assistantMessageId = crypto.randomUUID();
          messageToolIds = [];
          // pi stamps the message with the time its request started.
          const requestStartedAt =
            typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
          messageTiming = streamTimingEnabled()
            ? new ModelMessageTiming(requestStartedAt)
            : undefined;
          push({ type: "phase", phase: "model", since: requestStartedAt });
          // A steer queued while the request was in flight, before its
          // first token, cuts the response as soon as it starts.
          steering.interruptForSteer();
          break;
        }
        case "message_update": {
          const ame = (ev as any).assistantMessageEvent;
          messageTiming?.update(
            String(ame?.type),
            typeof ame?.delta === "string" ? ame.delta.length : 0,
          );
          if (
            (ame?.type === "text_delta" || ame?.type === "thinking_delta") &&
            typeof ame.delta === "string"
          ) {
            // Each prose block streams under its own id and kind, so a
            // viewer can show thinking apart from the reply and swap either
            // for its durable entry (same id) when the message ends.
            const blockId =
              assistantMessageId && typeof ame.contentIndex === "number"
                ? piAssistantBlockId(assistantMessageId, ame.contentIndex)
                : undefined;
            push({
              type: "text_chunk",
              text: ame.delta,
              ...(blockId ? { blockId } : {}),
              kind: ame.type === "thinking_delta" ? "reasoning" : "text",
            });
          } else if (ame?.type === "toolcall_start") {
            // The model started writing a tool call: show its card now
            // rather than after the whole message, arguments included, ends.
            const block =
              typeof ame.contentIndex === "number"
                ? ame.partial?.content?.[ame.contentIndex]
                : undefined;
            if (block?.type === "toolCall" && block.id) {
              messageToolIds.push(String(block.id));
              push({
                type: "tool_call_start",
                toolUseId: String(block.id),
                toolName: String(block.name || "tool"),
              });
            }
          }
          break;
        }
        case "tool_execution_start": {
          const t = ev as any;
          // A codemode script's own calls never reach pi's transcript, so
          // a live card for one would vanish on reload. The codemode
          // call's card stands for them.
          if (t.parentToolCallId) break;
          const toolName = String(t.toolName || "tool");
          const toolUseId = String(t.toolCallId);
          push({
            type: "tool_use",
            toolName,
            toolInput: t.args ?? {},
            toolUseId,
          });
          runningTools.delete(toolUseId);
          runningTools.set(toolUseId, {
            id: toolUseId,
            name: toolName,
            summary: piToolSummary(toolName, t.args),
            since: Date.now(),
          });
          pushToolPhase();
          break;
        }
        case "tool_execution_end": {
          const t = ev as any;
          if (t.parentToolCallId) break;
          // Parallel tools: the phase falls back to one still running. The
          // last one to end sends nothing; the next model request (or the
          // turn's end) follows within milliseconds.
          if (runningTools.delete(String(t.toolCallId))) pushToolPhase();
          const { text, images } = contentToTextAndImages(t.result?.content);
          // `content`, not `result`: stream consumers read event.content
          // (run-session's stream_tool_result). 500-char preview like
          // previous runner — the full text reaches the store via the toolResult
          // message_end below and upserts over the streamed copy.
          push({
            type: "tool_result",
            toolUseId: String(t.toolCallId),
            content: text.length > 500 ? `${text.slice(0, 500)}...` : text,
            ...(images.length ? { images } : {}),
          });
          break;
        }
        case "message_end": {
          const msg = (ev as any).message;
          if (!msg) break;
          const ts = new Date(
            typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
          ).toISOString();
          if (msg.role === "assistant") {
            const streamedId = assistantMessageId;
            const messageId = streamedId ?? crypto.randomUUID();
            const startedToolIds = messageToolIds;
            assistantMessageId = undefined;
            messageToolIds = [];
            messageTiming?.end({
              messageId,
              stopReason: msg.stopReason,
              blocks: Array.isArray(msg.content) ? msg.content.length : 0,
            });
            messageTiming = undefined;
            outcome.lastStopReason = msg.stopReason;
            outcome.lastErrorMessage = msg.errorMessage;
            outcome.lastAssistantRenderableBlocks =
              assistantRenderableBlockCount(msg.content);
            const u = msg.usage;
            if (ledger.foldAssistantUsage(u)) {
              push({ type: "usage_snapshot", usage: ledger.snapshot() });
            }
            // Persist thinking, text, and tool calls now (messages have no
            // SDK id, while block ids are the model's and stay stable).
            // Error-stopped attempts are skipped: auto-retry replays them
            // and the terminal error carries the failure text — persisting
            // each attempt would stack duplicate partial bubbles. Aborted
            // partials DO persist (parity with pi's own jsonl).
            const cutBySteer = steering.consumeCut();
            const superseded =
              cutBySteer &&
              msg.stopReason === "aborted" &&
              !piResponseHasOutput(msg.content);
            if (!superseded && msg.stopReason !== "error") {
              persistRunEntries(
                piAssistantTranscriptEntries(
                  msg.content,
                  ts,
                  modelID,
                  messageId,
                ),
              );
            } else if (streamedId) {
              // Superseded thinking or a failed attempt: kept out of the
              // transcript, so its live blocks and early cards would wait
              // for durable rows that never land. Tell viewers to drop them.
              const toolUseIds = [
                ...new Set([...startedToolIds, ...piToolCallIds(msg.content)]),
              ];
              push({
                type: "discard",
                messageId: streamedId,
                ...(toolUseIds.length ? { toolUseIds } : {}),
              });
            }
          } else if (msg.role === "toolResult" && msg.toolCallId) {
            const { text, images } = contentToTextAndImages(msg.content);
            persistRunEntries([
              {
                id: `${msg.toolCallId}-result`,
                type: "tool_result",
                content: text,
                timestamp: ts,
                toolUseId: String(msg.toolCallId),
                ...(msg.isError ? { isError: true } : {}),
                ...(images.length ? { images } : {}),
              },
            ]);
          } else if (msg.role === "user") {
            // A user message_end is the DELIVERY signal for a steer (the
            // agent loop emits message_start/end when it injects a queued
            // steering message; the turn's own prompt also lands here and
            // is skipped — it was persisted with its stable uuid up front).
            const { text, images } = contentToTextAndImages(msg.content);
            if (text && text !== promptForEngine && text !== prompt) {
              const steer = steering.takeDelivered(text);
              if (steer) {
                // Transcript parsing deliberately strips fenced system
                // context. A background-wait steer can therefore be fully
                // delivered yet leave no visible user entry for receipt
                // reconciliation. Acknowledge the exact queue id at the
                // engine boundary instead of making UI state infer delivery
                // from display-sanitized transcript text.
                if (steer.steerId) {
                  push({ type: "steer_delivered", steerId: steer.steerId });
                }
                audit({
                  ...auditBase,
                  direction: "in",
                  kind: "steer_injected",
                  ...summarizeText(text),
                });
                const srcs = images.length
                  ? images
                  : (steer.images || []).map(
                      (im) => `data:${im.mediaType};base64,${im.data}`,
                    );
                persistRunEntries([
                  {
                    // Steering admission already wrote the visible user row.
                    // Reuse its id so engine delivery upserts that bubble
                    // instead of appending a duplicate.
                    id: steer.steerId || crypto.randomUUID(),
                    type: "user",
                    content: text,
                    timestamp: ts,
                    ...(srcs.length ? { images: srcs } : {}),
                  },
                ]);
              }
            }
          }
          break;
        }
        case "compaction_end": {
          const ce = ev as any;
          if (!ce.aborted && ce.result?.summary) {
            try {
              appendRunLines([
                transcriptLineCompactionSummary(
                  String(ce.result.summary),
                  crypto.randomUUID(),
                  nowIso(),
                ),
              ]);
            } catch {}
            // The summarization LLM call is billed like any other — fold it
            // so usage_snapshot/done don't under-report on exactly the most
            // expensive turns. contextTokens is left alone: it tracks live
            // conversation context and the next assistant message_end
            // re-derives it post-compaction.
            const cu = ce.result.usage;
            if (ledger.foldCompactionUsage(cu)) {
              push({ type: "usage_snapshot", usage: ledger.snapshot() });
            }
          }
          break;
        }
        case "auto_retry_start": {
          const r = ev as any;
          const errText = String(r.errorMessage || "");
          if (isUsageLimit(errText)) {
            // Usage-limit shapes mean the pool can't serve right now —
            // retrying only delays the fallback walk. abortRetry() cancels
            // the backoff sleep; the microtask matters: the SDK arms the
            // retry AbortController right AFTER emitting this event, so a
            // synchronous call would find nothing to abort.
            queueMicrotask(() => {
              try {
                abortRetry();
              } catch {}
            });
          } else {
            // Make the silent wait visible — pi retries transient provider
            // errors (3x, exponential from 2s) with no output in between.
            const notice = `pi auto-retry ${r.attempt}/${r.maxAttempts} in ${Math.round(
              (r.delayMs || 0) / 1000,
            )}s — ${errText.slice(0, 300)}`;
            push({ type: "runner_notice", text: notice });
            persistRunEntries([piSystemEntry(notice)]);
          }
          break;
        }
        case "agent_end":
          // pi is about to retry the request: the model phase stays open.
          if ((ev as any).willRetry) break;
          runningTools.clear();
          push({ type: "phase", phase: "idle", since: Date.now() });
          break;
        case "agent_settled":
          ledger.sawSettled = true;
          break;
      }
    } catch (err) {
      console.warn("[pi-runner] event mapping failed:", err);
    }
  };
  return { outcome, handle };
}
