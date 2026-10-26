// The email conversation pane's pure helpers: which state the reply box is
// in, its copy (the draft header, the veto countdown, the placeholder), what
// a push intent does on arrival, and the conversation as the timeline rows
// PlainEntryRow already draws. EmailConversation and SupportReplyBox render
// them.
import { formatVetoRemaining } from "../../shared/incident-response";
import type {
  DraftSource,
  SupportActor,
  SupportConversation,
  SupportDraft,
  SupportIntent,
} from "../../shared/support";
import { API_BASE } from "./api/request";
import type { PlainTimelineEntry } from "./types";

export type ReplyBoxMode =
  /** No live draft. */
  | { kind: "compose" }
  /** Needs a person: prefilled, editable, Send / Discard. */
  | { kind: "review"; draft: SupportDraft }
  /** Countdown, Stop / Send now. */
  | { kind: "veto"; draft: SupportDraft; deadline: number }
  | { kind: "sending"; draft: SupportDraft }
  /** lastError, Try again / Discard. */
  | { kind: "failed"; draft: SupportDraft };

export function replyBoxMode(c: SupportConversation): ReplyBoxMode {
  const draft = c.draft;
  if (!draft) return { kind: "compose" };
  switch (draft.state) {
    case "needs-person":
      return { kind: "review", draft };
    case "veto": {
      const deadline = draft.vetoDeadline
        ? Date.parse(draft.vetoDeadline)
        : NaN;
      // A window with no end can't count down; it is a draft to look at.
      return Number.isFinite(deadline)
        ? { kind: "veto", draft, deadline }
        : { kind: "review", draft };
    }
    case "sending":
      return { kind: "sending", draft };
    case "failed":
      return { kind: "failed", draft };
    default:
      return { kind: "compose" };
  }
}

/** Under ten minutes the countdown is what you act on. */
const COUNTDOWN_UNDER_MS = 600_000;

let clock: Intl.DateTimeFormat | undefined;

/** "Sends in 4:59" under ten minutes, else "Sends at 14:05": the 24-hour
 *  clock the push says it with (incidents/notify-copy.ts). */
export function vetoLabel(deadline: number, now: number): string {
  const left = deadline - now;
  if (left <= 0) return "Sending soon";
  if (left < COUNTDOWN_UNDER_MS) return `Sends in ${formatVetoRemaining(left)}`;
  clock ??= new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `Sends at ${clock.format(new Date(deadline))}`;
}

function draftAuthor(draft: SupportDraft): string {
  if (draft.purpose === "fixed-note") return "Fixed note";
  const author = draft.author;
  switch (author.kind) {
    case "agent":
      return "Draft by the agent";
    case "person":
      return `Draft by ${author.name}`;
    case "sessions":
      return "Draft by Sessions";
    default:
      return "Draft";
  }
}

/** "Draft by the agent · <rule>", or the countdown in a veto window. */
export function draftHeader(
  mode: Exclude<ReplyBoxMode, { kind: "compose" }>,
  now: number,
): string {
  const why =
    mode.kind === "veto" ? vetoLabel(mode.deadline, now) : mode.draft.rule;
  return why ? `${draftAuthor(mode.draft)} · ${why}` : draftAuthor(mode.draft);
}

/** The primary button under a draft waiting for a person. */
export function draftSendLabel(
  mode: Extract<ReplyBoxMode, { kind: "review" | "failed" }>,
): string {
  if (mode.kind === "failed") return "Try again";
  return mode.draft.purpose === "fixed-note" ? "Send fixed note" : "Send";
}

export interface SourceRow {
  kind: DraftSource["kind"];
  /** What the row reads: the URL without its scheme, the path, the id. */
  label: string;
  /** Opens in a new tab; only for an http(s) URL. */
  href: string | null;
}

/** The sources a draft cites, as rows to show under it: a public link
 *  opens, a repository path and a connector record read as they are. */
