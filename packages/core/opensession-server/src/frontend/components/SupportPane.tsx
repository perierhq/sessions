import { supportItemIdFromPath, type Route } from "../lib/app-route";
import {
  supportItemProviderId,
  supportItemRoute,
  supportPageItem,
} from "../lib/support-list";
import type {
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import { SupportInbox } from "./SupportInbox";
import { SupportPreview } from "./SupportPreview";

/**
 * The main pane for `/support`, `/support/:item` and `/plain/:thread`, so the
 * composition root mounts one element for the whole area: the Support page
 * for a list or an item, or SupportPreview for a Plain ticket's workspace
 * link while it resolves (see supportPageItem).
 */
export function SupportPane({
  route,
  sessions,
  connected,
  send,
  addHandler,
  navigate,
}: {
  route: Extract<Route, { view: "support" | "plain" }>;
  sessions: UnifiedSession[];
  connected: boolean;
  send: (msg: WSClientMessage) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
}) {
  const openSession = (id: string) => navigate({ view: "session", id });
  const itemId = supportPageItem(route);
  if (itemId !== undefined)
    return (
      <SupportInbox
        itemId={itemId}
        intent={route.view === "support" ? route.intent : undefined}
        onIntentHandled={() => {
          if (route.view === "support")
            navigate(
              { view: "support", threadId: route.threadId },
              { replace: true },
            );
        }}
        sessions={sessions}
        onSelectItem={(id) => navigate(supportItemRoute(id))}
        onOpenSession={openSession}
      />
    );
  // supportPageItem is undefined only for a "support" route.
  if (route.view !== "support") return null;
  return (
    <SupportPreview
      key={route.threadId}
      threadId={supportItemProviderId(supportItemIdFromPath(route.threadId))}
      connected={connected}
      send={send}
      addHandler={addHandler}
      onOpenSession={openSession}
    />
  );
}
