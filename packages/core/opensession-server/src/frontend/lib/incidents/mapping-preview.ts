// The JSON mapping editor's model: preset names, editing one field of a
// mapping (a preset's rule becomes explicit the moment one part of it is
// edited), where a validation error belongs, and the live preview over a
// sample. The preview runs the shared mapper in the browser, so it is the
// server's own answer without a request. Pure.
import {
  type JsonMappingOutcome,
  mapJson,
  resolveMapping,
} from "../../../shared/incidents-json-mapping";
import type {
  JsonLaneMapping,
  JsonMapping,
  JsonResultMapping,
  JsonScalar,
  StatusPagePreset,
} from "../../../shared/incidents";

export const PRESET_LABELS: Record<StatusPagePreset, string> = {
  statuspage: "Atlassian Statuspage (summary.json)",
  instatus: "Instatus",
  betterstack: "Better Stack",
  kener: "Kener",
  cachet: "Cachet",
  plain: "A plain status field",
};

/** One editable field of a mapping, and the error slot under it. */
export type MappingField =
  | "format"
  | "resultPath"
  | "resultOk"
  | "resultFail"
  | "value"
  | "detail"
  | "laneItems"
  | "laneName"
  | "lanePath"
  | "laneOk"
  | "laneFail";

const FOUND_VALUES = 3;

/** A JSON document, as `JSON.parse` returns it. */
export type JsonDocument =
  | JsonScalar
  | JsonDocument[]
  | { [key: string]: JsonDocument };

export interface FoundPath {
  path: string;
  values: string;
}

export interface MappingPreview {
  outcome: JsonMappingOutcome;
  found: FoundPath[];
}

/** `"ok, 1, true, null"` → `["ok", 1, true, null]`; blanks are dropped. */
export function listToValues(text: string): JsonScalar[] {
  const out: JsonScalar[] = [];
  for (const raw of text.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "true") out.push(true);
    else if (part === "false") out.push(false);
    else if (part === "null") out.push(null);
    else if (/^-?\d+(\.\d+)?$/.test(part)) out.push(Number(part));
    else out.push(part);
  }
  return out;
}

export function valuesToList(values: JsonScalar[]): string {
  return values.map((value) => String(value)).join(", ");
}

/** The mapper's answer for `doc`, and what each path it read found: the
 *  first three values as compact JSON, or `Nothing here`. */
export function previewRows(
  doc: JsonDocument,
  mapping: JsonMapping,
): MappingPreview {
  const outcome = mapJson(doc, mapping);
  const found = Object.entries(outcome.matches).map(([path, values]) => ({
    path,
    values: values.length
      ? values
          .slice(0, FOUND_VALUES)
          .map((value) => compact(JSON.stringify(value) ?? String(value)))
          .join(", ")
      : "Nothing here",
  }));
  return { outcome, found };
}

