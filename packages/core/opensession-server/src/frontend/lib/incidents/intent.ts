// What a push intent (`/incidents/<id>?intent=<decision>`) opens on the
// page: the confirm for a decision the card still offers, or a toast saying
// it no longer applies. A notification never acts alone. Pure.
import { DECISION_COPY } from "../../../shared/incident-decision-copy";
import type { OwnerDecision } from "../../../shared/incident-response";
import type { NextCard } from "./next-action";

export type IntentPlan =
  | {
      kind: "confirm";
      decision: OwnerDecision;
      title: string;
      description: string;
      confirmLabel: string;
    }
  | { kind: "stale"; message: string }
  /** A decision that needs a note: no confirm can carry one, so the page
   *  says where to write it, on the card. */
  | { kind: "on-card"; message: string };

function offers(card: NextCard, decision: OwnerDecision): boolean {
  if (!card) return false;
  if (card.mode === "choice") return card.decisions.includes(decision);
  return card.buttons.some((b) => b.decision === decision);
}

export function intentPlan(
  card: NextCard,
  intent: OwnerDecision,
  stateWord: string,
  /** `rollback`: the veto runs a rollback, not a deploy. */
  veto: { rollback: boolean } = { rollback: false },
): IntentPlan {
  if (!offers(card, intent)) {
    const message =
      intent === "stop"
        ? `Nothing to stop: ${stateWord}`
        : intent === "deploy-now"
          ? `Nothing to deploy: ${stateWord}`
          : `Already handled: ${stateWord}`;
    return { kind: "stale", message };
  }
  if (intent === "send-back")
    return {
      kind: "on-card",
      message: `Pick ${DECISION_COPY["send-back"].label} on the card and write the investigator a note`,
    };
  if (intent === "stop")
    return {
      kind: "confirm",
      decision: intent,
      title: veto.rollback ? "Stop the rollback?" : "Stop the deploy?",
      description: veto.rollback
        ? "Nothing is rolled back and the incident waits for you"
        : "Nothing ships and the incident waits for you",
      confirmLabel: "Stop",
    };
  if (intent === "deploy-now")
    return veto.rollback
      ? {
          kind: "confirm",
          decision: intent,
          title: "Roll back now?",
          description: "The rollback runs without the rest of the veto window",
          confirmLabel: "Roll back now",
        }
      : {
          kind: "confirm",
          decision: intent,
          title: "Deploy now?",
          description: "The fix goes out without the rest of the veto window",
          confirmLabel: "Deploy now",
        };
  const copy = DECISION_COPY[intent];
  return {
    kind: "confirm",
    decision: intent,
    title: `${copy.label}?`,
    description: copy.description,
    confirmLabel: copy.label,
  };
}
