// When an incident closes by itself: it waits on a person before any agent
// ran (a setup problem, the budget, or the kill switch), nothing was
// proposed, run or merged, and every one of its own signals has passed for
// a while. The coordinator closes it; the incident page says when. Pure.
import type { NeedsYouKind } from "./incident-response";
import type { Incident } from "./incidents";

/** How long every own signal has passed before the incident closes. */
export const RECOVERED_CLOSE_MS = 300_000;
/** The fewest passing checks in a row it takes, whatever the signal's rule
 *  asks for. */
export const RECOVERED_MIN_PASSES = 2;

/** Needs-you reasons that come before any agent could start. */
const BEFORE_START: ReadonlySet<NeedsYouKind> = new Set(["setup", "budget"]);

/**
 * Whether the incident closes by itself once its signals recover: it is
 * waiting on a person for a reason that came before any agent started, and
 * nothing ran or changed in production.
 */
export function closesWhenRecovered(
  incident: Pick<Incident, "state" | "response">,
): boolean {
  const r = incident.response;
  if (incident.state === "needs-you") {
    const kind = r?.needsYou?.kind;
    if (!kind || !BEFORE_START.has(kind)) return false;
  } else if (incident.state !== "paused") return false;
  return (
    !r ||
    (r.agents.length === 0 &&
      r.candidate === undefined &&
      r.proof === undefined &&
      r.actionRuns.length === 0 &&
      r.merge === undefined)
  );
}

/** When an incident whose signals all pass since `passingSince` closes. */
export function recoveredCloseAt(passingSince: number): number {
  return passingSince + RECOVERED_CLOSE_MS;
}
