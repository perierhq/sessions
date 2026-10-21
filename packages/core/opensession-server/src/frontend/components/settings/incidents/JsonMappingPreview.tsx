import { useId, useState } from "react";
import { validateJsonMapping } from "../../../../shared/incidents-json-mapping";
import {
  type JsonMapping,
  type ObservationResult,
  type SignalSource,
  STATUS_PAGE_PRESET_HINTS,
  STATUS_PAGE_PRESETS,
  type StatusPagePreset,
} from "../../../../shared/incidents";
import { testSignalApi } from "../../../lib/api/incidents";
import { errorMessage } from "../../../lib/error-message";
import {
  CHECK_ROW,
  DIALOG_INPUT,
  FIELD_ERROR,
  MAPPING_FOUND_LIST,
  MAPPING_FOUND_ROW,
  MAPPING_PREVIEW,
  MAPPING_RAW,
} from "../../../lib/incident-settings-classes";
import {
  editMapping,
  fieldText,
  type JsonDocument,
  type MappingField,
  mappingErrorField,
  mappingErrorText,
  PRESET_LABELS,
  parseSample,
  presetText,
  previewRows,
} from "../../../lib/incidents/mapping-preview";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import { Checkbox } from "../../../ui/checkbox";
import { cn } from "../../../ui/cn";
import { DetailKey } from "../../../ui/detail-key";
import { Disclosure } from "../../../ui/disclosure";
import { FieldGrid, Input, Textarea } from "../../../ui/input";
import { OptionSelect } from "../../../ui/select";
import { InlineAlert } from "../../../ui/state";
import { Switch } from "../../../ui/switch";
import { FormField, FormSection } from "./FormParts";

type Format = "none" | "custom" | StatusPagePreset;
type EditableField = Exclude<MappingField, "format">;

const RAW_LIMIT = 4000;

const RESULT_BADGE: Record<
  ObservationResult | "none",
  { tone: "success" | "danger" | "neutral"; text: string }
> = {
  ok: { tone: "success", text: "Passing" },
  fail: { tone: "danger", text: "Failing" },
  unknown: { tone: "neutral", text: "No answer" },
  none: { tone: "neutral", text: "No result rule" },
};

function formatOf(mapping: JsonMapping | undefined): Format {
  if (!mapping) return "none";
  return mapping.preset ?? "custom";
}

function ResultBadge({ result }: { result: ObservationResult | null }) {
  const badge = RESULT_BADGE[result ?? "none"];
  return <Badge tone={badge.tone}>{badge.text}</Badge>;
}

/**
 * How a JSON answer becomes a result, with the answer beside it: a fetched
 * sample (http) or a pasted payload (webhook) runs through the shared
 * mapper on every edit, so the preview is what the server will decide.
 * Nothing saves until the editor's Save.
 */
