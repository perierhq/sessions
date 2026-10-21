import { useId, useState } from "react";
import {
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  NEVER_WITHOUT_YOU,
  type NeverWithoutYou,
  type NightRule,
  type ProjectSpend,
  type RedactedProjectSettings,
} from "../../../../shared/incident-response";
import type { ProjectSettingsInput } from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import {
  CHECK_ROW,
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
  SETTING_WIDE_CONTROL,
  SETTING_WIDE_SELECT,
} from "../../../lib/incident-settings-classes";
import { formatUsd } from "../../../lib/incidents/copy";
import {
  AUTONOMY_COPY,
  minutesOptions,
  NEVER_COPY,
  nightDescription,
  parseUsd,
  ROUND_CHOICES,
  VETO_CHOICES,
  WATCH_CHOICES,
  withCurrent,
} from "../../../lib/incidents/policy-copy";
import { repoLabel } from "../../../lib/repo-label";
import { browserTimeZone } from "../../../lib/time-of-day";
import { Badge } from "../../../ui/badge";
import { Checkbox } from "../../../ui/checkbox";
import { Field, Input } from "../../../ui/input";
import { OptionSelect } from "../../../ui/select";
import { SettingCard, SettingsGroupLabel } from "../../../ui/settings";
import { Switch } from "../../../ui/switch";
import { TimeOfDayField, TimeZoneField } from "../../../ui/time-of-day";
import { toast } from "../../../ui/toast";
import { SettingRow } from "../shared";
import { SettingLinkRow } from "./SettingLinkRow";
import { SettingsDialog } from "./SettingsDialog";

type Save = (input: ProjectSettingsInput) => Promise<void>;
type DialogKind = "night" | "never" | "per-incident" | "per-month";

const PER_INCIDENT_MAX = 1000;
const PER_MONTH_MAX = 100_000;

/** Saves a one-control change at once; a refusal is a toast, and the
 *  control falls back to the stored value. */
function saveNow(onSave: Save, input: ProjectSettingsInput) {
  onSave(input).catch((error) =>
    toast(errorMessage(error, "Couldn't save the setting"), {
      variant: "error",
    }),
  );
}

/**
 * A project's incident policy: the pause switch, what the agents may do
 * without the owner, the night rule, what always needs the owner, and the
 * budgets.
 */