export function draftSources(draft: SupportDraft): SourceRow[] {
  return (draft.sources ?? []).flatMap((source): SourceRow[] => {
    const ref = source.ref.trim();
    if (!ref) return [];
    if (source.kind !== "url")
      return [{ kind: source.kind, label: ref, href: null }];
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return [{ kind: source.kind, label: ref, href: null }];
    }
    const web = url.protocol === "https:" || url.protocol === "http:";
    const label = web
      ? `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`
      : ref;
    return [{ kind: source.kind, label, href: web ? url.href : null }];
  });
}

/** Local draft storage (lib/drafts.ts): a person's own reply under the
 *  conversation, their edits to a draft under the draft. */
export function replyDraftKey(
  conversationId: string,
  draftId?: string,
): string {
  return draftId
    ? `support-reply:${conversationId}:${draftId}`
    : `support-reply:${conversationId}`;
}

/** The compose box's placeholder, in the Plain box's grammar. */
export function composePlaceholder(
  c: Pick<SupportConversation, "customer">,
  inboxAddress: string | null,
): string {
  const who = c.customer.name || c.customer.address || "the customer";
  return inboxAddress
    ? `Reply to ${who}, sent from ${inboxAddress}…`
    : `Reply to ${who}…`;
}

export type SupportIntentPlan =
  /** Focus Stop and ask before stopping. */
  | { kind: "confirm-stop" }
  /** Focus a control; the person presses it. */
  | { kind: "focus"; target: "send" | "stop" }
  | { kind: "stale"; message: string };

const NOW_STATE: Record<ReplyBoxMode["kind"], string> = {
  compose: "the reply was already handled",
  review: "the reply is waiting for you",
  veto: "the reply is waiting out its window",
  sending: "the reply is sending",
  failed: "the reply couldn't send",
};

/** What a push intent does when the page opens: never the action itself.
 *  Stop asks first; Review puts focus on Send under the draft to read. */
export function supportIntentPlan(
  intent: SupportIntent,
  mode: ReplyBoxMode,
): SupportIntentPlan {
  if (intent === "stop")
    return mode.kind === "veto"
      ? { kind: "confirm-stop" }
      : { kind: "stale", message: `Nothing to stop: ${NOW_STATE[mode.kind]}` };
  if (mode.kind === "review" || mode.kind === "failed")
    return { kind: "focus", target: "send" };
  if (mode.kind === "veto") return { kind: "focus", target: "stop" };
  return {
    kind: "stale",
    message: `Nothing to review: ${NOW_STATE[mode.kind]}`,
  };
}

/** Polls faster while a send is about to go or going. */
export function pollMs(c: SupportConversation): number {
  return c.draft?.state === "veto" || c.draft?.state === "sending"
    ? 10_000
    : 20_000;
}

/** Why the support agent isn't running, when the newest word about it is
 *  that it couldn't start; null while it runs or was never asked to. */
export function agentCantStart(c: SupportConversation): string | null {
  if (c.sessionId) return null;
  const last = c.events.findLast((e) => e.kind.startsWith("agent-"));
  if (!last) return null;
  if (last.kind === "agent-rate-limited") return last.detail;
  if (last.kind !== "agent-cant-start") return null;
  const colon = last.detail.indexOf(": ");
  return colon < 0 ? last.detail : last.detail.slice(colon + 2);
}

function actorName(actor: SupportActor, c: SupportConversation): string {
  switch (actor.kind) {
    case "person":
      return actor.name;
    case "agent":
      return "Support agent";
    case "sessions":
      return "Sessions";
    default:
      return c.customer.name || c.customer.address;
  }
}

const REMOVED = "(Removed after the retention period)";

/** A timeline row: a message or note PlainEntryRow draws, or a quiet line
 *  for something Sessions did on its own that needs no reading (it closed
 *  a conversation after thanks or a week of silence). */
export type EmailTimelineEntry = PlainTimelineEntry & { quiet?: true };

/** Events that read as one quiet line rather than a note. */
function quietEvent(e: SupportConversation["events"][number]): boolean {
  return e.kind === "closed" && e.actor.kind === "sessions";
}

