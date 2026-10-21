// Incident change → at most one inbox event for the incident's owner: its
// kind, its copy, how loud it is and the buttons on the lock screen. Pure:
// the facts it needs (night, fully down, what the veto runs) come in.
//
// The quiet rules: a heads-up and a close without action only land in the
// inbox; progress replaces the banner silently; the owner's own change
// never alerts them; a flapping incident alerts once per kind per cooldown
// (the inbox model turns repeats into replaces); at night only "needs you
// while fully down" alerts, the rest is held for one alert after the night.
// Every button opens the incident page, which asks before it acts.
import type {
  IncidentResponse,
  OwnerDecision,
} from "../../shared/incident-response";
import type {
  Incident,
  IncidentEvent,
  IncidentState,
  SignalState,
} from "../../shared/incidents";
import type {
  IncidentNotificationKind,
  NotificationEvent,
  NotificationPush,
  PushAction,
} from "../notification-threads";
import {
  actorName,
  answeredBody,
  clockLabel,
  COPY,
  decisionLabel,
  deployingBody,
  firstLine,
  incidentHeadline,
  reopenedTitle,
  resolvedBody,
  stoppedBody,
  type VetoChange,
  vetoBody,
  vetoLabels,
} from "./notify-copy";

export interface NotifyFacts {
  signal: SignalState | null;
  night: boolean;
  fullyDown: boolean;
  timeZone: string;
  change: VetoChange | null;
}

export interface PlannedNotification {
  user: string;
  event: NotificationEvent;
}

export const INCIDENT_ALERT_COOLDOWN_MS = 900_000;
export const TTL_SECONDS = {
  veto: { min: 60, max: 3600 },
  needsYou: 43_200,
  resolved: 21_600,
  other: 3_600,
} as const;

const DEPLOY: VetoChange = { kind: "deploy" };

export function incidentUrl(id: string): string {
  return `/incidents/${encodeURIComponent(id)}`;
}

export function incidentIntentUrl(id: string, intent: OwnerDecision): string {
  return `${incidentUrl(id)}?intent=${encodeURIComponent(intent)}`;
}

/** The newest event that moved the incident into its state. */
export function latestStateEvent(
  incident: Incident,
): IncidentEvent | undefined {
  return incident.events.findLast(
    (e) => e.kind === "opened" || e.kind === "state" || e.kind === "reopened",
  );
}

/** How the incident got into its state, as far as the copy cares. */
interface Entry {
  kind: "opened" | "state" | "reopened";
  from?: IncidentState;
  /** A person's name, or `sessions` when nobody acted. */
  by: string;
}

interface Row {
  kind: IncidentNotificationKind;
  reason: string;
  body: string;
}

function vetoDeadline(response: IncidentResponse | undefined): string | null {
  if (response?.next?.kind === "veto") return response.next.deadline;
  return response?.veto?.deadline ?? null;
}

function isPerson(by: string): boolean {
  return by.trim() !== "" && by !== "sessions";
}

