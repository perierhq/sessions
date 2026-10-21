import type * as React from "react";
import { useId, useState } from "react";
import type {
  MaintenanceWindow,
  SignalView,
} from "../../../../shared/incidents";
import { updateSignalApi } from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import {
  CHECK_ROW,
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
  WINDOW_ROW,
  WINDOW_ROW_TEXT,
} from "../../../lib/incident-settings-classes";
import {
  dayLabel,
  describeWindow,
  isoToLocalInput,
  localInputToIso,
  MAX_NOTE,
  MAX_WINDOWS,
  newOnceWindow,
  newWeeklyWindow,
  type ProjectWindow,
  projectWindows,
  signalWindows,
  WEEK_ORDER,
  windowProblem,
  windowsChanged,
} from "../../../lib/incidents/maintenance-form";
import { repoLabel } from "../../../lib/repo-label";
import { browserTimeZone } from "../../../lib/time-of-day";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { cn } from "../../../ui/cn";
import { FieldGrid, Input } from "../../../ui/input";
import { TimeOfDayField, TimeZoneField } from "../../../ui/time-of-day";
import { toast } from "../../../ui/toast";
import { FormField } from "./FormParts";
import { SettingsDialog } from "./SettingsDialog";

const DOWNTIME_COPY =
  "Planned downtime doesn't open incidents. Checks still run and are recorded";

/**
 * One window's fields: days, times and zone for a weekly window, a start
 * and an end for a one-time window, and a note. What is wrong with it shows
 * under the field it is about.
 */
export function WindowFields({
  window: w,
  onChange,
}: {
  window: MaintenanceWindow;
  onChange: (next: MaintenanceWindow) => void;
}) {
  const id = useId();
  const problem = windowProblem(w);
  const messageId = `${id}-problem`;
  const dayProblem = problem === "Pick at least one day";
  const message = problem ? (
    <p id={messageId} className={FIELD_ERROR}>
      {problem}
    </p>
  ) : null;
  const note = (
    <FormField label="Note" htmlFor={`${id}-note`}>
      <Input
        id={`${id}-note`}
        value={w.note ?? ""}
        maxLength={MAX_NOTE}
        placeholder="Optional, like Database upgrade"
        className={DIALOG_INPUT}
        onChange={(event) => {
          const text = event.currentTarget.value;
          const next = { ...w };
          if (text) next.note = text;
          else delete next.note;
          onChange(next);
        }}
      />
    </FormField>
  );

  if (w.kind === "once")
    return (
      <div className="flex flex-col gap-3">
        <FieldGrid>
          <FormField label="From" htmlFor={`${id}-start`}>
            <Input
              id={`${id}-start`}
              type="datetime-local"
              step={60}
              value={isoToLocalInput(w.start)}
              className={cn("tabular-nums", DIALOG_INPUT)}
              onChange={(event) => {
                const start = localInputToIso(event.currentTarget.value);
                if (start) onChange({ ...w, start });
              }}
            />
          </FormField>
          <FormField label="To" htmlFor={`${id}-end`}>
            <Input
              id={`${id}-end`}
              type="datetime-local"
              step={60}
              value={isoToLocalInput(w.end)}
              aria-invalid={!!problem || undefined}
              aria-describedby={problem ? messageId : undefined}
              className={cn("tabular-nums", DIALOG_INPUT)}
              onChange={(event) => {
                const end = localInputToIso(event.currentTarget.value);
                if (end) onChange({ ...w, end });
              }}
            />
          </FormField>
        </FieldGrid>
        {message}
        {note}
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <FormField label="Days">
        <div
          className="flex flex-wrap gap-x-4"
          role="group"
          aria-label="Days"
          aria-describedby={dayProblem ? messageId : undefined}
        >
          {WEEK_ORDER.map((day) => (
            <label key={day} className={CHECK_ROW}>
              <Checkbox
                checked={w.days.includes(day)}
                onCheckedChange={(on) =>
                  onChange({
                    ...w,
                    days: on
                      ? [...w.days, day].sort((a, b) => a - b)
                      : w.days.filter((d) => d !== day),
                  })
                }
              />
              {dayLabel(day)}
            </label>
          ))}
        </div>
        {dayProblem && message}
      </FormField>
      <FieldGrid>
        <FormField label="From">
          <TimeOfDayField
            label="From"
            value={w.start}
            onChange={(start) => onChange({ ...w, start })}
          />
        </FormField>
        <FormField label="To">
          <TimeOfDayField
            label="To"
            value={w.end}
            aria-invalid={(!!problem && !dayProblem) || undefined}
            aria-describedby={problem && !dayProblem ? messageId : undefined}
            onChange={(end) => onChange({ ...w, end })}
          />
          {!dayProblem && message}
        </FormField>
      </FieldGrid>
      <FormField label="Time zone">
        <TimeZoneField
          value={w.timeZone}
          onChange={(timeZone) => onChange({ ...w, timeZone })}
        />
      </FormField>
      {note}
    </div>
  );
}

