import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  SupportConversation,
  SupportConversationView,
  SupportIntent,
} from "../../shared/support";
import { useSecondsLeft } from "../hooks/useSecondsLeft";
import {
  discardDraft,
  replyToConversation,
  sendDraft,
  stopVeto,
} from "../lib/api/support";
import { ApiError } from "../lib/api/request";
import { noAutofill } from "../lib/composer-autofill";
import {
  composerBox,
  composerBoxExpanded,
  composerSend,
  composerSendDefault,
  composerTextarea,
  composerTextareaPadding,
  composerToolbar,
} from "../lib/composer-classes";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";
import { errorMessage } from "../lib/error-message";
import {
  composePlaceholder,
  draftHeader,
  draftSendLabel,
  draftSources,
  replyBoxMode,
  replyDraftKey,
  sendingDiscardable,
  supportIntentPlan,
} from "../lib/support-reply";
import {
  DRAFT_SOURCES,
  DRAFT_SOURCE_LINK,
  DRAFT_SOURCE_REF,
} from "../lib/support-classes";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { useConfirm } from "../ui/confirm";
import { Spinner } from "../ui/spinner";
import { InlineAlert } from "../ui/state";
import { toast } from "../ui/toast";
import { IconArrowUp } from "./icons";

const HANDLED = "Someone else already handled this draft";

/** The draft's buttons: a 44px target under a thumb. */
const ACTION = "phone:min-h-11";

/**
 * The email conversation's reply box. With no live draft it is the Plain
 * reply box's shape for a person's own reply; with one it shows the draft in
 * its state: waiting for a person (edit, Send, Discard), in its veto window
 * (the countdown, Stop, Send now), sending, or failed (the error, Try again,
 * Discard). Edits to a draft stay in local draft storage under the draft
 * until it is sent or discarded. Every press goes to the one reply path on
 * the server; a 409 means someone else settled the draft first.
 *
 * A push intent (`?intent=stop|review`) focuses the matching control and,
 * for Stop, asks first. Nothing is sent or stopped on load.
 *
 * Key it on the draft id, so a new draft starts from its own text.
 */
