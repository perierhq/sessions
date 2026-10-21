// What the incident's next-action card says and offers, from plan 2's
// `response.next`. Soft for the optional action, danger "Stop" for a veto,
// primary only when the next step is the owner's. Pure.
import { DECISION_COPY } from "../../../shared/incident-decision-copy";
import {
  type AgentRun,
  type AutonomyLevel,
  describeIndependence,
  type IncidentResponse,
  type OwnerDecision,
  type RedactedProjectSettings,
  type ResponsePhase,
} from "../../../shared/incident-response";
import {
  type Incident,
  isTerminalIncidentState,
} from "../../../shared/incidents";
import { ApiError } from "../api/request";
import { repoLabel } from "../repo-label";
import { clockTime } from "../time";
import type { AskQuestion } from "../types";
import { formatSpan } from "./copy";
import { type DotTone, signalDotTone } from "./tone";

export { DECISION_COPY };

export type CardButtonKind =
  | "decision"
  | "deploy-now"
  | "stop"
  | "pause-agents"
  | "resume-agents";

export interface CardButton {
  key: string;
  kind: CardButtonKind;
  label: string;
  weight: "primary" | "soft" | "danger";
  decision?: OwnerDecision;
  /** The Stop button counts down to the end of the veto. */
  countdownTo?: string;
  /** What the Stop button reads once the veto has ended. */
  doneLabel?: string;
  /** Deploy now while its undo window runs: the undo control's label and
   *  what the button reads meanwhile. */
  undoLabel?: string;
  pendingLabel?: string;
  confirm?: {
    title: string;
    description?: string;
    confirmLabel: string;
    destructive?: boolean;
  };
}

export interface ShellCard {
  mode: "shell";
  tone: DotTone;
  pulse: boolean;
  eyebrow: string;
  headline: string;
  body: string;
  footnote?: string;
  buttons: CardButton[];
}

export interface ChoiceCard {
  mode: "choice";
  eyebrow: string;
  question: AskQuestion;
  decisions: OwnerDecision[];
}

export type NextCard = ShellCard | ChoiceCard | null;

const DEFAULT_WATCH_MS = 600_000;

const PHASE_WORD: Partial<Record<ResponsePhase, string>> = {
  investigating: "investigating",
  proving: "measuring the fix",
  verifying: "verifying",
  deciding: "deciding",
  merging: "merging",
  deploying: "deploying",
  "rolling-back": "rolling back",
  documenting: "writing the note",
};

const AUTONOMY_BODY: Record<AutonomyLevel, string> = {
  watch: "Agents only look and report",
  propose: "A verified fix waits for you",
  "deploy-after-veto":
    "Nothing changes in production without a veto window first",
  "deploy-right-away":
    "A verified fix goes out as soon as the verifier is certain",
};

const ROLL_BACK_CONFIRM: NonNullable<CardButton["confirm"]> = {
  title: "Roll back the release?",
  description:
    "Sessions runs the rollback action now and the investigator gets another round",
  confirmLabel: "Roll back",
  destructive: true,
};

function decisionButton(
  decision: OwnerDecision,
  weight: CardButton["weight"],
): CardButton {
  const button: CardButton = {
    key: `decision:${decision}`,
    kind: "decision",
    label: DECISION_COPY[decision].label,
    weight,
    decision,
  };
  if (decision === "roll-back") button.confirm = ROLL_BACK_CONFIRM;
  return button;
}

function newest(
  agents: AgentRun[],
  role: AgentRun["role"],
): AgentRun | undefined {
  let found: AgentRun | undefined;
  for (const run of agents)
    if (run.role === role && (!found || run.round >= found.round)) found = run;
  return found;
}

/** What the verifier measured, in one sentence. */
function proofSentence(r: IncidentResponse): string {
  const proof = r.proof;
  let sentence = r.verdict?.reasons[0] ?? "";
  if (proof?.candidate.kind === "after-deploy")
    sentence = "The verifier is certain. The signal decides once it is out";
  else if (proof?.candidate.verdict === "passes") {
    const passed = proof.candidate.samples.filter(
      (s) => s.result === "ok",
    ).length;
    const failed = proof.baseline.samples.filter(
      (s) => s.result === "fail",
    ).length;
    sentence =
      `The verifier is certain: ${passed} of ${proof.candidate.samples.length} checks pass with the fix, ` +
      `${failed} of ${proof.baseline.samples.length} fail without it`;
  }
  const independence = newest(r.agents, "verifier")?.independence;
  if (sentence && independence && independence !== "other-provider")
    sentence += ` (${describeIndependence(independence).replace(/^Verifier · /, "")})`;
  return sentence;
}

function shell(
  card: Omit<ShellCard, "mode" | "pulse" | "body" | "buttons"> &
    Partial<Pick<ShellCard, "pulse" | "body" | "buttons">>,
): ShellCard {
  const out: ShellCard = {
    mode: "shell",
    tone: card.tone,
    pulse: card.pulse ?? false,
    eyebrow: card.eyebrow,
    headline: card.headline,
    body: card.body ?? "",
    buttons: card.buttons ?? [],
  };
  if (card.footnote) out.footnote = card.footnote;
  return out;
}

