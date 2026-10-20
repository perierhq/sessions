// JSON response → observation result, value, detail and component lanes,
// with presets for common status-page formats.
import {
  STATUS_PAGE_PRESETS,
  type JsonLaneMapping,
  type JsonMapping,
  type JsonResultMapping,
  type JsonScalar,
  type ObservationResult,
  type StatusPagePreset,
} from "../../shared/incidents";
import { parseJsonPath, queryJsonPath } from "./jsonpath";

export const MAX_LANES = 24;
const MAX_LANE_NAME = 80;
const MAX_MATCH_VALUES = 20;
const MAX_LIST_VALUES = 20;
const MAX_LANES_INCLUDE = 50;
const MAX_DETAIL = 200;

export const STATUS_PAGE_PRESET_MAPPINGS: Record<
  StatusPagePreset,
  JsonMapping
> = {
  statuspage: {
    result: {
      path: "$.status.indicator",
      ok: ["none"],
      fail: ["minor", "major", "critical"],
    },
    detail: "$.status.description",
    lanes: {
      items: "$.components[?(@.group!=true)]",
      name: "name",
      result: {
        path: "status",
        ok: ["operational"],
        fail: ["degraded_performance", "partial_outage", "major_outage"],
      },
    },
  },
  instatus: {
    result: { path: "$.page.status", ok: ["UP"], fail: ["HASISSUES"] },
    lanes: {
      items: "$.components[*]",
      name: "name",
      result: {
        path: "status",
        ok: ["OPERATIONAL"],
        fail: ["DEGRADEDPERFORMANCE", "PARTIALOUTAGE", "MAJOROUTAGE"],
      },
    },
  },
  betterstack: {
    result: {
      path: "$.data.attributes.aggregate_state",
      ok: ["operational"],
      fail: ["degraded", "downtime"],
    },
    lanes: {
      items: "$.included[?(@.type=='status_page_resource')]",
      name: "attributes.public_name",
      result: {
        path: "attributes.status",
        ok: ["operational"],
        fail: ["degraded", "downtime"],
      },
    },
  },
  kener: {
    result: { path: "$.status", ok: ["UP"], fail: ["DOWN", "DEGRADED"] },
  },
  cachet: {
    lanes: {
      items: "$.data[*]",
      name: "name",
      result: { path: "status", ok: [1], fail: [2, 3, 4] },
    },
    aggregate: "worst-lane",
  },
  plain: {
    result: {
      path: "$.status",
      ok: ["ok", "up", "healthy", "pass", "operational", true],
      fail: ["down", "fail", "error", "unhealthy", "outage", false],
    },
  },
};

export interface JsonMappingOutcome {
  /** `null` when the mapping has neither a result rule nor an aggregate. */
  result: ObservationResult | null;
  value?: number;
  detail?: string;
  lanes: Array<{
    lane: string;
    result: ObservationResult;
    value?: number;
    detail: string;
  }>;
  matches: Record<string, unknown[]>;
}