export function SupportReplyBox({
  conversation,
  inboxAddress,
  intent,
  onIntentHandled,
  onChanged,
  onRefetch,
  className,
}: {
  conversation: SupportConversation;
  inboxAddress: string | null;
  intent?: SupportIntent;
  /** The intent was acted on (asked, focused or found stale): drop it from
   *  the route so the next tap on the same push counts again. */
  onIntentHandled?: () => void;
  /** The conversation as the server answered an action. */
  onChanged: (view: SupportConversationView) => void;
  /** Load the conversation again (after a 409). */
  onRefetch: () => void;
  className?: string;
}) {
  const mode = replyBoxMode(conversation);
  const draft = mode.kind === "compose" ? null : mode.draft;
  const key = replyDraftKey(conversation.id, draft?.id);
  const [text, setText] = useState(
    () => loadDraft(key).text || draft?.text || "",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<"send" | "stop" | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const secondsLeft = useSecondsLeft(
    mode.kind === "veto" ? mode.deadline : null,
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "";
    if (text) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (focus === "stop") stopRef.current?.focus();
    if (focus === "send") sendRef.current?.focus();
  }, [focus]);

  function edit(next: string) {
    setText(next);
    // The agent's text needs no copy; a person's edits to it do.
    if (draft && next === draft.text) clearDraft(key);
    else saveDraft(key, { text: next });
  }

  async function act(
    label: string,
    run: () => Promise<SupportConversationView>,
    settled: boolean,
  ) {
    if (busy) return;
    setBusy(label);
    setError(null);
    await run()
      .then((next) => {
        if (settled) clearDraft(key);
        onChanged(next);
      })
      .catch((failure: Error) => {
        if (failure instanceof ApiError && failure.status === 409) {
          setError(HANDLED);
          onRefetch();
          return;
        }
        setError(errorMessage(failure, "Something went wrong"));
      })
      .finally(() => setBusy(null));
  }

  const editFor = (d: NonNullable<typeof draft>) =>
    text.trim() && text !== d.text ? { text } : undefined;

  function send() {
    if (!draft) {
      const reply = text.trim();
      if (!reply) return;
      void act("send", () => replyToConversation(conversation.id, reply), true);
      return;
    }
    void act(
      "send",
      () => sendDraft(conversation.id, draft.id, editFor(draft)),
      true,
    );
  }

  function sendNow() {
    if (!draft) return;
    void act("send-now", () => sendDraft(conversation.id, draft.id), true);
  }

  function discard() {
    if (!draft) return;
    void act("discard", () => discardDraft(conversation.id, draft.id), true);
  }

  function stop() {
    if (!draft) return;
    void act("stop", () => stopVeto(conversation.id, draft.id), false);
  }

  const handledIntent = useRef<SupportIntent | null>(null);
  const handleIntent = useEffectEvent((wanted: SupportIntent) => {
    if (handledIntent.current === wanted) return;
    handledIntent.current = wanted;
    const plan = supportIntentPlan(wanted, mode);
    if (plan.kind === "stale") toast(plan.message);
    else if (plan.kind === "focus") setFocus(plan.target);
    else {
      setFocus("stop");
      confirm({
        title: "Stop this reply?",
        description: "It won't send. The draft waits for a person instead",
        confirmLabel: "Stop",
        onConfirm: stop,
      });
    }
    onIntentHandled?.();
  });
  useEffect(() => {
    if (intent) handleIntent(intent);
    else handledIntent.current = null;
  }, [intent]);

  const header =
    mode.kind === "compose"
      ? null
      : draftHeader(
          mode,
          mode.kind === "veto" && secondsLeft !== null
            ? mode.deadline - secondsLeft * 1000
            : 0,
        );
  const pinnedTo = draft?.to?.map((a) => a.address).join(", ");
  const sources = draft ? draftSources(draft) : [];
  const locked = mode.kind === "veto" || mode.kind === "sending" || !!busy;

  return (
    <div
      className={cn(
        "composer shrink-0",
        composerBox,
        composerBoxExpanded,
        className,
      )}
    >
      {header && (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 pb-1.5">
          <span className="min-w-0 text-label font-semibold text-fg">
            {header}
          </span>
          {pinnedTo && (
            <span className="min-w-0 truncate text-meta text-faint">
              {`To ${pinnedTo}`}
            </span>
          )}
        </div>
      )}
      {sources.length > 0 && (
        <div className={DRAFT_SOURCES} aria-label="Sources">
          <span className="text-faint">Sources</span>
          {sources.map((source) =>
            source.href ? (
              <a
                key={`${source.kind}:${source.label}`}
                className={DRAFT_SOURCE_LINK}
                href={source.href}
                target="_blank"
                rel="noreferrer noopener"
                title={source.href}
              >
                {source.label}
              </a>
            ) : (
              <span
                key={`${source.kind}:${source.label}`}
                className={DRAFT_SOURCE_REF}
                title={source.label}
              >
                {source.label}
              </span>
            ),
          )}
        </div>
      )}
      {mode.kind === "failed" && (
        <InlineAlert className="mb-2">
          {mode.draft.lastError || "The reply didn't send"}
        </InlineAlert>
      )}
      <textarea
        ref={textareaRef}
        rows={1}
        {...noAutofill}
        className={cn(
          "composer-textarea min-h-12 text-fg placeholder:text-faint",
          composerTextarea,
          composerTextareaPadding,
          (mode.kind === "veto" || mode.kind === "sending") && "text-dim",
        )}
        aria-label={draft ? "Reply draft" : "Reply"}
        placeholder={composePlaceholder(conversation, inboxAddress)}
        value={text}
        readOnly={mode.kind === "veto" || mode.kind === "sending"}
        disabled={!!busy}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !locked) {
            e.preventDefault();
            send();
          }
        }}
      />
      {error && (
        <div className="mt-1 text-label text-red" role="alert">
          {error}
        </div>
      )}
      <div className={cn(composerToolbar, "gap-2")}>
        {mode.kind === "compose" ? (
          <button
            type="button"
            className={cn("ml-auto", composerSend, composerSendDefault)}
            onClick={send}
            disabled={!!busy || !text.trim()}
            title="Send (⌘↵)"
            aria-label="Send reply"
          >
            <IconArrowUp size={24} />
          </button>
        ) : mode.kind === "sending" ? (
          <>
            <span className="flex items-center gap-2 text-label text-dim">
              <Spinner aria-hidden />
              <span>Sending…</span>
            </span>
            {/* A send cut off by a restart, or waiting for its retry, can
						    be dropped; one running now cannot. */}
            {sendingDiscardable(mode.draft, Date.now()) && (
              <Button
                size="sm"
                variant="default"
                className={cn(ACTION, "ml-auto")}
                disabled={!!busy}
                onClick={discard}
              >
                Discard
              </Button>
            )}
          </>
        ) : mode.kind === "veto" ? (
          <>
            <Button
              ref={stopRef}
              size="sm"
              variant="default"
              className={ACTION}
              autoFocus={focus === "stop"}
              disabled={!!busy}
              onClick={stop}
            >
              Stop
            </Button>
            <Button
              size="sm"
              variant="soft"
              className={ACTION}
              disabled={!!busy}
              onClick={sendNow}
            >
              Send now
            </Button>
          </>
        ) : (
          <>
            <Button
              ref={sendRef}
              size="sm"
              variant="primary"
              className={ACTION}
              autoFocus={focus === "send"}
              disabled={!!busy || !text.trim()}
              onClick={send}
            >
              {draftSendLabel(mode)}
            </Button>
            <Button
              size="sm"
              variant="default"
              className={ACTION}
              disabled={!!busy}
              onClick={discard}
            >
              Discard
            </Button>
          </>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}
