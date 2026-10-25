import React, { useCallback, useEffect, useRef, useState } from "react";
import type { PlainThread, UnifiedSession } from "../lib/types";
import { fetchPlainThreadById, startPlainTriageApi } from "../lib/api";
import { useSupportPaneLayout } from "../hooks/useSupportPaneLayout";
import { InlineAlert, LoadingState } from "../ui/state";
import { Tooltip } from "../ui/tooltip";
// The transcript's floating pills. This is the same job — chrome that hangs
// over live content the reader is scrolling — so it takes the same shape
// rather than a second one invented here, in its opaque form: a support
// message runs the full width of the column, so glass would show the words
// through the pill.
import {
  FLOATING_PILL,
  FLOATING_PILL_LOADING,
  TRANSCRIPT_PILL_SPINNER,
} from "../lib/session-viewer-classes";
import { PlainStatusBadge } from "./PlainStatusBadge";
import {
  PlainReplyBox,
  PlainThreadActions,
  PlainWaitingBanner,
} from "./PlainThreadPanel";
import { cn } from "../ui/cn";
import { IconSparkle } from "./icons";
import { errorMessage } from "../lib/error-message";
import { parseSupportItemId, type SupportIntent } from "../../shared/support";
import { EmailConversation } from "./EmailConversation";
import { SupportMessageList } from "./SupportMessageList";
import {
  SupportRailButton,
  SupportSessionPill,
  SupportThreadBar,
  SupportThreadBody,
  SupportThreadFooter,
  SupportThreadHeader,
} from "./SupportThread";

interface Props {
  /** The Plain thread id — the pane's key. */
  threadId: string;
  /** A Support list item id (`plain:th_…`, `email:sc_…`), when the pane
   *  opens from the Support list: an email item opens EmailConversation,
   *  a Plain item this pane for its thread. */
  itemId?: string;
  /** A support push's button (`?intent=`), on an email conversation. */
  intent?: SupportIntent;
  onIntentHandled?: () => void;
  /** Navigate into a session (the triage button resolves to one over HTTP). */
  onOpenSession: (id: string) => void;
  /** Hide the "Triage this ticket" affordance (e.g. the pane is already
   *  rendered inside the session that would answer it). */
  hideTriage?: boolean;
  /** A session already working this ticket. Shown at the top of the thread in
   *  place of the triage offer: on the Support page the ticket is all you can
   *  see, so without this there is nothing to say the agent has been here, and
   *  no way through to what it did. */
  session?: UnifiedSession | null;
  className?: string;
  /** Put the ticket's identity — subject, status, customer — in a top bar of
   *  the pane's own instead of at the top of the thread. For the Support
   *  inbox, where the pane has that bar to itself. */
  headerInBar?: boolean;
}

/**
 * The pane width at which the ticket's actions fit in the bar beside the
 * subject. Measured on a ticket carrying the widest of them (an assignee, a
 * named priority, two labels): the action row 536px, the status badge 26, the
 * bar's own padding and gaps 48. At this threshold that leaves the subject and
 * the customer under it about 140px, which is short but still reads as a title
 * rather than as an ellipsis; wider panes give it everything they gain. A
 * 1440pt window clears it, the app sidebar and the queue column taking about
 * 600 of whatever is left.
 *
 * It came down 40px when "Open in Plain" stopped being a link floating at the
 * end of the bar and became a button in the action row, which is a smaller
 * control saying the same thing.
 *
 * Narrower than this the actions stay at the top of the thread, where they have
 * a whole row to wrap into.
 */
const ACTIONS_IN_BAR_MIN = 750;

/**
 * The support-ticket Conversation surface: the full thread straight from Plain
 * (no LLM involved) with ticket admin (status/priority/assign/labels/spam), a
 * customer-reply / internal-note box, and the one-click triage affordance.
 * Rendered as a workspace view tab (the Conversation tab of ticket-backed
 * workspaces) and by the legacy session-less /support preview. Polls at 20s —
 * there's no live push for Plain.
 */
export function ConversationPane(props: Props) {
  const item = props.itemId ? parseSupportItemId(props.itemId) : null;
  if (item?.channel === "email")
    return (
      <EmailConversation
        itemId={props.itemId!}
        onOpenSession={props.onOpenSession}
        session={props.session}
        headerInBar={props.headerInBar}
        intent={props.intent}
        onIntentHandled={props.onIntentHandled}
        className={props.className}
      />
    );
  return (
    <PlainConversationPane {...props} threadId={item?.id ?? props.threadId} />
  );
}

