// Incident lifecycle: the transition table, state transitions and the capped
// timeline. Pure: every function returns a new incident and never mutates
// its input.
import { randomUUIDv7 } from "bun";
import {
  type FixedBy,
  type Incident,
  type IncidentEvent,
  type IncidentState,
  type StripMarkerKind,
  isTerminalIncidentState,
} from "../../shared/incidents";

export const TIMELINE_CAP = 500;
export const EVENT_DETAIL_MAX = 2000;

export const INCIDENT_TRANSITIONS: Readonly<
  Record<IncidentState, readonly IncidentState[]>
> = Object.freeze({
  "heads-up": [
    "investigating",
    "waiting-on-provider",
    "needs-you",
    "paused",
    "closed-without-action",
  ],
  investigating: [
    "fix-ready",
    "waiting-on-provider",
    "needs-you",
    "paused",
    "resolved",
    "closed-without-action",
  ],
  "fix-ready": ["veto", "deploying", "investigating", "needs-you", "paused"],
  veto: ["deploying", "investigating", "needs-you", "paused"],
  // `investigating`: a failing check before the merge sends the work back.
  deploying: [
    "watching",
    "rolled-back",
    "investigating",
    "needs-you",
    "paused",
  ],
  watching: ["resolved", "rolled-back", "needs-you", "paused"],
  "rolled-back": ["investigating", "needs-you"],
  "needs-you": [
    "heads-up",
    "investigating",
    "fix-ready",
    "veto",
    "deploying",
    "watching",
    "paused",
    "resolved",
    "closed-without-action",
  ],
  paused: [
    "heads-up",
    "investigating",
    "fix-ready",
    "veto",
    "deploying",
    "watching",
    "needs-you",
    "resolved",
    "closed-without-action",
  ],
  "waiting-on-provider": [
    "investigating",
    "needs-you",
    "paused",
    "resolved",
    "closed-without-action",
  ],
  resolved: ["investigating", "heads-up"],
  "closed-without-action": ["investigating", "heads-up"],
} satisfies Record<IncidentState, readonly IncidentState[]>);

/** States that remember where to return to (`resumeState`). */
const WAITING_STATES: ReadonlySet<IncidentState> = new Set([
  "needs-you",
  "paused",
  "waiting-on-provider",
]);

/** Kinds the timeline cap keeps longest: they carry the incident's story. */
const KEPT_KINDS: ReadonlySet<IncidentEvent["kind"]> = new Set([
  "opened",
  "state",
  "reopened",
]);

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  return from !== to && INCIDENT_TRANSITIONS[from].includes(to);
}

export function markerForTransition(
  from: IncidentState,
  to: IncidentState,
): StripMarkerKind | undefined {
  switch (to) {
    case "fix-ready":
      return "fix-ready";
    case "investigating":
      return from === "fix-ready" || from === "veto" || from === "deploying"
        ? "sent-back"
        : undefined;
    case "deploying":
      return "deploy";
    case "watching":
      return "released";
    case "rolled-back":
      return "rolled-back";
    case "resolved":
      return "resolved";
    default:
      return undefined;
  }
}

/** Append one event: id, detail cap, `updatedAt`, and the timeline cap. */
export function appendEvent(
  incident: Incident,
  event: Omit<IncidentEvent, "id">,
): Incident {
  const events = [
    ...incident.events,
    {
      ...event,
      id: `evt-${randomUUIDv7()}`,
      detail: event.detail.slice(0, EVENT_DETAIL_MAX),
    },
  ];
  let droppedEvents = incident.droppedEvents;
  while (events.length > TIMELINE_CAP) {
    const index = events.findIndex((e) => !KEPT_KINDS.has(e.kind));
    // Only story events left: keep the first, drop the oldest after it.
    events.splice(index === -1 ? 1 : index, 1);
    droppedEvents++;
  }
  return { ...incident, events, droppedEvents, updatedAt: event.at };
}

export function transitionIncident(
  incident: Incident,
  to: IncidentState,
  opts: { by: string; detail: string; at: string; fixedBy?: FixedBy },
): Incident | { error: string } {
  const from = incident.state;
  if (!canTransition(from, to))
    return { error: `Cannot move from ${from} to ${to}` };
  const next: Incident = { ...incident, state: to };

  if (WAITING_STATES.has(to)) {
    if (!WAITING_STATES.has(from)) next.resumeState = from;
  } else delete next.resumeState;

  const reopening = isTerminalIncidentState(from);
  if (reopening) {
    delete next.closedAt;
    delete next.fixedBy;
  }
  if (isTerminalIncidentState(to)) {
    next.closedAt = opts.at;
    if (to === "resolved" && opts.fixedBy) next.fixedBy = opts.fixedBy;
    else delete next.fixedBy;
  }

  const marker = reopening ? "reopened" : markerForTransition(from, to);
  return appendEvent(next, {
    at: opts.at,
    kind: reopening ? "reopened" : "state",
    by: opts.by,
    detail: opts.detail,
    from,
    to,
    ...(marker ? { marker } : {}),
  });
}
