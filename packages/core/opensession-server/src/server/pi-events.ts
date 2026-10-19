import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { audit, summarizeText } from "./audit";
import { wrapContext } from "./prompt-context";
import {
  interruptedReplyNote,
  type PiTurnCheckpointWriter,
  type PiTurnRepair,
} from "./pi-turn-checkpoint";
import { transcriptLineCompactionSummary } from "./transcript-persistence";
import type { TranscriptEntry } from "./types";
import type { StreamEvent } from "./run-events";
import { nowIso } from "./pi-common";
import {
  assistantRenderableBlockCount,
  contentToTextAndImages,
  piAssistantTranscriptEntries,
} from "./pi-transcript";
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
  const handle = (ev: AgentSessionEvent) => {
    try {
      checkpointWriter()?.observe(ev);
      switch (ev.type) {
        case "message_start":
          // A steer queued while the request was in flight, before its
          // first token, cuts the response as soon as it starts.
          if ((ev as any).message?.role === "assistant")
            steering.interruptForSteer();
          break;
        case "message_update": {
          const ame = (ev as any).assistantMessageEvent;
          if (
            (ame?.type === "text_delta" || ame?.type === "thinking_delta") &&
            typeof ame.delta === "string"
          ) {
            // The live transcript has one prose stream. Thinking and ordinary
            // model output both ride it rather than leaving reasoning blank
            // until message_end persists the provider's separate blocks.
            push({ type: "text_chunk", text: ame.delta });
          }
          break;
        }
        case "tool_execution_start": {
          const t = ev as any;
          // A codemode script's own calls never reach pi's transcript, so
          // a live card for one would vanish on reload. The codemode
          // call's card stands for them.
          if (t.parentToolCallId) break;
          push({
            type: "tool_use",
            toolName: String(t.toolName || "tool"),
            toolInput: t.args ?? {},
            toolUseId: String(t.toolCallId),
          });
          break;
        }
        case "tool_execution_end": {
          const t = ev as any;
          if (t.parentToolCallId) break;
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
            if (
              cutBySteer &&
              msg.stopReason === "aborted" &&
              !piResponseHasOutput(msg.content)
            ) {
              // Superseded thinking: keep it out of the transcript.
            } else if (msg.stopReason !== "error") {
              persistRunEntries(
                piAssistantTranscriptEntries(msg.content, ts, modelID),
              );
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
