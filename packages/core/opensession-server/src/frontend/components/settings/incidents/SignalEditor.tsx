import type * as React from "react";
import { useId, useState } from "react";
import {
  SEVERITIES,
  type Severity,
  type SignalSourceKind,
  type SignalView,
} from "../../../../shared/incidents";
import {
  createSignalApi,
  deleteSignalApi,
  type ProductionRunnerView,
  updateSignalApi,
} from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import {
  CHECK_ROW,
  DIALOG_INPUT,
  FIELD_ERROR,
  FIELD_HINT,
} from "../../../lib/incident-settings-classes";
import {
  type DraftField,
  defaultDraft,
  draftFromSignal,
  draftSource,
  draftToInput,
  GRACE_CHOICES,
  HEARTBEAT_INTERVALS,
  hookUrl,
  INTERVALS,
  intervalOptions,
  KIND_LABELS,
  SEVERITY_LABELS,
  type SignalDraft,
  switchKind,
  TIMEOUT_CHOICES,
  withMapping,
} from "../../../lib/incidents/signal-form";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { cn } from "../../../ui/cn";
import { useConfirm } from "../../../ui/confirm";
import { Disclosure } from "../../../ui/disclosure";
import { FieldGrid, Input, Textarea } from "../../../ui/input";
import { Segmented, SegmentedOption } from "../../../ui/segmented";
import { OptionSelect } from "../../../ui/select";
import { Switch } from "../../../ui/switch";
import { toast } from "../../../ui/toast";
import { CopyUrl, FormField, HeaderRows } from "./FormParts";
import type { JsonDocument } from "../../../lib/incidents/mapping-preview";
import { JsonMappingPreview } from "./JsonMappingPreview";
import { MaintenanceWindowsEditor } from "./MaintenanceWindowsEditor";
import { SettingsDialog } from "./SettingsDialog";
import { SignalImpactFields } from "./SignalImpactFields";
import { SignalRuleFields } from "./SignalRuleFields";

const MINUTE_MS = 60_000;
const KINDS: SignalSourceKind[] = ["http", "webhook", "heartbeat", "expiry"];
const METHODS = ["GET", "HEAD", "POST"] as const;

/**
 * Add or edit one signal. Opens as a dialog on a desktop and a sheet on a
 * phone; Save sends the whole signal, Delete (stored signals) asks first.
 * A new webhook or check-in stays open after its first save, so its URL can
 * be copied.
 */
