/**
 * Pure model of a person's notification inbox. src/server/notifications.ts
 * stores it in the central catalog; everything that decides what a record
 * looks like after an event, a read or a "done" lives here so it can be
 * tested without the catalog.
 *
 * The inbox is thread-shaped, like GitHub's: one row per subject (a session,
 * a pull request, a workspace, a reminder). A new event on a subject moves
 * that row to the top and marks it unread instead of adding a second row.
 *
 * Every event carries an optional key naming the real-world occurrence (a
 * review request's timestamp, say). A key seen recently is a replay, not news: a
 * restart that re-raises the same event changes nothing, so nothing can
 * alert twice.
 */

/** Incidents you own, from the moment they open to the moment they close. */
export const INCIDENT_NOTIFICATION_KINDS = [
  "incident_heads_up",
  "incident_opened",
  "incident_needs_you",
  "incident_veto",
  "incident_rolled_back",
  "incident_resolved",
  "incident_update",
] as const;
export type IncidentNotificationKind =
  (typeof INCIDENT_NOTIFICATION_KINDS)[number];

/** Support replies waiting on the conversation's owner: a draft that needs
 *  a person, a veto window about to send, a send that failed. */
export const SUPPORT_NOTIFICATION_KINDS = [
  "support_needs_you",
  "support_veto",
  "support_failed",
] as const;
export type SupportNotificationKind =
  (typeof SUPPORT_NOTIFICATION_KINDS)[number];

/**
 * People notify people: review requests and results, mentions, workspace
 * invites, and your own Desk reminders. Agent activity (questions, failed or
 * finished runs) does not; the sidebar already shows it. Incidents you own
 * and support replies waiting on you are the kinds the system raises for a
 * person, because the decision can be yours.
 */
export const NOTIFICATION_KINDS = [
  "review_requested",
  "team_review_requested",
  "review_done",
  "mention",
  "collaborator",
  "reminder",
  "comment",
  ...INCIDENT_NOTIFICATION_KINDS,
  ...SUPPORT_NOTIFICATION_KINDS,
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What a person switches on or off in Settings. */
export const ALERT_GROUPS = {
  reviews: ["review_requested", "review_done"],
  teamReviews: ["team_review_requested"],
  mentions: ["mention", "comment"],
  collaborators: ["collaborator"],
  reminders: ["reminder"],
  incidents: INCIDENT_NOTIFICATION_KINDS,
  support: SUPPORT_NOTIFICATION_KINDS,
} as const satisfies Record<string, readonly NotificationKind[]>;
export type AlertGroup = keyof typeof ALERT_GROUPS;
export type AlertPrefs = Record<AlertGroup, boolean>;

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  reviews: true,
  teamReviews: true,
  mentions: true,
  collaborators: true,
  reminders: true,
  incidents: true,
  support: true,
};

export type NotificationSubjectType =
  | "session"
  | "pr"
  | "workspace"
  | "reminder"
  | "incident"
  | "support";

const SUBJECT_TYPES: ReadonlySet<string> = new Set<NotificationSubjectType>([
  "session",
  "pr",
  "workspace",
  "reminder",
  "incident",
  "support",
]);

export interface NotificationSubject {
  type: NotificationSubjectType;
  id: string;
  title: string;
  /** Repository or workspace label shown above the title. */
  context?: string;
}

/** One inbox row as clients see it. */
export interface NotificationThread {
  /** `<subject type>:<subject id>`. Stable for the life of the subject. */
  id: string;
  subject: NotificationSubject;
  kind: NotificationKind;
  /** Why this is here, short: "Needs input", "Ada asked for your review". */
  reason: string;
  /** Optional detail: the question, the error, the mention text. */
  body: string;
  actor?: string;
  /** In-app path to open. */
  url: string;
  /** ms epoch of the latest event. */
  updatedAt: number;
  unread: boolean;
  done: boolean;
}

/**
 * Stored form: the wire thread plus the recent event keys used to dedupe,
 * and the delivery state behind quiet hours and cooldowns.
 */