export function PolicySection({
  project,
  settings,
  spend,
  onSave,
}: {
  project: string;
  settings: RedactedProjectSettings;
  spend?: ProjectSpend;
  onSave: Save;
}) {
  const label = repoLabel(project);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  // Bumped on every open, so a dialog starts from the stored values.
  const [opened, setOpened] = useState(0);
  const open = (kind: DialogKind) => {
    setOpened((n) => n + 1);
    setDialog(kind);
  };
  const close = () => setDialog(null);

  const setPaused = (paused: boolean) => {
    onSave({ agentsPaused: paused }).then(
      () =>
        toast(
          paused ? `Agents paused for ${label}` : `Agents resumed for ${label}`,
          {
            action: {
              label: "Undo",
              onClick: () => saveNow(onSave, { agentsPaused: !paused }),
            },
          },
        ),
      (error) =>
        toast(errorMessage(error, "Couldn't save the setting"), {
          variant: "error",
        }),
    );
  };

  const never = NEVER_WITHOUT_YOU.filter((item) =>
    settings.neverWithoutYou.includes(item),
  );

  return (
    <>
      <SettingCard className="mt-2">
        <SettingRow
          title="Pause all agents"
          desc={`Stops every incident run for ${label} right now. Signals keep running`}
          control={
            <Switch
              checked={settings.agentsPaused}
              onCheckedChange={setPaused}
              aria-label="Pause all agents"
            />
          }
        />
      </SettingCard>

      <SettingsGroupLabel>Autonomy</SettingsGroupLabel>
      <SettingCard>
        <SettingRow
          title="What agents may do without you"
          desc={AUTONOMY_COPY[settings.autonomy].description}
          controlClassName={SETTING_WIDE_CONTROL}
          control={
            <OptionSelect<AutonomyLevel>
              label="What agents may do without you"
              value={settings.autonomy}
              options={AUTONOMY_LEVELS.map((level) => ({
                value: level,
                label: AUTONOMY_COPY[level].label,
              }))}
              onChange={(autonomy) => saveNow(onSave, { autonomy })}
              className={SETTING_WIDE_SELECT}
            />
          }
        />
        <SettingRow
          title="Veto window"
          desc="Before a fix or a rollback goes out"
          control={
            <OptionSelect
              label="Veto window"
              value={String(settings.vetoMs)}
              options={minutesOptions(
                withCurrent(VETO_CHOICES, settings.vetoMs),
              )}
              onChange={(ms) => saveNow(onSave, { vetoMs: Number(ms) })}
            />
          }
        />
        <SettingRow
          title="Watch after a deploy"
          desc="The signal must pass this long or it rolls back by itself"
          control={
            <OptionSelect
              label="Watch after a deploy"
              value={String(settings.watchMs)}
              options={minutesOptions(
                withCurrent(WATCH_CHOICES, settings.watchMs),
              )}
              onChange={(ms) => saveNow(onSave, { watchMs: Number(ms) })}
            />
          }
        />
        <SettingRow
          title="Rounds before it asks you"
          desc="How often the verifier may send a fix back"
          control={
            <OptionSelect
              label="Rounds before it asks you"
              value={String(settings.maxRounds)}
              options={withCurrent(ROUND_CHOICES, settings.maxRounds).map(
                (n) => ({ value: String(n), label: String(n) }),
              )}
              onChange={(n) => saveNow(onSave, { maxRounds: Number(n) })}
            />
          }
        />
        <SettingLinkRow
          title="At night"
          description={nightDescription(settings.night)}
          value={settings.night ? "Propose only" : "Off"}
          onClick={() => open("night")}
        />
        <SettingLinkRow
          title="Never without you"
          description="Agents stop and ask before any of these"
          stacked
          value={
            never.length
              ? never.map((item) => (
                  <Badge key={item}>{NEVER_COPY[item]}</Badge>
                ))
              : "Nothing"
          }
          onClick={() => open("never")}
        />
      </SettingCard>

      <SettingsGroupLabel>Budget</SettingsGroupLabel>
      <SettingCard>
        <SettingLinkRow
          title="Per incident"
          description="Agents pause and ask you at the cap"
          value={formatUsd(settings.budget.perIncidentUsd, { whole: true })}
          onClick={() => open("per-incident")}
        />
        <SettingLinkRow
          title="Per month"
          description={
            spend
              ? `Across every incident in ${label}. Spent this month: ${formatUsd(spend.monthUsd)}`
              : `Across every incident in ${label}`
          }
          value={formatUsd(settings.budget.perMonthUsd, { whole: true })}
          onClick={() => open("per-month")}
        />
      </SettingCard>

      <NightDialog
        key={`night-${opened}`}
        open={dialog === "night"}
        onClose={close}
        night={settings.night}
        onSave={onSave}
      />
      <NeverDialog
        key={`never-${opened}`}
        open={dialog === "never"}
        onClose={close}
        selected={settings.neverWithoutYou}
        onSave={onSave}
      />
      <BudgetDialog
        key={`budget-${opened}`}
        open={dialog === "per-incident" || dialog === "per-month"}
        onClose={close}
        which={dialog === "per-month" ? "month" : "incident"}
        budget={settings.budget}
        onSave={onSave}
      />
    </>
  );
}

/** Save from a dialog: busy while it runs, the refusal inside the dialog,
 *  a toast and a close on success. */
function useDialogSave(onSave: Save, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (input: ProjectSettingsInput) => {
    setBusy(true);
    setError(null);
    onSave(input).then(
      () => {
        setBusy(false);
        toast("Saved");
        onClose();
      },
      (cause) => {
        setBusy(false);
        setError(errorMessage(cause, "Couldn't save the setting"));
      },
    );
  };
  return { busy, error, save };
}

