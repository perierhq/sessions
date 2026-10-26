import React, { useId, useState } from "react";
import type { PlainEntryAttachment, PlainTimelineEntry } from "../lib/types";
import { API_BASE } from "../lib/api";
import { BASE_PATH } from "../lib/base";
import { renderMarkdown } from "../lib/markdown";
import { noteSurface } from "../lib/tinted-surface";
import {
  plainEntryBody,
  plainEntryHead,
  plainEntryIn,
  plainEntryMeta,
  plainEntryName,
  plainEntryNote,
  plainEntryOut,
  plainEntryQuoteToggle,
  plainEntryQuoted,
  plainEntryRow,
} from "../lib/plain-classes";
import { QUIET_EVENT } from "../lib/support-classes";
import { cn } from "../ui/cn";
import { PlainButton } from "../ui/plain-button";
import { IconArrowUpRight, IconPaperclip } from "./icons";
import { MarkdownBody } from "./MarkdownBody";

/**
 * The support conversation's message list, shared by every channel: Plain's
 * timeline and an email conversation both arrive as `PlainTimelineEntry` rows
 * (customer messages on the left, ours on the right, team notes inline, each
 * with its attachments). A channel can add quiet one-line events between them
 * (`quiet: true`, an email conversation's "closed without a reply").
 */

/** A row: a message or note, or a quiet event line between them. */
export type SupportListEntry = PlainTimelineEntry & { quiet?: true };

export function SupportMessageList({
  entries,
  threadId,
  threadTitle,
  className,
}: {
  entries: SupportListEntry[];
  /** Enables the "open the triage session" link on agent notes (Plain). */
  threadId?: string;
  /** The conversation's own subject, so a message that only echoes it stays
   *  quiet. */
  threadTitle?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {entries.length === 0 ? (
        <div className="mt-5 text-center text-label text-faint">
          No messages in this thread yet.
        </div>
      ) : (
        entries.map((entry) =>
          entry.quiet ? (
            <p key={entry.id} className={QUIET_EVENT}>
              {entry.text}
            </p>
          ) : (
            <SupportMessage
              key={entry.id}
              entry={entry}
              threadId={threadId}
              threadTitle={threadTitle}
            />
          ),
        )
      )}
    </div>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human-readable file size for an attachment chip. */
function fileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A message's attachments. Images render inline — on a visual bug report the
 * screenshot usually *is* the report — and click through to the full-size file.
 * Everything else gets a download chip.
 */
export function SupportAttachments({
  attachments,
}: {
  attachments: PlainEntryAttachment[];
}) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {attachments.map((a) => {
        if (a.href === null)
          return (
            <span
              key={a.id}
              title="No longer kept"
              className="inline-flex items-center gap-1.5 rounded-lg bg-active px-2.5 py-1.5 text-label text-faint"
            >
              <IconPaperclip size={16} className="shrink-0 opacity-60" />
              <span className="truncate">{a.fileName}</span>
              {a.sizeBytes ? (
                <span className="shrink-0">{fileSize(a.sizeBytes)}</span>
              ) : null}
            </span>
          );
        const href =
          a.href ?? `${API_BASE}/plain/attachments/${encodeURIComponent(a.id)}`;
        const isImage = a.mimeType.startsWith("image/") && !failed[a.id];
        return (
          <a
            key={a.id}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={`${a.fileName}${a.sizeBytes ? ` · ${fileSize(a.sizeBytes)}` : ""}`}
            className={cn(
              "block overflow-hidden rounded-lg no-underline",
              isImage
                ? "md-image-link bg-surface"
                : "inline-flex items-center gap-1.5 bg-active px-2.5 py-1.5 text-label text-dim hover:bg-hover hover:text-fg",
            )}
          >
            {isImage ? (
              <img
                src={href}
                alt={a.fileName}
                loading="lazy"
                onError={() => setFailed((f) => ({ ...f, [a.id]: true }))}
                /* md-image is what opens the lightbox. Its own block
								   treatment is for a full-width transcript image, so the
								   thumbnail keeps its cap and drops the border and margin
								   the wrapper already provides. */
                className="md-image m-0 block max-h-[220px] max-w-full border-0 bg-surface object-contain"
              />
            ) : (
              <>
                <IconPaperclip size={16} className="shrink-0 opacity-60" />
                <span className="truncate">{a.fileName}</span>
                {a.sizeBytes ? (
                  <span className="shrink-0 text-faint">
                    {fileSize(a.sizeBytes)}
                  </span>
                ) : null}
              </>
            )}
          </a>
        );
      })}
    </div>
  );
}

/**
 * A message body, rendered as markdown. Customer mail and our own replies get
 * the same treatment a session message does: `**test**` is bold, a pasted
 * stack trace in a fence is highlighted, and an inline image opens the shared
 * lightbox (markdown.ts emits the `md-image` class the delegated handler in
 * MediaLightbox.tsx watches for).
 *
 * Deliberately rendered with no context: a bare `#123` in a customer's mail is
 * their order number rather than a PR in our repo, and raw HTML they paste
 * stays literal text, which is the renderer's default.
 */
function EntryText({ text }: { text: string }) {
  const html = renderMarkdown(text);
  return <MarkdownBody className={plainEntryBody} html={html} />;
}

