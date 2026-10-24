import type * as React from "react";
import { useState } from "react";
import type {
  ProjectReadiness,
  ReadinessFix,
  ReadinessStep,
} from "../../../../shared/project-settings";
import {
  CHECKLIST_BLOCKED_MARK,
  CHECKLIST_FIX,
  CHECKLIST_FOLD,
  CHECKLIST_FOLD_SUMMARY,
  CHECKLIST_FOLD_TOGGLE,
  CHECKLIST_HEAD,
  CHECKLIST_MARK,
  CHECKLIST_READY_MARK,
  CHECKLIST_ROW,
  CHECKLIST_SEGMENT,
  CHECKLIST_SEGMENTS,
  CHECKLIST_STEP_DETAIL,
  CHECKLIST_STEP_TITLE,
  CHECKLIST_SUB,
  CHECKLIST_TEXT,
  CHECKLIST_TITLE,
  CHECKLIST_TODO_MARK,
} from "../../../lib/project-settings-classes";
import {
  checklistModel,
  fixLabel,
  stepSummary,
} from "../../../lib/project-settings/page-model";
import { Button } from "../../../ui/button";
import { cn } from "../../../ui/cn";
import { SettingCard } from "../../../ui/settings";
import { IconCheck, IconChevronDown } from "../../icons";
import { PlainButton } from "../../../ui/plain-button";

/**
 * The first card on a project page: what stands between the project and
 * incident agents that can act, in step order on the bar and to-dos first
 * in the list. One fix is the screen's ink button; while a step blocks, the
 * other to-dos fold into "N more to do" so it stays the only one.
 */
export function ReadinessChecklist({
  project,
  readiness,
  onFix,
  connectForm,
}: {
  project: string;
  readiness: ProjectReadiness;
  onFix: (fix: ReadinessFix) => void;
  /** Shown under the blocking step when its fix is connecting a sandbox;
   *  it carries the ink button itself. */
  connectForm?: React.ReactNode;
}) {
  const model = checklistModel(readiness, project);
  const [openTodo, setOpenTodo] = useState(false);
  const [openReady, setOpenReady] = useState(false);
  const allReady = !model.rows.length && !model.collapsedTodo.length;

  const step = (s: ReadinessStep, primary: boolean) => (
    <div key={`${s.id}-${s.title}`} className={CHECKLIST_ROW}>
      <span className={CHECKLIST_MARK} aria-hidden>
        <StepMark state={s.state} />
      </span>
      <div className={CHECKLIST_TEXT}>
        <div className={CHECKLIST_STEP_TITLE}>{s.title}</div>
        <div className={CHECKLIST_STEP_DETAIL}>{s.detail}</div>
      </div>
      {s.fix && s.fix.kind === "connect-sandbox" && connectForm
        ? connectForm
        : s.fix && (
            <Button
              type="button"
              size="sm"
              variant={primary ? "primary" : "soft"}
              className={CHECKLIST_FIX}
              onClick={() => onFix(s.fix!)}
            >
              {fixLabel(s.fix)}
            </Button>
          )}
    </div>
  );

  return (
    <SettingCard>
      <div className={CHECKLIST_HEAD}>
        <div className="min-w-0">
          <h2 className={CHECKLIST_TITLE}>{model.title}</h2>
          {model.subtitle && <p className={CHECKLIST_SUB}>{model.subtitle}</p>}
        </div>
        <div
          className={CHECKLIST_SEGMENTS}
          role="img"
          aria-label={`${readiness.readyCount} of ${readiness.total} steps ready`}
        >
          {model.segments.map((state, i) => (
            <span
              // The bar is fixed: one segment per step, in step order.
              // oxlint-disable-next-line react/no-array-index-key
              key={i}
              className={CHECKLIST_SEGMENT[state]}
            />
          ))}
        </div>
      </div>
      {model.rows.map((s) => step(s, s === model.primary))}
      {model.collapsedTodo.length > 0 && (
        <div>
          <Fold
            mark="todo"
            title={`${model.collapsedTodo.length} more to do`}
            summary={stepSummary(model.collapsedTodo)}
            open={openTodo}
            onToggle={() => setOpenTodo(!openTodo)}
          />
          {openTodo && model.collapsedTodo.map((s) => step(s, false))}
        </div>
      )}
      {!allReady && model.collapsedReady.length > 0 && (
        <div>
          <Fold
            mark="ready"
            title={`${model.collapsedReady.length} ready`}
            summary={stepSummary(model.collapsedReady)}
            open={openReady}
            onToggle={() => setOpenReady(!openReady)}
          />
          {openReady && model.collapsedReady.map((s) => step(s, false))}
        </div>
      )}
    </SettingCard>
  );
}

function StepMark({ state }: { state: ReadinessStep["state"] }) {
  if (state === "blocked")
    return <span className={CHECKLIST_BLOCKED_MARK}>!</span>;
  if (state === "ready")
    return (
      <span className={CHECKLIST_READY_MARK}>
        <IconCheck size={14} dense />
      </span>
    );
  return <span className={CHECKLIST_TODO_MARK} />;
}

function Fold({
  mark,
  title,
  summary,
  open,
  onToggle,
}: {
  mark: "todo" | "ready";
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <PlainButton
      className={CHECKLIST_FOLD}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className={CHECKLIST_MARK} aria-hidden>
        <StepMark state={mark} />
      </span>
      <span className={CHECKLIST_STEP_TITLE}>{title}</span>
      <span className={CHECKLIST_FOLD_SUMMARY}>{summary}</span>
      <span className={CHECKLIST_FOLD_TOGGLE}>
        <span className="phone:hidden">{open ? "Hide" : "Show"}</span>
        <IconChevronDown
          size={16}
          dense
          className={cn("transition-transform", open && "rotate-180")}
        />
      </span>
    </PlainButton>
  );
}
