// What an incident notification says. The title is one line of state
// ("Search is down"); the body says what happens next. The project leads
// the body on every banner (`bannerText` adds it), so no sentence here
// names it. Pure: strings in, strings out.
import { DECISION_COPY } from "../../shared/incident-decision-copy";
import type { OwnerDecision } from "../../shared/incident-response";
import type {
  FixedBy,
  IncidentState,
  SignalState,
} from "../../shared/incidents";

/** What the veto runs when nobody stops it. */
export type VetoChange =
  | { kind: "deploy" }
  | { kind: "rollback" }
  | { kind: "action"; label: string };

const DEPLOY: VetoChange = { kind: "deploy" };

export const COPY = {
  investigating: "Agents are investigating",
  investigatingAgain: "Agents are investigating again",
  provider: "Waiting on the provider. Nothing to do yet",
  headsUp: "Heads-up. Nothing is down yet",
  needsYou: "Agents stopped and need a decision",
  rolledBack:
    "It still failed after the deploy. Agents are investigating again",
  watching: "The fix is live. Watching the signal before closing",
  fixReady: "A verified fix is ready",
  paused: "Agents are paused",
  closedWithoutAction: "Closed without action",
  open: "Open",
} as const;

/** One line of state. A heads-up never says "is down": nothing is yet. */
export function incidentHeadline(
  title: string,
  state: IncidentState,
  signal: SignalState | null,
): string {
  if (state === "heads-up")
    return signal === "flaky"
      ? `${title} is failing on and off`
      : `${title} needs attention soon`;
  if (state === "waiting-on-provider" || signal === "external")
    return `${title} is down at the provider`;
  switch (signal) {
    case "slow":
      return `${title} is slow`;
    case "failing":
      return `${title} is down`;
    case "flaky":
      return `${title} is failing on and off`;
    default:
      return `${title} has an open incident`;
  }
}

export function reopenedTitle(
  title: string,
  signal: SignalState | null,
): string {
  if (signal === "failing") return `${title} is failing again`;
  if (signal === "slow") return `${title} is slow again`;
  return `${title} has a problem again`;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

function clockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = clocks.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone,
      });
    } catch {
      format = clockFormat("UTC");
    }
    clocks.set(timeZone, format);
  }
  return format;
}

/** `HH:MM`, 24-hour, in `timeZone` (UTC when the zone is unknown). */
export function clockLabel(iso: string, timeZone: string): string {
  return clockFormat(timeZone).format(new Date(iso));
}

export function vetoBody(change: VetoChange, clock: string): string {
  switch (change.kind) {
    case "deploy":
      return `The fix is verified and deploys at ${clock} unless you stop it`;
    case "rollback":
      return `Rolls back to the last release at ${clock} unless you stop it`;
    case "action":
      return `${change.label} at ${clock} unless you stop it`;
  }
}

export function vetoLabels(change: VetoChange): { stop: string; now: string } {
  switch (change.kind) {
    case "deploy":
      return { stop: "Stop the deploy", now: "Deploy now" };
    case "rollback":
      return { stop: "Stop the rollback", now: "Roll back now" };
    case "action":
      return { stop: "Stop", now: "Run now" };
  }
}

export function deployingBody(change: VetoChange | null): string {
  if (change?.kind === "deploy") return "Deploying the fix now";
  if (change?.kind === "rollback") return "Rolling back now";
  return "Running the action now";
}

export function resolvedBody(
  fixedBy: FixedBy | undefined,
  actor: string,
): string {
  switch (fixedBy) {
    case "agents":
      return "Fixed by agents and verified in production";
    case "agents-with-you":
      return "Fixed with you and verified in production";
    case "by-hand":
      return `${actor} closed it as fixed`;
    case "provider-recovered":
      return "The provider recovered";
    default:
      return "Closed";
  }
}

export function stoppedBody(actor: string): string {
  return `${actor} stopped it. Agents are investigating`;
}

export function answeredBody(actor: string): string {
  return `${actor} answered. Agents are continuing`;
}

/** A decision's button label; the veto's two are named for what it runs. */
export function decisionLabel(
  decision: OwnerDecision,
  change: VetoChange | null,
): string {
  if (decision === "stop") return vetoLabels(change ?? DEPLOY).stop;
  if (decision === "deploy-now") return vetoLabels(change ?? DEPLOY).now;
  return DECISION_COPY[decision].label;
}

/** "You" for the owner's own change, else the person's name. */
export function actorName(by: string, owner: string): string {
  return by.trim().toLowerCase() === owner.trim().toLowerCase() ? "You" : by;
}

/** The first line, trimmed, cut to `max` characters with an ellipsis. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
