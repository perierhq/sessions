// The email conversation pane's pure helpers: which state the reply box is
// in, its copy (the draft header, the veto countdown, the placeholder), what
// a push intent does on arrival, and the conversation as the timeline rows
// PlainEntryRow already draws. EmailConversation and SupportReplyBox render
// them.
import { formatVetoRemaining } from "../../shared/incident-response";
import type {
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
      const deadline = draft.vetoDeadline ? Date.parse(draft.vetoDeadline) : NaN;
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
  if (left < COUNTDOWN_UNDER_MS)
    return `Sends in ${formatVetoRemaining(left)}`;
  clock ??= new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `Sends at ${clock.format(new Date(deadline))}`;
}

function draftAuthor(author: SupportActor): string {
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
  return why ? `${draftAuthor(mode.draft.author)} · ${why}` : draftAuthor(mode.draft.author);
}

/** Local draft storage (lib/drafts.ts): a person's own reply under the
 *  conversation, their edits to a draft under the draft. */
export function replyDraftKey(conversationId: string, draftId?: string): string {
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
  return { kind: "stale", message: `Nothing to review: ${NOW_STATE[mode.kind]}` };
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

/** Messages as email rows and events as system notes, oldest first. */
export function timelineEntries(c: SupportConversation): PlainTimelineEntry[] {
  const base = `${API_BASE}/support/conversations/${encodeURIComponent(c.id)}/attachments/`;
  const rows: Array<{ at: number; order: number; entry: PlainTimelineEntry }> =
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
    rows.push({
      at: Date.parse(e.at),
      order: c.messages.length + i,
      entry: {
        id: `event:${i}`,
        timestamp: e.at,
        actorName: actorName(e.actor, c),
        actorType: "system",
        kind: "note",
        text: e.detail,
      },
    });
  });
  return rows
    .sort((a, b) => (a.at || 0) - (b.at || 0) || a.order - b.order)
    .map((r) => r.entry);
}