export function JsonMappingPreview({
  kind,
  source,
  signalId,
  provider = false,
  mapping,
  onChange,
  sample,
  onSample,
}: {
  kind: "http" | "webhook";
  /** The editor's current source, null while it is not valid yet. */
  source: SignalSource | null;
  /** A stored signal: its hidden header values are used for the fetch. */
  signalId?: string;
  provider?: boolean;
  mapping: JsonMapping | undefined;
  onChange: (mapping: JsonMapping | undefined) => void;
  sample: JsonDocument | undefined;
  onSample: (doc: JsonDocument) => void;
}) {
  const id = useId();
  const format = formatOf(mapping);
  const checked = mapping ? validateJsonMapping(mapping) : null;
  const problem =
    checked && "error" in checked
      ? {
          field: mappingErrorField(checked.error),
          error: mappingErrorText(checked.error),
        }
      : null;
  // The last mapping that validated keeps driving the preview while a
  // field is mid-edit.
  const [lastValid, setLastValid] = useState<JsonMapping | undefined>(
    problem ? undefined : mapping,
  );
  if (!problem && mapping !== lastValid) setLastValid(mapping);

  const edit = (field: EditableField, text: string) =>
    onChange(editMapping(mapping ?? {}, field, text));
  const errorOf = (field: MappingField) =>
    problem?.field === field ? problem.error : null;

  const text = (field: EditableField, label: string) => (
    <MappingInput
      // A new format starts every field from what it now holds.
      key={`${format}-${field}`}
      id={`${id}-${field}`}
      label={label}
      initial={mapping ? fieldText(mapping, field) : ""}
      placeholder={mapping ? presetText(mapping, field) : ""}
      error={errorOf(field)}
      onText={(value) => edit(field, value)}
    />
  );

  const allLanes =
    sample !== undefined && lastValid
      ? previewRows(sample, { ...lastValid, lanesInclude: undefined }).outcome
          .lanes
      : [];
  const include = mapping?.lanesInclude;
  const toggleLane = (lane: string, on: boolean) => {
    if (!mapping) return;
    const current = include ?? allLanes.map((l) => l.lane);
    const next = on
      ? [...current, lane]
      : current.filter((name) => name !== lane);
    const updated: JsonMapping = { ...mapping };
    if (next.length === allLanes.length) delete updated.lanesInclude;
    else updated.lanesInclude = next;
    onChange(updated);
  };

  const hint = mapping?.preset ? STATUS_PAGE_PRESET_HINTS[mapping.preset] : "";

  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="Format"
        error={errorOf("format")}
        hint={hint}
        messageId={`${id}-format-message`}
      >
        <OptionSelect<Format>
          label="Format"
          value={format}
          options={[
            { value: "none", label: "No mapping" },
            ...STATUS_PAGE_PRESETS.map((preset) => ({
              value: preset,
              label: PRESET_LABELS[preset],
            })),
            { value: "custom", label: "Custom paths" },
          ]}
          onChange={(next) =>
            onChange(
              next === "none"
                ? undefined
                : next === "custom"
                  ? {}
                  : { preset: next },
            )
          }
          className="w-full justify-between phone:min-h-11"
        />
      </FormField>

      {mapping && (
        <>
          <FieldGrid>
            {text("resultPath", "Status path")}
            {text("detail", "Detail path")}
          </FieldGrid>
          <FieldGrid>
            {text("resultOk", "OK values")}
            {text("resultFail", "Fail values")}
          </FieldGrid>
          {text("value", "Value path")}
          <FormSection title="Components">
            <FieldGrid>
              {text("laneItems", "Items path")}
              {text("laneName", "Name path")}
            </FieldGrid>
            {text("lanePath", "Status path")}
            <FieldGrid>
              {text("laneOk", "OK values")}
              {text("laneFail", "Fail values")}
            </FieldGrid>
            <label className={CHECK_ROW}>
              <span className="min-w-0 flex-1">
                The worst component decides
              </span>
              <Switch
                checked={mapping.aggregate === "worst-lane"}
                onCheckedChange={(on) => {
                  const updated: JsonMapping = { ...mapping };
                  if (on) updated.aggregate = "worst-lane";
                  else delete updated.aggregate;
                  onChange(updated);
                }}
              />
            </label>
            {allLanes.length > 0 && (
              <FormField label="Count these components">
                <div className="flex flex-wrap gap-x-5">
                  {allLanes.map((lane) => (
                    <label key={lane.lane} className={CHECK_ROW}>
                      <Checkbox
                        checked={!include || include.includes(lane.lane)}
                        onCheckedChange={(on) => toggleLane(lane.lane, on)}
                      />
                      <span className="min-w-0 truncate">{lane.lane}</span>
                    </label>
                  ))}
                </div>
              </FormField>
            )}
          </FormSection>
        </>
      )}

      {mapping && (
        <SampleSection
          kind={kind}
          source={source}
          signalId={signalId}
          provider={provider}
          sample={sample}
          onSample={onSample}
          id={id}
        />
      )}

      {mapping && sample !== undefined && lastValid && (
        <MappingPreviewView sample={sample} mapping={lastValid} />
      )}
    </div>
  );
}

/** One mapping field. The text is its own while it is typed, so a list
 *  like "ok, " is not reformatted under the cursor. */
function MappingInput({
  id,
  label,
  initial,
  placeholder,
  error,
  onText,
}: {
  id: string;
  label: string;
  initial: string;
  placeholder: string;
  error: string | null;
  onText: (text: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const messageId = `${id}-message`;
  return (
    <FormField label={label} htmlFor={id} error={error} messageId={messageId}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? messageId : undefined}
        className={cn("font-mono", DIALOG_INPUT)}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          onText(event.currentTarget.value);
        }}
      />
    </FormField>
  );
}

interface FetchMeta {
  status?: number;
  contentType?: string;
  latencyMs?: number;
}

