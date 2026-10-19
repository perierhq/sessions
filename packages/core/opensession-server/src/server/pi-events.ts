import { wrapContext } from "./prompt-context";
import { interruptedReplyNote, type PiTurnRepair } from "./pi-turn-checkpoint";
import type { TranscriptEntry } from "./types";
import type { StreamEvent } from "./run-events";
import { nowIso } from "./pi-common";
import { piAssistantTranscriptEntries } from "./pi-transcript";
import { piStreamEventRequiresAccountContinuation } from "./pi-account-walk";
import type { PiTurnLedger } from "./pi-turn-ledger";

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
