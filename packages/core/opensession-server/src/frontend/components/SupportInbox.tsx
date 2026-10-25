import React, { useEffect, useState } from "react";
import {
  SUPPORT_EMAIL_LIST_LIMIT,
  type SupportChannelKind,
  type SupportListItem,
} from "../../shared/support";
import { useIsPhone } from "../hooks/useIsPhone";
import { type SupportItems, fetchSupportItems } from "../lib/api/support";
import {
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_LANE_COUNT,
  SIDEBAR_LANE_HEADER,
  SIDEBAR_LANE_NAME,
  SIDEBAR_RAIL,
  SIDEBAR_RAIL_GAP,
} from "../lib/sidebar-classes";
import {
  SUPPORT_PRIORITY_DOT,
  SUPPORT_PRIORITY_GROUPS,
} from "../lib/sidebar-filter";
import { SUPPORT_COLUMN_BAR } from "../lib/support-classes";
import {
  filterByChannel,
  liveSessionFor,
  supportItemProviderId,
  supportLanes,
} from "../lib/support-list";
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import { clockTime, shortTime } from "../lib/time";
import type { UnifiedSession } from "../lib/types";
import { cn } from "../ui/cn";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
import { ConversationPane } from "./ConversationPane";
import { IconMail, IconMessage } from "./icons";

/**
 * The support queue as a place of its own: every channel's conversations in
 * one column beside the sidebar (email from the inboxes, Plain's TODO queue),
 * the one you picked open next to them, and no chat anywhere.
 *
 * It is the second way into the same queue, running beside the Plain band at
 * the bottom of the sidebar rather than replacing it — the two are being tried
 * against each other. The band opens a ticket's workspace, so the answer
 * arrives with a session, a tab strip and a transcript around it; this opens
 * the ticket itself, and a session is something you go to from it — the pane's
 * own "Triage this ticket", or, once a run exists, the pill that replaces it.
 *
 * The list is the sidebar's grammar at a column's width: the same priority
 * lanes, the same 22px rail, the same hover and selected washes, with a second
 * line for the subject because 300px has room for it. The ticket beside it is
 * ConversationPane, the same surface the workspace Conversation tab renders.
 */

/** The column. Paper like the pane it sits in, separated by the chrome seam —
 *  the Reports page's list column, whose doc argues that shape at length. On a
 *  phone the two panes are separate pages, so it is the whole width there. */
const COLUMN =
  "flex min-h-0 flex-col " +
  "phone:w-full phone:flex-1 " +
  "desktop:w-[320px] desktop:shrink-0 desktop:border-r desktop:border-divider";

const COLUMN_TITLE =
  "m-0 text-item-title font-semibold text-fg phone:text-section-title";

const COLUMN_COUNT =
  "ml-auto shrink-0 text-meta font-medium tabular-nums text-faint";

/** The channel filter, under the bar. Only there when a second channel has
 *  something to say, so a one-inbox instance never sees it. */
const FILTER_ROW = "shrink-0 px-3 pt-2.5";
const FILTER_OPTION = "phone:min-h-11";

/** The glyph and accessible name for a channel's mark; null for a channel
 *  this build has no mark for. */
function channelMark(channel: SupportChannelKind) {
  if (channel === "email") return { label: "Email", Icon: IconMail };
  if (channel === "plain") return { label: "Plain", Icon: IconMessage };
  return null;
}

type ChannelFilter = SupportChannelKind | "all";

/** Each failed channel's own copy from the server, as one line: "Plain
 *  could not be reached." */
function channelErrorText(channels: SupportItems["channels"]): string | null {
  const errors = channels.flatMap((c) => (c.error ? [c.error] : []));
  return errors.length ? errors.map((e) => `${e}.`).join(" ") : null;
}

const LIST =
  "min-h-0 flex-1 overflow-y-auto px-1.5 pt-2 pb-3 " +
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** A ticket. Two lines, so it sets its own vertical rhythm rather than taking
 *  the sidebar's one-line row padding; everything else — corner, rail gap,
 *  hover layer, `bg-selected` for the open one — is the shared row grammar. */
const ROW =
  "group mt-0.5 flex w-full cursor-pointer items-start rounded-row border-0 " +
  "bg-transparent py-2.5 pr-3 pl-2.5 text-left data-active:bg-selected " +
  `${SIDEBAR_RAIL_GAP} ${SIDEBAR_HOVER_LAYER}`;