function compact(text: string): string {
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const EMPTY_RESULT: JsonResultMapping = { path: "", ok: [] };

function resultWith(
  base: JsonResultMapping,
  part: "path" | "ok" | "fail",
  text: string,
): JsonResultMapping {
  const next: JsonResultMapping = { ...base };
  if (part === "path") next.path = text.trim();
  else if (part === "ok") next.ok = listToValues(text);
  else {
    const fail = listToValues(text);
    if (fail.length) next.fail = fail;
    else delete next.fail;
  }
  return next;
}

const isEmptyResult = (r: JsonResultMapping) =>
  !r.path && !r.ok.length && !r.fail?.length;

/**
 * `mapping` with one field set from its text. A preset's rule (its status
 * rule or its components) is copied in whole the first time one part of it
 * is edited, so the other parts keep the preset's values; a cleared field
 * leaves the mapping.
 */
export function editMapping(
  mapping: JsonMapping,
  field: Exclude<MappingField, "format">,
  text: string,
): JsonMapping {
  const next: JsonMapping = { ...mapping };
  const resolved = resolveMapping(mapping);
  switch (field) {
    case "value":
    case "detail": {
      const path = text.trim();
      if (path) next[field] = path;
      else delete next[field];
      return next;
    }
    case "resultPath":
    case "resultOk":
    case "resultFail": {
      const part =
        field === "resultPath" ? "path" : field === "resultOk" ? "ok" : "fail";
      const result = resultWith(
        mapping.result ?? resolved.result ?? EMPTY_RESULT,
        part,
        text,
      );
      if (isEmptyResult(result)) delete next.result;
      else next.result = result;
      return next;
    }
    default: {
      const base: JsonLaneMapping = mapping.lanes ??
        resolved.lanes ?? { items: "", name: "", result: EMPTY_RESULT };
      const lanes: JsonLaneMapping = { ...base };
      if (field === "laneItems") lanes.items = text.trim();
      else if (field === "laneName") lanes.name = text.trim();
      else
        lanes.result = resultWith(
          base.result,
          field === "lanePath" ? "path" : field === "laneOk" ? "ok" : "fail",
          text,
        );
      if (!lanes.items && !lanes.name && isEmptyResult(lanes.result))
        delete next.lanes;
      else next.lanes = lanes;
      return next;
    }
  }
}

/** The text a field shows: its explicit value, or "" when it comes from
 *  the preset (the preset's value is the placeholder). */
export function fieldText(
  mapping: JsonMapping,
  field: Exclude<MappingField, "format">,
): string {
  return partOf(mapping, field);
}

/** What the preset (alone) puts in a field, for its placeholder. */
export function presetText(
  mapping: JsonMapping,
  field: Exclude<MappingField, "format">,
): string {
  if (!mapping.preset) return "";
  return partOf(resolveMapping({ preset: mapping.preset }), field);
}

function partOf(
  m: JsonMapping,
  field: Exclude<MappingField, "format">,
): string {
  switch (field) {
    case "value":
      return m.value ?? "";
    case "detail":
      return m.detail ?? "";
    case "resultPath":
      return m.result?.path ?? "";
    case "resultOk":
      return valuesToList(m.result?.ok ?? []);
    case "resultFail":
      return valuesToList(m.result?.fail ?? []);
    case "laneItems":
      return m.lanes?.items ?? "";
    case "laneName":
      return m.lanes?.name ?? "";
    case "lanePath":
      return m.lanes?.result.path ?? "";
    case "laneOk":
      return valuesToList(m.lanes?.result.ok ?? []);
    case "laneFail":
      return valuesToList(m.lanes?.result.fail ?? []);
  }
}

const ERROR_FIELDS: Array<[string, MappingField]> = [
  ["lanes.result.path", "lanePath"],
  ["lanes.result.ok", "laneOk"],
  ["lanes.result.fail", "laneFail"],
  ["lanes.result", "lanePath"],
  ["lanes.items", "laneItems"],
  ["lanes.name", "laneName"],
  ["lanes.value", "laneItems"],
  ["lanes", "laneItems"],
  ["lanesInclude", "laneItems"],
  ["worst-lane", "laneItems"],
  ["aggregate", "laneItems"],
  ["result.path", "resultPath"],
  ["result.ok", "resultOk"],
  ["result.fail", "resultFail"],
  ["result", "resultPath"],
  ["value", "value"],
  ["detail", "detail"],
];

/** Which field a `validateJsonMapping` error is about. */
export function mappingErrorField(error: string): MappingField {
  for (const [prefix, field] of ERROR_FIELDS)
    if (error.startsWith(prefix)) return field;
  return "format";
}

export type ParsedSample =
  | { kind: "doc"; doc: JsonDocument }
  | { kind: "empty" }
  | { kind: "invalid" };

/** JSON text (a pasted payload, a fetched answer re-serialised) as a
 *  document; blank text is `empty`. */
export function parseSample(text: string): ParsedSample {
  if (!text.trim()) return { kind: "empty" };
  try {
    const doc: JsonDocument = JSON.parse(text);
    return { kind: "doc", doc };
  } catch {
    return { kind: "invalid" };
  }
}

/** A `validateJsonMapping` error as the field under it says it: without
 *  the wire name the field already stands for. */
export function mappingErrorText(error: string): string {
  if (/^[\w.]+ must be a JSON path$/.test(error))
    return "Enter a JSON path like $.status";
  if (/^[\w.]+ needs at least one value$/.test(error))
    return "Enter at least one value";
  const detail = /^[\w.]+: (.+)$/.exec(error)?.[1];
  if (!detail) return error;
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}
