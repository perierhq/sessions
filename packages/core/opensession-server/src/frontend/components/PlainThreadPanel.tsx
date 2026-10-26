import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  PlainLabelType,
  PlainThread,
  PlainWorkspaceUser,
} from "../lib/types";
import {
  changePlainThreadLabelsApi,
  fetchPlainLabelTypesApi,
  fetchPlainThreadApi,
  fetchPlainUsersApi,
  PLAIN_ATTACHMENTS_MAX_COUNT,
  PLAIN_ATTACHMENT_MAX_BYTES,
  PLAIN_NOTE_ATTACHMENTS_MAX_BYTES,
  PLAIN_REPLY_ATTACHMENT_MAX_BYTES,
  sendPlainReplyApi,
  setPlainThreadAssigneeApi,
  setPlainThreadPriorityApi,
  setPlainThreadSpamApi,
  setPlainThreadStatusApi,
  setPlainThreadTitleApi,
  uploadPlainAttachmentApi,
} from "../lib/api";
import { Menu } from "../ui/menu";
import { useCurrentUser } from "./UserPicker";
import { cn } from "../ui/cn";
import { PLAIN_WORKSPACE_ID, PRODUCT_NAME } from "../lib/brand";
import { PlainStatusBadge } from "./PlainStatusBadge";
import { noteSurface } from "../lib/tinted-surface";
import { paletteIconBtn, palettePill } from "../lib/palette-classes";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import {
  IconArrowUpRight,
  IconCheck,
  IconDotsHorizontal,
  IconClock,
  IconFlag,
  IconForbid,
  IconPencil,
  IconPerson,
  IconPlus,
  IconRestore,
  IconTag,
} from "./icons";
import { FileChips } from "./FileChips";
import { UserAvatar } from "./UserAvatar";
import { SupportMessageList } from "./SupportMessageList";
import { SupportComposer, SupportSendButton } from "./SupportComposer";
import { useSavedDraft } from "../hooks/useSavedDraft";
import { PlainButton } from "../ui/plain-button";
import { errorMessage } from "../lib/error-message";

interface Props {
  sessionId: string;
  /** The linked Plain thread id — panel re-fetches when it changes. */
  threadId: string;
  /** Deep link into the thread in the Plain app (the "jump into Plain" action). */
  plainUrl: string;
}

/** Deep link into the Plain app, or "" when the instance has no configured
 *  Plain workspace id (integrations.plain.workspaceId) — links hide. */
export function plainThreadUrl(threadId: string): string {
  return PLAIN_WORKSPACE_ID
    ? `https://app.plain.com/workspace/${PLAIN_WORKSPACE_ID}/thread/${threadId}/`
    : "";
}

/**
 * Read-only conversation timeline for a session's linked Plain thread: customer
 * emails/chats on the left, support/bot replies on the right, internal notes
 * inline. Polls lightly so new replies show up, and offers a one-click jump into
 * the thread in Plain. Shown as the session viewer's "Plain" workspace tab.
 */