const ROW_HEAD = "flex min-w-0 items-baseline gap-2";

const ROW_NAME =
  "min-w-0 flex-1 truncate text-label font-medium text-dim " +
  "group-hover:text-fg group-data-active:text-fg phone:text-[15px]";

const ROW_TIME = "shrink-0 text-right text-meta tabular-nums text-faint";

/** The channel mark before the time: which door the conversation came in. */
const ROW_MARK = "inline-flex shrink-0 self-center text-faint";

const ROW_SUBJECT =
  "mt-1 block truncate text-label text-faint " +
  "group-data-active:text-dim phone:text-[14px]";

interface Props {
  /** The open item (`email:sc_…`, `plain:th_…`), or null for the list on
   *  its own. */
  itemId: string | null;
  /** Live sessions, for the rail dot: a conversation already being worked on
   *  wears its session's status instead of its priority. */
  sessions: UnifiedSession[];
  /** Open an item (drives the route, so the pane is deep-linkable). */
  onSelectItem: (itemId: string) => void;
  /** Navigate into a session — what the pane's triage button resolves to. */
  onOpenSession: (id: string) => void;
}

export function SupportInbox({
  itemId,
  sessions,
  onSelectItem,
  onOpenSession,
}: Props) {
  const isPhone = useIsPhone();
  const [data, setData] = useState<SupportItems | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelFilter>("all");

  // The same gentle cadence the sidebar polls Plain on (the server caches
  // ~60s). A poll that fails while items are already on screen keeps them:
  // the list is the queue as of the last good answer, not an error page.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchSupportItems()
        .then((next) => {
          if (!alive) return;
          setData(next);
          setError(null);
        })
        .catch((e) => {
          if (alive) setError(e?.message || "Failed to load the queue");
        });
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load();
    }, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const allItems = data?.items ?? null;
  const channels = data?.channels ?? [];
  // The filter shows only when more than one channel has items or an error.
  const speaking = channels.filter(
    (c) => c.error || allItems?.some((i) => i.channel === c.channel),
  );
  const showFilter = speaking.length > 1;
  const items =
    allItems && filterByChannel(allItems, showFilter ? channel : "all");
  const channelError = channelErrorText(channels);
  const openItem = allItems?.find((i) => i.id === itemId) ?? null;
  const openChannel = itemId?.slice(0, itemId.indexOf(":")) ?? null;

  // Phone: list and conversation are separate pages, with a back button
  // between.
  const showList = !isPhone || !itemId;
  const showTicket = !isPhone || !!itemId;

  function renderMark(item: SupportListItem) {
    const mark = channelMark(item.channel);
    if (!mark) return null;
    const glyph = (
      <span className={ROW_MARK} role="img" aria-label={mark.label}>
        {/* dense: a 14px glyph riding in the meta line, which the 20px
				    icon floor would otherwise make taller than the time. */}
        <mark.Icon size={14} dense />
      </span>
    );
    return isPhone ? glyph : <Tooltip label={mark.label}>{glyph}</Tooltip>;
  }

  function renderRow(item: SupportListItem) {
    const session = liveSessionFor(item, sessions);
    const customer = item.customer.name || item.customer.email || "Unknown";
    const dot =
      (session
        ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))?.dotColor
        : SUPPORT_PRIORITY_DOT[item.priority ?? 2]) || "var(--text-faint)";
    // A send waiting out its veto window shows when it goes, not when the
    // mail came in.
    const veto = item.draftState === "veto" && item.vetoDeadline;
    const stamp = veto ? item.vetoDeadline : item.at;
    return (
      <button
        key={item.id}
        type="button"
        className={ROW}
        data-active={(itemId === item.id && !isPhone) || undefined}
        onClick={() => onSelectItem(item.id)}
      >
        <span className={SIDEBAR_RAIL}>
          <span
            className="size-[7px] rounded-full"
            style={{ backgroundColor: dot }}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className={ROW_HEAD}>
            <span className={ROW_NAME}>{customer}</span>
            {renderMark(item)}
            {stamp && (
              <span
                className={ROW_TIME}
                title={new Date(stamp).toLocaleString()}
              >
                {veto ? `sends ${clockTime(stamp)}` : shortTime(stamp)}
              </span>
            )}
          </span>
          <span className={ROW_SUBJECT}>
            {item.title || item.preview || "No subject"}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {showList && (
        <aside className={COLUMN}>
          <div className={SUPPORT_COLUMN_BAR}>
            <h1 className={COLUMN_TITLE}>Support</h1>
            {items && <span className={COLUMN_COUNT}>{items.length}</span>}
          </div>
          {showFilter && (
            <div className={FILTER_ROW}>
              <Segmented
                label="Channel"
                size="sm"
                value={channel}
                onValueChange={setChannel}
              >
                <SegmentedOption value="all" className={FILTER_OPTION}>
                  All
                </SegmentedOption>
                {speaking.map((c) => (
                  <SegmentedOption
                    key={c.channel}
                    value={c.channel}
                    className={FILTER_OPTION}
                  >
                    {c.label}
                  </SegmentedOption>
                ))}
              </Segmented>
            </div>
          )}
          <div className={LIST}>
            {/* A channel that can't answer is a warning over the rows the
						    others sent, not an error page; only a failed request is. */}
            {channelError && items && items.length > 0 && (
              <InlineAlert variant="warn" className="mx-1.5 mb-2">
                {channelError}
              </InlineAlert>
            )}
            {items === null ? (
              error ? (
                <InlineAlert className="mt-2">{error}</InlineAlert>
              ) : (
                <LoadingState>Loading conversations…</LoadingState>
              )
            ) : items.length === 0 ? (
              channelError ? (
                <InlineAlert variant="warn" className="mt-2">
                  {channelError}
                </InlineAlert>
              ) : (
                <div className="px-3 py-6 text-center text-label text-faint">
                  Nothing waiting.
                </div>
              )
            ) : (
              supportLanes(items).map((lane) => {
                // "Needs you" wears the urgent lane's colour.
                const tone =
                  lane.key === "needs-you"
                    ? SUPPORT_PRIORITY_GROUPS[0].cls
                    : lane.key <= 1
                      ? SUPPORT_PRIORITY_GROUPS[lane.key].cls
                      : null;
                return (
                  <div key={lane.key}>
                    {/* The sidebar's lane caption, not a heading of its
										    own: same tokens, same colour per priority. */}
                    <div
                      className={cn(
                        SIDEBAR_GROUP_HEADER,
                        SIDEBAR_GROUP_HEADER_INSET,
                        SIDEBAR_LANE_HEADER,
                        "cursor-default hover:text-dim",
                      )}
                    >
                      <span
                        className={cn(
                          SIDEBAR_GROUP_NAME,
                          SIDEBAR_LANE_NAME,
                          tone,
                        )}
                      >
                        {lane.label}
                      </span>
                      <span
                        className={cn(
                          SIDEBAR_LANE_COUNT,
                          lane.key === "needs-you"
                            ? tone
                            : SUPPORT_PRIORITY_GROUPS[lane.key].cls,
                        )}
                      >
                        {lane.items.length}
                      </span>
                    </div>
                    {lane.items.map(renderRow)}
                  </div>
                );
              })
            )}
            {data?.truncated && (
              <p className="m-0 px-3 pt-3 text-meta text-faint">
                Showing the newest {SUPPORT_EMAIL_LIST_LIMIT} email
                conversations.
              </p>
            )}
          </div>
        </aside>
      )}

      {showTicket && (
        <section className="flex min-w-0 flex-1 flex-col">
          {/* An open Plain ticket brings its own bar, with its subject and
					    customer in it. This is the one for everything else, and
					    for phones, where the app's floating back control sits here
					    and the ticket keeps its header inline (a second back button
					    would be the same gesture twice). Either way the two columns
					    start on one line. */}
          {(!itemId || isPhone || openChannel !== "plain") && (
            <div className={SUPPORT_COLUMN_BAR} />
          )}
          {itemId && openChannel === "plain" ? (
            <ConversationPane
              key={itemId}
              threadId={supportItemProviderId(itemId)}
              onOpenSession={onOpenSession}
              session={liveSessionFor(
                openItem ?? { id: itemId, channel: "plain", sessionId: null },
                sessions,
              )}
              headerInBar
            />
          ) : itemId ? (
            // An email conversation: who wrote and what they said, from its
            // list row.
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
              <EmptyState
                icon={<IconMail size={22} />}
                title={openItem?.title || "Email conversation"}
              >
                {openItem?.preview || "No preview for this conversation."}
              </EmptyState>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center p-8">
              <EmptyState
                icon={<IconMail size={22} />}
                title="Nothing selected"
              >
                Open a conversation to read it here.
              </EmptyState>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
