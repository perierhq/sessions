import type { SessionLiveEvent } from "@tellahq/opensession-protocol/session";
import type { StreamEvent } from "./run-events";

/**
 * Viewer frames for the run events that only describe the live turn: what it
 * is doing now (`phase`) and a tool call the model has started writing
 * (`tool_call_start`). Every gateway path that relays a run's events uses
 * these, so a fresh run, a recovered run and a new session's first run send
 * the same frames.
 */

/** A `stream_phase` frame for a phase event, or null when it is malformed. */
export function streamPhaseFrame(
  sessionId: string | undefined,
  event: StreamEvent,
): Extract<SessionLiveEvent, { type: "stream_phase" }> | null {
  if (event.type !== "phase" || !event.phase) return null;
  return {
    type: "stream_phase",
    ...(sessionId ? { sessionId } : {}),
    phase: event.phase,
    since: typeof event.since === "number" ? event.since : Date.now(),
    ...(event.phase === "tool" && event.tool ? { tool: event.tool } : {}),
    ...(event.phase === "tool" && event.toolCount
      ? { toolCount: event.toolCount }
      : {}),
    ...(event.phase === "wait" && event.reason ? { reason: event.reason } : {}),
  };
}

/** The early `stream_tool_use` card for a tool call whose arguments are
 *  still streaming. The ordinary card for the same id follows. */
export function earlyToolUseFrame(
  sessionId: string | undefined,
  event: StreamEvent,
): Extract<SessionLiveEvent, { type: "stream_tool_use" }> | null {
  if (event.type !== "tool_call_start" || !event.toolUseId) return null;
  const toolName = event.toolName || "tool";
  return {
    type: "stream_tool_use",
    ...(sessionId ? { sessionId } : {}),
    entry: {
      id: event.toolUseId,
      type: "tool_use",
      content: `Using ${toolName}`,
      timestamp: new Date().toISOString(),
      toolName,
      toolInput: {},
      toolUseId: event.toolUseId,
    },
    inputPending: true,
  };
}

/** A `stream_discard` frame for a discard event: an assistant message that
 *  will never be saved, whose live blocks and early cards viewers drop. */
export function streamDiscardFrame(
  sessionId: string | undefined,
  event: StreamEvent,
): Extract<SessionLiveEvent, { type: "stream_discard" }> | null {
  if (event.type !== "discard" || !event.messageId) return null;
  return {
    type: "stream_discard",
    ...(sessionId ? { sessionId } : {}),
    messageId: event.messageId,
    ...(event.toolUseIds?.length ? { toolUseIds: event.toolUseIds } : {}),
  };
}

/**
 * Whether an adopted run's event (after a gateway restart) shows its turn is
 * live, so the gateway opens the turn for viewers (a synthetic stream_start)
 * before relaying it. A phase counts: an adopted run is often mid-tool, and
 * its phase frame must follow that stream_start, which resets the phase.
 */
export function recoveredEventOpensLiveTurn(
  event: Pick<StreamEvent, "type" | "phase">,
): boolean {
  return (
    event.type === "init" ||
    event.type === "text_chunk" ||
    (event.type === "phase" && event.phase !== "idle") ||
    event.type === "tool_call_start" ||
    event.type === "tool_use" ||
    event.type === "tool_result"
  );
}
