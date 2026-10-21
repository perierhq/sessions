import type * as React from "react";
import type { SignalRule } from "../../../../shared/incidents";
import { FIELD_HINT } from "../../../lib/incident-settings-classes";
import {
  type DraftField,
  defaultRule,
  RULE_KINDS_FOR,
  RULE_LABELS,
  type SignalDraft,
} from "../../../lib/incidents/signal-form";
import { FieldGrid } from "../../../ui/input";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { FormField, FormSection, NumberField } from "./FormParts";

const MINUTE_MS = 60_000;

/** "When to open an incident": the rule kind when the source allows
 *  several, then its numbers with their units in the labels. */
export function SignalRuleFields({
  draft,
  onRule,
  idFor,
}: {
  draft: SignalDraft;
  onRule: (rule: SignalRule) => void;
  idFor: (field: DraftField) => string;
}) {
  const rule = draft.rule;
  const kinds = RULE_KINDS_FOR[draft.kind];
  const id = (name: string) => `${idFor("rule")}-${name}`;
  // Each rule kind gets fresh number fields.
  const key = `${draft.kind}-${rule.kind}`;
  let numbers: React.ReactNode = null;
  if (rule.kind === "consecutive")
    numbers = (
      <FieldGrid key={key}>
        <FormField label="Failures in a row" htmlFor={id("failures")}>
          <NumberField
            id={id("failures")}
            value={rule.failures}
            min={1}
            max={50}
            onChange={(failures) => onRule({ ...rule, failures })}
          />
        </FormField>
        <FormField label="Passes to recover" htmlFor={id("recoveries")}>
          <NumberField
            id={id("recoveries")}
            value={rule.recoveries ?? 1}
            min={1}
            max={50}
            onChange={(recoveries) => onRule({ ...rule, recoveries })}
          />
        </FormField>
      </FieldGrid>
    );
  else if (rule.kind === "rate")
    numbers = (
      <FieldGrid key={key}>
        <FormField label="Failures, at least" htmlFor={id("atLeast")}>
          <NumberField
            id={id("atLeast")}
            value={rule.atLeast}
            min={1}
            onChange={(atLeast) => onRule({ ...rule, atLeast })}
          />
        </FormField>
        <FormField label="Within (min)" htmlFor={id("window")}>
          <NumberField
            id={id("window")}
            value={rule.windowMs / MINUTE_MS}
            min={1}
            onChange={(m) => onRule({ ...rule, windowMs: m * MINUTE_MS })}
          />
        </FormField>
      </FieldGrid>
    );
  else if (rule.kind === "threshold") {
    const unit = draft.kind === "http" && !draft.json?.value ? " (ms)" : "";
    numbers = (
      <FieldGrid key={key}>
        <FormField label={`Slow above${unit}`} htmlFor={id("above")}>
          <NumberField
            id={id("above")}
            value={rule.above}
            decimal
            step={0.1}
            onChange={(above) => onRule({ ...rule, above })}
          />
        </FormField>
        <FormField label="For (min)" htmlFor={id("for")}>
          <NumberField
            id={id("for")}
            value={rule.forMs / MINUTE_MS}
            min={0}
            onChange={(m) => onRule({ ...rule, forMs: m * MINUTE_MS })}
          />
        </FormField>
      </FieldGrid>
    );
  } else if (rule.kind === "deadline")
    numbers = (
      <FieldGrid key={key}>
        <FormField label="Warn at (days left)" htmlFor={id("warn")}>
          <NumberField
            id={id("warn")}
            value={rule.warnDays}
            min={1}
            max={365}
            onChange={(warnDays) => onRule({ ...rule, warnDays })}
          />
        </FormField>
        <FormField label="Fail at (days left)" htmlFor={id("fail")}>
          <NumberField
            id={id("fail")}
            value={rule.failDays}
            min={0}
            max={365}
            onChange={(failDays) => onRule({ ...rule, failDays })}
          />
        </FormField>
      </FieldGrid>
    );
  return (
    <FormSection title="When to open an incident">
      {kinds.length > 1 && (
        <Segmented
          label="When to open an incident"
          value={rule.kind}
          onValueChange={(kind) => {
            const next = kinds.find((k) => k === kind);
            if (next) onRule(defaultRule(next));
          }}
          className="self-start"
        >
          {kinds.map((kind) => (
            <SegmentedOption key={kind} value={kind}>
              {RULE_LABELS[kind]}
            </SegmentedOption>
          ))}
        </Segmented>
      )}
      {draft.kind === "heartbeat" ? (
        <p className={FIELD_HINT}>
          When a check-in is later than the schedule plus the grace
        </p>
      ) : (
        numbers
      )}
    </FormSection>
  );
}
