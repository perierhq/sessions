import {
  appendTranscriptEntries,
  transcriptLineForEntry,
  transcriptLineRunnerNotice,
} from "./transcript-persistence";
import { transcriptForwarder } from "./transcript-forward";
import { assistantProseFields } from "./transcript-media";
import type { TranscriptEntry } from "./types";
import type { ImageInput } from "./run-events";

/** How many content blocks of an assistant message a reader could actually
 *  see: non-empty text or thinking blocks and tool calls. Truly empty content
 *  counts zero — that is the empty-completion shape the pump loop retries. */
export function assistantRenderableBlockCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as {
      type?: string;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
    };
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    )
      n++;
    else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim()
    )
      n++;
    else if (block.type === "toolCall" && block.id) n++;
  }
  return n;
}

/**
 * The id of one prose block of an assistant message: the message id for the
 * first content block, `<messageId>-b<contentIndex>` for the rest. The live
 * `stream_text` frames of a block and its durable transcript entry both use
 * it, so a viewer swaps the live copy for the durable one by id.
 */
export function piAssistantBlockId(
  messageId: string,
  contentIndex: number,
): string {
  return contentIndex === 0 ? messageId : `${messageId}-b${contentIndex}`;
}

/** Preserve every model-authored prose block in provider order. Pi exposes
 * reasoning as `thinking` blocks and ordinary output as `text`; both become
 * visible assistant transcript entries, while tool calls keep their own rows.
 * Prose entry ids come from `piAssistantBlockId`. */
export function piAssistantTranscriptEntries(
  content: unknown,
  timestamp: string,
  model: string,
  messageId: string = crypto.randomUUID(),
): TranscriptEntry[] {
  if (!Array.isArray(content)) return [];
  const entries: TranscriptEntry[] = [];
  for (const [contentIndex, raw] of content.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as {
      type?: string;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    const reasoning =
      block.type === "thinking" && typeof block.thinking === "string"
        ? block.thinking
        : "";
    const isReasoning = reasoning.length > 0;
    const prose =
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : reasoning;
    if (prose.trim()) {
      entries.push({
        id: piAssistantBlockId(messageId, contentIndex),
        type: "assistant",
        timestamp,
        model,
        ...(isReasoning ? { isReasoning: true } : {}),
        ...assistantProseFields(prose),
      });
    } else if (block.type === "toolCall" && block.id) {
      entries.push({
        id: String(block.id),
        type: "tool_use",
        content: "",
        timestamp,
        toolName: String(block.name || "tool"),
        toolInput: block.arguments ?? {},
        toolUseId: String(block.id),
      });
    }
  }
  return entries;
}

/** Pi ImageContent from our wire shape. */
export function piImages(
  images?: ImageInput[],
): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  if (!images?.length) return undefined;
  return images.map((im) => ({
    type: "image" as const,
    data: im.data,
    mimeType: im.mediaType,
  }));
}

/** Flatten pi tool-result content to text + renderable image srcs. */
export function contentToTextAndImages(content: unknown): {
  text: string;
  images: string[];
} {
  const texts: string[] = [];
  const images: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "image" && typeof b.data === "string") {
        images.push(
          `data:${String(b.mimeType || "image/png")};base64,${b.data}`,
        );
      }
    }
  } else if (typeof content === "string") {
    texts.push(content);
  }
  return { text: texts.join("\n"), images };
}

// ── Transcript integration (the claude-direct recipe) ────────────────────────

/** One transcript append, routed. In the server process this writes the
 *  store directly (appendTranscriptEntries). Inside a run host a forwarder
 *  is registered (transcript-forward.ts): the batch is relayed to the server
 *  over the run-host protocol instead, keeping transcripts.db single-writer
 *  and giving sandboxed/detached pi runs host-side persistence. */
export function piAppend(
  engineSessionId: string,
  lines: Record<string, unknown>[],
): void {
  const forward = transcriptForwarder();
  if (forward) {
    forward(engineSessionId, lines);
    return;
  }
  void appendTranscriptEntries(engineSessionId, lines).catch((error) => {
    console.error(
      `[pi] Transcript append failed for ${engineSessionId}:`,
      error,
    );
  });
}

/** Store one batch of normalized entries under the pi session id. Requires
 *  recordEngineSessionOwner to have mapped pi→unified first (see runPi); system
 *  entries ride runner-notice lines. Best-effort — a transcript write must
 *  never take the run down. */
export function persistEntries(
  engineSessionId: string | undefined,
  entries: TranscriptEntry[],
): void {
  if (!entries.length || !engineSessionId) return;
  try {
    const lines = entries
      .map((e) =>
        e.type === "system"
          ? transcriptLineRunnerNotice(e.content, e.id, e.timestamp)
          : transcriptLineForEntry(e),
      )
      .filter((l): l is Record<string, unknown> => !!l);
    piAppend(engineSessionId, lines);
  } catch (e) {
    console.warn("[pi-runner] transcript persist failed:", e);
  }
}