export interface StoredThread extends NotificationThread {
  events: Array<{ key: string; at: number }>;
  /** An alert held back (at night); one flush later alerts it. */
  heldAt?: number;
  /** Recent alerts, newest last: the cooldown and replace windows. */
  alerted?: Array<{ key: string; at: number }>;
}

export interface NotificationDocument {
  threads: StoredThread[];
  alerts?: Partial<AlertPrefs>;
}

/**
 * How an event reaches the person. `alert` marks the row unread and pushes;
 * `quiet` updates the row in place without a push; `replace` updates the
 * row and silently replaces a banner that is still on a screen.
 */
export type NotificationDelivery = "alert" | "quiet" | "replace";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

/** A button on the OS notification. `url` is an in-app path to open. */
export interface PushAction {
  action: string;
  title: string;
  url: string;
}

/** Delivery hints for the push. Never stored with the row. */
export interface NotificationPush {
  /** What the push body says instead of the row's: fixed wording, so a
   *  lock screen never shows what only a signed-in page should. */
  body?: string;
  actions?: PushAction[];
  requireInteraction?: boolean;
  ttlSeconds?: number;
  urgency?: PushUrgency;
}

export interface NotificationEvent {
  kind: NotificationKind;
  subject: NotificationSubject;
  reason: string;
  body?: string;
  actor?: string;
  url: string;
  /** Names the real occurrence. A repeat within the window is ignored. */
  eventKey?: string;
  at?: number;
  /** Default `alert`. */
  delivery?: NotificationDelivery;
  /** Record quietly and hold the alert for a later `flushHeld`. */
  hold?: boolean;
  /** Alert a held row once; a row that is not held is left alone. */
  flushHeld?: boolean;
  /** The person has seen the subject: drop any alert held for later. */
  clearHeld?: boolean;
  /** A repeat alert under the same key within `ms` becomes a replace. */
  cooldown?: { key: string; ms: number };
  /** Update the subject's row only if it is already in the inbox: news
   *  that settles a row (a support reply sent) never opens one. */
  existingOnly?: boolean;
  push?: NotificationPush;
}

export const MAX_THREADS = 200;
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** How long an event key keeps suppressing a replay. */
export const EVENT_DEDUPE_MS = 48 * 60 * 60 * 1000;
const MAX_EVENTS_PER_THREAD = 20;
/** A replace only makes sense while an alert can still be on a screen. */
export const REPLACE_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MAX_ALERT_HISTORY = 10;
const REASON_LEN = 120;
const BODY_LEN = 280;
const TITLE_LEN = 160;

export function threadId(subject: Pick<NotificationSubject, "type" | "id">) {
  return `${subject.type}:${subject.id}`;
}

export function kindAlertGroup(kind: NotificationKind): AlertGroup {
  for (const [group, kinds] of Object.entries(ALERT_GROUPS))
    if ((kinds as readonly NotificationKind[]).includes(kind))
      return group as AlertGroup;
  return "reviews";
}

export function alertPrefs(doc: NotificationDocument | null): AlertPrefs {
  return { ...DEFAULT_ALERT_PREFS, ...(doc?.alerts ?? {}) };
}

export function shouldAlert(
  doc: NotificationDocument | null,
  kind: NotificationKind,
): boolean {
  return alertPrefs(doc)[kindAlertGroup(kind)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanThread(value: unknown): StoredThread | null {
  if (!isRecord(value) || !isRecord(value.subject)) return null;
  const subject = value.subject;
  const type = subject.type;
  if (typeof type !== "string" || !SUBJECT_TYPES.has(type)) return null;
  if (typeof subject.id !== "string" || !subject.id) return null;
  const kind = value.kind;
  if (!NOTIFICATION_KINDS.some((known) => known === kind)) return null;
  if (typeof value.url !== "string" || typeof value.updatedAt !== "number")
    return null;
  const events = keyedTimes(value.events);
  const alerted = keyedTimes(value.alerted);
  return {
    id: threadId({ type: type as NotificationSubjectType, id: subject.id }),
    subject: {
      type: type as NotificationSubjectType,
      id: subject.id,
      title: text(subject.title, TITLE_LEN),
      ...(typeof subject.context === "string" && subject.context
        ? { context: text(subject.context, TITLE_LEN) }
        : {}),
    },
    kind: kind as NotificationKind,
    reason: text(value.reason, REASON_LEN),
    body: text(value.body, BODY_LEN),
    ...(typeof value.actor === "string" && value.actor
      ? { actor: text(value.actor, 64) }
      : {}),
    url: value.url,
    updatedAt: value.updatedAt,
    unread: value.unread === true,
    done: value.done === true,
    events,
    ...(typeof value.heldAt === "number" ? { heldAt: value.heldAt } : {}),
    ...(alerted.length ? { alerted } : {}),
  };
}

function keyedTimes(value: unknown): Array<{ key: string; at: number }> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is { key: string; at: number } =>
          isRecord(entry) &&
          typeof entry.key === "string" &&
          typeof entry.at === "number",
      )
    : [];
}

