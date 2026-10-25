import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import useSWR from "swr";
import type {
  ForgetCustomerResult,
  SupportConversation,
  SupportConversationView,
  SupportIntent,
} from "../../shared/support";
import { useIsPhone } from "../hooks/useIsPhone";
import {
  approveIssue,
  closeConversation,
  dismissIssue,
  fetchInboxes,
  fetchSupportConversation,
  forgetCustomer,
  markNotSpam,
  moveConversation,
  reopenConversation,
  replyToConversation,
  setConversationOwner,
  startFixSession,
} from "../lib/api/support";
import { API_SWR_OPTIONS, apiSWRKey } from "../lib/api-swr";
import { errorMessage } from "../lib/error-message";
import { usePeople } from "../lib/people";
import {
  FLOATING_PILL,
  FLOATING_PILL_BUTTON,
} from "../lib/session-viewer-classes";
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import {
  PREPARED_CARD,
  PREPARED_TEXT,
  QUIET_EVENT,
  SUPPORT_COLUMN_BAR,
  SUPPORT_TOP_RAIL,
} from "../lib/support-classes";
import { supportItemProviderId } from "../lib/support-list";
import {
  agentCantStart,
  fixedNoteReason,
  pendingIssueCopy,
  pollMs,
  timelineEntries,
  waitingFixedNote,
} from "../lib/support-reply";
import type { UnifiedSession } from "../lib/types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { useConfirm } from "../ui/confirm";
import { Field, Input, Textarea } from "../ui/input";
import { Menu } from "../ui/menu";
import { Modal } from "../ui/modal";
import { OptionSelect } from "../ui/select";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import {
  IconCheck,
  IconDotsHorizontal,
  IconFolder,
  IconMail,
  IconPerson,
  IconRestore,
} from "./icons";
import { PlainEntryRow } from "./PlainThreadPanel";
import { SupportReplyBox } from "./SupportReplyBox";

/**
 * The pane width at which the conversation's actions fit in the bar beside
 * the subject: Owner, Move, Mark as done and the overflow come to about
 * 380px, the chip about 140, and the subject keeps 120 at this width.
 * Narrower, the actions sit at the top of the thread with a row of their own.
 */
const ACTIONS_IN_BAR_MIN = 640;

/** "<inbox label> · <project>": which door it came in and whose it is. */
const CHIP =
  "inline-flex max-w-[240px] shrink-0 items-center truncate rounded-[999px] " +
  "bg-active px-2 py-0.5 text-meta font-medium text-dim";

const ACTION = "phone:min-h-11";

const STATUS_WORD: Partial<Record<SupportConversation["status"], string>> = {
  closed: "Done",
  spam: "Spam",
};

/**
 * An email conversation in the Support pane: the thread from the store with
 * its events between the messages, what a person does to it (owner, move,
 * done or reopen, not spam, forget the customer), what the agent prepared
 * for a person (an issue, a fix task, a fixed note), the stop after a second
 * manipulation attempt, and the draft-aware reply box. ConversationPane's shape for a
 * Plain ticket, with the same bar, floating session pill and polling: 10s
 * while a send is about to go or going, else 20s, never while hidden.
 */
