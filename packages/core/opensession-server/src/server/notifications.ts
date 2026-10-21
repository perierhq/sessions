/**
 * The notification inbox: one durable record per person and subject, stored
 * in the central catalog (src/server/notification-threads.ts has the model).
 *
 * This is the only way the server notifies a person. `notifyUser` records the
 * event, tells that person's open clients over the WebSocket, and sends Web
 * Push to their devices when their alert settings allow it. Clients never
 * work out notifications by diffing session lists: a banner can only come
 * from a new record, so reconnecting or restarting an app cannot replay one.
 *
 * An event is delivered as an alert (unread, pushed), quietly (the row
 * updates in place, no push) or as a replace (the row updates and a banner
 * still on a screen is replaced without a sound); the model decides which.
 *
 * Delivery is best-effort. A failed push or broadcast never fails the flow
 * that raised the event.
 */
import { catalogDocuments } from "./catalog-documents";
import {
  alertPrefs,
  applyNotificationEvent,
  bannerText,
  cleanDocument,
  markNotificationThreads,
  pushSafeText,
  shouldAlert,
  unreadCount,
  wireThread,
  type AlertPrefs,
  type NotificationDelivery,
  type NotificationDocument,
  type NotificationEvent,
  type NotificationMark,
  type NotificationThread,
} from "./notification-threads";
import type { PushPayload, PushSendOptions } from "./push";
import { canonicalName } from "./shared/user-store-key";

export type {
  AlertPrefs,
  NotificationEvent,
  NotificationKind,
  NotificationThread,
} from "./notification-threads";

const documents = catalogDocuments("notifications");

/** The subject for an event about a session, labelled by its repository. */
export function sessionSubject(
  sessionId: string,
  session?: { id?: string; title?: string | null; repo?: string | null } | null,
): NotificationEvent["subject"] {
  return {
    type: "session",
    id: session?.id || sessionId,
    title: session?.title || "Untitled session",
    ...(session?.repo ? { context: session.repo } : {}),
  };
}

