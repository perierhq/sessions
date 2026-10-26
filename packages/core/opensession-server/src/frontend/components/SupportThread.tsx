import React from "react";
import type { UnifiedSession } from "../lib/types";
// The transcript's floating pills. This is the same job — chrome that hangs
// over live content the reader is scrolling — so it takes the same shape
// rather than a second one invented here, in its opaque form: a support
// message runs the full width of the column, so glass would show the words
// through the pill.
import { FLOATING_PILL_BUTTON } from "../lib/session-viewer-classes";
import { mineStatus } from "../lib/sidebar-lanes";
import { MINE_STATUS_META } from "../lib/sidebar-types";
import { SUPPORT_COLUMN_BAR, SUPPORT_TOP_RAIL } from "../lib/support-classes";
import { cn } from "../ui/cn";
import { PlainButton } from "../ui/plain-button";
import { Tooltip } from "../ui/tooltip";

/**
 * The frame every support conversation shares, Plain ticket or email: the
 * subject and customer (in the pane's top bar, or at the top of the thread),
 * the scrolling thread column with its floating rail of pills, and the
 * footer the reply box sits in. Each channel fills the slots: its status
 * badge or chip, its actions, its messages and its reply box.
 */

/** The pane's own top bar. Empty until the conversation lands; the bar
 *  keeps its height, so nothing below it moves when the words arrive. */
export function SupportThreadBar({ children }: { children?: React.ReactNode }) {
  return <div className={SUPPORT_COLUMN_BAR}>{children}</div>;
}

/**
 * Who and what the conversation is about. In the bar: `badge`, then the
 * subject over the customer, then `meta` and the actions. At the top of the
 * thread: the customer with `badge` beside them, the subject under it, and
 * `meta` on a row of its own (the actions there are the caller's, since
 * each channel puts something different before them).
 */
export function SupportThreadHeader({
  placement,
  subject,
  subjectFallback,
  customerName,
  customerEmail,
  badge,
  meta,
  actions,
}: {
  placement: "bar" | "inline";
  subject: string | null | undefined;
  /** At the top of the thread, what stands in for a missing subject; leave
   *  it out to show no subject line at all. The bar always says "No
   *  subject". */
  subjectFallback?: string;
  customerName: string;
  customerEmail: string;
  /** A state that reads first: Plain's status badge. */
  badge?: React.ReactNode;
  /** What follows the subject: an email's status word and inbox chip. */
  meta?: React.ReactNode;
  /** The actions, in the bar only, when they fit. */
  actions?: React.ReactNode;
}) {
  const customerLabel = customerName || customerEmail || "Unknown customer";
  if (placement === "bar")
    return (
      <>
        {/* The state leads the row instead of trailing the subject.
            Trailing, it landed at a different x on every ticket and read
            as part of the name; leading, it reads as the conversation's
            state and the subject gets a fixed left edge to truncate
            against. */}
        {badge}
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {/* The actions beside it can leave this 200px on a laptop, so
              the full subject stays on hover. */}
          <h2
            className="m-0 truncate text-item-title font-semibold text-fg"
            title={subject || undefined}
          >
            {subject || "No subject"}
          </h2>
          {/* The customer sits at the bottom step, under a 14px subject.
              Who it is from is read once on the way in and then lives in
              the queue row beside it, so it recedes here rather than
              competing with the subject. */}
          <div className="flex min-w-0 items-center gap-1.5 text-meta">
            <span className="truncate text-dim">{customerLabel}</span>
            {customerName && customerEmail && (
              <>
                <span className="text-faint">·</span>
                <span className="truncate text-faint">{customerEmail}</span>
              </>
            )}
          </div>
        </div>
        {meta}
        {actions}
      </>
    );
  const shownSubject = subject || subjectFallback;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="truncate text-item-title font-semibold text-fg"
          title={customerEmail}
        >
          {customerLabel}
        </span>
        {customerName && customerEmail && (
          <span className="truncate text-label text-faint">
            {customerEmail}
          </span>
        )}
        {badge}
      </div>
      {shownSubject && (
        <div className="mt-2 text-section-title font-semibold text-fg">
          {shownSubject}
        </div>
      )}
      {meta && (
        <div className="mt-2 flex min-w-0 items-center gap-2">{meta}</div>
      )}
    </>
  );
}

/**
 * The thread's scrolling column, and the rail of floating pills over its top
 * (a session, a triage offer, a fix session). The rail floats, so the column
 * owes it the space it sits in: 12px of offset plus a 32px pill, and 4px
 * clear of it. With the identity in the bar and no rail, the first block's
 * own top margin is the whole gap under the bar.
 */
export function SupportThreadBody({
  rail,
  inBar,
  children,
}: {
  rail?: React.ReactNode;
  inBar: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative min-h-0 flex-1">
      <div className="h-full overflow-y-auto">
        <div
          className={cn(
            "mx-auto w-full max-w-[760px] px-5 pb-5",
            rail ? "pt-12" : inBar ? "pt-1" : "pt-6",
          )}
        >
          {children}
        </div>
      </div>
      {rail && <div className={SUPPORT_TOP_RAIL}>{rail}</div>}
    </div>
  );
}

/** Under the thread, in the column's width: what stays in reach while the
 *  thread scrolls (the reply box, a warning above it). */
export function SupportThreadFooter({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] shrink-0 flex-col gap-3 px-5 pb-5">
      {children}
    </div>
  );
}

/** A pill in the rail that does something: open a session, start triage.
 *  Extra props and the ref reach the button, so a Tooltip can wrap it. */
export function SupportRailButton({
  className,
  ...props
}: React.ComponentProps<typeof PlainButton>) {
  return (
    <PlainButton
      {...props}
      className={cn(FLOATING_PILL_BUTTON, "pointer-events-auto", className)}
    />
  );
}

/**
 * The way through to the session working the conversation. Never the
 * session's own title: a support session is named after the conversation, so
 * it would repeat the subject in the bar above and read as a second heading.
 * It names its destination, except in the two states that are a reason to
 * go there now: a run still working, or one stopped on a question. The rest
 * of the lane vocabulary is about pull requests ("Ready to merge", "Done"),
 * which says nothing here; that state stays in the dot, where the sidebar
 * keeps it too.
 */
export function SupportSessionPill({
  sessionId,
  session,
  tooltip,
  onOpenSession,
}: {
  sessionId: string;
  /** The live session, for the dot and the label; null while unknown. */
  session?: UnifiedSession | null;
  tooltip: string;
  onOpenSession: (id: string) => void;
}) {
  const state = session
    ? MINE_STATUS_META.find((m) => m.key === mineStatus(session))
    : null;
  const label =
    state?.key === "needsinput" || state?.key === "inprogress"
      ? state.label
      : "Open session";
  return (
    <Tooltip label={tooltip}>
      <SupportRailButton
        aria-label={label}
        onClick={() => onOpenSession(sessionId)}
      >
        <span
          className="size-[7px] shrink-0 rounded-full"
          style={{ backgroundColor: state?.dotColor || "var(--text-faint)" }}
          aria-hidden
        />
        <span className="min-w-0 truncate">{label}</span>
      </SupportRailButton>
    </Tooltip>
  );
}
