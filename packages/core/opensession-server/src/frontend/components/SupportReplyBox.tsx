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
import { errorMessage } from "../lib/error-message";
import {
  composePlaceholder,
  draftHeader,
  draftSendLabel,
  draftSources,
  knowledgeChip,
  replyBoxMode,
  replyDraftKey,
  sendingDiscardable,
  supportIntentPlan,
} from "../lib/support-reply";
import {
  DRAFT_KNOWLEDGE,
  DRAFT_KNOWLEDGE_LINE,
  DRAFT_KNOWLEDGE_ROW,
  DRAFT_KNOWLEDGE_TITLE,
  DRAFT_SOURCES,
  DRAFT_SOURCE_LINK,
  DRAFT_SOURCE_REF,
} from "../lib/support-classes";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { useConfirm } from "../ui/confirm";
import { Spinner } from "../ui/spinner";
import { StatusChip } from "../ui/settings";
import { InlineAlert } from "../ui/state";
import { toast } from "../ui/toast";
import { useSavedDraft } from "../hooks/useSavedDraft";
import { SupportComposer, SupportSendButton } from "./SupportComposer";

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
  // The agent's text needs no copy; a person's edits to it do.
  const [text, edit, clearSaved] = useSavedDraft(key, draft?.text ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<"send" | "stop" | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const sendRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const secondsLeft = useSecondsLeft(
    mode.kind === "veto" ? mode.deadline : null,
  );

  useEffect(() => {
    if (focus === "stop") stopRef.current?.focus();
    if (focus === "send") sendRef.current?.focus();
  }, [focus]);

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
        if (settled) clearSaved();
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

  const stateLine =
    mode.kind === "compose"
      ? null
      : draftHeader(
          mode,
          mode.kind === "veto" && secondsLeft !== null
            ? mode.deadline - secondsLeft * 1000
            : 0,
        );
  const pinnedTo = draft?.to?.map((a) => a.address).join(", ");
  const rows = draft ? draftSources(draft, conversation.project) : [];
  // Checked knowledge reads as a list of items with their state; every
  // other source stays on the one wrapping line.
  const sources = rows.filter((row) => !row.knowledge);
  const knowledge = rows.filter((row) => row.knowledge);
  const locked = mode.kind === "veto" || mode.kind === "sending" || !!busy;

  return (
    <SupportComposer
      value={text}
      onChange={edit}
      onSubmit={locked ? undefined : send}
      label={draft ? "Reply draft" : "Reply"}
      placeholder={composePlaceholder(conversation, inboxAddress)}
      readOnly={mode.kind === "veto" || mode.kind === "sending"}
      disabled={!!busy}
      error={error}
      textareaClassName={cn(
        (mode.kind === "veto" || mode.kind === "sending") && "text-dim",
      )}
      toolbarClassName="gap-2"
      className={className}
      header={
        <>
          {stateLine && (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 pb-1.5">
              <span className="min-w-0 text-label font-medium text-fg">
                {stateLine}
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
                    className={cn(
                      DRAFT_SOURCE_LINK,
                      source.kind === "knowledge" && "font-mono",
                    )}
                    href={source.href}
                    // A knowledge item opens in the app, here.
                    target={source.kind === "knowledge" ? undefined : "_blank"}
                    rel={
                      source.kind === "knowledge"
                        ? undefined
                        : "noreferrer noopener"
                    }
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
          {knowledge.length > 0 && (
            <div className={DRAFT_KNOWLEDGE} aria-label="Knowledge">
              <span className="text-faint">Knowledge</span>
              {knowledge.map(({ label, href, knowledge: k }) => {
                if (!k) return null;
                const chip = knowledgeChip(k);
                const line = (
                  <>
                    <span className={DRAFT_KNOWLEDGE_LINE}>
                      <span
                        className={cn(
                          DRAFT_KNOWLEDGE_TITLE,
                          !href && "text-fg no-underline",
                        )}
                      >
                        {k.title}
                      </span>
                      <StatusChip
                        label={chip.label}
                        dot={chip.dot}
                        className="text-meta"
                      />
                      {k.uncited && (
                        <span className="shrink-0 text-faint">Not cited</span>
                      )}
                    </span>
                    {k.reason && <span className="text-dim">{k.reason}</span>}
                  </>
                );
                return href ? (
                  <a
                    key={label}
                    className={DRAFT_KNOWLEDGE_ROW}
                    href={href}
                    title={label}
                  >
                    {line}
                  </a>
                ) : (
                  <span key={label} className={DRAFT_KNOWLEDGE_ROW}>
                    {line}
                  </span>
                );
              })}
            </div>
          )}
          {mode.kind === "failed" && (
            <InlineAlert className="mb-2">
              {mode.draft.lastError || "The reply didn't send"}
            </InlineAlert>
          )}
        </>
      }
    >
      {mode.kind === "compose" ? (
        <SupportSendButton
          label="Send reply"
          onClick={send}
          disabled={!!busy || !text.trim()}
        />
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
      {confirmDialog}
    </SupportComposer>
  );
}