/**
 * An email's quoted history and signature, folded behind one toggle under the
 * new text, the way a mail client does it: the thread already shows every
 * earlier message, so the copy each reply carries is noise until someone asks
 * for it. Opening it shows the folded parts in their original order below the
 * toggle, which stays where it was so focus and the pointer don't lose it.
 */
function QuotedParts({
  parts,
}: {
  parts: NonNullable<PlainTimelineEntry["hiddenParts"]>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <PlainButton
        className={plainEntryQuoteToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">···</span>
        {open ? "Hide quoted text" : "Show quoted text"}
      </PlainButton>
      <div id={id} hidden={!open} className="flex flex-col gap-2">
        {open &&
          parts.map((part, i) => (
            <MarkdownBody
              // Parts never reorder; their index is their identity.
              key={i}
              className={plainEntryQuoted}
              html={renderMarkdown(part.text)}
            />
          ))}
      </div>
    </>
  );
}

/**
 * Notes posted from here carry an author prefix (see the reply route) because
 * Plain's API can't attribute a write to a workspace user — everything lands
 * as our machine user. Unpick that so a teammate's note shows *their* name,
 * and so anything else from the machine user is honestly labelled as the
 * agent rather than passing for a human.
 */
const NOTE_VIA_PREFIX = /^\*\*(.+?) \(via [^)]+\):\*\*\s*/;

function noteAuthor(entry: PlainTimelineEntry) {
  const viaUs = entry.text.match(NOTE_VIA_PREFIX);
  if (viaUs)
    return {
      name: viaUs[1],
      isAgent: false,
      text: entry.text.slice(viaUs[0].length),
    };
  if (entry.actorType === "bot") {
    // Agents open their notes with their own name; the badge says it now.
    const selfSigned = new RegExp(
      `^${entry.actorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`,
    );
    return {
      name: entry.actorName,
      isAgent: true,
      text: entry.text.replace(selfSigned, ""),
    };
  }
  return { name: entry.actorName, isAgent: false, text: entry.text };
}

/**
 * A message repeats the thread's own subject on almost every line ("Re: …"),
 * which is the loudest thing in the timeline and the one fact the reader
 * already has. Show it only where it says something new.
 */
function subjectWorthShowing(
  subject: string | null | undefined,
  threadTitle?: string | null,
): string | null {
  const s = subject?.trim();
  if (!s) return null;
  if (!threadTitle) return s;
  const bare = (t: string) =>
    t
      .replace(/^((re|fwd|fw)\s*:\s*)+/i, "")
      .trim()
      .toLowerCase();
  return bare(s) === bare(threadTitle) ? null : s;
}

export function SupportMessage({
  entry,
  threadId,
  threadTitle,
}: {
  entry: PlainTimelineEntry;
  /** Enables the "open the triage session" link on agent notes. */
  threadId?: string;
  /** The thread's own subject, so a message that only echoes it stays quiet. */
  threadTitle?: string | null;
}) {
  if (entry.kind === "note") {
    const author = noteAuthor(entry);
    return (
      <div
        className={plainEntryNote}
        style={{ background: noteSurface("transparent") }}
      >
        <div className={plainEntryHead}>
          <span className={plainEntryName}>{author.name}</span>
          <span
            className="text-meta font-semibold text-yellow"
            title="Only the team sees this note"
          >
            Note
          </span>
          {author.isAgent && (
            <span
              className={plainEntryMeta}
              title="Written by an agent run, not a teammate"
            >
              agent
            </span>
          )}
          <span className={plainEntryMeta}>{timeOf(entry.timestamp)}</span>
          {author.isAgent && threadId && (
            <a
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-meta font-semibold text-link no-underline hover:underline"
              href={`${BASE_PATH}/plain-triage/${encodeURIComponent(threadId)}`}
              target="_blank"
              rel="noreferrer"
              title="Open the triage session for this ticket"
            >
              Session
              <IconArrowUpRight size={13} />
            </a>
          )}
        </div>
        <EntryText text={author.text} />
        {entry.attachments?.length ? (
          <SupportAttachments attachments={entry.attachments} />
        ) : null}
      </div>
    );
  }

  const ours = entry.actorType !== "customer";
  const subject = subjectWorthShowing(entry.subject, threadTitle);
  return (
    <div className={plainEntryRow}>
      {/* The head sits above the message rather than inside it, so our own
			    bubble holds nothing but the words — the transcript's grammar for a
			    speaker label, and the only way the customer's side can lose its
			    plate without losing who wrote it. */}
      <div className={cn(plainEntryHead, ours && "flex-row-reverse")}>
        <span className={plainEntryName}>{entry.actorName}</span>
        <span className={plainEntryMeta}>
          {entry.kind} · {timeOf(entry.timestamp)}
        </span>
      </div>
      <div className={ours ? plainEntryOut : plainEntryIn}>
        {subject && (
          <div className="text-body font-semibold text-fg">{subject}</div>
        )}
        {entry.text && <EntryText text={entry.text} />}
        {entry.hiddenParts?.length ? (
          <QuotedParts parts={entry.hiddenParts} />
        ) : null}
        {entry.attachments?.length ? (
          <SupportAttachments attachments={entry.attachments} />
        ) : null}
      </div>
    </div>
  );
}