/** Preset fields first; explicit fields override per top-level key. */
export function resolveMapping(mapping: JsonMapping): JsonMapping {
  const base = mapping.preset
    ? STATUS_PAGE_PRESET_MAPPINGS[mapping.preset]
    : undefined;
  if (!base) return mapping;
  const out: JsonMapping = { ...base };
  for (const [key, value] of Object.entries(mapping) as Array<
    [keyof JsonMapping, unknown]
  >) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function scalarMatches(entry: JsonScalar, value: unknown): boolean {
  if (typeof entry === "string" && typeof value === "string")
    return entry.trim().toLowerCase() === value.trim().toLowerCase();
  if (typeof entry === "number" && typeof value === "string")
    return value.trim() !== "" && Number(value) === entry;
  if (typeof entry === "string" && typeof value === "number")
    return entry.trim() !== "" && Number(entry) === value;
  return entry === value;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, MAX_DETAIL);
  if (value === null || typeof value !== "object") return String(value);
  return (JSON.stringify(value) ?? "").slice(0, MAX_DETAIL);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function matchResult(
  node: unknown,
  rule: JsonResultMapping,
): { result: ObservationResult; detail: string } {
  const found = queryJsonPath(node, rule.path);
  if (!found.length)
    return { result: "unknown", detail: `Nothing at ${rule.path}` };
  const value = found[0];
  const detail = asText(value);
  if (rule.ok.some((entry) => scalarMatches(entry, value)))
    return { result: "ok", detail };
  if (rule.fail?.some((entry) => scalarMatches(entry, value)))
    return { result: "fail", detail };
  return { result: rule.fail ? "unknown" : "fail", detail };
}

function firstNumber(
  node: unknown,
  path: string | undefined,
): number | undefined {
  if (!path) return undefined;
  const found = queryJsonPath(node, path);
  return found.length ? asNumber(found[0]) : undefined;
}

const RESULT_RANK: Record<ObservationResult, number> = {
  ok: 0,
  unknown: 1,
  fail: 2,
};

function mapLanes(
  doc: unknown,
  lanes: JsonLaneMapping,
): JsonMappingOutcome["lanes"] {
  const items = queryJsonPath(doc, lanes.items).slice(0, MAX_LANES);
  return items.map((item, index) => {
    const names = queryJsonPath(item, lanes.name);
    const raw =
      names.length && names[0] !== null && typeof names[0] !== "object"
        ? String(names[0]).trim()
        : "";
    const lane = raw ? raw.slice(0, MAX_LANE_NAME) : `#${index + 1}`;
    const { result, detail } = matchResult(item, lanes.result);
    const value = firstNumber(item, lanes.value);
    return value === undefined
      ? { lane, result, detail }
      : { lane, result, value, detail };
  });
}

export function mapJson(
  doc: unknown,
  mapping: JsonMapping,
): JsonMappingOutcome {
  const m = resolveMapping(mapping);
  const matches: Record<string, unknown[]> = {};
  const record = (path: string | undefined) => {
    if (path && !(path in matches))
      matches[path] = queryJsonPath(doc, path).slice(0, MAX_MATCH_VALUES);
  };
  record(m.result?.path);
  record(m.value);
  record(m.detail);
  record(m.lanes?.items);

  const lanes = m.lanes ? mapLanes(doc, m.lanes) : [];
  let result: ObservationResult | null = null;
  let detail: string | undefined;
  if (m.result) {
    const matched = matchResult(doc, m.result);
    result = matched.result;
    detail = matched.detail;
  }
  if (m.aggregate === "worst-lane") {
    const include = m.lanesInclude?.map((name) => name.trim().toLowerCase());
    const counted = include
      ? lanes.filter((l) => include.includes(l.lane.trim().toLowerCase()))
      : lanes;
    if (!counted.length) {
      result = "unknown";
      detail = "No components to check";
    } else {
      result = counted.reduce<ObservationResult>(
        (worst, l) =>
          RESULT_RANK[l.result] > RESULT_RANK[worst] ? l.result : worst,
        "ok",
      );
      const bad = counted.filter((l) => l.result !== "ok");
      detail = bad.length
        ? bad
            .map((l) => `${l.lane}: ${l.detail}`)
            .join(", ")
            .slice(0, MAX_DETAIL)
        : "All components operational";
    }
  }
  if (m.detail) {
    const found = queryJsonPath(doc, m.detail);
    if (
      found.length &&
      found[0] !== null &&
      found[0] !== undefined &&
      asText(found[0])
    )
      detail = asText(found[0]);
  }
  const value = firstNumber(doc, m.value);
  const out: JsonMappingOutcome = { result, lanes, matches };
  if (value !== undefined) out.value = value;
  if (detail !== undefined) out.detail = detail;
  return out;
}

function isScalar(v: unknown): v is JsonScalar {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validatePath(
  value: unknown,
  field: string,
): string | { error: string } {
  if (typeof value !== "string" || !value.trim())
    return { error: `${field} must be a JSON path` };
  const parsed = parseJsonPath(value);
  if (!Array.isArray(parsed)) return { error: `${field}: ${parsed.error}` };
  return value.trim();
}

function validateList(
  value: unknown,
  field: string,
  required: boolean,
): JsonScalar[] | undefined | { error: string } {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || !value.every(isScalar))
    return {
      error: `${field} must be a list of strings, numbers, booleans or null`,
    };
  if (!value.length) return { error: `${field} needs at least one value` };
  if (value.length > MAX_LIST_VALUES)
    return { error: `${field} has more than ${MAX_LIST_VALUES} values` };
  return value;
}

function validateResultMapping(
  value: unknown,
  field: string,
): JsonResultMapping | { error: string } {
  if (!isRecord(value)) return { error: `${field} must be an object` };
  const path = validatePath(value.path, `${field}.path`);
  if (typeof path !== "string") return path;
  const ok = validateList(value.ok, `${field}.ok`, true);
  if (!Array.isArray(ok)) return ok ?? { error: `${field}.ok is required` };
  const fail = validateList(value.fail, `${field}.fail`, false);
  if (fail && !Array.isArray(fail)) return fail;
  return fail ? { path, ok, fail } : { path, ok };
}

export function validateJsonMapping(
  value: unknown,
): JsonMapping | { error: string } {
  if (!isRecord(value)) return { error: "Mapping must be an object" };
  const out: JsonMapping = {};
  if (value.preset !== undefined) {
    if (
      typeof value.preset !== "string" ||
      !(STATUS_PAGE_PRESETS as readonly string[]).includes(value.preset)
    )
      return {
        error: `Preset must be one of ${STATUS_PAGE_PRESETS.join(", ")}`,
      };
    out.preset = value.preset as StatusPagePreset;
  }
  if (value.result !== undefined) {
    const result = validateResultMapping(value.result, "result");
    if ("error" in result) return result;
    out.result = result;
  }
  for (const key of ["value", "detail"] as const) {
    if (value[key] === undefined) continue;
    const path = validatePath(value[key], key);
    if (typeof path !== "string") return path;
    out[key] = path;
  }
  if (value.lanes !== undefined) {
    const lanes = value.lanes;
    if (!isRecord(lanes)) return { error: "lanes must be an object" };
    const items = validatePath(lanes.items, "lanes.items");
    if (typeof items !== "string") return items;
    const name = validatePath(lanes.name, "lanes.name");
    if (typeof name !== "string") return name;
    const result = validateResultMapping(lanes.result, "lanes.result");
    if ("error" in result) return result;
    const lane: JsonLaneMapping = { items, name, result };
    if (lanes.value !== undefined) {
      const path = validatePath(lanes.value, "lanes.value");
      if (typeof path !== "string") return path;
      lane.value = path;
    }
    out.lanes = lane;
  }
  if (value.aggregate !== undefined) {
    if (value.aggregate !== "worst-lane")
      return { error: 'aggregate must be "worst-lane"' };
    out.aggregate = "worst-lane";
  }
  if (value.lanesInclude !== undefined) {
    const list = value.lanesInclude;
    if (
      !Array.isArray(list) ||
      !list.every((v) => typeof v === "string" && v.trim())
    )
      return { error: "lanesInclude must be a list of component names" };
    if (list.length > MAX_LANES_INCLUDE)
      return { error: `lanesInclude has more than ${MAX_LANES_INCLUDE} names` };
    out.lanesInclude = list.map((v: string) => v.trim());
  }
  const resolved = resolveMapping(out);
  if (
    !resolved.result &&
    !resolved.value &&
    !resolved.detail &&
    !resolved.lanes
  )
    return { error: "Mapping needs a preset or at least one path" };
  if (resolved.aggregate && !resolved.lanes)
    return { error: "worst-lane needs component lanes" };
  return out;
}
