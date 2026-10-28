import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { mutate } from "swr";
import type {
  OwnerDecision,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import type { Incident, SignalView } from "../../../shared/incidents";
import type { SignalInput } from "../../lib/api/incidents";
import { useDeadlinePassed } from "../../hooks/useDeadlinePassed";
import {
  useDeferredMergeDeadline,
  useDeferredMergePhase,
} from "../../hooks/useDeferredMerge";
import { isIncidentKey } from "../../hooks/useIncidents";
import { projectSWRKey } from "../../hooks/useProjects";
import { useSecondsLeft } from "../../hooks/useSecondsLeft";
import { decideIncidentApi, updateSignalApi } from "../../lib/api/incidents";
import { updateProjectSettingsApi } from "../../lib/api/projects";
import { apiSWRKey } from "../../lib/api-swr";
import { ASK_CARD_PLATE } from "../../lib/ask-card-classes";
import { formatCountdown } from "../../lib/countdown";
import {
  cancelDeferredMergeByKey,
  MERGE_UNDO_DELAY_MS,
  scheduleDeferredMerge,
} from "../../lib/deferred-merge";
import { nextFindings } from "../../lib/incidents/findings";
import { intentPlan } from "../../lib/incidents/intent";
import {
  type CardButton,
  type ChoicePick,
  DECISION_COPY,
  decisionErrorText,
  incidentDecisionKey,
  nextCard,
  orderButtons,
  pickFromAnswer,
  type ShellCard,
  STOP_GRACE_MS,
} from "../../lib/incidents/next-action";
import { DOT_BG, incidentStateWord } from "../../lib/incidents/tone";
import {
  NEXT_AUDIT_LINK,
  NEXT_BUTTON_INERT,
  NEXT_BUTTONS,
  NEXT_EYEBROW,
} from "../../lib/incident-classes";
import { repoLabel } from "../../lib/repo-label";
import type { ProjectSectionId } from "../../lib/project-settings/page-model";
import type { SettingsSectionKey } from "../../lib/settings-sections";
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
import { NextFindingsView } from "./findings/NextFindings";
import { PlainButton } from "../../ui/plain-button";

const BUTTON_VARIANT: Record<
  CardButton["weight"],
  "primary" | "soft" | "danger"
> = { primary: "primary", soft: "soft", danger: "danger" };

/** Stop · m:ss, counting down to the end of the veto. At the deadline it
 *  drops the count and stays pressable for STOP_GRACE_MS, since this
 *  device's clock may run ahead of the server's; then it reads what is
 *  happening instead. It never shows 0:00 while still claiming to stop, and
 *  it goes `aria-disabled` rather than `disabled`, so a focused Stop keeps
 *  the focus when it flips. `onDeadline` fires once the deadline passes. */
export function StopButton({
  button,
  busy,
  onPress,
  onDeadline,
}: {
  button: CardButton;
  busy: boolean;
  onPress: () => void;
  onDeadline?: () => void;
}) {
  const deadline = Date.parse(button.countdownTo ?? "");
  const passed = useDeadlinePassed(deadline);
  const over = useDeadlinePassed(deadline + STOP_GRACE_MS);
  const seconds = useSecondsLeft(passed ? null : deadline);
  const reached = useEffectEvent(() => onDeadline?.());
  useEffect(() => {
    if (passed) reached();
  }, [passed]);
  if (over || !Number.isFinite(deadline))
    return (
      <Button
        variant="danger"
        size="lg"
        className={cn("phone:min-h-11", NEXT_BUTTON_INERT)}
        icon={<IconUndo />}
        aria-disabled
      >
        {button.doneLabel ?? "Deploying"}
      </Button>
    );
  if (passed)
    return (
      <Button
        variant="danger"
        size="lg"
        className="phone:min-h-11"
        icon={<IconUndo />}
        disabled={busy}
        onClick={onPress}
      >
        {button.label}
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
      {/* One child: the button's gap must not open around the dot too.
          Flex, so the rolling digits centre on the label's line rather
          than sit on their clipped box's bottom edge. */}
      <span className="inline-flex items-center">
        {`${button.label}\u00a0·\u00a0`}
        <CountdownDigits deadline={deadline} format="clock" />
      </span>
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
  onDeadline,
  context = null,
}: {
  card: ShellCard;
  busy: string | null;
  onButton: (button: CardButton) => void;
  scheduled?: { deadline: number | null; onUndo: () => void } | null;
  /** Opens "What the agents did". */
  onAudit?: () => void;
  /** The veto's deadline passed (Stop's countdown ended). */
  onDeadline?: () => void;
  /** What to read before deciding, above the buttons (`NextFindingsView`). */
  context?: ReactNode;
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
      <h2 className="m-0 text-dialog-title font-medium text-fg [overflow-wrap:anywhere]">
        {card.headline}
      </h2>
      {card.body && (
        <p className="m-0 text-supporting text-dim [overflow-wrap:anywhere]">
          {card.body}
        </p>
      )}
      {card.footnote && (
        <p className="m-0 mt-1 text-meta text-faint [overflow-wrap:anywhere]">
          {card.footnote}
        </p>
      )}
      {context}
      {(buttons.length > 0 || onAudit) && (
        <div className={NEXT_BUTTONS}>
          {onAudit && (
            <PlainButton className={NEXT_AUDIT_LINK} onClick={onAudit}>
              What the agents did
            </PlainButton>
          )}
          {buttons.map((button) => {
            if (button.kind === "stop")
              return (
                <StopButton
                  key={button.key}
                  button={button}
                  busy={busy === button.key}
                  onPress={() => onButton(button)}
                  onDeadline={onDeadline}
                />
              );
            if (button.kind === "deploy-now" && scheduled)
              return (
                <span key={button.key} className="flex items-center gap-1">
                  <MergeUndoControl
                    onUndo={scheduled.onUndo}
                    deadline={scheduled.deadline}
                    label={button.undoLabel ?? "Undo deploy"}
                  />
                  <Button
                    variant={BUTTON_VARIANT[button.weight]}
                    size="lg"
                    className="phone:min-h-11"
                    disabled
                  >
                    {button.pendingLabel ?? "Deploying…"}
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
  signals,
  primaryName,
  agentSessionIds,
  safety,
  onOpenSession,
  onOpenSettings,
  onOpenProjectSettings,
  intent,
  onIntentHandled,
}: {
  incident: Incident;
  settings: RedactedProjectSettings | null;
  /** Every signal with its evaluation, for what the card says about them. */
  signals?: SignalView[];
  primaryName: string;
  agentSessionIds: string[];
  /** An agent session of this incident paused for safety. */
  safety?: { sessionId: string; state: SessionSafetyState };
  onOpenSession: (sessionId: string) => void;
  /** Opens a settings section, where a setup problem is fixed. */
  onOpenSettings?: (section: SettingsSectionKey) => void;
  /** Opens a section of the incident project's settings: a step the
   *  investigator suggested. Navigation only. */
  onOpenProjectSettings?: (section: ProjectSectionId) => void;
  intent?: OwnerDecision;
  onIntentHandled: () => void;
}) {
  const card = nextCard({
    incident,
    settings,
    primaryName,
    signals,
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
  const findings = nextFindings(incident);
  const context = findings ? <NextFindingsView findings={findings} /> : null;
  const incidentKey = apiSWRKey.incident(incident.id);

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
      // The lists, the strip and the sidebar band show the decision too.
      void mutate(isIncidentKey);
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
        incidents: { agentsPaused: paused },
      });
      void mutate(apiSWRKey.incidentProject(incident.project));
      void mutate(projectSWRKey.projectSettings(incident.project));
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

  /** A stricter rule or a mute for the incident's flapping signal; its
   *  toast offers Undo, which offers none of its own. */
  const writeSignal = async (
    signalId: string,
    change: SignalInput,
    landed: string,
    key: string,
    undo: SignalInput | null,
  ) => {
    setBusy(key);
    try {
      await updateSignalApi(signalId, change);
      void mutate(apiSWRKey.incidentSignals());
      toast(
        landed,
        undo
          ? {
              action: {
                label: "Undo",
                onClick: () =>
                  void writeSignal(
                    signalId,
                    undo,
                    `Undone for ${primaryName}`,
                    key,
                    null,
                  ),
              },
            }
          : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(`Couldn't change ${primaryName}: ${message}`, {
        variant: "error",
      });
    }
    setBusy(null);
  };

  const onButton = (button: CardButton) => {
    switch (button.kind) {
      case "signal-fix":
        if (button.signalId && button.fix)
          void writeSignal(
            button.signalId,
            button.fix.patch,
            button.fix.landed,
            button.key,
            button.fix.undo,
          );
        return;
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
      case "open-settings":
        if (button.section) onOpenSettings?.(button.section);
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

  // The card asks in place for the note a decision needs (Send it back),
  // so an answer is one decision through the same route as every other:
  // a picked option, or typed text, which sends it back with that note. A
  // suggested settings step only opens the section.
  const onAnswer = async (
    answers: Record<string, string>,
    notes: Record<string, string>,
    typed: Record<string, string>,
  ) => {
    if (card?.mode !== "choice") return;
    const [question = "", answer = ""] = Object.entries(answers)[0] ?? [];
    const written = typed[question]?.trim();
    const pick: ChoicePick | null = written
      ? card.freeText
        ? { kind: "decision", decision: "send-back" }
        : null
      : pickFromAnswer(answer, card);
    let ok = false;
    if (pick?.kind === "settings") onOpenProjectSettings?.(pick.section);
    else if (pick)
      ok = await decide(
        pick.decision,
        DECISION_COPY[pick.decision].label,
        `choice:${pick.decision}`,
        written || notes[question],
      );
    // A refused answer, or a settings step, gets a fresh card to answer
    // again.
    if (!ok) setChoiceAttempt((n) => n + 1);
  };

  const handledIntent = useRef<OwnerDecision | null>(null);
  const handleIntent = useEffectEvent((wanted: OwnerDecision) => {
    if (handledIntent.current === wanted) return;
    handledIntent.current = wanted;
    const plan = intentPlan(card, wanted, incidentStateWord(incident).text, {
      rollback: !!incident.response?.candidate?.rollbackFirst,
    });
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
    // Handled once per arrival: with the intent gone from the route, the
    // same intent can come again (a second tap on the same notification).
    if (intent) handleIntent(intent);
    else handledIntent.current = null;
  }, [intent]);

  // A Deploy now still in its undo window goes when the card stops
  // offering it (the veto ended, someone else decided).
  const offersDeployNow =
    card?.mode === "shell" &&
    card.buttons.some((button) => button.kind === "deploy-now");
  useEffect(() => {
    if (!offersDeployNow && deferPhase === "scheduled")
      cancelDeferredMergeByKey(deferKey);
  }, [offersDeployNow, deferPhase, deferKey]);

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
          // Nothing to show until an agent or an action has run.
          onAudit={
            incident.response?.agents.length ||
            incident.response?.actionRuns.length
              ? () => setAuditOpen(true)
              : undefined
          }
          onDeadline={() => void mutate(incidentKey)}
          context={context}
        />
      )}
      {card?.mode === "choice" && (
        <AskCard
          key={`${incident.id}:${incident.updatedAt}:${choiceAttempt}`}
          questions={[card.question]}
          status={{ label: "Next", tone: "blue" }}
          // The reason is agent text from what it read: never markdown
          // that could load from another host.
          plainText
          freeText={card.freeText ?? false}
          notes={card.notes}
          groups={card.groups}
          context={context}
          onAnswer={(answers, notes, typed) =>
            void onAnswer(answers, notes, typed)
          }
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