export function PlainThreadPanel({ sessionId, threadId, plainUrl }: Props) {
  const [thread, setThread] = useState<PlainThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Load on mount / thread change, then poll — a customer can reply at any time
  // and there's no live push for Plain, so a gentle refresh keeps it current.
  // `load` is callable on its own so the reply box can refresh the timeline
  // right after a send instead of waiting out the poll.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const load = useCallback(
    () =>
      fetchPlainThreadApi(sessionId)
        .then((t) => {
          if (!aliveRef.current) return;
          setThread(t);
          setError(null);
        })
        .catch((error) => {
          if (aliveRef.current) {
            // Record every failure so a later successful poll can clear it.
            // The error renders only when no valid thread is available.
            setError(errorMessage(error, "Failed to load Plain thread"));
          }
        })
        .finally(() => {
          if (aliveRef.current) setLoading(false);
        }),
    [sessionId],
  );
  useEffect(() => {
    setLoading(true);
    setError(null);
    load();
    const poll = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      load();
    }, 20000);
    return () => clearInterval(poll);
  }, [threadId, load]);

  // Keep the newest message in view, but only when the reader is already near the
  // bottom — a poll refresh shouldn't yank them out of scrollback.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [thread?.entries.length]);

  const status = thread?.status;

  return (
    <div className="flex h-full min-h-0 flex-col bg-raised">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-label font-semibold text-fg"
            title={thread?.customer?.email || ""}
          >
            {thread?.customer?.name ||
              thread?.customer?.email ||
              "Plain thread"}
          </span>
          {status && <PlainStatusBadge status={status} />}
        </div>
      </div>

      {thread?.waitingSince && (
        <PlainWaitingBanner
          thread={thread}
          className="shrink-0 mx-3 mt-2 rounded-md"
        />
      )}

      {thread && (
        <PlainThreadActions
          threadId={threadId}
          thread={thread}
          onChanged={load}
          className="shrink-0 px-3 py-2 border-b border-divider"
        />
      )}

      {thread?.title && (
        <div className="shrink-0 border-b border-divider px-3 py-2 text-label font-semibold text-fg">
          {thread.title}
        </div>
      )}

      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
        ref={bodyRef}
      >
        {loading && !thread ? (
          <div className="mt-5 text-center text-label text-faint">
            Loading conversation…
          </div>
        ) : error && !thread ? (
          <div className="mt-5 text-center text-label text-faint">
            Couldn't load Plain thread: {error}
          </div>
        ) : thread ? (
          <SupportMessageList
            entries={thread.entries}
            threadId={threadId}
            threadTitle={thread.title}
          />
        ) : null}
      </div>

      {thread && (
        <PlainReplyBox
          key={threadId}
          threadId={threadId}
          customerName={thread.customer?.name || thread.customer?.email || null}
          onSent={load}
          className="mx-3 mb-3"
        />
      )}
    </div>
  );
}

/** Plain thread priorities, as Plain's own UI names them. */
const PRIORITY_LABELS = new Map([
  [0, "Urgent"],
  [1, "High"],
  [2, "Normal"],
  [3, "Low"],
]);

const SNOOZE_OPTIONS: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3_600 },
  { label: "4 hours", seconds: 4 * 3_600 },
  { label: "1 day", seconds: 86_400 },
  { label: "3 days", seconds: 3 * 86_400 },
  { label: "1 week", seconds: 7 * 86_400 },
];

/** A checkmark on the current choice, at the trailing edge — the app's own menu
 *  grammar (see Archived.tsx), where this row used to lead with a "✓" glyph in
 *  a hand-measured 16px gutter. */
function MenuTick({ on }: { on: boolean }) {
  return <Menu.Check on={on} className="ml-auto" />;
}

/**
 * Quick thread actions mirroring Plain's own inbox: status (Todo / Snoozed /
 * Done), priority, and mark-as-spam. Spam lives on the customer in Plain, so
 * marking spam also closes the thread. Shared by the session viewer's Plain
 * tab and the Support ticket preview — like the reply box, these are the
 * human gate: agent runs never get Plain writes as tools.
 *
 * Two layouts. `stack` is the row above a thread: it wraps onto a second line
 * when it runs out of width, and reports a failure underneath. `bar` is the
 * Support inbox's top bar, where there is one line and no room to grow, so the
 * row cannot wrap, a failure reads beside the controls instead of below them,
 * the two rarely-used actions (rename, spam) fold into an overflow menu, and
 * Done and Snooze drop to their glyphs. Those folds are what make the set fit
 * next to a subject, which is the difference between a readable ticket title
 * and an ellipsis.
 */