/** Messages as email rows and events as system notes, oldest first. */
export function timelineEntries(c: SupportConversation): EmailTimelineEntry[] {
  const base = `${API_BASE}/support/conversations/${encodeURIComponent(c.id)}/attachments/`;
  const rows: Array<{ at: number; order: number; entry: EmailTimelineEntry }> =
    [];
  c.messages.forEach((m, order) => {
    const ours = m.direction === "out";
    const actorType: PlainTimelineEntry["actorType"] = !ours
      ? "customer"
      : m.sentBy?.kind === "agent" || m.sentBy?.kind === "sessions"
        ? "bot"
        : "support";
    const sender = m.from.name || m.from.address;
    const name =
      !m.sentBy || m.sentBy.kind === "customer"
        ? sender
        : actorName(m.sentBy, c);
    rows.push({
      at: Date.parse(m.at),
      order,
      entry: {
        id: m.id,
        timestamp: m.at,
        actorName: name,
        actorType,
        kind: "email",
        subject: m.subject,
        text: m.text ?? REMOVED,
        attachments: m.attachments.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          href: a.stored ? base + encodeURIComponent(a.id) : null,
        })),
      },
    });
  });
  c.events.forEach((e, i) => {
    const entry: EmailTimelineEntry = {
      id: `event:${i}`,
      timestamp: e.at,
      actorName: actorName(e.actor, c),
      actorType: "system",
      kind: "note",
      text: e.detail,
    };
    if (quietEvent(e)) entry.quiet = true;
    rows.push({ at: Date.parse(e.at), order: c.messages.length + i, entry });
  });
  return rows
    .sort((a, b) => (a.at || 0) - (b.at || 0) || a.order - b.order)
    .map((r) => r.entry);
}

/** The held-issue hold reasons that bugs.ts writes (shown as is). */
const HELD_PUBLIC = "Waiting for a person: the repository is public";

/** The card over the reply box for the issue the agent prepared: nothing
 *  is posted until a person creates it, and only the instance owner posts
 *  to a public repository. */
export interface PendingIssueCopy {
  text: string;
  canApprove: boolean;
  /** Why this person can't create it, or the server's other hold reason. */
  why?: string;
}

const PREPARED_ISSUE =
  "The agent prepared an issue. Nothing is posted until you create it.";

export function pendingIssueCopy(
  issue: NonNullable<SupportConversation["pendingIssue"]>,
  isInstanceOwner: boolean,
): PendingIssueCopy {
  const isPublic = !issue.heldFor || issue.heldFor === HELD_PUBLIC;
  if (!isPublic)
    return { text: PREPARED_ISSUE, canApprove: true, why: issue.heldFor };
  return isInstanceOwner
    ? { text: PREPARED_ISSUE, canApprove: true }
    : {
        text: PREPARED_ISSUE,
        canApprove: false,
        why: "The repository is public. Only the instance owner can post the issue",
      };
}

/** The "it's fixed" note the server prepared that isn't in the reply box
 *  (another draft was live then) and hasn't gone out: no reply was sent
 *  after it was prepared. null otherwise. */
export function waitingFixedNote(
  c: SupportConversation,
): NonNullable<SupportConversation["fixedNote"]> | null {
  const note = c.fixedNote;
  if (!note || note.draftId) return null;
  const at = Date.parse(note.at);
  const answered = c.messages.some(
    (m) => m.direction === "out" && Date.parse(m.at) >= at,
  );
  return answered ? null : note;
}

/** Why the fixed note exists, in a few words. */
export function fixedNoteReason(
  note: NonNullable<SupportConversation["fixedNote"]>,
): string {
  return note.because === "pr-merged"
    ? "The fix was merged"
    : "The linked issue was closed";
}

/** reply.ts INTERRUPTED_AFTER_MS: an attempt older than this with no
 *  answer was cut off (a restart), and a person may discard it. */
const INTERRUPTED_AFTER_MS = 2 * 60_000;

/** Whether a `sending` draft may be discarded: it waits for a retry, or its
 *  attempt started long enough ago that it was cut off. The server checks
 *  again (a send still running here answers 409). */
export function sendingDiscardable(draft: SupportDraft, now: number): boolean {
  if (draft.state !== "sending") return false;
  if (draft.nextAttemptAt) return true;
  const started = Date.parse(draft.attemptStartedAt ?? draft.createdAt);
  return Number.isFinite(started) && now - started > INTERRUPTED_AFTER_MS;
}
