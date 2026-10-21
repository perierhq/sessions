import { useEffect, useEffectEvent, useRef, useState } from "react";
import { mutate } from "swr";
import type {
  OwnerDecision,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { useDeadlinePassed } from "../../hooks/useDeadlinePassed";
import {
  useDeferredMergeDeadline,
  useDeferredMergePhase,
} from "../../hooks/useDeferredMerge";
import { useSecondsLeft } from "../../hooks/useSecondsLeft";
import {
  decideIncidentApi,
  updateProjectSettingsApi,
} from "../../lib/api/incidents";
import { apiSWRKey } from "../../lib/api-swr";
import { ASK_CARD_PLATE } from "../../lib/ask-card-classes";
import { formatCountdown } from "../../lib/countdown";
import {
  cancelDeferredMergeByKey,
  MERGE_UNDO_DELAY_MS,
  scheduleDeferredMerge,
} from "../../lib/deferred-merge";
import { intentPlan } from "../../lib/incidents/intent";
import {
  type CardButton,
  DECISION_COPY,
  decisionErrorText,
  decisionFromAnswer,
  incidentDecisionKey,
  nextCard,
  orderButtons,
  type ShellCard,
} from "../../lib/incidents/next-action";
import { DOT_BG, incidentStateWord } from "../../lib/incidents/tone";
import {
  NEXT_AUDIT_LINK,
  NEXT_BUTTONS,
  NEXT_EYEBROW,
} from "../../lib/incident-classes";
import { repoLabel } from "../../lib/repo-label";
import type { SessionSafetyState } from "../../lib/types";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { useConfirm } from "../../ui/confirm";
import { CountdownDigits } from "../../ui/countdown";
import { PulseDot } from "../../ui/status";
import { toast } from "../../ui/toast";
import { AskCard } from "../AskCard";
import { CredentialRegistrationCard } from "../CredentialRegistrationCard";
import { IconUndo } from "../icons";
import { KeychainAskCard } from "../KeychainAskCard";
import { MergeUndoControl } from "../pr/MergeUndoControl";
import { SessionSafetyNotice } from "../SessionSafetyNotice";
import { AgentAuditSheet } from "./AgentAuditSheet";

const BUTTON_VARIANT: Record<
  CardButton["weight"],
  "primary" | "soft" | "danger"
> = { primary: "primary", soft: "soft", danger: "danger" };

/** Stop · m:ss, counting down to the end of the veto. At the deadline it
 *  disables and says what is happening instead; it never shows 0:00 while
 *  still claiming to stop. */
function StopButton({
  button,
  busy,
  onPress,
}: {
  button: CardButton;
  busy: boolean;
  onPress: () => void;
}) {
  const deadline = Date.parse(button.countdownTo ?? "");
  const passed = useDeadlinePassed(deadline);
  const seconds = useSecondsLeft(passed ? null : deadline);
  if (passed || !Number.isFinite(deadline))
    return (
      <Button
        variant="danger"
        size="lg"
        className="phone:min-h-11"
        icon={<IconUndo />}
        disabled
      >
        {button.doneLabel ?? "Deploying"}
      </Button>
    );
  const left = formatCountdown(seconds ?? 1, "clock");
  return (
    <Button
      variant="danger"
      size="lg"
      className="phone:min-h-11"
      icon={<IconUndo />}
      disabled={busy}
      aria-label={`${button.label}, ${left} left`}
      onClick={onPress}
    >
      {button.label} · <CountdownDigits deadline={deadline} format="clock" />
    </Button>
  );
}

/**
 * The next-action card in the ask-card plate: what happens next, why, and
 * the owner's buttons. Presentational. `scheduled` is a Deploy now waiting
 * out its undo window.
 */
export function NextActionView({
  card,
  busy,
  onButton,
  scheduled = null,
  onAudit,
}: {
  card: ShellCard;
  busy: string | null;
  onButton: (button: CardButton) => void;
  scheduled?: { deadline: number | null; onUndo: () => void } | null;
  /** Opens "What the agents did". */
  onAudit?: () => void;
}) {
  const buttons = orderButtons(card.buttons);
  return (
    <section className={cn(ASK_CARD_PLATE, "gap-1")}>
      <div className={NEXT_EYEBROW}>
        {card.pulse ? (
          <PulseDot size={8} />
        ) : (
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", DOT_BG[card.tone])}
          />
        )}
        <span className="min-w-0 truncate">{card.eyebrow}</span>
      </div>
      <h2 className="m-0 text-item-title font-medium text-fg [overflow-wrap:anywhere]">
        {card.headline}
      </h2>
      {card.body && (
        <p className="m-0 text-body text-dim [overflow-wrap:anywhere]">
          {card.body}
        </p>
      )}
      {card.footnote && (
        <p className="m-0 mt-1 text-meta text-faint [overflow-wrap:anywhere]">
          {card.footnote}
        </p>
      )}
      {(buttons.length > 0 || onAudit) && (
        <div className={NEXT_BUTTONS}>
          {onAudit && (
            <button type="button" className={NEXT_AUDIT_LINK} onClick={onAudit}>
              What the agents did
            </button>
          )}
          {buttons.map((button) => {
            if (button.kind === "stop")
              return (
                <StopButton
                  key={button.key}
                  button={button}
                  busy={busy === button.key}
                  onPress={() => onButton(button)}
                />
              );
            if (button.kind === "deploy-now" && scheduled)
              return (
                <span key={button.key} className="flex items-center gap-1">
                  <MergeUndoControl
                    onUndo={scheduled.onUndo}
                    deadline={scheduled.deadline}
                    label="Undo deploy"
                  />
                  <Button
                    variant={BUTTON_VARIANT[button.weight]}
                    size="lg"
                    className="phone:min-h-11"
                    disabled
                  >
                    Deploying…
                  </Button>
                </span>
              );
            return (
              <Button
                key={button.key}
                variant={BUTTON_VARIANT[button.weight]}
                size="lg"
                className="phone:min-h-11"
                disabled={busy === button.key}
                onClick={() => onButton(button)}
              >
                {button.label}
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * The incident's next action: the card from `nextCard`, the decisions it
 * posts, Pause agents through the project settings, the choice card for
 * several ways forward, the agent sessions' own asks above it, and the push
 * intent's confirm.
 */
export function NextAction({
  incident,
  settings,
  primaryName,
  agentSessionIds,
  safety,
  onOpenSession,
  intent,
  onIntentHandled,
}: {
  incident: Incident;
  settings: RedactedProjectSettings | null;
  primaryName: string;
  agentSessionIds: string[];
  /** An agent session of this incident paused for safety. */
  safety?: { sessionId: string; state: SessionSafetyState };
  onOpenSession: (sessionId: string) => void;
  intent?: OwnerDecision;
  onIntentHandled: () => void;
}) {
  const card = nextCard({
    incident,
    settings,
    primaryName,
    now: Date.now(),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [choiceAttempt, setChoiceAttempt] = useState(0);
  const [confirm, confirmDialog] = useConfirm();
  const deferKey = incidentDecisionKey(incident.id);
  const deferPhase = useDeferredMergePhase(deferKey);
  const deferDeadline = useDeferredMergeDeadline(deferKey);
  const project = repoLabel(incident.project);
  const incidentKey = apiSWRKey.incident(incident.id);
  const investigatorSession = incident.response?.agents
    .filter((run) => run.role === "investigator")
    .at(-1)?.sessionId;

  const decide = async (
    decision: OwnerDecision,
    label: string,
    key: string,
    note?: string,
  ): Promise<boolean> => {
    setBusy(key);
    let ok = false;
    // No `finally`: the React Compiler cannot lower it. Both paths below
    // fall through to the one reset, so a button never stays busy.
    try {
      const updated = await decideIncidentApi(incident.id, decision, note);
      await mutate(incidentKey, updated, { revalidate: false });
      ok = true;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      toast(decisionErrorText(failure, label), { variant: "error" });
      void mutate(incidentKey);
    }
    setBusy(null);
    return ok;
  };

  const writePaused = async (
    paused: boolean,
    key: string,
    undoable: boolean,
  ) => {
    setBusy(key);
    try {
      await updateProjectSettingsApi(incident.project, {
        agentsPaused: paused,
      });
      void mutate(apiSWRKey.incidentProject(incident.project));
      toast(
        paused
          ? `Agents paused for ${project}`
          : `Agents resumed for ${project}`,
        undoable
          ? {
              action: {
                label: "Undo",
                onClick: () => void writePaused(!paused, key, false),
              },
            }
          : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(`Couldn't ${paused ? "pause" : "resume"} agents: ${message}`, {
        variant: "error",
      });
    }
    setBusy(null);
  };

  const onButton = (button: CardButton) => {
    switch (button.kind) {
      case "stop":
        void decide("stop", button.label, button.key);
        return;
      case "deploy-now":
        scheduleDeferredMerge(
          deferKey,
          () => decide("deploy-now", button.label, button.key),
          MERGE_UNDO_DELAY_MS,
        );
        return;
      case "pause-agents":
        void writePaused(true, button.key, true);
        return;
      case "resume-agents":
        void writePaused(false, button.key, true);
        return;
      case "decision": {
        const decision = button.decision;
        if (!decision) return;
        if (button.confirm)
          confirm({
            ...button.confirm,
            onConfirm: () => void decide(decision, button.label, button.key),
          });
        else void decide(decision, button.label, button.key);
      }
    }
  };

  const onAnswer = async (answers: Record<string, string>) => {
    if (card?.mode !== "choice") return;
    const answer = Object.values(answers)[0] ?? "";
    const decision = decisionFromAnswer(answer, card.decisions);
    let ok = true;
    if (decision)
      ok = await decide(
        decision,
        DECISION_COPY[decision].label,
        `choice:${decision}`,
      );
    else if (card.decisions.includes("send-back"))
      ok = await decide(
        "send-back",
        DECISION_COPY["send-back"].label,
        "choice:send-back",
        answer.trim(),
      );
    else {
      ok = false;
      const open = investigatorSession;
      toast(
        "Pick one of the options. Notes to the agents go in the investigator's session",
        open
          ? { action: { label: "Open", onClick: () => onOpenSession(open) } }
          : {},
      );
    }
    // A refused answer gets a fresh card to answer again.
    if (!ok) setChoiceAttempt((n) => n + 1);
  };

  const handledIntent = useRef<OwnerDecision | null>(null);
  const handleIntent = useEffectEvent((wanted: OwnerDecision) => {
    if (handledIntent.current === wanted) return;
    handledIntent.current = wanted;
    const plan = intentPlan(card, wanted, incidentStateWord(incident).text);
    if (plan.kind === "confirm")
      confirm({
        title: plan.title,
        description: plan.description,
        confirmLabel: plan.confirmLabel,
        onConfirm: () =>
          void decide(
            plan.decision,
            plan.confirmLabel,
            `intent:${plan.decision}`,
          ),
      });
    else toast(plan.message);
    onIntentHandled();
  });
  useEffect(() => {
    if (intent) handleIntent(intent);
  }, [intent]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {agentSessionIds.map((id) => (
        <div key={id} className="contents">
          <CredentialRegistrationCard sessionId={id} />
          <KeychainAskCard sessionId={id} />
        </div>
      ))}
      {safety && (
        <SessionSafetyNotice
          safety={safety.state}
          onContinue={() => onOpenSession(safety.sessionId)}
        />
      )}
      {card?.mode === "shell" && (
        <NextActionView
          card={card}
          busy={busy}
          onButton={onButton}
          scheduled={
            deferPhase === "idle"
              ? null
              : {
                  deadline: deferDeadline,
                  onUndo: () => cancelDeferredMergeByKey(deferKey),
                }
          }
          onAudit={incident.response ? () => setAuditOpen(true) : undefined}
        />
      )}
      {card?.mode === "choice" && (
        <AskCard
          key={`${incident.id}:${incident.updatedAt}:${choiceAttempt}`}
          questions={[card.question]}
          status={{ label: "Next", tone: "blue" }}
          onAnswer={(answers) => void onAnswer(answers)}
        />
      )}
      {incident.response && (
        <AgentAuditSheet
          incidentId={incident.id}
          open={auditOpen}
          onClose={() => setAuditOpen(false)}
          onOpenSession={onOpenSession}
        />
      )}
      {confirmDialog}
    </div>
  );
}
