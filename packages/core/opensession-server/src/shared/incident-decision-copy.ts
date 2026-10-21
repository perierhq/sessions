// What each owner decision is called and what it does, shared by the
// incident page and the lock-screen notification, and the one parser for a
// push intent (`/incidents/<id>?intent=<decision>`).
import { OWNER_DECISIONS, type OwnerDecision } from "./incident-response";

export const DECISION_COPY: Readonly<
  Record<OwnerDecision, { label: string; description: string }>
> = {
  stop: {
    label: "Stop",
    description: "Nothing ships; the incident waits for you",
  },
  "deploy-now": {
    label: "Deploy now",
    description: "Skip the rest of the veto window",
  },
  approve: {
    label: "Deploy the fix",
    description: "Sessions merges the fix and runs the deploy action",
  },
  "send-back": {
    label: "Send it back",
    description: "The investigator gets another round",
  },
  retry: {
    label: "Try again",
    description: "Start the agents again from where they stopped",
  },
  resolve: {
    label: "Mark as fixed",
    description: "Close the incident as fixed by hand",
  },
  close: {
    label: "Close without action",
    description: "Nothing needed fixing",
  },
  "roll-back": {
    label: "Roll back",
    description:
      "Sessions runs the rollback action and the investigator gets another round",
  },
};

const DECISIONS: ReadonlySet<string> = new Set(OWNER_DECISIONS);

function isOwnerDecision(raw: string): raw is OwnerDecision {
  return DECISIONS.has(raw);
}

/** A push intent: an owner decision, else undefined. */
export function parseIncidentIntent(
  raw: string | null | undefined,
): OwnerDecision | undefined {
  return raw && isOwnerDecision(raw) ? raw : undefined;
}