export function sessionUrl(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}`;
}

/** One inbox per person, whatever case their name arrives in. */
function inboxKey(user: string): string {
  return canonicalName(user.trim().toLowerCase());
}

function validUser(user: string | null | undefined): user is string {
  return typeof user === "string" && user.trim().length > 0;
}

async function readDocument(user: string): Promise<NotificationDocument> {
  return cleanDocument(await documents.get(inboxKey(user)));
}

export interface NotificationInbox {
  threads: NotificationThread[];
  unread: number;
  alerts: AlertPrefs;
}

export async function getNotificationInbox(
  user: string,
): Promise<NotificationInbox> {
  if (!validUser(user))
    return { threads: [], unread: 0, alerts: alertPrefs(null) };
  const doc = await readDocument(user);
  return {
    threads: doc.threads.map(wireThread),
    unread: unreadCount(doc),
    alerts: alertPrefs(doc),
  };
}

async function announceChanged(user: string): Promise<void> {
  try {
    const { broadcastToUser } = await import("./ws-hub");
    broadcastToUser(user, { type: "notifications_changed", user });
  } catch {}
}

// Mirrors push.ts `pushTopic`, which stays out of this module's static
// imports (web-push loads only when something is sent).
async function topicFor(threadId: string): Promise<string> {
  const { pushTopic } = await import("./push");
  return pushTopic(threadId);
}

/**
 * The push for a row: the one place a push is built from a thread. Rows
 * other than incidents keep their plain payload and default options. An
 * incident push says the event's fixed `push.body` when it has one, never
 * the row's own text, and every push is cleaned of control and bidi
 * characters.
 */
export async function pushFor(
  thread: NotificationThread,
  event: NotificationEvent,
  delivery: Exclude<NotificationDelivery, "quiet">,
): Promise<{ payload: PushPayload; options?: PushSendOptions }> {
  const hints = thread.subject.type === "incident" ? event.push : undefined;
  const { title, body } = bannerText(
    hints?.body !== undefined ? { ...thread, body: hints.body } : thread,
  );
  const payload: PushPayload = {
    title: pushSafeText(title),
    body: pushSafeText(body),
    url: thread.url,
    // One OS notification per thread: a newer event replaces the older
    // banner instead of stacking, on every device.
    tag: `os-notification-${thread.id}`,
    id: thread.id,
  };
  if (thread.subject.type !== "incident") return { payload };
  const alert = delivery === "alert";
  if (hints?.actions?.length)
    payload.actions = hints.actions.map((a) => ({
      ...a,
      title: pushSafeText(a.title),
    }));
  // A banner with buttons stays until it is handled, even when a repeat
  // inside the cooldown replaces it silently.
  if (
    hints?.requireInteraction &&
    (alert || (payload.actions?.length ?? 0) > 0)
  )
    payload.requireInteraction = true;
  payload.timestamp = event.at ?? Date.now();
  if (alert) payload.renotify = true;
  else {
    payload.silent = true;
    payload.renotify = false;
  }
  const options: PushSendOptions = {
    ...(hints?.ttlSeconds !== undefined
      ? { ttlSeconds: hints.ttlSeconds }
      : {}),
    ...(hints?.urgency ? { urgency: hints.urgency } : {}),
    // The push service keeps only the newest undelivered message per
    // topic: a silent replace must never drop an alert still in flight.
    ...(alert ? { topic: await topicFor(thread.id) } : {}),
  };
  return { payload, options };
}

/**
 * Record an event for `user` and deliver it. Returns the thread, or null when
 * the event was a replay (same `eventKey` recently) and nothing was sent.
 */
export async function notifyUser(
  user: string | null | undefined,
  event: NotificationEvent,
): Promise<NotificationThread | null> {
  if (!validUser(user)) return null;
  // Written by the mutator, which the catalog may rerun on a conflict: the
  // last run is the one that committed.
  const outcome: {
    thread: NotificationThread | null;
    delivery: NotificationDelivery;
    allowed: boolean;
  } = { thread: null, delivery: "quiet", allowed: false };
  try {
    await documents.update(inboxKey(user), (current) => {
      const doc = cleanDocument(current);
      const result = applyNotificationEvent(doc, event);
      outcome.thread = result.thread ? wireThread(result.thread) : null;
      outcome.delivery = result.delivery;
      outcome.allowed = shouldAlert(doc, event.kind);
      return result.doc;
    });
  } catch (error) {
    console.warn(
      "[notifications] could not record:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const { thread, delivery, allowed } = outcome;
  if (!thread) return null;
  const alert = delivery === "alert" && allowed;
  const replace = delivery === "replace" && allowed;
  try {
    const { broadcastToUser } = await import("./ws-hub");
    broadcastToUser(user, {
      type: "notification",
      user,
      notification: thread,
      alert,
      replace,
    });
  } catch {}
  if (alert || replace) {
    try {
      const { sendPushToUser } = await import("./push");
      const { payload, options } = await pushFor(
        thread,
        event,
        alert ? "alert" : "replace",
      );
      if (options) await sendPushToUser(user, payload, options);
      else await sendPushToUser(user, payload);
    } catch (error) {
      console.warn(
        "[notifications] push failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return thread;
}

/** Mark threads read, unread, done or not done, and tell the person's devices. */
export async function markNotifications(
  user: string,
  mark: NotificationMark,
): Promise<number> {
  if (!validUser(user)) return 0;
  let changed = 0;
  await documents.update(inboxKey(user), (current) => {
    const result = markNotificationThreads(cleanDocument(current), mark);
    changed = result.changed;
    return result.doc;
  });
  if (changed) await announceChanged(user);
  return changed;
}

export async function setAlertPrefs(
  user: string,
  patch: Partial<AlertPrefs>,
): Promise<AlertPrefs> {
  if (!validUser(user)) return alertPrefs(null);
  let next: AlertPrefs = alertPrefs(null);
  await documents.update(inboxKey(user), (current) => {
    const doc = cleanDocument(current);
    const alerts = { ...alertPrefs(doc) };
    for (const group of Object.keys(alerts) as Array<keyof AlertPrefs>)
      if (typeof patch[group] === "boolean") alerts[group] = patch[group];
    next = alerts;
    return { ...doc, alerts };
  });
  await announceChanged(user);
  return next;
}