function NightDialog({
  open,
  onClose,
  night,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  night: NightRule | undefined;
  onSave: Save;
}) {
  const [on, setOn] = useState(!!night);
  const [draft, setDraft] = useState<NightRule>(
    () =>
      night ?? { start: "23:00", end: "07:00", timeZone: browserTimeZone() },
  );
  const { busy, error, save } = useDialogSave(onSave, onClose);
  const toId = useId();
  const same = on && draft.start === draft.end;
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="At night"
      error={error}
      busy={busy}
      canSave={!same}
      onSave={() => save({ night: on ? draft : null })}
    >
      <label className={CHECK_ROW}>
        <span className="min-w-0 flex-1">Wait for me at night</span>
        <Switch checked={on} onCheckedChange={setOn} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <TimeOfDayField
            label="From"
            value={draft.start}
            disabled={!on}
            onChange={(start) => setDraft({ ...draft, start })}
          />
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Field label="To">
            <TimeOfDayField
              label="To"
              value={draft.end}
              disabled={!on}
              aria-describedby={same ? toId : undefined}
              aria-invalid={same || undefined}
              onChange={(end) => setDraft({ ...draft, end })}
            />
          </Field>
          {same && (
            <p id={toId} className={FIELD_ERROR}>
              Pick two different times
            </p>
          )}
        </div>
      </div>
      <Field label="Time zone">
        <TimeZoneField
          value={draft.timeZone}
          disabled={!on}
          onChange={(timeZone) => setDraft({ ...draft, timeZone })}
        />
      </Field>
      <p className={FIELD_HINT}>
        A fix waits for you between these times unless the signal is fully down
      </p>
    </SettingsDialog>
  );
}

function NeverDialog({
  open,
  onClose,
  selected,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  selected: NeverWithoutYou[];
  onSave: Save;
}) {
  const [draft, setDraft] = useState(selected);
  const { busy, error, save } = useDialogSave(onSave, onClose);
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Never without you"
      error={error}
      busy={busy}
      onSave={() =>
        save({
          neverWithoutYou: NEVER_WITHOUT_YOU.filter((item) =>
            draft.includes(item),
          ),
        })
      }
    >
      <p className={FIELD_HINT}>Agents stop and ask before any of these</p>
      <div className="flex flex-col">
        {NEVER_WITHOUT_YOU.map((item) => (
          <label key={item} className={CHECK_ROW}>
            <Checkbox
              checked={draft.includes(item)}
              onCheckedChange={(checked) =>
                setDraft(
                  checked
                    ? [...draft, item]
                    : draft.filter((other) => other !== item),
                )
              }
            />
            {NEVER_COPY[item]}
          </label>
        ))}
      </div>
    </SettingsDialog>
  );
}

export function BudgetDialog({
  open,
  onClose,
  which,
  budget,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  which: "incident" | "month";
  budget: RedactedProjectSettings["budget"];
  onSave: Save;
}) {
  const current =
    which === "incident" ? budget.perIncidentUsd : budget.perMonthUsd;
  const [text, setText] = useState(String(current));
  const { busy, error, save } = useDialogSave(onSave, onClose);
  const hintId = useId();
  const min = which === "incident" ? 0.5 : budget.perIncidentUsd;
  const max = which === "incident" ? PER_INCIDENT_MAX : PER_MONTH_MAX;
  const amount = parseUsd(text, min, max);
  const title =
    which === "incident" ? "Budget per incident" : "Budget per month";
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title={title}
      error={error}
      busy={busy}
      canSave={amount !== null}
      onSave={() => {
        if (amount === null) return;
        save({
          budget:
            which === "incident"
              ? { ...budget, perIncidentUsd: amount }
              : { ...budget, perMonthUsd: amount },
        });
      }}
    >
      <Field label="Amount in dollars">
        <Input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={0.5}
          value={text}
          aria-describedby={hintId}
          aria-invalid={amount === null || undefined}
          className={DIALOG_INPUT}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </Field>
      <p id={hintId} className={amount === null ? FIELD_ERROR : FIELD_HINT}>
        {`From ${formatUsd(min, { whole: true })} to ${formatUsd(max, { whole: true })}`}
      </p>
    </SettingsDialog>
  );
}