export function SignalEditor({
  open,
  onClose,
  project,
  signal,
  runners,
  signals,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: string;
  signal: SignalView | null;
  /** The project's bound production Runners. */
  runners: ProductionRunnerView[];
  /** The project's signals, for "Depends on". */
  signals: SignalView[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<SignalDraft>(() =>
    signal ? draftFromSignal(signal) : defaultDraft("http", project),
  );
  const [fieldError, setFieldError] = useState<{
    field: DraftField;
    error: string;
  } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The mapping preview's sample: kept here so it outlives a kind switch
  // back and forth, never saved.
  const [sample, setSample] = useState<JsonDocument | undefined>(undefined);
  const [confirm, confirmDialog] = useConfirm();
  const idBase = useId();
  const idFor = (field: DraftField) => `${idBase}-${field}`;

  const change = (next: SignalDraft) => {
    setDraft(next);
    setFieldError(null);
  };

  const save = () => {
    const result = draftToInput(draft);
    if ("field" in result) {
      setFieldError(result);
      document.getElementById(idFor(result.field))?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    const id = draft.id;
    const pending = id
      ? updateSignalApi(id, result.input)
      : createSignalApi(result.input);
    pending.then(
      (saved) => {
        setBusy(false);
        onSaved();
        const showUrl =
          !id &&
          (saved.source.kind === "webhook" ||
            saved.source.kind === "heartbeat");
        toast(id ? "Signal saved" : "Signal added");
        if (showUrl) setDraft(draftFromSignal(saved));
        else onClose();
      },
      (error) => {
        setBusy(false);
        setServerError(errorMessage(error, "Couldn't save the signal"));
      },
    );
  };

  const remove = () => {
    const id = draft.id;
    if (!id) return;
    confirm({
      title: `Delete ${draft.name || "this signal"}?`,
      description: "Its incidents keep their history. Checks stop right away",
      confirmLabel: "Delete",
      destructive: true,
      onConfirm: () =>
        deleteSignalApi(id).then(
          () => {
            onSaved();
            toast("Signal deleted");
            onClose();
          },
          (error) =>
            setServerError(errorMessage(error, "Couldn't delete the signal")),
        ),
    });
  };

  return (
    <>
      <SettingsDialog
        open={open}
        onClose={onClose}
        title={signal ? `Edit ${signal.name}` : "New signal"}
        error={serverError}
        busy={busy}
        onSave={save}
        wide
        leading={
          draft.id ? (
            <Button type="button" variant="danger" onClick={remove}>
              Delete
            </Button>
          ) : null
        }
      >
        <SignalEditorFields
          draft={draft}
          onChange={change}
          error={fieldError}
          idFor={idFor}
          runners={runners}
          others={signals.filter(
            (other) => other.project === project && other.id !== draft.id,
          )}
          sample={sample}
          onSample={setSample}
        />
      </SettingsDialog>
      {confirmDialog}
    </>
  );
}

/**
 * The editor's fields, as data in and edits out: what to watch, how, when
 * it opens an incident, its impact, and the rarer settings under More.
 */
export function SignalEditorFields({
  draft,
  onChange,
  error,
  idFor,
  runners,
  others,
  sample,
  onSample = () => {},
}: {
  draft: SignalDraft;
  onChange: (next: SignalDraft) => void;
  error: { field: DraftField; error: string } | null;
  idFor: (field: DraftField) => string;
  runners: ProductionRunnerView[];
  others: SignalView[];
  /** The JSON mapping preview's sample. */
  sample?: JsonDocument;
  onSample?: (doc: JsonDocument) => void;
}) {
  const set = (patch: Partial<SignalDraft>) => onChange({ ...draft, ...patch });
  const errorOf = (field: DraftField) =>
    error?.field === field ? error.error : null;
  const describe = (field: DraftField) =>
    error?.field === field ? `${idFor(field)}-message` : undefined;
  const text = (
    field: DraftField,
    value: string,
    onText: (value: string) => void,
    props: React.ComponentProps<typeof Input> = {},
  ) => (
    <Input
      id={idFor(field)}
      value={value}
      aria-invalid={error?.field === field || undefined}
      aria-describedby={describe(field)}
      autoComplete="off"
      spellCheck={false}
      {...props}
      className={cn(DIALOG_INPUT, props.className)}
      onChange={(event) => onText(event.currentTarget.value)}
    />
  );

  return (
    <>
      <FormField
        label="Name"
        htmlFor={idFor("name")}
        error={errorOf("name")}
        messageId={describe("name")}
      >
        {text("name", draft.name, (name) => set({ name }), {
          placeholder: "Search",
        })}
      </FormField>
      <FormField label="What to watch">
        <OptionSelect<SignalSourceKind>
          label="What to watch"
          value={draft.kind}
          options={KINDS.map((kind) => ({
            value: kind,
            label: KIND_LABELS[kind],
          }))}
          onChange={(kind) => onChange(switchKind(draft, kind))}
          className="w-full justify-between phone:min-h-11"
        />
      </FormField>

      {draft.kind === "http" && (
        <>
          <FormField
            label="URL"
            htmlFor={idFor("url")}
            error={errorOf("url")}
            messageId={describe("url")}
          >
            {text("url", draft.url, (url) => set({ url }), {
              type: "url",
              inputMode: "url",
              placeholder: "https://",
              className: "font-mono",
            })}
          </FormField>
          <FieldGrid>
            <FormField label="Method">
              <Segmented
                className="self-start"
                label="Method"
                value={draft.method}
                onValueChange={(method) =>
                  set({
                    method: METHODS.find((m) => m === method) ?? draft.method,
                  })
                }
              >
                <SegmentedOption value="GET">GET</SegmentedOption>
                <SegmentedOption value="HEAD">HEAD</SegmentedOption>
                <SegmentedOption value="POST">POST</SegmentedOption>
              </Segmented>
            </FormField>
            <FormField label="Check every">
              <OptionSelect
                label="Check every"
                value={String(draft.intervalMs)}
                options={intervalOptions(INTERVALS.http, draft.intervalMs)}
                onChange={(ms) => set({ intervalMs: Number(ms) })}
                className="w-full justify-between phone:min-h-11"
              />
            </FormField>
          </FieldGrid>
          <FormField label="Headers">
            <HeaderRows
              idPrefix={idFor("headers")}
              rows={draft.headers}
              onChange={(headers) => set({ headers })}
              error={errorOf("headers")}
            />
          </FormField>
          {draft.method === "POST" && (
            <FormField label="Body" htmlFor={idFor("body")}>
              <Textarea
                id={idFor("body")}
                value={draft.body}
                rows={4}
                spellCheck={false}
                className={cn("font-mono", DIALOG_INPUT)}
                onChange={(event) => set({ body: event.currentTarget.value })}
              />
            </FormField>
          )}
          <FieldGrid>
            <FormField
              label="Expected status"
              htmlFor={idFor("expectStatus")}
              error={errorOf("expectStatus")}
              messageId={describe("expectStatus")}
            >
              {text(
                "expectStatus",
                draft.expectStatus,
                (expectStatus) => set({ expectStatus }),
                { placeholder: "Any 2xx", inputMode: "numeric" },
              )}
            </FormField>
            <FormField label="Timeout">
              <OptionSelect
                label="Timeout"
                value={String(draft.timeoutMs)}
                options={intervalOptions(TIMEOUT_CHOICES, draft.timeoutMs)}
                onChange={(ms) => set({ timeoutMs: Number(ms) })}
                className="w-full justify-between phone:min-h-11"
              />
            </FormField>
          </FieldGrid>
          {draft.method !== "HEAD" && (
            <FieldGrid>
              <FormField label="Body must contain" htmlFor={idFor("contains")}>
                {text("contains", draft.contains, (contains) =>
                  set({ contains }),
                )}
              </FormField>
              <FormField
                label="Body must match (regex)"
                htmlFor={idFor("regex")}
              >
                {text("regex", draft.regex, (regex) => set({ regex }), {
                  className: "font-mono",
                })}
              </FormField>
            </FieldGrid>
          )}
        </>
      )}

      {draft.kind === "webhook" && (
        <FormField
          label="Where to send events"
          hint={
            draft.hookPath
              ? "POST JSON here. The mapping below decides what each event means"
              : undefined
          }
        >
          {draft.hookPath ? (
            <CopyUrl url={hookUrl(draft.hookPath)} label="the webhook URL" />
          ) : (
            <p className={FIELD_HINT}>Save to get the URL</p>
          )}
        </FormField>
      )}

      {draft.kind === "heartbeat" && (
        <>
          <FieldGrid>
            <FormField label="Expected">
              <Segmented
                className="self-start"
                label="Schedule"
                value={draft.schedule}
                onValueChange={(schedule) =>
                  set({ schedule: schedule === "cron" ? "cron" : "every" })
                }
              >
                <SegmentedOption value="every">Every</SegmentedOption>
                <SegmentedOption value="cron">Cron</SegmentedOption>
              </Segmented>
            </FormField>
            {draft.schedule === "every" ? (
              <FormField label="Every">
                <OptionSelect
                  label="Every"
                  value={String(draft.everyMs)}
                  options={intervalOptions(HEARTBEAT_INTERVALS, draft.everyMs)}
                  onChange={(ms) => set({ everyMs: Number(ms) })}
                  className="w-full justify-between phone:min-h-11"
                />
              </FormField>
            ) : (
              <FormField
                label="Cron schedule"
                htmlFor={idFor("cron")}
                error={errorOf("cron")}
                hint="Five fields, in UTC"
                messageId={`${idFor("cron")}-message`}
              >
                {text("cron", draft.cron, (cron) => set({ cron }), {
                  placeholder: "0 3 * * *",
                  className: "font-mono",
                  "aria-describedby": `${idFor("cron")}-message`,
                })}
              </FormField>
            )}
          </FieldGrid>
          <FormField label="Grace">
            <OptionSelect
              label="Grace"
              value={String(draft.graceMs)}
              options={GRACE_CHOICES.map((ms) => ({
                value: String(ms),
                label: ms ? `${ms / MINUTE_MS} min` : "None",
              }))}
              onChange={(ms) => set({ graceMs: Number(ms) })}
              className="w-full justify-between phone:min-h-11"
            />
          </FormField>
          <FormField label="Check-in URL">
            {draft.hookPath ? (
              <CopyUrl url={hookUrl(draft.hookPath)} label="the check-in URL" />
            ) : (
              <p className={FIELD_HINT}>Save to get the URL</p>
            )}
          </FormField>
          {draft.hookPath && (
            <FormField label="Failure URL" hint="Call this to report a failure">
              <CopyUrl
                url={`${hookUrl(draft.hookPath)}/fail`}
                label="the failure URL"
              />
            </FormField>
          )}
        </>
      )}

      {draft.kind === "expiry" && (
        <>
          <FieldGrid>
            <FormField
              label="Host"
              htmlFor={idFor("host")}
              error={errorOf("host")}
              messageId={describe("host")}
            >
              {text("host", draft.host, (host) => set({ host }), {
                placeholder: "acme.example.test",
                inputMode: "url",
              })}
            </FormField>
            <FormField
              label="Port"
              htmlFor={idFor("port")}
              error={errorOf("port")}
              messageId={describe("port")}
            >
              {text("port", draft.port, (port) => set({ port }), {
                inputMode: "numeric",
              })}
            </FormField>
          </FieldGrid>
          <FormField label="Check every">
            <OptionSelect
              label="Check every"
              value={String(draft.intervalMs)}
              options={intervalOptions(INTERVALS.expiry, draft.intervalMs)}
              onChange={(ms) => set({ intervalMs: Number(ms) })}
              className="w-full justify-between phone:min-h-11"
            />
          </FormField>
        </>
      )}

      <SignalRuleFields
        draft={draft}
        onRule={(rule) => set({ rule })}
        idFor={idFor}
      />

      <SignalImpactFields
        draft={draft}
        onImpact={(impact) => set({ impact })}
        errorOf={errorOf}
        describe={describe}
        idFor={idFor}
      />

      {((draft.kind === "http" && draft.method !== "HEAD") ||
        draft.kind === "webhook") && (
        <Disclosure
          title="JSON mapping"
          defaultOpen={
            !!(draft.kind === "http" ? draft.json : draft.webhookMapping)
          }
        >
          <JsonMappingPreview
            kind={draft.kind}
            source={draftSource(draft)}
            signalId={draft.id}
            provider={draft.provider}
            mapping={draft.kind === "http" ? draft.json : draft.webhookMapping}
            onChange={(mapping) =>
              onChange(
                draft.kind === "http"
                  ? withMapping(draft, "json", mapping)
                  : withMapping(draft, "webhookMapping", mapping),
              )
            }
            sample={sample}
            onSample={onSample}
          />
        </Disclosure>
      )}

      <Disclosure
        title="Maintenance windows"
        defaultOpen={draft.maintenance.length > 0}
      >
        <div className="flex flex-col gap-2">
          <MaintenanceWindowsEditor
            windows={draft.maintenance}
            onChange={(maintenance) => set({ maintenance })}
          />
          {errorOf("maintenance") && (
            <p id={describe("maintenance")} className={FIELD_ERROR}>
              {errorOf("maintenance")}
            </p>
          )}
        </div>
      </Disclosure>

      <Disclosure title="More">
        <div className="flex flex-col gap-4">
          <FormField label="Severity">
            <Segmented
              className="self-start"
              label="Severity"
              value={draft.severity}
              onValueChange={(severity) =>
                set({
                  severity:
                    SEVERITIES.find((s) => s === severity) ?? draft.severity,
                })
              }
            >
              {SEVERITIES.map((severity: Severity) => (
                <SegmentedOption key={severity} value={severity}>
                  {SEVERITY_LABELS[severity]}
                </SegmentedOption>
              ))}
            </Segmented>
          </FormField>
          <div className="flex flex-col">
            <label className={CHECK_ROW}>
              <span className="min-w-0 flex-1">
                This is a provider's status page
              </span>
              <Switch
                checked={draft.provider}
                onCheckedChange={(provider) =>
                  set({
                    provider,
                    selfReported: provider ? false : draft.selfReported,
                  })
                }
              />
            </label>
            <label className={CHECK_ROW}>
              <span className="min-w-0 flex-1">
                This is our own status endpoint
              </span>
              <Switch
                checked={draft.selfReported}
                onCheckedChange={(selfReported) =>
                  set({
                    selfReported,
                    provider: selfReported ? false : draft.provider,
                  })
                }
              />
            </label>
            <label className={CHECK_ROW}>
              <span className="min-w-0 flex-1">Enabled</span>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => set({ enabled })}
              />
            </label>
          </div>
          {others.length > 0 && (
            <FormField
              label="Depends on"
              hint="While one of these fails, this signal opens no incident of its own"
            >
              <div className="flex flex-col">
                {others.map((other) => (
                  <label key={other.id} className={CHECK_ROW}>
                    <Checkbox
                      checked={draft.dependsOn.includes(other.id)}
                      onCheckedChange={(checked) =>
                        set({
                          dependsOn: checked
                            ? [...draft.dependsOn, other.id]
                            : draft.dependsOn.filter((id) => id !== other.id),
                        })
                      }
                    />
                    <span className="min-w-0 truncate">{other.name}</span>
                  </label>
                ))}
              </div>
            </FormField>
          )}
          {draft.kind === "http" && (
            <FormField
              label="Check from"
              hint="Checks that depend on IP or TLS fingerprint should run from production"
            >
              <OptionSelect
                label="Check from"
                value={draft.runOn}
                options={[
                  { value: "", label: "This server" },
                  ...runners.map((runner) => ({
                    value: runner.id,
                    label: runner.label || runner.name,
                  })),
                ]}
                onChange={(runOn) => set({ runOn })}
                className="w-full justify-between phone:min-h-11"
              />
            </FormField>
          )}
        </div>
      </Disclosure>
    </>
  );
}