function PlainConversationPane({
  threadId,
  onOpenSession,
  hideTriage,
  session,
  className,
  headerInBar,
}: Props) {
  const [thread, setThread] = useState<PlainThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null);
  const { paneRef, inBar, actionsInBar } = useSupportPaneLayout(
    headerInBar,
    ACTIONS_IN_BAR_MIN,
  );
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Load on mount / thread change, then poll — the customer can reply while
  // the ticket is being read and there's no live push for Plain.
  const load = useCallback(() => {
    return fetchPlainThreadById(threadId)
      .then((t) => {
        if (!aliveRef.current) return;
        setThread(t);
        setError(null);
      })
      .catch((e) => {
        if (aliveRef.current) setError(e?.message || "Failed to load");
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, [threadId]);
  useEffect(() => {
    setLoading(true);
    setThread(null);
    setError(null);
    load();
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, 20000);
    return () => clearInterval(poll);
  }, [load]);
  // The triage automation reuses a live session for this thread when one
  // exists, else boots a fresh run — that takes tens of seconds, so keep the
  // button in a visible in-progress state the whole way.
  async function handleTriage() {
    if (triaging) return;
    setTriaging(true);
    setTriageError(null);
    await (async () => {
      const sessionId = await startPlainTriageApi(threadId);
      if (aliveRef.current) onOpenSession(sessionId);
    })()
      .catch(async (error) => {
        if (aliveRef.current)
          setTriageError(
            errorMessage(error, "Failed to start the triage run."),
          );
      })
      .finally(async () => {
        if (aliveRef.current) setTriaging(false);
      });
  }

  const status = thread?.status;
  const badge = status ? <PlainStatusBadge status={status} /> : null;
  const identity = {
    subject: thread?.title,
    customerName: thread?.customer?.name || "",
    customerEmail: thread?.customer?.email || "",
    badge,
  };

  // A ticket with a session on it is being worked; offering to start that
  // work again would be the wrong thing to put in front of the reader, so the
  // two share one slot. Neither depends on the thread having loaded, and the
  // rail is what the thread's top padding clears, so this must not change
  // when the ticket lands.
  const rail = session ? (
    <SupportSessionPill
      sessionId={session.id}
      session={session}
      tooltip={`Open the session on this ticket${
        session.title ? ` · ${session.title}` : ""
      }`}
      onOpenSession={onOpenSession}
    />
  ) : hideTriage ? null : (
    <>
      {triaging ? (
        <div className={FLOATING_PILL_LOADING}>
          <span className={TRANSCRIPT_PILL_SPINNER} aria-hidden />
          <span>Starting triage…</span>
        </div>
      ) : (
        <Tooltip label="Investigates, posts an internal note, and can open a PR for review.">
          <SupportRailButton onClick={handleTriage}>
            <IconSparkle size={14} className="text-dim" aria-hidden />
            Triage this ticket
          </SupportRailButton>
        </Tooltip>
      )}
      {triageError && (
        <div
          className={cn(
            FLOATING_PILL,
            "pointer-events-auto min-w-0 font-normal text-red",
          )}
          role="alert"
        >
          <span className="min-w-0 truncate" title={triageError}>
            {triageError}
          </span>
        </div>
      )}
    </>
  );

  return (
    <div
      ref={paneRef}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      {inBar && (
        <SupportThreadBar>
          {thread && (
            <SupportThreadHeader
              placement="bar"
              {...identity}
              actions={
                actionsInBar && (
                  <PlainThreadActions
                    threadId={threadId}
                    thread={thread}
                    onChanged={load}
                    layout="bar"
                    className="shrink-0"
                  />
                )
              }
            />
          )}
        </SupportThreadBar>
      )}
      <SupportThreadBody rail={rail} inBar={inBar}>
        {loading && !thread ? (
          <LoadingState>Loading ticket…</LoadingState>
        ) : error && !thread ? (
          <InlineAlert>Couldn't load this Plain thread: {error}</InlineAlert>
        ) : (
          <>
            {!inBar && <SupportThreadHeader placement="inline" {...identity} />}

            {/* Is anyone still owed an answer? Plain leads with this; so
                should we. */}
            {thread && <PlainWaitingBanner thread={thread} className="mt-3" />}

            {/* One-click ticket admin, straight from here: status, priority,
                spam — no need to jump into Plain. Only when the bar could
                not take it. */}
            {thread && !actionsInBar && (
              <PlainThreadActions
                threadId={threadId}
                thread={thread}
                onChanged={load}
                className="mt-3"
              />
            )}

            {thread && (
              <SupportMessageList
                entries={thread.entries}
                threadId={threadId}
                threadTitle={thread.title}
                className="mt-5"
              />
            )}
          </>
        )}
      </SupportThreadBody>

      {/* Keep the customer reply available while the ticket scrolls. */}
      {thread && (
        <SupportThreadFooter>
          <PlainReplyBox
            key={threadId}
            threadId={threadId}
            customerName={
              thread.customer?.name || thread.customer?.email || null
            }
            onSent={load}
          />
        </SupportThreadFooter>
      )}
    </div>
  );
}
