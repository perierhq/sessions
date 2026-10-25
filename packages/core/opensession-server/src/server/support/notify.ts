// Tells a support conversation's owner when its reply waits on them: a
// draft that needs a person, a veto window that will send unless someone
// stops it, a send that failed. The incident notifier's split
// (incidents/notifier.ts, notify-plan.ts): a store listener plans one inbox
// event per change and hands it to the inbox (notifications.ts), which
// records it and pushes.
//
// The wording is fixed (the incidents rule): the title and body are support
// copy (SUPPORT_PUSH) and the context is the project, so no customer name,
// address, subject or text reaches a lock screen, the inbox row or the push
// service. The row's reason is the draft's rule, which policy and reply
// write from fixed text and team members' names; a failed send says "Not
// sent", never the server's error, which can quote an address.
//
// A conversation owned by nobody who can be told goes to its inbox's
// owner, then the instance owner; with nobody, nothing is written. Buttons
// open the conversation with an intent (`?intent=stop`), where the page
// asks before it acts.
//
// Delivery follows the incident notifier: a repeat needs-you or failed
// alert inside the cooldown replaces the banner silently (a veto always
// alerts, it is about to act); the recipient's own change replaces it
// silently, since they made it; a draft that leaves the inbox (sent or
// discarded) settles its row with fixed wording and replaces any banner
// still on a screen, without ever opening a row of its own.
//
// Nothing runs at import: `startSupportNotifications` subscribes, once.
import type {
  SupportConversation,
  SupportDraft,
  SupportIntent,
} from "../../shared/support";
import { SUPPORT_PUSH } from "../../shared/support-copy";
import { clockLabel } from "../incidents/notify-copy";
import { instanceOwner, personOwner } from "../incidents/owner";
import type {
  NotificationEvent,
  NotificationPush,
  SupportNotificationKind,
} from "../notification-threads";
import { timezoneForUser } from "../shared/user-mappings";
import { INTERRUPTED_SEND } from "./reply";
import { onConversationChange } from "./store";

export type { SupportIntent };

export const SUPPORT_TTL_SECONDS = {
  vetoMin: 60,
  vetoMax: 3600,
  needsYou: 43_200,
  failed: 43_200,
  settled: 3600,
} as const;

/** A repeat needs-you or failed alert within this replaces the banner
 *  silently (the incidents' INCIDENT_ALERT_COOLDOWN_MS). */
export const SUPPORT_ALERT_COOLDOWN_MS = 900_000;

/** The failed row's reason: the error stays in the reply box. */
export const FAILED_REASON = "Not sent";

export function supportUrl(
  conversationId: string,
  intent?: SupportIntent,
): string {
  const url = `/support/email:${encodeURIComponent(conversationId)}`;
  return intent ? `${url}?intent=${intent}` : url;
}

export interface SupportNotifyFacts {
  /** Who is told: the owner, else the instance owner; "" for nobody. */
  recipient: string;
  timeZone: string;
}

export interface PlannedSupportNotification {
  user: string;
  event: NotificationEvent;
}

type Notified = Extract<
  SupportDraft["state"],
  "needs-person" | "veto" | "failed"
>;

function notified(draft: SupportDraft | null): draft is SupportDraft & {
  state: Notified;
} {
  return (
    draft?.state === "needs-person" ||
    draft?.state === "veto" ||
    draft?.state === "failed"
  );
}

/** Who made the change: whoever decided, else whoever wrote the draft. */
function changedBy(draft: SupportDraft): string | null {
  const actor = draft.decidedBy ?? draft.author;
  return actor.kind === "person" ? personOwner(actor.name) : null;
}

/** The recipient made this change and has seen its outcome. A failed send
 *  only counts when it failed on their own first attempt, which they read
 *  in the reply box; a retry that failed later, or a send a restart cut
 *  off, is news to them. */
function ownChange(draft: SupportDraft, recipient: string): boolean {
  const by = changedBy(draft);
  if (!by || by.toLowerCase() !== recipient.toLowerCase()) return false;
  if (draft.state !== "failed") return true;
  return draft.attempts === 1 && draft.lastError !== INTERRUPTED_SEND;
}

/** What one notified state says: kind, fixed title and body, the push. */
interface SupportRow {
  kind: SupportNotificationKind;
  title: string;
  reason: string;
  body: string;
  push: NotificationPush;
}