export function EmailConversation({
  itemId,
  onOpenSession,
  session,
  headerInBar,
  intent,
  onIntentHandled,
  className,
}: {
  /** The Support list item id (`email:sc_…`). */
  itemId: string;
  onOpenSession: (id: string) => void;
  /** The live session working the conversation, for the pill's dot. */
  session?: UnifiedSession | null;
  /** The subject, customer and actions in a bar of the pane's own (desktop). */
  headerInBar?: boolean;
  /** A support push's button (`?intent=`), handed to the reply box. */
  intent?: SupportIntent;
  onIntentHandled?: () => void;
  className?: string;
}) {
  const id = supportItemProviderId(itemId);
  const isPhone = useIsPhone();
  const people = usePeople();
  const { data: inboxes } = useSWR(
    apiSWRKey.supportInboxes(),
    fetchInboxes,
    API_SWR_OPTIONS,
  );
  const [view, setView] = useState<SupportConversationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState<ForgetCustomerResult | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!paneEl) return;
    setPaneWidth(paneEl.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => {
      setPaneWidth(entry.contentRect.width);
    });
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl]);

  function reload() {
    return fetchSupportConversation(id)
      .then((next) => {
        if (!aliveRef.current) return;
        setView(next);
        setError(null);
      })
      .catch((failure: Error) => {
        if (aliveRef.current) setError(errorMessage(failure, "Failed to load"));
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }
  const load = useEffectEvent(() => void reload());
  useEffect(() => {
    load();
  }, [id]);
  const interval = view ? pollMs(view.conversation) : 20_000;
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, interval);
    return () => clearInterval(poll);
  }, [id, interval]);

  const c = view?.conversation ?? null;
  const headerInTopBar = !!headerInBar && !isPhone;
  const actionsInBar = headerInTopBar && paneWidth >= ACTIONS_IN_BAR_MIN;
  const chip = c ? `${view?.inbox?.label || "Email"} · ${c.project}` : null;
  const customerName = c?.customer.name || "";
  const customerEmail = c?.customer.address || "";
  const statusWord = c ? STATUS_WORD[c.status] : undefined;
  // Handed to a person for good: the agent was stopped on purpose.
  const stopped = c?.personOnly ?? null;
  const cantStart = c && !stopped ? agentCantStart(c) : null;
  const fixedNote = c ? waitingFixedNote(c) : null;
  const rail = c && (c.sessionId || c.fixSessionId || cantStart);

  const actions = c && (
    <EmailConversationActions
      conversation={c}
      isInstanceOwner={inboxes?.isInstanceOwner ?? false}
      projects={inboxes?.projects.map((p) => p.id) ?? [c.project]}
      people={people.map((p) => p.name)}
      onChanged={setView}
      onForgotten={setForgotten}
      layout={actionsInBar ? "bar" : "stack"}
      className={actionsInBar ? "shrink-0" : "mt-3"}
    />
  );

  const sessionState = session
    ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))
    : null;
  const sessionLabel =
    sessionState?.key === "needsinput" || sessionState?.key === "inprogress"
      ? sessionState.label
      : "Open session";

  async function issue(action: "approve" | "dismiss") {
    if (!c || issueBusy) return;
    setIssueBusy(true);
    await (
      action === "approve" ? approveIssue(c.id, c.revision) : dismissIssue(c.id)
    )
      .then((next) => {
        if (aliveRef.current) setView(next);
      })
      .catch((failure: Error) => {
        toast(
          errorMessage(
            failure,
            action === "approve"
              ? "Couldn't create the issue"
              : "Couldn't dismiss the issue",
          ),
          { variant: "error" },
        );
        void reload();
      })
      .finally(() => {
        if (aliveRef.current) setIssueBusy(false);
      });
  }

  if (forgotten)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <EmptyState icon={<IconMail size={22} />} title="Customer forgotten">
          {forgetSummary(forgotten)}
        </EmptyState>
      </div>
    );

  return (
    <div
      ref={setPaneEl}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      {headerInTopBar && (
        <div className={SUPPORT_COLUMN_BAR}>
          {c && (
            <>
              <div className="flex min-w-0 flex-1 flex-col justify-center">
                <h2
                  className="m-0 truncate text-item-title font-semibold text-fg"
                  title={c.subject || undefined}
                >
                  {c.subject || "No subject"}
                </h2>
                <div className="flex min-w-0 items-center gap-1.5 text-meta">
                  {customerName && (
                    <>
                      <span className="truncate text-dim">{customerName}</span>
                      <span className="text-faint">·</span>
                    </>
                  )}
                  <span className="truncate text-faint">{customerEmail}</span>
                </div>
              </div>
              {statusWord && (
                <span className="shrink-0 text-meta font-medium text-faint">
                  {statusWord}
                </span>
              )}
              {chip && (
                <span className={CHIP} title={chip}>
                  {chip}
                </span>
              )}
              {actionsInBar && actions}
            </>
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto">
          <div
            className={cn(
              "mx-auto w-full max-w-[760px] px-5 pb-5",
              rail ? "pt-12" : headerInTopBar ? "pt-1" : "pt-6",
            )}
          >
            {loading && !c ? (
              <LoadingState>Loading conversation…</LoadingState>
            ) : error && !c ? (
              <InlineAlert>
                Couldn't load this conversation: {error}
              </InlineAlert>
            ) : c ? (
              <>
                {!headerInTopBar && (
                  <>
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="truncate text-item-title font-semibold text-fg"
                        title={customerEmail}
                      >
                        {customerName || customerEmail}
                      </span>
                      {customerName && (
                        <span className="truncate text-label text-faint">
                          {customerEmail}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-section-title font-semibold text-fg">
                      {c.subject || "No subject"}
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-2">
                      {chip && (
                        <span className={CHIP} title={chip}>
                          {chip}
                        </span>
                      )}
                      {statusWord && (
                        <span className="text-meta font-medium text-faint">
                          {statusWord}
                        </span>
                      )}
                    </div>
                  </>
                )}
                {!actionsInBar && actions}
                <div className="mt-5 flex flex-col gap-3">
                  {timelineEntries(c).map((entry) =>
                    entry.quiet ? (
                      <p key={entry.id} className={QUIET_EVENT}>
                        {entry.text}
                      </p>
                    ) : (
                      <PlainEntryRow
                        key={entry.id}
                        entry={entry}
                        threadTitle={c.subject}
                      />
                    ),
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
        {rail && c && (
          <div className={SUPPORT_TOP_RAIL}>
            {c.sessionId ? (
              <Tooltip label="Open the support agent's session">
                <button
                  type="button"
                  aria-label={sessionLabel}
                  className={cn(FLOATING_PILL_BUTTON, "pointer-events-auto")}
                  onClick={() => onOpenSession(c.sessionId!)}
                >
                  <span
                    className="size-[7px] shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        sessionState?.dotColor || "var(--text-faint)",
                    }}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{sessionLabel}</span>
                </button>
              </Tooltip>
            ) : cantStart ? (
              <div
                className={cn(
                  FLOATING_PILL,
                  "pointer-events-auto min-w-0 font-normal",
                )}
                role="status"
              >
                <span className="shrink-0 font-semibold text-fg">
                  Agent can't start
                </span>
                <span className="min-w-0 truncate text-dim" title={cantStart}>
                  {cantStart}
                </span>
              </div>
            ) : null}
            {c.fixSessionId && (
              <button
                type="button"
                aria-label="Open fix session"
                className={cn(FLOATING_PILL_BUTTON, "pointer-events-auto")}
                onClick={() => onOpenSession(c.fixSessionId!)}
              >
                <span className="min-w-0 truncate">
                  {fixSessionLabel(view?.fixSession ?? null)}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {c && (
        <div className="mx-auto flex w-full max-w-[760px] shrink-0 flex-col gap-3 px-5 pb-5">
          {stopped && (
            <InlineAlert
              variant="warn"
              title="Possible manipulation attempt. The agent stopped"
            >
              A customer message tried to give the agent instructions twice.
              Nothing sends on its own now. Reply yourself or close the
              conversation.
            </InlineAlert>
          )}
          {c.pendingIssue && (
            <PendingIssueCard
              issue={c.pendingIssue}
              isInstanceOwner={inboxes?.isInstanceOwner ?? false}
              busy={issueBusy}
              onApprove={() => void issue("approve")}
              onDismiss={() => void issue("dismiss")}
            />
          )}
          {c.fixTask && !c.fixSessionId && (
            <FixTaskCard
              key={`${c.fixTask.at}`}
              conversation={c}
              onStarted={setView}
              onRefetch={() => void reload()}
            />
          )}
          {fixedNote && c.status !== "spam" && (
            <FixedNoteCard
              key={fixedNote.at}
              conversation={c}
              note={fixedNote}
              onSent={setView}
              onRefetch={() => void reload()}
            />
          )}
          {c.status !== "spam" && (
            <SupportReplyBox
              key={c.draft?.id ?? "compose"}
              conversation={c}
              inboxAddress={view?.inbox?.address ?? null}
              intent={intent}
              onIntentHandled={onIntentHandled}
              onChanged={setView}
              onRefetch={() => void reload()}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The fix session pill: where its pull request stands, when it has one. */
function fixSessionLabel(
  fix: SupportConversationView["fixSession"] | null,
): string {
  if (fix?.prState === "MERGED") return "Fix merged";
  if (fix?.prState === "OPEN") return "Fix in review";
  return "Open fix session";
}

/** The issue the agent prepared: its title and scrubbed text as they
 *  would be posted. A person creates it or dismisses it. */
export function PendingIssueCard({
  issue,
  isInstanceOwner,
  busy,
  onApprove,
  onDismiss,
}: {
  issue: NonNullable<SupportConversation["pendingIssue"]>;
  isInstanceOwner: boolean;
  busy: boolean;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const copy = pendingIssueCopy(issue, isInstanceOwner);
  return (
    <div className={PREPARED_CARD}>
      <p className="m-0 text-supporting text-fg">{copy.text}</p>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="m-0 text-label font-medium text-fg [overflow-wrap:anywhere]">
          {issue.title}
        </p>
        {issue.ghRepo && (
          <p className="m-0 truncate text-meta text-faint">{issue.ghRepo}</p>
        )}
        {issue.body && (
          <pre className={PREPARED_TEXT} aria-label="Issue text">
            {issue.body}
          </pre>
        )}
      </div>
      {copy.why && <p className="m-0 text-label text-faint">{copy.why}</p>}
      <div className="flex flex-wrap gap-2">
        {copy.canApprove && (
          <Button
            size="sm"
            variant="primary"
            className={ACTION}
            disabled={busy}
            onClick={onApprove}
          >
            Create issue
          </Button>
        )}
        <Button
          size="sm"
          variant="default"
          className={ACTION}
          disabled={busy}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** The fix task the agent prepared from a customer email: a person edits
 *  it and starts a fix session from it. Nothing starts on its own. */
export function FixTaskCard({
  conversation: c,
  onStarted,
  onRefetch,
}: {
  conversation: SupportConversation;
  onStarted: (view: SupportConversationView) => void;
  onRefetch: () => void;
}) {
  const [task, setTask] = useState(c.fixTask?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!task.trim() || busy) return;
    setBusy(true);
    setError(null);
    await startFixSession(c.id, c.revision, task.trim())
      .then(onStarted)
      .catch((failure: Error) => {
        setError(errorMessage(failure, "Couldn't start the fix session"));
        onRefetch();
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className={PREPARED_CARD}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="m-0 text-supporting text-fg">
          The agent prepared a fix task
        </p>
        <span className="text-meta text-faint">From a customer email</span>
      </div>
      <p className="m-0 text-label text-dim">
        {`Starts a code session in ${c.fixTask?.project ?? c.project} as you, with this task. Its words come from the customer, so read it first.`}
      </p>
      <Textarea
        aria-label="Fix task"
        rows={3}
        value={task}
        disabled={busy}
        onChange={(e) => setTask(e.target.value)}
        className="phone:text-input-phone"
      />
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          className={ACTION}
          disabled={busy || !task.trim()}
          onClick={() => void start()}
        >
          Start a fix session
        </Button>
      </div>
    </div>
  );
}

/** The "it's fixed" note the server prepared while another draft was in
 *  the reply box. A person sends it once that draft is settled. */
export function FixedNoteCard({
  conversation: c,
  note,
  onSent,
  onRefetch,
}: {
  conversation: SupportConversation;
  note: NonNullable<SupportConversation["fixedNote"]>;
  onSent: (view: SupportConversationView) => void;
  onRefetch: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftLive =
    !!c.draft && c.draft.state !== "sent" && c.draft.state !== "discarded";

  async function send() {
    if (busy || draftLive) return;
    setBusy(true);
    setError(null);
    await replyToConversation(c.id, note.text)
      .then(onSent)
      .catch((failure: Error) => {
        setError(errorMessage(failure, "Couldn't send the fixed note"));
        onRefetch();
      })
      .finally(() => setBusy(false));
  }

  return (
    <div className={PREPARED_CARD}>
      <p className="m-0 text-supporting text-fg">
        {`${fixedNoteReason(note)}. A note for the customer is ready.`}
      </p>
      <pre className={PREPARED_TEXT} aria-label="Fixed note">
        {note.text}
      </pre>
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          className={ACTION}
          disabled={busy || draftLive}
          onClick={() => void send()}
        >
          Send fixed note
        </Button>
        {draftLive && (
          <span className="text-label text-faint">
            Send or discard the draft below first
          </span>
        )}
      </div>
    </div>
  );
}

function forgetSummary(r: ForgetCustomerResult): string {
  const parts = [
    `${r.conversations} ${r.conversations === 1 ? "conversation" : "conversations"}`,
    `${r.sessions} ${r.sessions === 1 ? "session" : "sessions"}`,
    `${r.attachments} ${r.attachments === 1 ? "attachment" : "attachments"}`,
  ];
  const kept = r.notDeleted.length
    ? ` Not deleted: ${r.notDeleted.join(", ")}.`
    : "";
  const failed = r.failed ? ` ${r.failed} couldn't be deleted.` : "";
  return `Deleted ${parts.join(", ")}.${failed}${kept}`;
}

/**
 * What a person does to an email conversation besides replying: the owner,
 * a move to another project (only a person moves a conversation), Mark as
 * done or Reopen, and in the overflow Not spam
 * (spam only) and Forget this customer (the instance owner only, behind a
 * confirm that says what goes). Each answers with the conversation, which
 * replaces the pane's copy.
 */
export function EmailConversationActions({
  conversation: c,
  isInstanceOwner,
  projects,
  people,
  onChanged,
  onForgotten,
  layout = "stack",
  className,
}: {
  conversation: SupportConversation;
  isInstanceOwner: boolean;
  /** Every project a conversation can be in. */
  projects: string[];
  /** Roster first names, for the Owner menu. */
  people: string[];
  onChanged: (view: SupportConversationView) => void;
  onForgotten?: (result: ForgetCustomerResult) => void;
  layout?: "stack" | "bar";
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const inBar = layout === "bar";

  async function run(
    action: () => Promise<SupportConversationView>,
    failed: string,
  ) {
    if (busy) return;
    setBusy(true);
    await action()
      .then(onChanged)
      .catch((failure: Error) =>
        toast(errorMessage(failure, failed), { variant: "error" }),
      )
      .finally(() => setBusy(false));
  }

  async function forget() {
    setBusy(true);
    await forgetCustomer(c.customer.address)
      .then((result) => {
        toast(forgetSummary(result));
        onForgotten?.(result);
      })
      .catch((failure: Error) =>
        toast(errorMessage(failure, "Couldn't forget this customer"), {
          variant: "error",
        }),
      )
      .finally(() => setBusy(false));
  }

  function askForget() {
    confirm({
      title: `Forget ${c.customer.address}?`,
      description:
        "Deletes every conversation with this address, their support sessions, drafts and attachments. Mail in the mailbox and GitHub issues are not deleted",
      confirmLabel: "Forget",
      destructive: true,
      onConfirm: () => void forget(),
    });
  }

  const open = c.status === "open" || c.status === "waiting";
  const overflow = c.status === "spam" || isInstanceOwner;
  const ownerChoices =
    c.owner && !people.includes(c.owner) ? [c.owner, ...people] : people;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        inBar ? "flex-nowrap" : "flex-wrap",
        className,
      )}
    >
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              size="sm"
              variant="default"
              icon={<IconPerson size={20} />}
              caret
              className={ACTION}
              disabled={busy}
              title="Who answers this conversation"
            >
              {c.owner ? `Owner: ${c.owner}` : "Owner"}
            </Button>
          }
        />
        <Menu.Popup align="start">
          {ownerChoices.length === 0 ? (
            <div className="px-2.5 py-1.5 text-label text-faint">
              Nobody on the team yet
            </div>
          ) : (
            ownerChoices.map((name) => (
              <Menu.Item
                key={name}
                onClick={() =>
                  void run(
                    () => setConversationOwner(c.id, name),
                    "Couldn't change the owner",
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <Menu.Check on={c.owner === name} className="ml-auto" />
              </Menu.Item>
            ))
          )}
        </Menu.Popup>
      </Menu.Root>
      <Button
        size="sm"
        variant="default"
        icon={<IconFolder size={20} />}
        className={ACTION}
        disabled={busy}
        onClick={() => setMoveOpen(true)}
        title="Move this conversation to another project"
      >
        Move
      </Button>
      {open ? (
        <Button
          size="sm"
          variant="default"
          icon={<IconCheck size={20} />}
          className={cn(ACTION, "hover:text-green")}
          disabled={busy}
          onClick={() =>
            void run(() => closeConversation(c.id), "Couldn't mark it as done")
          }
        >
          Mark as done
        </Button>
      ) : c.status === "closed" ? (
        <Button
          size="sm"
          variant="default"
          icon={<IconRestore size={20} />}
          className={ACTION}
          disabled={busy}
          onClick={() =>
            void run(
              () => reopenConversation(c.id),
              "Couldn't reopen the conversation",
            )
          }
        >
          Reopen
        </Button>
      ) : null}
      {overflow && (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="sm"
                variant="default"
                icon={<IconDotsHorizontal size={20} />}
                className={cn(ACTION, "phone:min-w-11")}
                disabled={busy}
                aria-label="More conversation actions"
                title="More actions"
              />
            }
          />
          <Menu.Popup align="end">
            {c.status === "spam" && (
              <Menu.Item
                onClick={() =>
                  void run(
                    () => markNotSpam(c.id),
                    "Couldn't mark it as not spam",
                  )
                }
              >
                Not spam
              </Menu.Item>
            )}
            {isInstanceOwner && (
              <Menu.Item onClick={askForget}>Forget this customer</Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Root>
      )}
      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        conversation={c}
        projects={projects}
        onMoved={onChanged}
      />
      {confirmDialog}
    </div>
  );
}

/** Move: a project and the reason, both required. A refusal (no such
 *  project, no reason) reads in the dialog. */
function MoveDialog({
  open,
  onOpenChange,
  conversation: c,
  projects,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: SupportConversation;
  projects: string[];
  onMoved: (view: SupportConversationView) => void;
}) {
  const others = projects.filter((p) => p !== c.project);
  const [project, setProject] = useState(others[0] ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const target = others.includes(project) ? project : (others[0] ?? "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !reason.trim() || busy) return;
    setBusy(true);
    setError(null);
    await moveConversation(c.id, target, reason.trim())
      .then((next) => {
        onMoved(next);
        setReason("");
        onOpenChange(false);
      })
      .catch((failure: Error) =>
        setError(errorMessage(failure, "Couldn't move the conversation")),
      )
      .finally(() => setBusy(false));
  }

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content widthClassName="max-w-[28rem]" initialFocus={reasonRef}>
        <Modal.Header
          title="Move this conversation"
          description={`From ${c.project}. Its agent starts again in the new project.`}
        />
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {others.length === 0 ? (
            <p className="m-0 text-supporting text-dim">
              There is no other project to move it to.
            </p>
          ) : (
            <>
              <Field label="Project">
                <OptionSelect
                  label="Project"
                  value={target}
                  options={others.map((p) => ({ value: p, label: p }))}
                  onChange={setProject}
                  className="phone:min-h-11"
                />
              </Field>
              <Field label="Why it moves">
                <Input
                  ref={reasonRef}
                  value={reason}
                  required
                  maxLength={500}
                  placeholder="The customer asks about billing"
                  onChange={(e) => setReason(e.target.value)}
                  className="phone:min-h-11 phone:text-input-phone"
                />
              </Field>
            </>
          )}
          {error && <InlineAlert>{error}</InlineAlert>}
          <Modal.Footer>
            <Button
              type="button"
              size="lg"
              variant="soft"
              className="phone:min-h-11 phone:flex-1"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              variant="primary"
              className="phone:min-h-11 phone:flex-1"
              disabled={busy || !target || !reason.trim()}
            >
              Move
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
