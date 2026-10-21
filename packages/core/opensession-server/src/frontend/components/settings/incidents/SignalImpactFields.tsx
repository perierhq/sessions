import { DIALOG_INPUT } from "../../../lib/incident-settings-classes";
import type {
  DraftField,
  ImpactDraft,
  SignalDraft,
} from "../../../lib/incidents/signal-form";
import { cn } from "../../../ui/cn";
import { Disclosure } from "../../../ui/disclosure";
import { FieldGrid, Input } from "../../../ui/input";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { OptionSelect } from "../../../ui/select";
import { FormField, HeaderRows } from "./FormParts";

const EMPTY_IMPACT: ImpactDraft = {
  kind: "none",
  url: "",
  headers: [],
  countPath: "",
  peoplePath: "",
  count: "fail-events",
  noun: "",
  label: "",
};

/** Where an incident's impact is counted (the status line's "~140
 *  searches failed for 23 people"). */
export function SignalImpactFields({
  draft,
  onImpact,
  errorOf,
  describe,
  idFor,
}: {
  draft: SignalDraft;
  onImpact: (impact: ImpactDraft) => void;
  errorOf: (field: DraftField) => string | null;
  describe: (field: DraftField) => string | undefined;
  idFor: (field: DraftField) => string;
}) {
  const impact = draft.impact ?? EMPTY_IMPACT;
  const set = (patch: Partial<ImpactDraft>) =>
    onImpact({ ...impact, ...patch });
  const kinds: Array<{ value: ImpactDraft["kind"]; label: string }> = [
    { value: "none", label: "Not counted" },
    { value: "http", label: "From a URL" },
  ];
  if (draft.kind === "webhook")
    kinds.push({ value: "events", label: "From the events" });
  const input = (
    field: DraftField,
    value: string,
    onText: (value: string) => void,
    placeholder?: string,
    mono = false,
  ) => (
    <Input
      id={idFor(field)}
      value={value}
      placeholder={placeholder}
      aria-invalid={!!errorOf(field) || undefined}
      aria-describedby={describe(field)}
      autoComplete="off"
      spellCheck={false}
      className={cn(DIALOG_INPUT, mono && "font-mono")}
      onChange={(event) => onText(event.currentTarget.value)}
    />
  );
  return (
    <Disclosure title="Impact" defaultOpen={impact.kind !== "none"}>
      <div className="flex flex-col gap-4">
        <FormField label="Count it">
          <OptionSelect<ImpactDraft["kind"]>
            label="Count it"
            value={impact.kind}
            options={kinds}
            onChange={(kind) => set({ kind })}
            className="w-full justify-between phone:min-h-11"
          />
        </FormField>
        {impact.kind !== "none" && (
          <FieldGrid>
            <FormField
              label="What the number counts"
              htmlFor={idFor("impactNoun")}
              error={errorOf("impactNoun")}
              messageId={describe("impactNoun")}
            >
              {input(
                "impactNoun",
                impact.noun,
                (noun) => set({ noun }),
                "searches failed",
              )}
            </FormField>
            <FormField
              label="Where it is counted"
              htmlFor={idFor("impactLabel")}
              error={errorOf("impactLabel")}
              messageId={describe("impactLabel")}
            >
              {input(
                "impactLabel",
                impact.label,
                (label) => set({ label }),
                "the request log",
              )}
            </FormField>
          </FieldGrid>
        )}
        {impact.kind === "http" && (
          <>
            <FormField
              label="URL"
              htmlFor={idFor("impactUrl")}
              error={errorOf("impactUrl")}
              hint="{{since}} is when the incident opened"
              messageId={`${idFor("impactUrl")}-message`}
            >
              {input(
                "impactUrl",
                impact.url,
                (url) => set({ url }),
                "https://",
                true,
              )}
            </FormField>
            <FieldGrid>
              <FormField
                label="Count path"
                htmlFor={idFor("impactCountPath")}
                error={errorOf("impactCountPath")}
                messageId={describe("impactCountPath")}
              >
                {input(
                  "impactCountPath",
                  impact.countPath,
                  (countPath) => set({ countPath }),
                  "$.failed",
                  true,
                )}
              </FormField>
              <FormField
                label="People path"
                htmlFor={idFor("impactPeoplePath")}
              >
                <Input
                  id={idFor("impactPeoplePath")}
                  value={impact.peoplePath}
                  placeholder="Optional, like $.users"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(DIALOG_INPUT, "font-mono")}
                  onChange={(event) =>
                    set({ peoplePath: event.currentTarget.value })
                  }
                />
              </FormField>
            </FieldGrid>
            <FormField label="Headers">
              <HeaderRows
                idPrefix={idFor("impactHeaders")}
                rows={impact.headers}
                onChange={(headers) => set({ headers })}
                error={errorOf("impactHeaders")}
              />
            </FormField>
          </>
        )}
        {impact.kind === "events" && (
          <FormField label="Count">
            <Segmented
              label="Count"
              value={impact.count}
              onValueChange={(count) =>
                set({
                  count: count === "value-sum" ? "value-sum" : "fail-events",
                })
              }
              className="self-start"
            >
              <SegmentedOption value="fail-events">
                Failed events
              </SegmentedOption>
              <SegmentedOption value="value-sum">Sum of values</SegmentedOption>
            </Segmented>
          </FormField>
        )}
      </div>
    </Disclosure>
  );
}