function row(
  draft: SupportDraft & { state: Notified },
  conversationId: string,
  facts: SupportNotifyFacts,
  now: number,
): SupportRow {
  switch (draft.state) {
    case "veto": {
      // A veto with no future deadline plans nothing (vetoOpen).
      const deadline = draft.vetoDeadline ?? "";
      const body = SUPPORT_PUSH.vetoBody(clockLabel(deadline, facts.timeZone));
      const seconds = Math.ceil((Date.parse(deadline) - now) / 1000);
      return {
        kind: "support_veto",
        title: SUPPORT_PUSH.vetoTitle,
        reason: draft.rule,
        body,
        push: {
          body,
          actions: [
            {
              action: "stop",
              title: SUPPORT_PUSH.stop,
              url: supportUrl(conversationId, "stop"),
            },
          ],
          requireInteraction: true,
          ttlSeconds: Math.min(
            SUPPORT_TTL_SECONDS.vetoMax,
            Math.max(SUPPORT_TTL_SECONDS.vetoMin, seconds),
          ),
          urgency: "high",
        },
      };
    }
    case "needs-person":
      return {
        kind: "support_needs_you",
        title: SUPPORT_PUSH.needsYouTitle,
        reason: draft.rule,
        body: SUPPORT_PUSH.needsYouBody,
        push: {
          body: SUPPORT_PUSH.needsYouBody,
          actions: [
            {
              action: "review",
              title: SUPPORT_PUSH.review,
              url: supportUrl(conversationId, "review"),
            },
          ],
          requireInteraction: true,
          ttlSeconds: SUPPORT_TTL_SECONDS.needsYou,
          urgency: "normal",
        },
      };
    case "failed":
      return {
        kind: "support_failed",
        title: SUPPORT_PUSH.failedTitle,
        reason: FAILED_REASON,
        body: SUPPORT_PUSH.failedBody,
        push: {
          body: SUPPORT_PUSH.failedBody,
          actions: [
            {
              action: "review",
              title: SUPPORT_PUSH.review,
              url: supportUrl(conversationId, "review"),
            },
          ],
          requireInteraction: true,
          ttlSeconds: SUPPORT_TTL_SECONDS.failed,
          urgency: "normal",
        },
      };
  }
}

/** A veto window still to come: one already over (or without a deadline)
 *  is the tick's to send or hold, too late to stop from a banner. */
function vetoOpen(draft: SupportDraft, now: number): boolean {
  if (draft.state !== "veto") return true;
  const deadline = Date.parse(draft.vetoDeadline ?? "");
  return Number.isFinite(deadline) && deadline > now;
}

/** The row of a draft that left the inbox: sent or discarded. Fixed
 *  wording, existing rows only, never an alert. */
function settled(
  next: SupportConversation,
  draft: SupportDraft & { state: "sent" | "discarded" },
  now: number,
): NotificationEvent {
  return {
    kind: "support_needs_you",
    subject: {
      type: "support",
      id: next.id,
      title:
        draft.state === "sent"
          ? SUPPORT_PUSH.sentTitle
          : SUPPORT_PUSH.discardedTitle,
      context: next.project,
    },
    reason: SUPPORT_PUSH.settledBody,
    body: SUPPORT_PUSH.settledBody,
    url: supportUrl(next.id),
    eventKey: eventKey(next, draft),
    at: now,
    delivery: "replace",
    existingOnly: true,
    push: {
      body: SUPPORT_PUSH.settledBody,
      ttlSeconds: SUPPORT_TTL_SECONDS.settled,
      urgency: "low",
    },
  };
}

/** One occurrence: the draft in a state at a revision, so a draft that
 *  comes back to a state (a resent draft fails again) is news. */
function eventKey(next: SupportConversation, draft: SupportDraft): string {
  return `${next.id}:${draft.id}:${draft.state}:${next.revision}`;
}

/**
 * Pure. One event per change into needs-person, veto (with its window
 * still open) or failed: a new draft, or the same draft in a new state.
 * The same draft going on to sent or discarded settles its row. Nothing
 * otherwise.
 *
 * Others' changes alert, needs-you and failed under a cooldown per kind;
 * the recipient's own change (they stopped the veto) replaces the banner
 * silently, except a failed send they did not watch fail.
 */
