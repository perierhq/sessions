// Live updates for the Knowledge page. The server sends knowledge_changed
// {project, what} over the main socket when a project's import jobs or its
// items change (server/knowledge/broadcast.ts); this revalidates that
// project's SWR keys (["api", "knowledge", project, …]): the jobs list for
// `jobs`, every key for `items`. Each project and kind folds its burst into
// a leading and a trailing call (lib/coalescer.ts), as the incident views
// do. Whether the socket is up is kept here too: while it is, the Import
// tab doesn't poll (import-model.ts pollJobs), and when it comes back every
// knowledge key is read again, since messages sent while it was down are
// lost. No React; hooks/useKnowledgeLive.ts wires it to the socket.
import { type Arguments, mutate as revalidateApiResources } from "swr";
import { knowledgeKeyFilter } from "../api-swr";
import { type Coalescer, createCoalescer } from "../coalescer";

/** Socket messages arrive one per write; revalidate at most this often per
 *  project and kind. */
export const KNOWLEDGE_REVALIDATE_MS = 500;

type KeyFilter = (key: Arguments) => boolean;

export interface KnowledgeLive {
  /** Hand it every socket message; all but knowledge_changed are ignored. */
  onMessage(msg: { type: string; project?: string; what?: string }): void;
  /** Drop the trailing calls still waiting. */
  cancel(): void;
  /** Whether the socket is up. */
  connected(): boolean;
  setConnected(up: boolean): void;
  /** Hear `connected` change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Every Knowledge key of every project. */
function isKnowledgeKey(key: Arguments): boolean {
  return Array.isArray(key) && key[0] === "api" && key[1] === "knowledge";
}

function jobsKeyFilter(project: string): KeyFilter {
  return (key) =>
    Array.isArray(key) &&
    key[0] === "api" &&
    key[1] === "knowledge" &&
    key[2] === project &&
    key[3] === "jobs";
}

export function createKnowledgeLive(
  revalidate: (filter: KeyFilter) => void,
  windowMs: number,
  now: () => number = Date.now,
): KnowledgeLive {
  const coalescers = new Map<string, Coalescer>();
  const listeners = new Set<() => void>();
  let up = false;
  return {
    onMessage(msg) {
      if (msg.type !== "knowledge_changed") return;
      const { project, what } = msg;
      if (!project) return;
      if (what !== "jobs" && what !== "items") return;
      const id = `${project}\u0000${what}`;
      let coalescer = coalescers.get(id);
      if (!coalescer) {
        const filter =
          what === "jobs"
            ? jobsKeyFilter(project)
            : knowledgeKeyFilter(project);
        coalescer = createCoalescer(() => revalidate(filter), windowMs, now);
        coalescers.set(id, coalescer);
      }
      coalescer.request();
    },
    cancel() {
      for (const coalescer of coalescers.values()) coalescer.cancel();
    },
    connected: () => up,
    setConnected(next) {
      if (next === up) return;
      up = next;
      if (up) revalidate(isKnowledgeKey);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's one channel (hooks/useKnowledgeLive.ts). */
export const knowledgeLive = createKnowledgeLive(
  (filter) => void revalidateApiResources(filter),
  KNOWLEDGE_REVALIDATE_MS,
);