/** The kind and the copy for `incident` entered as `entry` describes. */
function rowFor(
  incident: Incident,
  entry: Entry,
  facts: NotifyFacts,
  now: number,
): Row {
  const { title, state } = incident;
  const headline = incidentHeadline(title, state, facts.signal);
  const actor = actorName(entry.by, incident.owner);
  const update = (body: string, reason = headline): Row => ({
    kind: "incident_update",
    reason,
    body,
  });
  const entered = entry.kind === "opened" || entry.kind === "reopened";
  switch (state) {
    case "heads-up":
      return {
        kind: "incident_heads_up",
        reason: headline,
        body: COPY.headsUp,
      };
    case "investigating": {
      if (entry.kind === "reopened")
        return {
          kind: "incident_opened",
          reason: reopenedTitle(title, facts.signal),
          body: COPY.investigatingAgain,
        };
      if (entry.kind === "opened" || entry.from === "heads-up")
        return {
          kind: "incident_opened",
          reason: headline,
          body: COPY.investigating,
        };
      if (isPerson(entry.by)) {
        if (
          entry.from === "veto" ||
          entry.from === "fix-ready" ||
          entry.from === "watching"
        )
          return update(stoppedBody(actor));
        if (entry.from === "needs-you") return update(answeredBody(actor));
      }
      return update(COPY.investigatingAgain);
    }
    case "waiting-on-provider":
      return entered
        ? { kind: "incident_opened", reason: headline, body: COPY.provider }
        : update(COPY.provider);
    case "needs-you": {
      const next = incident.response?.next;
      return {
        kind: "incident_needs_you",
        reason: `${title} needs you`,
        body:
          next?.kind === "needs-you" && next.reason.trim()
            ? firstLine(next.reason)
            : COPY.needsYou,
      };
    }
    case "veto": {
      const deadline = vetoDeadline(incident.response);
      if (!deadline || !(Date.parse(deadline) > now))
        return update(deployingBody(facts.change));
      return {
        kind: "incident_veto",
        reason: headline,
        body: vetoBody(
          facts.change ?? DEPLOY,
          clockLabel(deadline, facts.timeZone),
        ),
      };
    }
    case "rolled-back":
      return {
        kind: "incident_rolled_back",
        reason: `${title}: the fix was rolled back`,
        body: COPY.rolledBack,
      };
    case "resolved":
      return {
        kind: "incident_resolved",
        reason: `${title} is back to normal`,
        body: resolvedBody(incident.fixedBy, actor),
      };
    case "closed-without-action":
      return {
        kind: "incident_resolved",
        reason: `${title} is back to normal`,
        body: COPY.closedWithoutAction,
      };
    case "deploying":
      return update(deployingBody(facts.change));
    case "watching":
      return update(COPY.watching, `${title}: the fix is live`);
    case "fix-ready":
      return update(COPY.fixReady);
    case "paused":
      return update(COPY.paused);
  }
}

/** The first option that is not Stop: the page's primary button. */
function topOption(incident: Incident): OwnerDecision | undefined {
  const next = incident.response?.next;
  if (next?.kind !== "needs-you") return undefined;
  return next.options.find((option) => option !== "stop");
}

function pushHints(
  incident: Incident,
  row: Row,
  facts: NotifyFacts,
  now: number,
): NotificationPush | undefined {
  const url = incidentUrl(incident.id);
  const open: PushAction = { action: "open", title: COPY.open, url };
  switch (row.kind) {
    case "incident_veto": {
      const labels = vetoLabels(facts.change ?? DEPLOY);
      const deadline = Date.parse(vetoDeadline(incident.response) ?? "");
      const seconds = Math.ceil((deadline - now) / 1000);
      return {
        actions: [
          {
            action: "stop",
            title: labels.stop,
            url: incidentIntentUrl(incident.id, "stop"),
          },
          {
            action: "deploy-now",
            title: labels.now,
            url: incidentIntentUrl(incident.id, "deploy-now"),
          },
          open,
        ],
        requireInteraction: true,
        urgency: "high",
        ttlSeconds: Math.min(
          TTL_SECONDS.veto.max,
          Math.max(TTL_SECONDS.veto.min, seconds),
        ),
      };
    }
    case "incident_needs_you": {
      const top = topOption(incident);
      return {
        actions: top
          ? [
              {
                action: "answer",
                title: decisionLabel(top, facts.change),
                url: incidentIntentUrl(incident.id, top),
              },
              open,
            ]
          : [open],
        requireInteraction: true,
        urgency: "high",
        ttlSeconds: TTL_SECONDS.needsYou,
      };
    }
    case "incident_opened":
    case "incident_rolled_back":
      return { urgency: "normal", ttlSeconds: TTL_SECONDS.other };
    case "incident_resolved":
      return { urgency: "normal", ttlSeconds: TTL_SECONDS.resolved };
    case "incident_update":
      return { urgency: "low", ttlSeconds: TTL_SECONDS.other };
    case "incident_heads_up":
      return undefined;
  }
}