export function planSupportNotification(
  next: SupportConversation,
  previous: SupportConversation | null,
  facts: SupportNotifyFacts,
  now: number = Date.now(),
): PlannedSupportNotification | null {
  const draft = next.draft;
  if (!draft || !facts.recipient) return null;
  const before = previous?.draft;
  const same = before?.id === draft.id;
  if (same && before?.state === draft.state) return null;
  if (draft.state === "sent" || draft.state === "discarded")
    return same
      ? {
          user: facts.recipient,
          event: settled(next, { ...draft, state: draft.state }, now),
        }
      : null;
  if (!notified(draft) || !vetoOpen(draft, now)) return null;
  const r = row(draft, next.id, facts, now);
  const event: NotificationEvent = {
    kind: r.kind,
    subject: {
      type: "support",
      id: next.id,
      title: r.title,
      context: next.project,
    },
    reason: r.reason,
    body: r.body,
    url: supportUrl(next.id),
    eventKey: eventKey(next, draft),
    at: now,
    push: r.push,
  };
  if (ownChange(draft, facts.recipient)) event.delivery = "replace";
  else if (r.kind !== "support_veto")
    event.cooldown = { key: r.kind, ms: SUPPORT_ALERT_COOLDOWN_MS };
  return { user: facts.recipient, event };
}

/** Who is told about `c`: its owner when a person, else its inbox's owner,
 *  else the instance owner; "" when there is nobody. */
export function supportRecipient(
  c: Pick<SupportConversation, "owner">,
  inboxOwner: string | null = null,
): string {
  return personOwner(c.owner) ?? personOwner(inboxOwner) ?? instanceOwner();
}

export interface SupportNotifierDeps {
  /** Resolves to the row, or null for a replay; rejects when it could not
   *  be recorded. */
  notify(user: string, event: NotificationEvent): Promise<unknown>;
  timeZone(user: string): string;
  now(): number;
  /** The owner of the conversation's inbox, or null. */
  inboxOwner(inboxId: string): Promise<string | null>;
}

const defaultDeps: SupportNotifierDeps = {
  notify: async (user, event) => {
    const { deliverNotification } = await import("../notifications");
    return deliverNotification(user, event);
  },
  timeZone: (user) => timezoneForUser(user) || "UTC",
  now: Date.now,
  inboxOwner: async (inboxId) => {
    const { getInbox } = await import("./inboxes");
    return (await getInbox(inboxId))?.owner ?? null;
  },
};

/** The tail of each conversation's queue, so rows end on the newest state. */
const queues = new Map<string, Promise<void>>();

function enqueue(id: string, task: () => Promise<void>): Promise<void> {
  const run = (queues.get(id) ?? Promise.resolve()).then(task);
  queues.set(id, run);
  void run.then(() => {
    if (queues.get(id) === run) queues.delete(id);
  });
  return run;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plan and deliver the notification for one committed change. Failures
 *  are logged; they never reach the conversation store. */
export function handleSupportChange(
  next: SupportConversation | null,
  previous: SupportConversation | null,
  overrides: Partial<SupportNotifierDeps> = {},
): Promise<void> {
  const draft = next?.draft;
  if (!next || !draft) return Promise.resolve();
  const before = previous?.draft;
  if (before?.id === draft.id && before.state === draft.state)
    return Promise.resolve();
  const deps: SupportNotifierDeps = { ...defaultDeps, ...overrides };
  return enqueue(next.id, async () => {
    try {
      const recipient = supportRecipient(
        next,
        personOwner(next.owner) ? null : await deps.inboxOwner(next.inboxId),
      );
      if (!recipient) return;
      const planned = planSupportNotification(
        next,
        previous,
        { recipient, timeZone: deps.timeZone(recipient) },
        deps.now(),
      );
      if (planned) await deps.notify(planned.user, planned.event);
    } catch (error) {
      console.warn("[support] notify failed:", message(error));
    }
  });
}

declare global {
  var __supportNotifier: (() => void) | undefined;
}

/** Subscribes to conversation changes, once. */
export function startSupportNotifications(
  overrides: Partial<SupportNotifierDeps> = {},
): void {
  if (globalThis.__supportNotifier) return;
  const deps: SupportNotifierDeps = { ...defaultDeps, ...overrides };
  globalThis.__supportNotifier = onConversationChange((next, previous) => {
    void handleSupportChange(next, previous, deps);
  });
}

/** Resolves once every queued change has been delivered (tests). */
export async function supportNotificationsSettled(): Promise<void> {
  while (queues.size) await Promise.all([...queues.values()]);
}

export function __resetSupportNotificationsForTest(): void {
  globalThis.__supportNotifier?.();
  globalThis.__supportNotifier = undefined;
  queues.clear();
}
