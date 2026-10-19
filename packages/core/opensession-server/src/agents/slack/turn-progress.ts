/** The live progress card for a session turn that answers in a Slack thread.
 * The turn loop owns it: it posts the card when a Slack-originated turn
 * starts, feeds it the same events it broadcasts to viewers, and closes it
 * when the turn settles, just before the reply is mirrored to the thread. */
import { isMcpCallDispatcher } from "@tellahq/opensession-protocol/tool-presentation";
import type { StreamEvent } from "../../server/run-events";
import type { SlackReplyTarget } from "../../server/types";
import { configuredServer } from "../../server/config";
import { SlackProgress, taskCardTitle } from "./progress";
import { buildToolStatus, isSilentTool } from "./streamer";

/** Pi and other engines emit lowercase tool names; the status helpers key on
 *  the Claude-style ones. */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  patch: "Edit",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  task: "Task",
  skill: "Skill",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  notebookedit: "NotebookEdit",
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name.toLowerCase()] || name;
}

export type SlackTurnOutcome = "done" | "failed" | "stopped";

const FINISH_LABEL: Record<SlackTurnOutcome, string> = {
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export interface SlackTurnProgress {
  /** Feed one event of the turn's stream. Never throws or blocks. */
  event(event: StreamEvent): void;
  /** Close the card in its terminal state. Idempotent. */
  finish(outcome: SlackTurnOutcome): Promise<void>;
}

/** Apply one stream event to a card. Exported for tests. */
export function applyTurnEvent(progress: SlackProgress, e: StreamEvent): void {
  if (e.type === "text_chunk" && e.text) {
    progress.appendNarration(e.text);
    return;
  }
  if (e.type !== "tool_use" || !e.toolName) return;
  const name = normalizeToolName(e.toolName);
  const input: any = e.toolInput;
  if (name === "TodoWrite") {
    progress.setTodos(input?.todos);
  } else if (name === "TaskCreate") {
    progress.setAction(input?.activeForm || input?.subject || "Working…");
  } else if (isMcpCallDispatcher(name) && typeof input?.name === "string") {
    progress.setAction(`Using ${input.name}`);
  } else if (!isSilentTool(name)) {
    progress.setAction(
      buildToolStatus(name, input),
      name === "Bash" ? String(input?.command || "") : undefined,
    );
  }
}

/**
 * Post the card for a turn that answers in `target`. Returns undefined for a
 * turn with no Slack thread. A failed post leaves a card that does nothing;
 * the turn itself is never affected.
 */
export async function startSlackTurnProgress(
  target: SlackReplyTarget | undefined,
  opts: {
    sessionId: string;
    /** Fallback title when the target carries none. */
    prompt: string;
    /** Display text of the session link in the header. */
    linkText?: string;
    /** Who added this follow-up; absent for the session's opening turn. */
    continuedBy?: string;
  },
): Promise<SlackTurnProgress | undefined> {
  if (!target) return undefined;
  const progress = new SlackProgress({
    channel: target.channel,
    sessionId: opts.sessionId,
    sessionUrl: `${configuredServer().publicBaseUrl}/session/${encodeURIComponent(opts.sessionId)}`,
    title: taskCardTitle(target.title || opts.prompt),
    linkText: opts.linkText?.trim() || "this session",
    continuedBy: opts.continuedBy,
  });
  await progress.start(target.threadTs);
  return {
    event: (e) => {
      try {
        applyTurnEvent(progress, e);
      } catch (error) {
        console.warn("[slack] progress card update failed:", error);
      }
    },
    finish: (outcome) => progress.finish(FINISH_LABEL[outcome]),
  };
}
