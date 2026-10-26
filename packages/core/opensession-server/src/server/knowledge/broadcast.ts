// Live updates for the Knowledge page: one socket message when a project's
// import jobs change (jobs.ts, at most every JOB_WRITE_MS per job) and when
// its knowledge repository is written (client.ts: a write, a revert, a new
// repository; the counts follow the items). Project names only, never
// content: the page refetches what it shows (frontend/lib/knowledge/live.ts).
// The same channel as the incident views (incidents/broadcast.ts). Nothing
// runs at import.
import { broadcastToAll } from "../ws-hub";

export interface KnowledgeBroadcast {
  type: "knowledge_changed";
  project: string;
  /** `jobs`: the import jobs; `items`: the items, lists and counts. */
  what: "jobs" | "items";
}

let send: (message: KnowledgeBroadcast) => void = broadcastToAll;

/** Record broadcasts instead of sending them; undefined restores sending. */
export function __setKnowledgeBroadcastForTest(
  fn: ((message: KnowledgeBroadcast) => void) | undefined,
): void {
  send = fn ?? broadcastToAll;
}

/** Tell every client that `project`'s knowledge changed. Never throws. */
export function knowledgeChanged(
  project: string,
  what: KnowledgeBroadcast["what"],
): void {
  try {
    send({ type: "knowledge_changed", project, what });
  } catch {
    // A client that can't be told reads again on its fallback poll.
  }
}
