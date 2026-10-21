// Which incidents the sidebar band lists and in what order: open ones by
// urgency (needs you, then vetoes by the soonest deadline, then the rest by
// newest), then incidents fixed within the last twelve hours. An incident
// closed without action was never a problem worth keeping in view. Pure.
import {
  type IncidentSummary,
  isOpenIncident,
} from "../../../shared/incidents";

/** How long a fixed incident stays in the band, reading "fixed". */
export const RECENTLY_FIXED_MS = 12 * 3_600_000;

const time = (iso: string | undefined, fallback: number) => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : fallback;
};

function urgency(incident: IncidentSummary): number {
  if (incident.state === "needs-you") return 0;
  if (incident.state === "veto") return 1;
  return 2;
}

export function sidebarIncidents(
  all: IncidentSummary[],
  now: number,
): IncidentSummary[] {
  const open = all
    .filter(isOpenIncident)
    .sort(
      (a, b) =>
        urgency(a) - urgency(b) ||
        (urgency(a) === 1
          ? time(a.response?.veto?.deadline, Infinity) -
            time(b.response?.veto?.deadline, Infinity)
          : 0) ||
        time(b.openedAt, 0) - time(a.openedAt, 0),
    );
  const fixed = all
    .filter(
      (incident) =>
        incident.state === "resolved" &&
        now - time(incident.closedAt, -Infinity) <= RECENTLY_FIXED_MS,
    )
    .sort((a, b) => time(b.closedAt, 0) - time(a.closedAt, 0));
  return [...open, ...fixed];
}