export function nextCard(input: {
  incident: Incident;
  settings: RedactedProjectSettings | null;
  primaryName: string;
  now: number;
}): NextCard {
  const { incident, settings, primaryName } = input;
  const r = incident.response;
  if (!r) return null;
  const next = r.next;

  if (next.kind === "done") {
    if (incident.state !== "resolved" || !next.options.includes("roll-back"))
      return null;
    return shell({
      tone: "green",
      eyebrow: "Fixed",
      headline: `The fix is out and ${primaryName} passes`,
      body: "Roll back if the release broke something else",
      buttons: [decisionButton("roll-back", "soft")],
    });
  }
  if (isTerminalIncidentState(incident.state)) return null;

  if (incident.state === "paused" || settings?.agentsPaused)
    return shell({
      tone: "faint",
      eyebrow: "Paused",
      headline: `Agents are paused for ${repoLabel(incident.project)}`,
      body: "Signals keep running. Nothing changes until you resume",
      buttons: [
        {
          key: "resume-agents",
          kind: "resume-agents",
          label: "Resume",
          weight: "soft",
        },
      ],
    });

  switch (next.kind) {
    case "working":
      return shell({
        tone: "yellow",
        pulse: true,
        eyebrow: `Round ${r.round} · ${PHASE_WORD[r.phase] ?? "working"}`,
        headline: next.detail,
        body: settings ? AUTONOMY_BODY[settings.autonomy] : "",
        buttons: [
          {
            key: "pause-agents",
            kind: "pause-agents",
            label: "Pause agents",
            weight: "soft",
          },
        ],
      });
    case "veto": {
      const at = clockTime(next.deadline);
      const rollback = !!r.candidate?.rollbackFirst;
      const watch = formatSpan(settings?.watchMs ?? DEFAULT_WATCH_MS);
      // A scheduled step is upcoming: steady yellow. Red is for failures
      // and the status line already carries the signal's state.
      return shell({
        tone: signalDotTone("upcoming"),
        // The time is the headline's; it is said once.
        eyebrow: "Next",
        headline: rollback ? `Rolls back at ${at}` : `Deploys the fix at ${at}`,
        body: proofSentence(r),
        // A rollback is itself the way back; only a fix promises one.
        footnote: rollback
          ? next.rule
          : `Rolls back by itself if ${primaryName} still fails ${watch} after. ${next.rule}`,
        buttons: [
          {
            key: "deploy-now",
            kind: "deploy-now",
            label: rollback
              ? "Roll back now"
              : DECISION_COPY["deploy-now"].label,
            weight: "soft",
            decision: "deploy-now",
            undoLabel: rollback ? "Undo roll back" : "Undo deploy",
            pendingLabel: rollback ? "Rolling back…" : "Deploying…",
          },
          {
            key: "stop",
            kind: "stop",
            label: DECISION_COPY.stop.label,
            weight: "danger",
            decision: "stop",
            countdownTo: next.deadline,
            doneLabel: rollback ? "Rolling back" : "Deploying",
          },
        ],
      });
    }
    case "needs-you": {
      const decisions = next.options.filter((d) => d !== "stop");
      if (decisions.length >= 2)
        return {
          mode: "choice",
          eyebrow: "Needs you",
          decisions,
          question: {
            header: "Needs you",
            question: next.reason,
            options: decisions.map((d) => DECISION_COPY[d]),
            multiSelect: false,
          },
        };
      return shell({
        tone: "blue",
        eyebrow: "Needs you",
        headline: next.reason,
        footnote: next.rule,
        buttons: next.options.map((d) =>
          decisionButton(d, d === "stop" ? "soft" : "primary"),
        ),
      });
    }
    case "watching":
      return shell({
        tone: "green",
        eyebrow: "Watching",
        headline: `Watching until ${clockTime(next.deadline)}, then it closes`,
        body: "Nothing for you to do",
        buttons: next.options.includes("roll-back")
          ? [decisionButton("roll-back", "soft")]
          : [],
      });
    case "info":
      return shell({
        tone: "faint",
        eyebrow:
          incident.state === "waiting-on-provider"
            ? "Nothing to fix on our side"
            : "Next",
        headline: next.detail,
        footnote: next.rule,
      });
  }
}

const WEIGHT_ORDER: Record<CardButton["weight"], number> = {
  soft: 0,
  danger: 1,
  primary: 2,
};

/** Soft, then danger, then primary: the owner's step sits last, at the
 *  right edge, where the eye ends. Stable within a weight. */
export function orderButtons(buttons: CardButton[]): CardButton[] {
  return buttons
    .map((button, i) => ({ button, i }))
    .sort(
      (a, b) =>
        WEIGHT_ORDER[a.button.weight] - WEIGHT_ORDER[b.button.weight] ||
        a.i - b.i,
    )
    .map(({ button }) => button);
}

/** The decision an AskCard answer picked: the answer is one option's
 *  label (case aside). Anything else is typed text, a note, and null here:
 *  "Close without action, but…" is not a vote to close. */
export function decisionFromAnswer(
  answer: string,
  decisions: OwnerDecision[],
): OwnerDecision | null {
  const text = answer.trim().toLowerCase();
  return (
    decisions.find((d) => DECISION_COPY[d].label.toLowerCase() === text) ?? null
  );
}

/** How long Stop stays pressable after the veto's deadline by this
 *  device's clock. The clocks can disagree; in the grace the server
 *  decides, and a stop that came too late is its 409. */
export const STOP_GRACE_MS = 5_000;

/** The shared deferred store's key for an incident's Deploy now. */
export function incidentDecisionKey(incidentId: string): string {
  return `incident:${incidentId}:deploy-now`;
}

/** The toast for a decision the server refused: a 409 or 400 is the
 *  server's own sentence ("Already deploying"). */
export function decisionErrorText(error: Error, label: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sign in to decide";
    if (error.status === 409 || error.status === 400 || error.status === 403)
      return error.message;
  }
  return `Couldn't ${label.toLowerCase()}: ${error.message}`;
}
