// What the incident's next-action card says and offers, from plan 2's
// `response.next`. Soft for the optional action, danger "Stop" for a veto,
// primary only when the next step is the owner's. Pure.
import { DECISION_COPY } from "../../../shared/incident-decision-copy";
import {
  closesWhenRecovered,
  RECOVERED_CLOSE_MS,
  recoveredCloseAt,
} from "../../../shared/incident-recovery";
import {
  type AgentRun,
  type AutonomyLevel,
  describeIndependence,
  type IncidentResponse,
  type NextStep,
  type NextStepTarget,
  type OwnerDecision,
  type RedactedProjectSettings,
  type ResponsePhase,
  SEND_BACK_NOTE_MAX,
  type SetupFix,
} from "../../../shared/incident-response";
import {
  type Incident,
  isTerminalIncidentState,
  type SignalState,
  type SignalView,
} from "../../../shared/incidents";
import { ApiError } from "../api/request";
import type { ProjectSectionId } from "../project-settings/page-model";
import { repoLabel } from "../repo-label";
import { clockTime } from "../time";
import type {
  AskFreeText,
  AskNoteField,
  AskOptionGroup,
  AskQuestion,
} from "../types";
import { formatSpan } from "./copy";
import { type DotTone, signalDotTone } from "./tone";

export { DECISION_COPY };

export type CardButtonKind =
  | "decision"
  | "deploy-now"
  | "stop"
  | "pause-agents"
  | "resume-agents"
  | "open-settings";

