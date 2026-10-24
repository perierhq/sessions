// Which colour and word an incident or signal state shows. Status colours
// (spec 4.1): failing red; slow, flaky and upcoming steady yellow; external
// and unknown faint; ok green. Only running agents pulse. Pure.
import type { IncidentResponse } from "../../../shared/incident-response";
import type { Incident, SignalState } from "../../../shared/incidents";
import { GIT_DOT_BG } from "../pr-tone-classes";
import { clockTime } from "../time";

export type DotTone = "red" | "yellow" | "faint" | "green" | "blue";

export const DOT_BG: Record<DotTone, string> = {
  red: GIT_DOT_BG.red,
  yellow: GIT_DOT_BG.yellow,
  faint: GIT_DOT_BG.muted,
  green: GIT_DOT_BG.green,
  blue: GIT_DOT_BG.blue,
};

const SIGNAL_TONE: Record<SignalState, DotTone> = {
  failing: "red",
  slow: "yellow",
  flaky: "yellow",
  upcoming: "yellow",
  external: "faint",
  unknown: "faint",
  ok: "green",
};

export function signalDotTone(state: SignalState): DotTone {
  return SIGNAL_TONE[state];
}

/** Problems first: the order lists and summaries sort by. */
export const SIGNAL_RANK: Record<SignalState, number> = {
  failing: 0,
  slow: 1,
  external: 2,
  flaky: 3,
  upcoming: 4,
  unknown: 5,
  ok: 6,
};

const SIGNAL_WORD: Record<SignalState, string> = {
  failing: "failing",
  slow: "slow",
  flaky: "flaky",
  upcoming: "due soon",
  external: "provider",
  unknown: "no data",
  ok: "ok",
};

export function signalStateWord(state: SignalState): string {
  return SIGNAL_WORD[state];
}

/** The state as a standalone value, in sentence case like "Off" beside it:
 *  "OK", "Failing", "No data". */
export function signalStateLabel(state: SignalState): string {
  if (state === "ok") return "OK";
  const word = SIGNAL_WORD[state];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Any agent of the incident is running now. */
export function agentsWorking(response: IncidentResponse | undefined): boolean {
  return !!response?.agents.some((agent) => agent.status === "running");
}

export interface IncidentDot {
  tone: DotTone;
  pulse: boolean;
}

export interface IncidentStateWord {
  text: string;
  /** Only "needs you" asks for attention. */
  tone: "info" | "faint";
}

/**
 * The dot follows the primary signal, not the lifecycle: a veto pending on a
 * failing check stays red. Closed incidents and provider waits have their
 * own; running agents pulse yellow.
 */
export function incidentDot(
  incident: Pick<Incident, "state" | "response">,
  primary: SignalState | null,
): IncidentDot {
  if (incident.state === "resolved") return { tone: "green", pulse: false };
  if (
    incident.state === "closed-without-action" ||
    incident.state === "waiting-on-provider"
  )
    return { tone: "faint", pulse: false };
  if (agentsWorking(incident.response)) return { tone: "yellow", pulse: true };
  return { tone: primary ? signalDotTone(primary) : "faint", pulse: false };
}

/** The sidebar's trailing state, in words (never colour alone). Only
 *  "needs you" asks for attention. */
export function incidentStateWord(
  incident: Pick<Incident, "state" | "response">,
): IncidentStateWord {
  const faint = (text: string): IncidentStateWord => ({ text, tone: "faint" });
  const response = incident.response;
  switch (incident.state) {
    case "needs-you":
      return { text: "needs you", tone: "info" };
    case "veto": {
      const deadline = response?.veto?.deadline;
      const at = deadline ? clockTime(deadline) : "";
      return faint(at ? `deploys ${at}` : "veto");
    }
    case "investigating":
      return faint(
        response && response.round >= 1
          ? `round ${response.round}`
          : "investigating",
      );
    case "fix-ready":
      return faint("fix ready");
    case "deploying":
      return faint("deploying");
    case "watching":
      return faint("watching");
    case "paused":
      return faint("paused");
    case "waiting-on-provider":
      return faint("not us");
    case "rolled-back":
      return faint("rolled back");
    case "heads-up":
      return faint("heads-up");
    case "resolved":
      return faint("fixed");
    case "closed-without-action":
      return faint("closed");
  }
}