function baseEvent(
  incident: Incident,
  row: Row,
  facts: NotifyFacts,
  now: number,
  eventKey: string,
): NotificationEvent {
  const push = pushHints(incident, row, facts, now);
  return {
    kind: row.kind,
    subject: {
      type: "incident",
      id: incident.id,
      title: incident.title,
      context: incident.project,
    },
    reason: row.reason,
    body: row.body,
    url: incidentUrl(incident.id),
    eventKey,
    at: now,
    ...(push ? { push } : {}),
  };
}

/** Plan the inbox event for one committed change, or null when it is not
 *  news (anything but a new state or a new question). */
export function planIncidentNotification(
  next: Incident,
  previous: Incident | null,
  facts: NotifyFacts,
  now: number,
): PlannedNotification | null {
  const owner = next.owner?.trim();
  if (!owner) return null;
  const latest = latestStateEvent(next);
  const moved =
    previous === null || latest?.id !== latestStateEvent(previous)?.id;
  const since = next.response?.needsYou?.since;
  const asked =
    !moved &&
    next.state === "needs-you" &&
    since !== undefined &&
    since !== previous?.response?.needsYou?.since;
  if (!moved && !asked) return null;
  const entry: Entry = moved
    ? {
        kind:
          latest?.kind === "state" || latest?.kind === "reopened"
            ? latest.kind
            : "opened",
        ...(latest?.from ? { from: latest.from } : {}),
        by: latest?.by ?? "sessions",
      }
    : { kind: "state", from: "needs-you", by: "sessions" };
  const row = rowFor(next, entry, facts, now);
  const eventKey = moved
    ? (latest?.id ?? `opened:${next.openedAt}`)
    : `needs:${since}`;
  const event = baseEvent(next, row, facts, now, eventKey);

  const ownChange = entry.by.trim().toLowerCase() === owner.toLowerCase();
  let delivered: Pick<NotificationEvent, "delivery" | "hold" | "cooldown">;
  if (
    row.kind === "incident_heads_up" ||
    next.state === "closed-without-action"
  )
    delivered = { delivery: "quiet" };
  else if (row.kind === "incident_update" || ownChange)
    delivered = { delivery: "replace" };
  else
    delivered = {
      delivery: "alert",
      cooldown: { key: row.kind, ms: INCIDENT_ALERT_COOLDOWN_MS },
    };
  if (facts.night && delivered.delivery !== "quiet") {
    const wakes =
      row.kind === "incident_needs_you" &&
      facts.fullyDown &&
      delivered.delivery === "alert";
    if (!wakes) delivered = { delivery: "quiet", hold: true };
  }
  return { user: owner, event: { ...event, ...delivered } };
}

/** UTC calendar day, `YYYY-MM-DD`: one flush per row per day. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The one alert after a night: the incident's current state as if it had
 * just entered it. Null for a heads-up and a close without action (they
 * never push) and for a blank owner.
 */
export function planHeldFlush(
  incident: Incident,
  facts: NotifyFacts,
  now: number,
): PlannedNotification | null {
  const owner = incident.owner?.trim();
  if (!owner) return null;
  if (
    incident.state === "heads-up" ||
    incident.state === "closed-without-action"
  )
    return null;
  // Entered at open: "Agents are investigating", not "again", for an
  // incident that opened overnight.
  const entry: Entry = {
    kind: "opened",
    by: latestStateEvent(incident)?.by ?? "sessions",
  };
  const row = rowFor(incident, entry, facts, now);
  return {
    user: owner,
    event: {
      ...baseEvent(incident, row, facts, now, `flush:${utcDay(now)}`),
      delivery: "alert",
      flushHeld: true,
    },
  };
}