/** The two add buttons, disabled at the limit with the reason beside. */
function AddWindowButtons({
  count,
  onAdd,
}: {
  count: number;
  onAdd: (window: MaintenanceWindow) => void;
}) {
  const full = count >= MAX_WINDOWS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="soft"
        size="sm"
        className="phone:min-h-11"
        disabled={full}
        onClick={() => onAdd(newWeeklyWindow(browserTimeZone()))}
      >
        Add a weekly window
      </Button>
      <Button
        type="button"
        variant="soft"
        size="sm"
        className="phone:min-h-11"
        disabled={full}
        onClick={() => onAdd(newOnceWindow(Date.now()))}
      >
        Add a one-time window
      </Button>
      {full && <span className={FIELD_HINT}>20 windows at most</span>}
    </div>
  );
}

/** One window in a list: what it says, then Edit and Remove; its fields
 *  open under it. */
function WindowRow({
  window: w,
  detail,
  editing,
  onEdit,
  onRemove,
  children,
}: {
  window: MaintenanceWindow;
  detail?: string;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  children?: React.ReactNode;
}) {
  const problem = windowProblem(w);
  return (
    <li className="flex flex-col gap-3">
      <div className={WINDOW_ROW}>
        <span className={WINDOW_ROW_TEXT}>
          <span className="block text-body text-fg">{describeWindow(w)}</span>
          {(w.note || detail) && (
            <span className="mt-0.5 block text-meta text-dim">
              {[w.note, detail].filter(Boolean).join(" · ")}
            </span>
          )}
          {problem && !editing && (
            <span className="mt-0.5 block text-meta text-red">{problem}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 desktop:min-h-8"
            aria-expanded={editing}
            onClick={onEdit}
          >
            {editing ? "Done" : "Edit"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 desktop:min-h-8"
            onClick={onRemove}
          >
            Remove
          </Button>
        </span>
      </div>
      {editing && children}
    </li>
  );
}

/** A signal's maintenance windows, inside the signal editor. */
export function MaintenanceWindowsEditor({
  windows,
  onChange,
}: {
  windows: MaintenanceWindow[];
  onChange: (windows: MaintenanceWindow[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {windows.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {windows.map((w, i) => (
            <WindowRow
              // Windows have no id; position is the identity.
              key={i}
              window={w}
              editing={editing === i}
              onEdit={() => setEditing(editing === i ? null : i)}
              onRemove={() => {
                onChange(windows.filter((_, j) => j !== i));
                setEditing(null);
              }}
            >
              <WindowFields
                window={w}
                onChange={(next) =>
                  onChange(windows.map((other, j) => (j === i ? next : other)))
                }
              />
            </WindowRow>
          ))}
        </ul>
      )}
      <AddWindowButtons
        count={windows.length}
        onAdd={(window) => {
          onChange([...windows, window]);
          setEditing(windows.length);
        }}
      />
      <p className={FIELD_HINT}>{DOWNTIME_COPY}</p>
    </div>
  );
}

/** Write each changed signal in turn; stop at the first refusal. */
async function saveInTurn(
  changes: Array<{
    id: string;
    name: string;
    maintenance: MaintenanceWindow[];
  }>,
): Promise<{
  saved: string[];
  failed: { name: string; message: string } | null;
}> {
  const saved: string[] = [];
  for (const change of changes) {
    const result = await updateSignalApi(change.id, {
      maintenance: change.maintenance,
    }).then(
      () => null,
      (error) => errorMessage(error, "Couldn't save"),
    );
    if (result !== null)
      return { saved, failed: { name: change.name, message: result } };
    saved.push(change.name);
  }
  return { saved, failed: null };
}

/**
 * The project's maintenance windows: every window of its signals, identical
 * ones shown once with the signals they apply to. Saving writes each signal
 * whose windows changed, one after another.
 */
export function ProjectMaintenanceDialog({
  open,
  onClose,
  project,
  signals,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  /** The project's signals. */
  signals: SignalView[];
  onSaved: () => void;
}) {
  const [groups, setGroups] = useState<ProjectWindow[]>(() =>
    projectWindows(signals),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(signals.map((s) => [s.id, s.name]));
  const allIds = signals.map((s) => s.id);
  const plan = signalWindows(signals, groups);
  const over = plan.find((p) => p.maintenance.length > MAX_WINDOWS);
  const invalid =
    groups.some((g) => windowProblem(g.window) !== null) ||
    groups.some((g) => g.signalIds.length === 0);

  const update = (i: number, patch: Partial<ProjectWindow>) =>
    setGroups(groups.map((g, j) => (j === i ? { ...g, ...patch } : g)));

  const save = () => {
    const changes = plan.filter((p) =>
      windowsChanged(
        signals.find((s) => s.id === p.id)?.maintenance,
        p.maintenance,
      ),
    );
    if (!changes.length) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    void saveInTurn(changes).then(({ saved, failed }) => {
      setBusy(false);
      if (saved.length) onSaved();
      if (failed) {
        setError(
          `Couldn't save ${failed.name}: ${failed.message}${saved.length ? `. Saved: ${saved.join(", ")}` : ""}`,
        );
        return;
      }
      toast("Saved");
      onClose();
    });
  };

  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Maintenance windows"
      error={
        error ??
        (over
          ? `${over.name} would have more than ${MAX_WINDOWS} windows`
          : null)
      }
      busy={busy}
      canSave={!invalid && !over}
      onSave={save}
    >
      <p className={FIELD_HINT}>
        {`${DOWNTIME_COPY}. They apply to the signals of ${repoLabel(project)} you pick`}
      </p>
      {groups.length === 0 && (
        <p className="m-0 text-body text-dim">None planned</p>
      )}
      {groups.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {groups.map((group, i) => (
            <WindowRow
              // Groups have no id; position is the identity.
              key={i}
              window={group.window}
              detail={
                group.signalIds.length === allIds.length
                  ? "Every signal"
                  : group.signalIds.map((id) => names.get(id) ?? id).join(", ")
              }
              editing={editing === i}
              onEdit={() => setEditing(editing === i ? null : i)}
              onRemove={() => {
                setGroups(groups.filter((_, j) => j !== i));
                setEditing(null);
              }}
            >
              <WindowFields
                window={group.window}
                onChange={(window) => update(i, { window })}
              />
              <FormField
                label="Applies to"
                error={
                  group.signalIds.length ? null : "Pick at least one signal"
                }
              >
                <div className="flex flex-col">
                  {signals.map((signal) => (
                    <label key={signal.id} className={CHECK_ROW}>
                      <Checkbox
                        checked={group.signalIds.includes(signal.id)}
                        onCheckedChange={(on) =>
                          update(i, {
                            signalIds: on
                              ? [...group.signalIds, signal.id]
                              : group.signalIds.filter(
                                  (id) => id !== signal.id,
                                ),
                          })
                        }
                      />
                      <span className="min-w-0 truncate">{signal.name}</span>
                    </label>
                  ))}
                </div>
              </FormField>
            </WindowRow>
          ))}
        </ul>
      )}
      <AddWindowButtons
        count={groups.length}
        onAdd={(window) => {
          setGroups([...groups, { window, signalIds: allIds }]);
          setEditing(groups.length);
        }}
      />
    </SettingsDialog>
  );
}
