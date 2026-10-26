// A signal that keeps failing and passing, seen from an incident closed
// without action: how often it came back, and the two one-click ways to
// quiet it, a stricter rule or a day's mute (a maintenance window). Pure.
import type {
  Incident,
  MaintenanceWindow,
  SignalRule,
  SignalState,
  SignalView,
} from "../../../shared/incidents";
import type { SignalInput } from "../api/incidents";
import { formatSpan } from "./copy";

/** Coming back this many times, counting the first, makes it a flap. */
export const FLAP_SUGGEST_AT = 3;
/** How long "Mute for a day" mutes. */
export const MUTE_MS = 86_400_000;
/** The most failures in a row a rule may ask for (signal validation). */
const MAX_FAILURES = 50;

const PROBLEM: ReadonlySet<SignalState> = new Set(["failing", "slow"]);

/**
 * How many times the incident's signal turned failing or slow: once to
 * open it, again each time it came back while the incident was open or
 * reopened it, and each time it came back while the closed incident stayed
 * quiet (`incident.quiet`).
 */
export function flapCount(incident: Incident): number {
  const id = incident.primarySignalId;
  let count = 1;
  let bad = true;
  for (const e of incident.events) {
    if (e.kind === "reopened") {
      if (!bad) count++;
      bad = true;
    } else if (
      (e.kind === "signal-state" || e.kind === "signal-attached") &&
      e.signalId === id &&
      e.signalState
    ) {
      if (PROBLEM.has(e.signalState)) {
        if (!bad) count++;
        bad = true;
      } else if (e.signalState === "ok") bad = false;
    }
  }
  return count + (incident.quiet?.flaps ?? 0);
}

/** The rule asking for twice the evidence before it fails, and what it
 *  then needs ("6 failures in a row"); null for a rule that counts no
 *  checks or is at its most. */
export function stricterRule(
  signal: Pick<SignalView, "rule">,
): { rule: SignalRule; needs: string } | null {
  const rule = signal.rule;
  switch (rule.kind) {
    case "consecutive": {
      if (rule.failures >= MAX_FAILURES) return null;
      const failures = Math.min(MAX_FAILURES, rule.failures * 2);
      return {
        rule: { ...rule, failures },
        needs: `${failures} failures in a row`,
      };
    }
    case "threshold": {
      const forMs = Math.max(rule.forMs * 2, 120_000);
      return {
        rule: { ...rule, forMs },
        needs: `${formatSpan(forMs)} over ${rule.above}`,
      };
    }
    case "rate": {
      const atLeast = rule.atLeast * 2;
      return {
        rule: { ...rule, atLeast },
        needs: `${atLeast} failures in ${formatSpan(rule.windowMs)}`,
      };
    }
    default:
      return null;
  }
}

/** One click on the card: the signal change, and the change that undoes
 *  it. */
export interface SignalFix {
  label: string;
  /** The toast once it lands. */
  landed: string;
  patch: SignalInput;
  undo: SignalInput;
}

export interface FlapSuggestion {
  signalId: string;
  signalName: string;
  flaps: number;
  stricter: SignalFix | null;
  mute: SignalFix;
}

/**
 * For an incident closed without action whose signal keeps coming back, a
 * stricter rule and a day's mute. Null when it has not come back
 * {@link FLAP_SUGGEST_AT} times, or its signal is gone, off, or was edited
 * since it last came back (someone already acted).
 */
export function flapSuggestion(
  incident: Incident,
  signals: readonly SignalView[],
  now: number,
): FlapSuggestion | null {
  if (incident.state !== "closed-without-action") return null;
  const flaps = flapCount(incident);
  if (flaps < FLAP_SUGGEST_AT) return null;
  const signal = signals.find((s) => s.id === incident.primarySignalId);
  if (!signal?.enabled) return null;
  const lastFlap = incident.quiet?.lastAt ?? incident.closedAt;
  if (lastFlap && Date.parse(signal.updatedAt) > Date.parse(lastFlap))
    return null;
  const stricter = stricterRule(signal);
  const windows = signal.maintenance ?? [];
  const mute: MaintenanceWindow = {
    kind: "once",
    start: new Date(now).toISOString(),
    end: new Date(now + MUTE_MS).toISOString(),
    note: "Muted from an incident",
  };
  return {
    signalId: signal.id,
    signalName: signal.name,
    flaps,
    stricter: stricter
      ? {
          label: `Need ${stricter.needs}`,
          landed: `${signal.name} now needs ${stricter.needs}`,
          patch: { rule: stricter.rule },
          undo: { rule: signal.rule },
        }
      : null,
    mute: {
      label: "Mute for a day",
      landed: `${signal.name} is muted for a day`,
      patch: { maintenance: [...windows, mute] },
      undo: { maintenance: [...windows] },
    },
  };
}
