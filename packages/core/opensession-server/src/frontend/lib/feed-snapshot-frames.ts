import type { WSServerMessage } from "./types";

type FeedSnapshot = Extract<WSServerMessage, { type: "feed_snapshot" }>;

/**
 * The ordinary live frames a stale-cursor `feed_snapshot` stands for, so every
 * conversation surface renders a reconnect through the same handlers as a
 * live turn: `stream_start`, one `stream_text` per live block with its id and
 * kind (so thinking stays a thought and each block still swaps for its
 * durable row by id), then the run's latest `stream_phase` (so a viewer
 * joining mid-tool sees the tool and its time at once). A server without
 * per-block state sends only the joined text, replayed as one anonymous
 * block.
 */
export function feedSnapshotFrames(msg: FeedSnapshot): WSServerMessage[] {
  const active = msg.active;
  if (!active) return [];
  const sessionId = msg.sessionId;
  const frames: WSServerMessage[] = [
    { type: "stream_start", sessionId, by: active.by },
  ];
  if (active.blocks?.length) {
    for (const block of active.blocks) {
      if (!block.text) continue;
      frames.push({
        type: "stream_text",
        sessionId,
        text: block.text,
        ...(block.id ? { blockId: block.id } : {}),
        ...(block.kind ? { kind: block.kind } : {}),
      });
    }
  } else if (active.text) {
    frames.push({ type: "stream_text", sessionId, text: active.text });
  }
  if (active.phase) {
    frames.push({ type: "stream_phase", sessionId, ...active.phase });
  }
  return frames;
}