export function cleanDocument(value: unknown): NotificationDocument {
  if (!isRecord(value)) return { threads: [] };
  const threads = Array.isArray(value.threads)
    ? value.threads.flatMap((thread) => cleanThread(thread) ?? [])
    : [];
  const alerts: Partial<AlertPrefs> = {};
  if (isRecord(value.alerts))
    for (const group of Object.keys(DEFAULT_ALERT_PREFS) as AlertGroup[])
      if (typeof value.alerts[group] === "boolean")
        alerts[group] = value.alerts[group];
  return {
    threads,
    ...(Object.keys(alerts).length ? { alerts } : {}),
  };
}

function prune(threads: StoredThread[], now: number): StoredThread[] {
  return threads
    .filter((thread) => now - thread.updatedAt < RETENTION_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS);
}

/** The delivery an event gets on `existing`, after hold, flush, cooldown
 *  and the replace window. */
function resolveDelivery(
  event: NotificationEvent,
  existing: StoredThread | undefined,
  now: number,
): NotificationDelivery {
  let delivery: NotificationDelivery = event.delivery ?? "alert";
  if (event.hold) delivery = "quiet";
  if (event.flushHeld) delivery = "alert";
  const alerted = existing?.alerted ?? [];
  const cooldown = event.cooldown;
  if (
    delivery === "alert" &&
    !event.flushHeld &&
    cooldown &&
    alerted.some(
      (seen) => seen.key === cooldown.key && now - seen.at < cooldown.ms,
    )
  )
    delivery = "replace";
  if (
    delivery === "replace" &&
    !alerted.some((seen) => now - seen.at < REPLACE_WINDOW_MS)
  )
    delivery = "quiet";
  return delivery;
}

/**
 * Apply one event. Returns the next document, the thread it touched and how
 * it is delivered, or `thread: null` when nothing changed: a replay, or a
 * flush of a row that is not held.
 */
export function applyNotificationEvent(
  doc: NotificationDocument,
  event: NotificationEvent,
): {
  doc: NotificationDocument;
  thread: StoredThread | null;
  delivery: NotificationDelivery;
} {
  const now = event.at ?? Date.now();
  const id = threadId(event.subject);
  const existing = doc.threads.find((thread) => thread.id === id);
  const events = (existing?.events ?? []).filter(
    (seen) => now - seen.at < EVENT_DEDUPE_MS,
  );
  if (event.eventKey && events.some((seen) => seen.key === event.eventKey))
    return { doc, thread: null, delivery: "quiet" };
  if (event.flushHeld && existing?.heldAt === undefined)
    return { doc, thread: null, delivery: "quiet" };
  if (event.existingOnly && !existing)
    return { doc, thread: null, delivery: "quiet" };
  const delivery = resolveDelivery(event, existing, now);
  const alert = delivery === "alert";
  const heldAt = event.clearHeld
    ? undefined
    : event.hold
      ? (existing?.heldAt ?? now)
      : alert
        ? undefined
        : existing?.heldAt;
  const alerted = alert
    ? [
        ...(existing?.alerted ?? []),
        { key: event.cooldown?.key ?? event.kind, at: now },
      ].slice(-MAX_ALERT_HISTORY)
    : (existing?.alerted ?? []);
  const thread: StoredThread = {
    id,
    subject: {
      type: event.subject.type,
      id: event.subject.id,
      title:
        text(event.subject.title, TITLE_LEN) || existing?.subject.title || "",
      ...((event.subject.context ?? existing?.subject.context)
        ? {
            context: text(
              event.subject.context ?? existing?.subject.context,
              TITLE_LEN,
            ),
          }
        : {}),
    },
    kind: event.kind,
    reason: text(event.reason, REASON_LEN),
    body: text(event.body, BODY_LEN),
    ...(event.actor ? { actor: text(event.actor, 64) } : {}),
    url: event.url,
    updatedAt: now,
    // Quiet news on a row you already read or finished leaves it that way.
    // A hold is a delayed alert: the row is unread again, so reading it
    // (the incident page on screen) cancels the alert after the night.
    unread: alert || event.hold || !existing ? true : existing.unread,
    done: alert || event.hold || !existing ? false : existing.done,
    events: event.eventKey
      ? [...events, { key: event.eventKey, at: now }].slice(
          -MAX_EVENTS_PER_THREAD,
        )
      : events,
    ...(heldAt !== undefined ? { heldAt } : {}),
    ...(alerted.length ? { alerted } : {}),
  };
  return {
    doc: {
      ...doc,
      threads: prune(
        [thread, ...doc.threads.filter((other) => other.id !== id)],
        now,
      ),
    },
    thread,
    delivery,
  };
}