export interface CardButton {
  key: string;
  kind: CardButtonKind;
  label: string;
  weight: "primary" | "soft" | "danger";
  decision?: OwnerDecision;
  /** Open settings: the section where a setup problem is fixed. */
  section?: SetupFix;
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

/** What picking a choice card's option does: post a decision, or only
 *  open a project settings section. */
export type ChoicePick =
  | { kind: "decision"; decision: OwnerDecision }
  | { kind: "settings"; section: ProjectSectionId };

export interface ChoiceCard {
  mode: "choice";
  eyebrow: string;
  question: AskQuestion;
  decisions: OwnerDecision[];
  /** The options that need a note, by label (Send it back): the card asks
   *  for it in a labelled field once that option is picked. A suggested
   *  send-back starts with the investigator's note. */
  notes: Record<string, AskNoteField>;
  /** What each option does, by label. */
  picks: Record<string, ChoicePick>;
  /** The investigator's suggested steps first, then the fixed decisions,
   *  set smaller. Absent without suggestions. */
  groups?: AskOptionGroup[];
  /** The typed answer: Send it back with that note. Null when Send it
   *  back is not offered. */
  freeText: AskFreeText | null;
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

/** The button that opens where a setup problem is fixed. */
const FIX_LABEL: Record<SetupFix, string> = {
  sandboxes: "Set up a sandbox",
  providers: "Set up a model provider",
};

/** A signal that has not recovered, after "<name> ". */
const STILL: Partial<Record<SignalState, string>> = {
  failing: "is still failing",
  slow: "is still slow",
  flaky: "is still flaky",
  external: "is still down at its provider",
  upcoming: "is still due soon",
};

/**
 * What the incident's own signals say now, for an incident that closes by
 * itself once they recover (`closesWhenRecovered`): still failing, or
 * passing again and when the incident closes. Null for any other incident,
 * or before the signals have loaded.
 */
export function recoveryLine(
  incident: Incident,
  signals: SignalView[],
  now: number,
): string | null {
  if (!closesWhenRecovered(incident)) return null;
  const find = (id: string) => signals.find((s) => s.id === id);
  const own = incident.signalIds.flatMap((id) => {
    const signal = find(id);
    return signal && !signal.provider ? [signal] : [];
  });
  const primary = find(incident.primarySignalId);
  const watched = own.length ? own : primary ? [primary] : [];
  if (!watched.length) return null;
  const closes = `The incident closes by itself ${formatSpan(RECOVERED_CLOSE_MS)} after it recovers`;
  const bad = watched.find((s) => s.evaluation?.state !== "ok");
  if (bad) {
    const state = bad.evaluation?.state;
    const still = (state && STILL[state]) ?? "has no recent checks";
    return `${bad.name} ${still}. ${closes}`;
  }
  const since = Math.max(
    ...watched.map((s) => Date.parse(s.evaluation?.since ?? "")),
  );
  const who =
    watched.length === 1
      ? `${watched[0]!.name} is`
      : `All ${watched.length} signals are`;
  // Passing since before it opened: it never recovered, so it does not
  // close by itself.
  if (!(since >= Date.parse(incident.openedAt))) return `${who} passing`;
  const at = new Date(since).toISOString();
  const closeAt = recoveredCloseAt(since);
  const when =
    closeAt > now ? `at ${clockTime(new Date(closeAt).toISOString())}` : "soon";
  return `${who} passing again since ${clockTime(at)}. The incident closes by itself ${when} if it stays green`;
}

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
  /** Every signal with its evaluation, for an incident that closes by
   *  itself once they recover. */
  signals?: SignalView[];
  now: number;
}): NextCard {
  const { incident, settings, primaryName } = input;
  const r = incident.response;
  if (!r) return null;
  const next = r.next;
  const recovery = recoveryLine(incident, input.signals ?? [], input.now);

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
      footnote: recovery ?? undefined,
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
      // Agents never started: say where it is fixed and what the signals
      // say now, since the incident may close by itself.
      if (next.needsYou === "setup" || recovery) {
        const fix = next.needsYou === "setup" ? next.fix : undefined;
        const buttons: CardButton[] = decisions.map((d) =>
          decisionButton(
            d,
            d === "retry" && next.needsYou === "setup" ? "primary" : "soft",
          ),
        );
        if (fix)
          buttons.push({
            key: `settings:${fix}`,
            kind: "open-settings",
            label: FIX_LABEL[fix],
            weight: "primary",
            section: fix,
          });
        return shell({
          tone: "blue",
          eyebrow: "Needs you",
          headline: next.reason,
          body: recovery ?? "",
          footnote: next.rule,
          buttons,
        });
      }
      const suggested = suggestedSteps(r, decisions);
      if (decisions.length >= 2 || (suggested.length && decisions.length))
        return choiceCard(next.reason, decisions, suggested);
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

/** Where an `open-settings` step goes in the project's settings. */
export const NEXT_STEP_SECTION: Record<NextStepTarget, ProjectSectionId> = {
  access: "access",
  production: "production",
  signals: "incidents",
  models: "models",
  sandbox: "where",
};

/** The label over the investigator's suggested steps. */
export const SUGGESTED_LABEL = "Suggested by the investigator";

/** The typed answer on a card that offers Send it back. */
export const TELL_INVESTIGATOR: AskFreeText = {
  label: "Tell the investigator",
  placeholder: "Tell the investigator…",
  maxLength: SEND_BACK_NOTE_MAX,
};

interface SuggestedStep {
  option: { label: string; description: string };
  pick: ChoicePick;
  note?: AskNoteField;
}

/**
 * The newest investigator's suggested next steps for this round, as card
 * options. A step whose decision the card does not offer is left out, and
 * so is one whose title repeats an option's label.
 */
export function suggestedSteps(
  r: IncidentResponse,
  decisions: readonly OwnerDecision[],
): SuggestedStep[] {
  const run = newest(r.agents, "investigator");
  const report = run?.report;
  if (!run || run.round !== r.round || report?.role !== "investigator")
    return [];
  const taken = new Set(
    decisions.map((d) => DECISION_COPY[d].label.toLowerCase()),
  );
  const out: SuggestedStep[] = [];
  for (const step of report.nextSteps ?? []) {
    const made = stepOption(step, decisions);
    const key = step.title.trim().toLowerCase();
    if (!made || !key || taken.has(key)) continue;
    taken.add(key);
    out.push(made);
  }
  return out;
}

function stepOption(
  step: NextStep,
  decisions: readonly OwnerDecision[],
): SuggestedStep | null {
  const option = { label: step.title.trim(), description: step.why };
  switch (step.kind) {
    case "send-back":
      if (!decisions.includes("send-back")) return null;
      return {
        option,
        pick: { kind: "decision", decision: "send-back" },
        note: { ...DECISION_NOTE["send-back"]!, initial: step.payload },
      };
    case "close-provider":
      if (!decisions.includes("close")) return null;
      return { option, pick: { kind: "decision", decision: "close" } };
    case "open-settings": {
      const section = NEXT_STEP_SECTION[step.payload];
      return section ? { option, pick: { kind: "settings", section } } : null;
    }
    default:
      return null;
  }
}

/** The needs-you choice card: suggested steps first, then the decisions. */
function choiceCard(
  reason: string,
  decisions: OwnerDecision[],
  suggested: SuggestedStep[],
): ChoiceCard {
  const picks: Record<string, ChoicePick> = {};
  const notes: Record<string, AskNoteField> = {};
  for (const s of suggested) {
    picks[s.option.label] = s.pick;
    if (s.note) notes[s.option.label] = s.note;
  }
  for (const d of decisions)
    picks[DECISION_COPY[d].label] = { kind: "decision", decision: d };
  const card: ChoiceCard = {
    mode: "choice",
    eyebrow: "Needs you",
    decisions,
    question: {
      header: "Needs you",
      question: reason,
      options: [
        ...suggested.map((s) => s.option),
        ...decisions.map((d) => DECISION_COPY[d]),
      ],
      multiSelect: false,
    },
    notes: { ...notes, ...decisionNotes(decisions) },
    picks,
    freeText: decisions.includes("send-back") ? TELL_INVESTIGATOR : null,
  };
  if (suggested.length)
    card.groups = [
      { label: SUGGESTED_LABEL, count: suggested.length },
      { count: decisions.length, quiet: true },
    ];
  return card;
}

/** What a choice card's answer picked: the answer is one option's label
 *  (case aside). Null for anything else. */
export function pickFromAnswer(
  answer: string,
  card: Pick<ChoiceCard, "picks">,
): ChoicePick | null {
  const text = answer.trim().toLowerCase();
  const label = Object.keys(card.picks).find((l) => l.toLowerCase() === text);
  return label ? card.picks[label]! : null;
}

/** The decisions that carry a note, and the field that asks for it. The
 *  server refuses Send it back without one; nothing else takes a note. */
export const DECISION_NOTE: Partial<Record<OwnerDecision, AskNoteField>> = {
  "send-back": {
    label: "Note for the investigator",
    placeholder: "What should it look at or try differently?",
    maxLength: SEND_BACK_NOTE_MAX,
  },
};

/** The note fields of a choice card's options, keyed by option label. */
export function decisionNotes(decisions: readonly OwnerDecision[]) {
  return Object.fromEntries(
    decisions.flatMap((d) => {
      const field = DECISION_NOTE[d];
      return field ? [[DECISION_COPY[d].label, field] as const] : [];
    }),
  );
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