/** Where the sample comes from: fetched from the URL, or pasted. */
function SampleSection({
  kind,
  source,
  signalId,
  provider,
  sample,
  onSample,
  id,
}: {
  kind: "http" | "webhook";
  source: SignalSource | null;
  signalId?: string;
  provider: boolean;
  sample: JsonDocument | undefined;
  onSample: (doc: JsonDocument) => void;
  id: string;
}) {
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<FetchMeta | null>(null);
  const [notJson, setNotJson] = useState<{
    contentType: string;
    body: string;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [payload, setPayload] = useState(() =>
    sample === undefined ? "" : JSON.stringify(sample, null, 2),
  );
  const [payloadError, setPayloadError] = useState(false);

  if (kind === "webhook") {
    const messageId = `${id}-payload-message`;
    return (
      <FormField
        label="Sample payload"
        htmlFor={`${id}-payload`}
        error={payloadError ? "Not valid JSON" : null}
        hint="Paste an event as your service sends it"
        messageId={messageId}
      >
        <Textarea
          id={`${id}-payload`}
          value={payload}
          rows={6}
          spellCheck={false}
          aria-invalid={payloadError || undefined}
          aria-describedby={messageId}
          className={cn("font-mono", DIALOG_INPUT)}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setPayload(next);
            const parsed = parseSample(next);
            setPayloadError(parsed.kind === "invalid");
            if (parsed.kind === "doc") onSample(parsed.doc);
          }}
        />
      </FormField>
    );
  }

  const fetchSample = () => {
    if (!source) return;
    setBusy(true);
    setFailure(null);
    testSignalApi({ source, provider, signalId }).then(
      (result) => {
        setBusy(false);
        const preview = result.preview;
        if (!preview) {
          setFailure("The check returned no answer to map");
          return;
        }
        setMeta({
          status: preview.status,
          contentType: preview.contentType,
          latencyMs: preview.latencyMs,
        });
        if (preview.json === undefined) {
          setNotJson({
            contentType: preview.contentType ?? "unknown type",
            body: preview.bodyHead.slice(0, RAW_LIMIT),
          });
          return;
        }
        // Re-read from text: the answer arrives untyped, and the preview
        // takes a JSON document.
        const parsed = parseSample(JSON.stringify(preview.json) ?? "");
        if (parsed.kind !== "doc") {
          setFailure("The answer could not be read as JSON");
          return;
        }
        setNotJson(null);
        onSample(parsed.doc);
      },
      (error) => {
        setBusy(false);
        setFailure(errorMessage(error, "Couldn't fetch a sample"));
      },
    );
  };

  const metaLine = meta
    ? [
        meta.status,
        meta.contentType,
        meta.latencyMs !== undefined ? `${meta.latencyMs} ms` : undefined,
      ]
        .filter((part) => part !== undefined && part !== "")
        .join(" · ")
    : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="soft"
          size="sm"
          className="phone:min-h-11"
          disabled={!source || busy}
          onClick={fetchSample}
        >
          {busy
            ? "Fetching"
            : sample === undefined
              ? "Fetch a sample"
              : "Fetch again"}
        </Button>
        {metaLine ? (
          <span className="text-meta text-dim tabular-nums">{metaLine}</span>
        ) : (
          !source && (
            <span className="text-meta text-dim">Enter a URL first</span>
          )
        )}
      </div>
      {failure && <p className={FIELD_ERROR}>{failure}</p>}
      {notJson && (
        <>
          <InlineAlert variant="info">
            {`The answer is not JSON (${notJson.contentType}). Mapping applies to JSON answers only`}
          </InlineAlert>
          <Disclosure title="Response">
            <pre className={MAPPING_RAW}>{notJson.body}</pre>
          </Disclosure>
        </>
      )}
    </div>
  );
}

/** The mapper's answer for the sample: the result, value and detail, one
 *  line per component, and what each path found. */
export function MappingPreviewView({
  sample,
  mapping,
}: {
  sample: JsonDocument;
  mapping: JsonMapping;
}) {
  const { outcome, found } = previewRows(sample, mapping);
  const raw = JSON.stringify(sample, null, 2) ?? "";
  return (
    <section className={MAPPING_PREVIEW} aria-label="Preview">
      <div className="flex flex-wrap items-center gap-2">
        <ResultBadge result={outcome.result} />
        {outcome.value !== undefined && (
          <span className="text-supporting text-fg tabular-nums">
            {outcome.value}
          </span>
        )}
        {outcome.detail && (
          <span className="min-w-0 text-supporting text-dim [overflow-wrap:anywhere]">
            {outcome.detail}
          </span>
        )}
      </div>
      {outcome.lanes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {outcome.lanes.map((lane) => (
            <li
              key={lane.lane}
              className="flex min-w-0 items-center justify-between gap-3 text-supporting text-fg"
            >
              <span className="min-w-0 truncate">{lane.lane}</span>
              <ResultBadge result={lane.result} />
            </li>
          ))}
        </ul>
      )}
      {found.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="m-0 text-label font-semibold text-fg">
            What each path found
          </h4>
          <ul className={MAPPING_FOUND_LIST}>
            {found.map((row) => (
              <li key={row.path} className={MAPPING_FOUND_ROW}>
                <DetailKey>
                  <span className="font-mono whitespace-normal [overflow-wrap:anywhere]">
                    {row.path}
                  </span>
                </DetailKey>
                <span className="min-w-0 select-text font-mono text-label text-dim [overflow-wrap:anywhere]">
                  {row.values}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Disclosure title="Response">
        <pre className={MAPPING_RAW}>
          {raw.length > RAW_LIMIT ? `${raw.slice(0, RAW_LIMIT)}…` : raw}
        </pre>
      </Disclosure>
    </section>
  );
}