export interface NotificationMark {
  /** Thread ids. Omit with `all` to touch every thread. */
  ids?: string[];
  all?: boolean;
  unread?: boolean;
  done?: boolean;
}

/** Apply a read/unread/done change. Returns how many threads changed. */
export function markNotificationThreads(
  doc: NotificationDocument,
  mark: NotificationMark,
): { doc: NotificationDocument; changed: number } {
  const ids = new Set(mark.ids ?? []);
  let changed = 0;
  const threads = doc.threads.map((thread) => {
    if (!mark.all && !ids.has(thread.id)) return thread;
    const next: StoredThread = { ...thread };
    if (typeof mark.unread === "boolean") next.unread = mark.unread;
    if (typeof mark.done === "boolean") {
      next.done = mark.done;
      // Done implies read, like GitHub: it leaves the inbox entirely.
      if (mark.done) next.unread = false;
    }
    // Reading a held row means the person saw it: no alert after the night.
    if (next.heldAt !== undefined && (!next.unread || next.done))
      delete next.heldAt;
    if (
      next.unread !== thread.unread ||
      next.done !== thread.done ||
      next.heldAt !== thread.heldAt
    )
      changed++;
    return next;
  });
  return { doc: changed ? { ...doc, threads } : doc, changed };
}

/** The client shape: dedupe keys and delivery state stay on the server. */
export function wireThread(thread: StoredThread): NotificationThread {
  const {
    events: _events,
    heldAt: _heldAt,
    alerted: _alerted,
    ...wire
  } = thread;
  return wire;
}

/** Subjects whose push says only fixed wording (the event's `push`
 *  hints) and leads the body with the project. */
export function hasFixedPush(type: NotificationSubjectType): boolean {
  return type === "incident" || type === "support";
}

/**
 * What a banner says. Incidents lead the body with the project
 * ("acme · Deploying the fix now"); support rows too, under their fixed
 * title ("A support reply is ready"), never the rule that is the row's
 * reason; every other row keeps "<subject>: <body>".
 */
export function bannerText(
  thread: Pick<NotificationThread, "subject" | "reason" | "body">,
): { title: string; body: string } {
  const title =
    thread.subject.type === "support"
      ? thread.subject.title
      : thread.reason || thread.subject.title;
  const body = hasFixedPush(thread.subject.type)
    ? [thread.subject.context, thread.body].filter(Boolean).join(" · ")
    : [thread.subject.title, thread.body].filter(Boolean).join(": ");
  return { title, body };
}

// Bidirectional overrides, embeddings, isolates and marks.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Text as it may appear in a push: one line, no control or bidi characters
 * (a lock screen must show what the text says, not what it hides).
 */
export function pushSafeText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(BIDI, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function unreadCount(doc: NotificationDocument): number {
  return doc.threads.filter((thread) => thread.unread && !thread.done).length;
}
