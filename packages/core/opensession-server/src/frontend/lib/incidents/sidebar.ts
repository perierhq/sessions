// Which incidents the sidebar band lists and in what order: open ones by
// urgency (needs you, then vetoes by the soonest deadline, then the rest by
// newest), then incidents fixed within the last twelve hours. An incident
// closed without action was never a problem worth keeping in view. Pure.
import {
  type IncidentSummary,
  isOpenIncident,
  type SignalState,
  type SignalView,
} from "../../../shared/incidents";
import {
  type DotTone,
  SIGNAL_RANK,
  signalDotTone,
  signalStateWord,
} from "./tone";

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

export interface IncidentsToolStatus {
  tone: DotTone;
  /** The dot in words, for the row's accessible name. */
  label: string;
}

/**
 * The Incidents tool row's trailing dot. Red while any signal is failing,
 * blue while an incident needs you, steady yellow for a heads-up or a slow,
 * flaky or due-soon signal, green when every signal is ok, and nothing at
 * all before the first signal exists. Signals count as the home's status
 * line counts them (switched-off ones are left out), so the row and the
 * page it opens show the same colour for the same signals. What is left
 * (a provider outage, a signal with no data yet) is faint, as on the home.
 */
export function incidentsToolStatus(
  incidents: IncidentSummary[],
  signals: SignalView[],
): IncidentsToolStatus | null {
  const states = signals
    .filter((signal) => signal.enabled)
    .map((signal): SignalState => signal.evaluation?.state ?? "unknown")
    .sort((a, b) => SIGNAL_RANK[a] - SIGNAL_RANK[b]);
  const open = incidents.filter(isOpenIncident);
  if (!states.length && !open.length) return null;
  if (states.includes("failing")) return { tone: "red", label: "failing" };
  if (open.some((incident) => incident.state === "needs-you"))
    return { tone: "blue", label: "needs you" };
  if (open.some((incident) => incident.state === "heads-up"))
    return { tone: "yellow", label: "heads-up" };
  const warning = states.find((state) => signalDotTone(state) === "yellow");
  if (warning) return { tone: "yellow", label: signalStateWord(warning) };
  const worst = states[0];
  if (worst === "ok") return { tone: "green", label: "all ok" };
  return {
    tone: "faint",
    label: worst ? signalStateWord(worst) : "open incident",
  };
}
