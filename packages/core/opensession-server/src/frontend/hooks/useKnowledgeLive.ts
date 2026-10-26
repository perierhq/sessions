// Wires the Knowledge live channel (lib/knowledge/live.ts) to the main
// socket, the way useIncidentLiveUpdates wires the incident views: mounted
// once in AppContent. useKnowledgeLiveConnected tells a view whether the
// socket is up, so it polls only while it isn't.
import { useEffect, useSyncExternalStore } from "react";
import { knowledgeLive } from "../lib/knowledge/live";
import type { WSServerMessage } from "../lib/types";

export function useKnowledgeLiveUpdates(
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void,
  connected: boolean,
): void {
  useEffect(() => {
    const off = addHandler((msg) => knowledgeLive.onMessage(msg));
    return () => {
      off();
      knowledgeLive.cancel();
    };
  }, [addHandler]);
  useEffect(() => {
    knowledgeLive.setConnected(connected);
  }, [connected]);
}

/** True while knowledge_changed messages can arrive. */
export function useKnowledgeLiveConnected(): boolean {
  return useSyncExternalStore(
    knowledgeLive.subscribe,
    knowledgeLive.connected,
    () => false,
  );
}
