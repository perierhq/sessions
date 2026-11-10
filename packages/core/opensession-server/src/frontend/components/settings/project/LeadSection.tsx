import { useState } from "react";
import {
  MAX_LEAD_BUDGET_USD,
  type LeadCategory,
  type LeadLevel,
  isLeadStage,
  type ProjectLeadPatch,
} from "../../../../shared/project-lead";
import type { ProjectSettingsView } from "../../../../shared/project-settings";
import {
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
  SETTING_SELECT,
  SETTING_SWITCH_HIT,
  SETTING_WIDE_CONTROL,
} from "../../../lib/incident-settings-classes";
import { formatUsd } from "../../../lib/incidents/copy";
import { parseUsd } from "../../../lib/incidents/policy-copy";
import {
  LEAD_LEVEL_OPTIONS,
  LEAD_STAGE_OPTIONS,
  LEAD_STATUS_LABELS,
  leadRuleRows,
  leadSaveErrorText,
  leadStageHelp,
  leadStatus,
} from "../../../lib/project-settings/lead-model";
import type { ProjectPatchBody } from "../../../lib/project-settings/save";
import { Field, Input } from "../../../ui/input";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { OptionSelect } from "../../../ui/select";
import {
  SettingCard,
  SettingsGroupLabel,
  StatusChip,
} from "../../../ui/settings";
import { InlineAlert } from "../../../ui/state";
import { Switch } from "../../../ui/switch";
import { SettingLinkRow } from "../incidents/SettingLinkRow";
import { SettingsDialog } from "../incidents/SettingsDialog";
import { SettingRow } from "../shared";

const ALWAYS_ONLY_YOU = "Always only you";

/**
 * The project lead's charter: on or off, its stage, its monthly budget, who
 * it answers to, and who decides each kind of action. A refusal (a change
 * that gives the lead more room from someone who may not, or a stale
 * revision) shows above the controls.
 */
export function LeadSection({
  view,
  onSave,
}: {
  view: ProjectSettingsView;
  onSave: (body: ProjectPatchBody) => Promise<void>;
}) {
  const lead = view.document.lead;
  const [error, setError] = useState<string | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(0);

  // Immediate saves report a refusal above the section; the budget dialog
  // calls `onSave` itself and shows its refusal inside, so it shows once.
  const saveNow = (patch: ProjectLeadPatch) => {
    setError(null);
    onSave({ lead: patch }).catch((cause) => {
      setError(leadSaveErrorText(cause));
    });
  };
  const status = leadStatus(lead);

  return (
    <>
      {error && (
        <InlineAlert className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}
      <SettingCard>
        <SettingRow
          title="Lead"
          desc="Watches this project and reports to your supervisor"
          control={
            <div className="flex items-center gap-3">
              <StatusChip
                label={LEAD_STATUS_LABELS[status]}
                dot={status === "off" ? "var(--text-faint)" : "var(--green)"}
              />
              <Switch
                checked={lead.enabled}
                onCheckedChange={(on) => saveNow({ enabled: on })}
                aria-label="Lead"
                className={SETTING_SWITCH_HIT}
              />
            </div>
          }
        />
      </SettingCard>
      {lead.enabled && (
        <>
          <SettingCard className="mt-3">
            <SettingRow
              title="Stage"
              desc={leadStageHelp(lead.stage)}
              controlClassName={SETTING_WIDE_CONTROL}
              control={
                <Segmented
                  label="Lead stage"
                  value={lead.stage}
                  onValueChange={(value) => {
                    if (isLeadStage(value) && value !== lead.stage)
                      saveNow({ stage: value });
                  }}
                >
                  {LEAD_STAGE_OPTIONS.map((o) => (
                    <SegmentedOption
                      key={o.value}
                      value={o.value}
                      className="phone:min-h-11"
                    >
                      {o.label}
                    </SegmentedOption>
                  ))}
                </Segmented>
              }
            />
            <SettingLinkRow
              title="Budget per month"
              description="The lead stops and asks you at the cap"
              value={formatUsd(lead.budgetUsdPerMonth, { whole: true })}
              onClick={() => setBudgetOpen(Date.now())}
            />
            <SettingRow
              title="Owner"
              desc="The person the lead answers to"
              control={
                <span className="text-label text-dim">
                  {lead.owner ?? "The instance owner"}
                </span>
              }
            />
          </SettingCard>
          <SettingsGroupLabel>Rules</SettingsGroupLabel>
          <SettingCard>
            {leadRuleRows(lead).map((row) => (
              <SettingRow
                key={row.category}
                title={row.label}
                control={
                  row.pinned ? (
                    <span className="text-label text-dim">
                      {ALWAYS_ONLY_YOU}
                    </span>
                  ) : (
                    <OptionSelect<LeadLevel>
                      label={`Who decides: ${row.label}`}
                      value={row.level}
                      options={LEAD_LEVEL_OPTIONS}
                      onChange={(level) =>
                        saveNow({ rules: ruleChange(row.category, level) })
                      }
                      className={SETTING_SELECT}
                    />
                  )
                }
              />
            ))}
          </SettingCard>
          <LeadBudgetDialog
            key={budgetOpen}
            open={budgetOpen > 0}
            onClose={() => setBudgetOpen(0)}
            budget={lead.budgetUsdPerMonth}
            onSave={(amount) => onSave({ lead: { budgetUsdPerMonth: amount } })}
          />
        </>
      )}
    </>
  );
}

function ruleChange(
  category: LeadCategory,
  level: LeadLevel,
): Partial<Record<LeadCategory, LeadLevel>> {
  const rules: Partial<Record<LeadCategory, LeadLevel>> = {};
  rules[category] = level;
  return rules;
}

export function LeadBudgetDialog({
  open,
  onClose,
  budget,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  budget: number;
  onSave: (amount: number) => Promise<void>;
}) {
  const [text, setText] = useState(String(budget));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = parseUsd(text, 0, MAX_LEAD_BUDGET_USD);
  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title="Lead budget per month"
      error={error}
      busy={busy}
      canSave={amount !== null}
      onSave={() => {
        if (amount === null) return;
        setBusy(true);
        setError(null);
        onSave(amount).then(
          () => {
            setBusy(false);
            onClose();
          },
          (cause) => {
            setBusy(false);
            setError(leadSaveErrorText(cause));
          },
        );
      }}
    >
      <Field label="Amount in dollars">
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          max={MAX_LEAD_BUDGET_USD}
          step={1}
          value={text}
          aria-invalid={amount === null || undefined}
          className={DIALOG_INPUT}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </Field>
      <p className={amount === null ? FIELD_ERROR : FIELD_HINT}>
        {`From $0 to ${formatUsd(MAX_LEAD_BUDGET_USD, { whole: true })}`}
      </p>
    </SettingsDialog>
  );
}
