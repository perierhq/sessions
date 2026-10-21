// Tells an incident's owner as the incident changes. Listens to committed
// incident changes, plans one inbox event per change (notify-plan.ts) and
// hands it to the inbox (notifications.ts), which records it and pushes.
//
// Changes for one incident are handled in commit order, so the banner and
// the row end on the newest state. Alerts held at night are flushed by a
// once-a-minute sweep after the night: one alert per incident with its
// current state, none for a row the owner already read. A failed flush
// stays held and is tried again on the next sweep. Any failure is logged;
// it never reaches the incident store.
//
// Nothing runs at import: `startIncidentNotifications` subscribes and starts
// the sweep, once.
import type { Incident } from "../../shared/incidents";
import type { NotificationEvent } from "../notification-threads";
import { isShuttingDown } from "../shutdown-state";
import { getIncident, listIncidents, onIncidentChange } from "./incident-store";
import { loadNotifyFacts } from "./notify-facts";
import {
  type NotifyFacts,
  planHeldFlush,
  planIncidentNotification,
} from "./notify-plan";

export const HELD_SWEEP_MS = 60_000;
export const HELD_LOOKBACK_MS = 86_400_000;

export interface NotifierDeps {
  facts(incident: Incident, now: number): Promise<NotifyFacts>;
  /** Resolves to the row when it was recorded, null when there was nothing
   *  to send (a replay, or a flush of a row that is not held); rejects when
   *  it could not be recorded. */
  notify(user: string, event: NotificationEvent): Promise<unknown>;
  now(): number;
}

const defaultDeps: NotifierDeps = {
  facts: (incident, now) => loadNotifyFacts(incident, now),
  notify: async (user, event) => {
    const { deliverNotification } = await import("../notifications");
    return deliverNotification(user, event);
  },
  now: Date.now,
};

/** The tail of each incident's queue. */
const queues = new Map<string, Promise<void>>();
/** Incidents whose inbox row may hold an alert for after the night. */
const held = new Set<string>();

interface NotifierHandle {
  unsubscribe: () => void;
  interval: ReturnType<typeof setInterval>;
}

declare global {
  var __incidentNotifier: NotifierHandle | undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run `task` after everything already queued for `id`. */
function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/** Plan and deliver the notification for one committed change. */
export function handleIncidentChange(
  next: Incident,
  previous: Incident | null,
  deps: NotifierDeps = defaultDeps,
): Promise<void> {
  return enqueue(next.id, async () => {
    try {
      const now = deps.now();
      const facts = await deps.facts(next, now);
      const planned = planIncidentNotification(next, previous, facts, now);
      if (!planned) return;
      if (planned.event.hold) held.add(next.id);
      await deps.notify(planned.user, planned.event);
    } catch (error) {
      console.warn("[incidents] notify failed:", message(error));
    }
  });
}

let sweeping: Promise<number> | null = null;

/**
 * Flush held alerts whose night is over. Returns how many incidents got
 * their one alert. Serial, and one sweep at a time.
 */
export function sweepHeldIncidents(
  deps: NotifierDeps = defaultDeps,
): Promise<number> {
  sweeping ??= (async () => {
    let flushed = 0;
    for (const id of [...held]) {
      const sent = await enqueue(id, async () => {
        try {
          const incident = await getIncident(id);
          if (!incident) {
            held.delete(id);
            return false;
          }
          const now = deps.now();
          const facts = await deps.facts(incident, now);
          if (facts.night) return false;
          const planned = planHeldFlush(incident, facts, now);
          if (!planned) {
            held.delete(id);
            return false;
          }
          // The inbox sends nothing for a row that is not held (read in
          // the night, or already flushed): that is a null, and done too.
          // A failure throws and keeps the incident for the next sweep.
          const sent = await deps.notify(planned.user, planned.event);
          held.delete(id);
          return sent != null;
        } catch (error) {
          console.warn("[incidents] held notification failed:", message(error));
          return false;
        }
      });
      if (sent) flushed++;
    }
    return flushed;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

/** A restart loses the held set while the inbox keeps `heldAt`: every
 *  incident that could hold one is a candidate, and a flush of a row that
 *  is not held is a no-op. */
async function seedHeld(deps: NotifierDeps): Promise<void> {
  try {
    const candidates = await listIncidents({
      closedSince: deps.now() - HELD_LOOKBACK_MS,
    });
    for (const incident of candidates) held.add(incident.id);
  } catch (error) {
    console.warn(
      "[incidents] could not seed held notifications:",
      message(error),
    );
  }
}

export function startIncidentNotifications(
  overrides: Partial<NotifierDeps> = {},
): void {
  if (globalThis.__incidentNotifier) return;
  const deps: NotifierDeps = { ...defaultDeps, ...overrides };
  const unsubscribe = onIncidentChange((next, previous) => {
    void handleIncidentChange(next, previous, deps);
  });
  void seedHeld(deps);
  const interval = setInterval(() => {
    if (isShuttingDown() || held.size === 0) return;
    void sweepHeldIncidents(deps);
  }, HELD_SWEEP_MS);
  interval.unref?.();
  globalThis.__incidentNotifier = { unsubscribe, interval };
}

/** Resolves once every queued change has been delivered (tests). */
export async function incidentNotificationsSettled(): Promise<void> {
  while (queues.size) await Promise.all([...queues.values()]);
}

export function __resetIncidentNotifierForTest(): void {
  const handle = globalThis.__incidentNotifier;
  if (handle) {
    handle.unsubscribe();
    clearInterval(handle.interval);
  }
  globalThis.__incidentNotifier = undefined;
  queues.clear();
  held.clear();
  sweeping = null;
}
