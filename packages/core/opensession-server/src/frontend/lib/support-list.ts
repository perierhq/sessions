// The Support list's pure helpers: lanes, the channel filter, which live
// session a row wears, and where a row opens. SupportInbox renders them.
import type {
  DraftState,
  SupportChannelKind,
  SupportListItem,
} from "../../shared/support";
import { type Route, supportItemIdFromPath } from "./app-route";
import { SUPPORT_PRIORITY_GROUPS } from "./sidebar-filter";
import type { UnifiedSession } from "./types";

export type SupportLane = {
  key: "needs-you" | 0 | 1 | 2 | 3;
  label: string;
  items: SupportListItem[];
};

/** Draft states that wait on a person: a draft to approve, a send that can
 *  still be stopped, a send that failed. */
const NEEDS_YOU: ReadonlySet<DraftState> = new Set([
  "needs-person",
  "veto",
  "failed",
]);

const NORMAL = 2;

export function needsYou(item: SupportListItem): boolean {
  return item.draftState !== null && NEEDS_YOU.has(item.draftState);
}

const newestFirst = (a: SupportListItem, b: SupportListItem) =>
  (b.at ?? "").localeCompare(a.at ?? "");

/** "Needs you" first (draftState needs-person, veto or failed), then the
 *  priority lanes; email rows sit in Normal. Empty lanes are left out; each
 *  lane is newest first. */
export function supportLanes(items: SupportListItem[]): SupportLane[] {
  const lanes: SupportLane[] = [
    { key: "needs-you", label: "Needs you", items: [] },
    ...SUPPORT_PRIORITY_GROUPS.map((g): SupportLane => ({
      key: g.p,
      label: g.label,
      items: [],
    })),
  ];
  for (const item of items) {
    const priority = item.priority ?? NORMAL;
    const lane = needsYou(item)
      ? lanes[0]!
      : (lanes.find((l) => l.key === priority) ??
        lanes.find((l) => l.key === NORMAL)!);
    lane.items.push(item);
  }
  return lanes
    .filter((l) => l.items.length > 0)
    .map((l) => ({ ...l, items: [...l.items].sort(newestFirst) }));
}

export function filterByChannel(
  items: SupportListItem[],
  channel: SupportChannelKind | "all",
): SupportListItem[] {
  return channel === "all"
    ? items
    : items.filter((item) => item.channel === channel);
}

/** The provider id behind a list item id (`plain:th_1` → `th_1`). */
export function supportItemProviderId(itemId: string): string {
  const colon = itemId.indexOf(":");
  return colon < 0 ? itemId : itemId.slice(colon + 1);
}

/** The live session a row wears. Email: the conversation's own session.
 *  Plain: the newest live session linked to the thread (the sidebar's rule). */
export function liveSessionFor(
  item: Pick<SupportListItem, "id" | "channel" | "sessionId">,
  sessions: UnifiedSession[],
): UnifiedSession | null {
  if (item.channel !== "plain") {
    if (!item.sessionId) return null;
    return sessions.find((s) => s.id === item.sessionId && !s.archived) ?? null;
  }
  const threadId = supportItemProviderId(item.id);
  let newest: UnifiedSession | null = null;
  for (const s of sessions) {
    if (s.archived || s.plainThreadId !== threadId) continue;
    if (!newest || s.lastActivity > newest.lastActivity) newest = s;
  }
  return newest;
}

/**
 * Where a row opens. A Plain ticket keeps the Support tool's own page
 * (`/plain/<thread>`); `/support/plain:<thread>` still means "the ticket's
 * workspace", the link Plain's cards land on. Every other channel opens
 * under `/support/<itemId>` beside the list.
 */
export function supportItemRoute(itemId: string): Route {
  const id = supportItemIdFromPath(itemId);
  return id.startsWith("plain:")
    ? { view: "plain", threadId: supportItemProviderId(id) }
    : { view: "support", threadId: id };
}

/**
 * The item the Support page shows for a route: null for the list on its
 * own, undefined when the route is not the Support page. `/support/<plain
 * item>` is the ticket's workspace link (SupportPreview while it resolves),
 * so it is not the page.
 */
export function supportPageItem(route: Route): string | null | undefined {
  if (route.view === "plain")
    return route.threadId ? `plain:${route.threadId}` : null;
  if (route.view !== "support") return undefined;
  const id = supportItemIdFromPath(route.threadId);
  return id.startsWith("plain:") ? undefined : id;
}