export function PlainThreadActions({
  threadId,
  thread,
  onChanged,
  layout = "stack",
  className,
}: {
  threadId: string;
  thread: PlainThread;
  /** Called after any successful action so the owner can refresh. */
  onChanged: () => void;
  layout?: "stack" | "bar";
  className?: string;
}) {
  const inBar = layout === "bar";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentUser = useCurrentUser();

  // Assign/Labels menu data — server-cached (~5 min), so fetching per mount
  // is cheap. Each menu owns its loader error so mutation feedback keeps the
  // action row's existing error slot.
  const [users, setUsers] = useState<PlainWorkspaceUser[] | null>(null);
  const [usersLoadError, setUsersLoadError] = useState<string | null>(null);
  const [labelTypes, setLabelTypes] = useState<PlainLabelType[] | null>(null);
  const [labelTypesLoadError, setLabelTypesLoadError] = useState<string | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    fetchPlainUsersApi()
      .then((u) => {
        if (!alive) return;
        setUsers(u);
        setUsersLoadError(null);
      })
      .catch((error) => {
        if (alive)
          setUsersLoadError(errorMessage(error, "Failed to load Plain users"));
      });
    fetchPlainLabelTypesApi()
      .then((lt) => {
        if (!alive) return;
        setLabelTypes(lt);
        setLabelTypesLoadError(null);
      })
      .catch((error) => {
        if (alive)
          setLabelTypesLoadError(
            errorMessage(error, "Failed to load Plain labels"),
          );
      });
    return () => {
      alive = false;
    };
  }, []);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    await (async () => {
      await fn();
      onChanged();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Plain update failed"));
      })
      .finally(async () => {
        setBusy(false);
      });
  }

  const status = thread.status;
  const setStatus = (
    s: "todo" | "done" | "snoozed",
    durationSeconds?: number,
  ) =>
    run(() =>
      setPlainThreadStatusApi(threadId, s, {
        durationSeconds,
        user: currentUser,
      }),
    );

  const customerLabel =
    thread.customer?.name || thread.customer?.email || "this customer";
  const isSpam = !!thread.customer?.isSpam;

  // Shared by the visible buttons and their overflow-menu twins.
  const renameThread = () => {
    const next = window.prompt(
      "Rename this thread in Plain:",
      thread.title || "",
    );
    const t = next?.trim();
    if (t && t !== thread.title)
      run(() => setPlainThreadTitleApi(threadId, t, currentUser));
  };
  const toggleSpam = () => {
    if (
      isSpam ||
      window.confirm(
        `Mark ${customerLabel} as spam?\n\nPlain filters all their threads and this one is closed right away. Reversible via “Not spam”.`,
      )
    )
      run(() => setPlainThreadSpamApi(threadId, !isSpam, currentUser));
  };
  const spamTitle = isSpam
    ? "This customer is marked as spam in Plain. Click to undo."
    : "Mark this customer as spam in Plain (also closes the thread)";

  // Every control carries its field's glyph, so the row reads as icons first:
  // what "Low", "Johnny" and "Mac App +2" each MEAN is otherwise something you
  // work out from the words. That costs the bar 96px it does not have (see
  // ACTIONS_IN_BAR_MIN in ConversationPane), and the ticket's subject is what
  // pays. So in the bar the two verbs go glyph-only and hand the width back:
  // a check and a clock say Done and Snooze on their own, where a flag or a
  // tag without its value would say nothing. The thread's own row has space
  // for both, and keeps the words.
  const verbLabel = (text: string) => (inBar ? false : text);

  // The way out to Plain, for the few things this pane cannot do. It belongs
  // with the ticket's other actions rather than beside them as a link: it
  // used to be a blue anchor at the end of the bar, which made the quietest
  // action in the row the loudest thing in it, and put a second vocabulary
  // next to five bordered controls. An action that NAVIGATES still has to be
  // an anchor, so it is the Button primitive rendered as one — that is what
  // `render` and the `trailing` outbound arrow are for.
  const plainUrl = plainThreadUrl(threadId);

  return (
    <div
      className={cn(
        "flex gap-1",
        inBar ? "min-w-0 items-center" : "flex-col",
        className,
      )}
    >
      {/* Each action draws its own edge (`default`, the raised control),
			    rather than the set sharing one box. A ghost has no shape until
			    you hover it, so beside a subject these read as loose words
			    trailing off it; giving each one a hairline says where a control
			    starts and ends, and keeps them separable: they are six unrelated
			    fields, not one segmented choice. */}
      <div
        className={cn(
          "flex items-center gap-1",
          inBar ? "flex-nowrap" : "flex-wrap",
        )}
      >
        {status === "DONE" ? (
          <Button
            size="sm"
            variant="default"
            icon={<IconRestore size={20} />}
            disabled={busy}
            onClick={() => setStatus("todo")}
            aria-label="Reopen this thread (back to Todo)"
            title="Reopen this thread (back to Todo)"
          >
            {verbLabel("Reopen")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              icon={<IconCheck size={20} />}
              className="hover:text-green"
              disabled={busy}
              onClick={() => setStatus("done")}
              aria-label="Mark this thread Done in Plain"
              title="Mark this thread Done in Plain"
            >
              {verbLabel("Done")}
            </Button>
            {status === "SNOOZED" ? (
              <Button
                size="sm"
                variant="default"
                icon={<IconRestore size={20} />}
                disabled={busy}
                onClick={() => setStatus("todo")}
                aria-label="Unsnooze, back to Todo"
                title="Unsnooze, back to Todo"
              >
                {verbLabel("Unsnooze")}
              </Button>
            ) : (
              <Menu.Root>
                <Menu.Trigger
                  render={
                    <Button
                      size="sm"
                      variant="default"
                      icon={<IconClock size={20} />}
                      caret
                      className={cn(inBar && "w-auto px-2")}
                      disabled={busy}
                      aria-label="Snooze this thread"
                      title="Snooze this thread"
                    >
                      {verbLabel("Snooze")}
                    </Button>
                  }
                />
                <Menu.Popup align="start">
                  {SNOOZE_OPTIONS.map((o) => (
                    <Menu.Item
                      key={o.seconds}
                      onClick={() => setStatus("snoozed", o.seconds)}
                    >
                      {o.label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Root>
            )}
          </>
        )}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="sm"
                variant="default"
                icon={<IconFlag size={20} />}
                caret
                disabled={busy}
                title="Change priority in Plain"
              >
                {thread.priority != null
                  ? (PRIORITY_LABELS.get(thread.priority) ??
                    `P${thread.priority}`)
                  : "Priority"}
              </Button>
            }
          />
          <Menu.Popup align="start">
            {([0, 1, 2, 3] as const).map((p) => (
              <Menu.Item
                key={p}
                onClick={() =>
                  run(() => setPlainThreadPriorityApi(threadId, p, currentUser))
                }
              >
                <span className="min-w-0 flex-1">{PRIORITY_LABELS.get(p)}</span>
                <MenuTick on={thread.priority === p} />
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Root>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                size="sm"
                variant="default"
                icon={<IconPerson size={20} />}
                caret
                disabled={busy}
                title={
                  usersLoadError ?? "Assign this thread to a teammate in Plain"
                }
              >
                {usersLoadError
                  ? "Assign unavailable"
                  : thread.assignee
                    ? thread.assignee.name
                    : "Assign"}
              </Button>
            }
          />
          <Menu.Popup align="start">
            {usersLoadError ? (
              <div
                role="alert"
                className="max-w-[240px] px-2.5 py-1.5 text-label leading-snug text-red"
              >
                {usersLoadError}
              </div>
            ) : users === null ? (
              <div className="px-2.5 py-1.5 text-label text-faint">
                Loading…
              </div>
            ) : (
              users.map((u) => (
                <Menu.Item
                  key={u.id}
                  onClick={() =>
                    run(() =>
                      setPlainThreadAssigneeApi(threadId, u.id, currentUser),
                    )
                  }
                >
                  <UserAvatar name={u.name} size={18} />
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <MenuTick on={thread.assignee?.id === u.id} />
                </Menu.Item>
              ))
            )}
            {thread.assignee && (
              <>
                <Menu.Separator />
                <Menu.Item
                  onClick={() =>
                    run(() =>
                      setPlainThreadAssigneeApi(threadId, null, currentUser),
                    )
                  }
                >
                  Unassign
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Root>
        {(labelTypesLoadError || (labelTypes?.length || 0) > 0) && (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  size="sm"
                  variant="default"
                  icon={<IconTag size={20} />}
                  caret
                  disabled={busy}
                  title={
                    labelTypesLoadError ?? "Labels on this thread in Plain"
                  }
                >
                  {labelTypesLoadError
                    ? "Labels unavailable"
                    : (thread.labels?.length || 0) > 0
                      ? `${thread.labels![0].name}${
                          thread.labels!.length > 1
                            ? ` +${thread.labels!.length - 1}`
                            : ""
                        }`
                      : "Labels"}
                </Button>
              }
            />
            <Menu.Popup align="start">
              {labelTypesLoadError ? (
                <div
                  role="alert"
                  className="max-w-[240px] px-2.5 py-1.5 text-label leading-snug text-red"
                >
                  {labelTypesLoadError}
                </div>
              ) : (
                labelTypes!.map((lt) => {
                  const existing = (thread.labels || []).find(
                    (l) => l.labelTypeId === lt.id,
                  );
                  return (
                    <Menu.CheckboxItem
                      key={lt.id}
                      checked={!!existing}
                      closeOnClick={false}
                      onClick={() =>
                        run(() =>
                          changePlainThreadLabelsApi(
                            threadId,
                            existing
                              ? { removeLabelIds: [existing.id] }
                              : { addLabelTypeIds: [lt.id] },
                            currentUser,
                          ),
                        )
                      }
                    >
                      <span className="min-w-0 flex-1">{lt.name}</span>
                      <MenuTick on={!!existing} />
                    </Menu.CheckboxItem>
                  );
                })
              )}
            </Menu.Popup>
          </Menu.Root>
        )}
        {plainUrl && (
          <Button
            size="sm"
            variant="default"
            trailing={<IconArrowUpRight size={14} />}
            // In the bar the destination is the whole label: the row
            // there is already at the width the subject pays for, and
            // the arrow says "open" on its own.
            render={<a href={plainUrl} target="_blank" rel="noreferrer" />}
            title="Open this thread in Plain"
          >
            {inBar ? "Plain" : "Open in Plain"}
          </Button>
        )}
        {inBar ? (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  size="sm"
                  variant="default"
                  icon={<IconDotsHorizontal size={20} />}
                  disabled={busy}
                  aria-label="More ticket actions"
                  title="More actions"
                />
              }
            />
            <Menu.Popup align="end">
              <Menu.Item onClick={renameThread}>Rename</Menu.Item>
              <Menu.Item onClick={toggleSpam}>
                {isSpam ? "Not spam" : "Mark as spam"}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              icon={<IconPencil size={20} />}
              disabled={busy}
              onClick={renameThread}
              title="Rename this thread in Plain"
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="default"
              icon={<IconForbid size={20} />}
              className={cn(!isSpam && "hover:text-red")}
              disabled={busy}
              onClick={toggleSpam}
              title={spamTitle}
            >
              {isSpam ? "Not spam" : "Spam"}
            </Button>
          </>
        )}
      </div>
      {error && (
        <span
          className={cn(
            "text-red text-label truncate",
            inBar && "max-w-[160px] shrink-0",
          )}
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Human reply box for a Plain thread — a customer-facing reply (sent via
 * Plain as the bot machine user) or an internal note for the team.
 * Shared by the session viewer's Plain tab and the Support ticket preview.
 * ⌘/Ctrl+Enter sends; the draft persists per thread.
 */
export function PlainReplyBox({
  threadId,
  customerName,
  onSent,
  className,
}: {
  threadId: string;
  customerName: string | null;
  /** Called after a successful send, so the owner can refresh the timeline. */
  onSent?: () => void;
  className?: string;
}) {
  const draftKey = `plain-reply:${threadId}`;
  const [text, setText] = useSavedDraft(draftKey);
  const [kind, setKind] = useState<"reply" | "note">("reply");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  const currentUser = useCurrentUser();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSend() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || sending) return;
    const attachmentBytes = attachments.reduce(
      (total, file) => total + file.size,
      0,
    );
    const attachmentLimit =
      kind === "note"
        ? PLAIN_NOTE_ATTACHMENTS_MAX_BYTES
        : PLAIN_REPLY_ATTACHMENT_MAX_BYTES;
    if (attachmentBytes > attachmentLimit) {
      setError(
        kind === "note"
          ? "Internal note attachments are limited to 50 MB total"
          : "Reply attachments are limited to 6 MB total",
      );
      return;
    }
    setSending(true);
    setError(null);
    await (async () => {
      const attachmentIds: string[] = [];
      for (const file of attachments) {
        attachmentIds.push(
          await uploadPlainAttachmentApi(threadId, file, kind),
        );
      }
      await sendPlainReplyApi(threadId, t, kind, currentUser, attachmentIds);
      setText("");
      setAttachments([]);
      setSent(true);
      clearTimeout(sentTimer.current);
      sentTimer.current = setTimeout(() => setSent(false), 3000);
      onSent?.();
    })()
      .catch(async (error) => {
        setError(errorMessage(error, "Failed to send"));
      })
      .finally(async () => {
        setSending(false);
      });
  }

  // The same wash a team note takes in a session transcript (lib/tinted-surface).
  const noteStyle: React.CSSProperties | undefined =
    kind === "note"
      ? { backgroundColor: noteSurface("var(--composer-surface)") }
      : undefined;

  return (
    <SupportComposer
      value={text}
      onChange={setText}
      onSubmit={handleSend}
      label={kind === "note" ? "Internal note" : "Reply"}
      placeholder={
        kind === "note"
          ? "Internal note for the team (English)…"
          : `Reply to ${customerName || "the customer"}, sent via Plain…`
      }
      disabled={sending}
      error={error}
      className={className}
      style={noteStyle}
      header={
        <FileChips
          files={attachments.map((file) => ({
            name: file.name,
            type: file.type,
          }))}
          onRemove={(index) =>
            setAttachments((current) => current.filter((_, i) => i !== index))
          }
          disabled={sending}
        />
      }
    >
      <Tooltip label="Add attachments">
        <PlainButton
          className={cn(paletteIconBtn, "-ml-1.5")}
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          aria-label="Add attachments"
        >
          <IconPlus size={20} />
        </PlainButton>
      </Tooltip>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const picked = Array.from(event.target.files || []);
          const accepted = picked.filter(
            (file) => file.size <= PLAIN_ATTACHMENT_MAX_BYTES,
          );
          const rejected = picked.find(
            (file) => file.size > PLAIN_ATTACHMENT_MAX_BYTES,
          );
          if (accepted.length) {
            setAttachments((current) => {
              const available = PLAIN_ATTACHMENTS_MAX_COUNT - current.length;
              if (accepted.length > available) {
                setError(
                  `You can attach up to ${PLAIN_ATTACHMENTS_MAX_COUNT} files`,
                );
              }
              return [...current, ...accepted.slice(0, Math.max(0, available))];
            });
          }
          if (rejected) setError(`${rejected.name} is too large (25 MB max)`);
          event.target.value = "";
        }}
      />
      {/* A labelled toggle rather than a bare glyph: which of the two
          things this box sends — a customer-facing reply or an internal
          note — is the one thing you must never have to guess. Same
          "Note" marker the session composer puts beside its own "+". */}
      <Tooltip
        label={
          kind === "note"
            ? "Switch to a customer reply"
            : "Write a note only the team sees"
        }
      >
        <PlainButton
          aria-pressed={kind === "note"}
          className={cn(
            palettePill,
            "shrink-0",
            kind === "note" &&
              "bg-[color-mix(in_srgb,var(--yellow-tint)_22%,transparent)] text-yellow hover:bg-[color-mix(in_srgb,var(--yellow-tint)_32%,transparent)] hover:text-yellow",
          )}
          onClick={() =>
            setKind((current) => (current === "note" ? "reply" : "note"))
          }
          disabled={sending}
        >
          <IconPencil size={14} />
          Internal note
        </PlainButton>
      </Tooltip>
      <span className="min-w-0 truncate text-meta text-faint phone:hidden">
        {kind === "note"
          ? `Posted as ${currentUser} (via ${PRODUCT_NAME})`
          : `Via Plain, signed “${currentUser.split(/\s+/)[0]}”`}
      </span>
      {sent && (
        <span className="shrink-0 text-meta font-semibold text-green">
          Sent ✓
        </span>
      )}
      <SupportSendButton
        label={kind === "note" ? "Add internal note" : "Send reply"}
        onClick={handleSend}
        disabled={sending || (!text.trim() && attachments.length === 0)}
      />
    </SupportComposer>
  );
}

/** "3d 4h" / "2h 15m" / "8m" — coarse enough to read at a glance. */
function waitDuration(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * "Customer waiting 2d 4h" — the signal Plain gives a whole banner to and we
 * previously dropped. Uses Plain's own inbound/outbound tracking, so the
 * autoresponder never counts as an answer.
 */
export function PlainWaitingBanner({
  thread,
  className,
}: {
  thread: PlainThread;
  className?: string;
}) {
  if (!thread.waitingSince || thread.status === "DONE") return null;
  const waited = waitDuration(thread.waitingSince);
  if (!waited) return null;
  const who = thread.customer?.name || thread.customer?.email || "Customer";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg bg-yellow-soft px-3 py-1.5 text-supporting text-fg",
        className,
      )}
    >
      <IconClock size={16} className="shrink-0 text-yellow" />
      <span className="min-w-0 truncate">
        {thread.awaitingFirstResponse ? (
          <>
            <strong className="font-semibold">{who}</strong> is waiting for a
            first response
          </>
        ) : (
          <>
            <strong className="font-semibold">{who}</strong> is waiting for a
            reply
          </>
        )}
        <span className="text-dim"> · {waited}</span>
      </span>
    </div>
  );
}

export default PlainThreadPanel;
