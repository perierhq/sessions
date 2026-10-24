// What a running turn is doing right now, and the honest words for it.
//
// A live turn alternates between two kinds of waiting: the model writing (a
// request is open) and a tool running (the model is idle). They feel the same
// from the outside and they are not the same: a 56s typecheck is not slow
// thinking. The server says which one it is with `stream_phase` frames; this
// module turns that into the tail's label and decides which thought, if any,
// may still shimmer.
//
// Before the server sends phases (an older gateway, or a reconnect that has
// not seen one yet) the phase is null and only what the transcript proves is
// claimed: a thought stops being "current" once a later step exists.

import type {
  StreamPhase,
  StreamPhaseTool,
} from "@tellahq/opensession-protocol/events";
import type { TranscriptEntry } from "./types";
import { isLegacyReasoningHeading } from "./reasoning-display";

export type LivePhaseKind = StreamPhase;

export interface LivePhase {
  phase: StreamPhase;
  /** Epoch ms the phase began, on this browser's clock (see LiveTurnStore). */
  since: number;
  tool?: StreamPhaseTool;
  /** With phase "tool": how many tools are running. */
  toolCount?: number;
}

function isThought(entry: TranscriptEntry): boolean {
  return (
    entry.type === "assistant" &&
    Boolean(entry.isReasoning || isLegacyReasoningHeading(entry.content))
  );
}

/**
 * The thought a live rail may still present as current ("Thinking", with the
 * shimmer), or undefined.
 *
 * Only the rail's newest assistant row can be current, and only when it is a
 * thought: narration after it means the model moved on to talking. A later
 * tool call means the model finished that message and handed over to a tool,
 * so the thought is history even though nothing has replaced it yet. With
 * phases known, it is current only while the model request is open.
 */
export function activeThought(
  items: TranscriptEntry[],
  live: boolean,
  phase: LivePhaseKind | null | undefined,
): TranscriptEntry | undefined {
  if (!live) return undefined;
  if (phase && phase !== "model") return undefined;
  const at = items.findLastIndex((entry) => entry.type === "assistant");
  if (at === -1) return undefined;
  const last = items[at]!;
  if (!isThought(last)) return undefined;
  for (let i = at + 1; i < items.length; i++) {
    if (items[i]!.type === "tool_use") return undefined;
  }
  return last;
}

/** "41s", then "1m 05s": a tool's wait ticks every second, so it keeps its
 * seconds where a turn's coarse age would round them away. */
export function phaseElapsed(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface LivePhaseStatus {
  label: string;
  /** Ticking time in this phase, shown after the label. */
  elapsed: string | null;
  /** Only an open model request shimmers. */
  shimmer: boolean;
}

/**
 * The tail's words for a known phase, or null when the phase says nothing the
 * generic "Working" row does not (unknown, or idle between steps).
 */
export function livePhaseStatus(
  phase: LivePhase | null | undefined,
  nowMs: number,
): LivePhaseStatus | null {
  if (!phase) return null;
  if (phase.phase === "model") {
    return { label: "Thinking", elapsed: null, shimmer: true };
  }
  if (phase.phase === "tool") {
    const what = phase.tool?.summary?.trim() || phase.tool?.name?.trim();
    const others = Math.max(0, (phase.toolCount ?? 1) - 1);
    const base = what ? `Running ${what}` : "Running a tool";
    return {
      label: others > 0 ? `${base} and ${others} more` : base,
      elapsed: phaseElapsed(phase.since, nowMs),
      shimmer: false,
    };
  }
  return null;
}
