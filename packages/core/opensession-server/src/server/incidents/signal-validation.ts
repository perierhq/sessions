// Signal validation: caller input → Signal fields, cross-field rules, header
// redaction and hook secrets. Pure apart from the context callbacks.
import { randomBytes } from "node:crypto";
import {
  IMPACT_PLACEHOLDERS,
  SEVERITIES,
  type ExpirySource,
  type HttpSource,
  type ImpactSource,
  type RedactedSignal,
  type Severity,
  type Signal,
  type SignalRule,
  type SignalSource,
  type SignalSourceKind,
  type WebhookSource,
} from "../../shared/incidents";
import { nextRun, parseCron } from "../cron";
import { compileSafeRegex } from "../shared/safe-regex";
import { validateJsonMapping } from "./json-mapping";
import { parseJsonPath } from "./jsonpath";
import { validateMaintenanceWindows } from "./maintenance";

export interface SignalValidationContext {
  projectExists(id: string): boolean;
  signalExists(id: string): Promise<boolean>;
  /** The signal being updated; it cannot depend on itself. */
  selfId?: string;
  /** `name` as an owner, or why it cannot be one (owner.ts). Without it,
   *  any name is taken as given. */
  resolveOwner?(name: string): string | { error: string };
}

export type SignalFields = Partial<
  Omit<Signal, "id" | "createdBy" | "createdAt" | "updatedAt" | "hookSecret">
>;

type FieldError = { error: string };
type FieldValidator = (
  value: unknown,
  ctx: SignalValidationContext,
) => unknown | Promise<unknown>;

export const REDACTED = "[redacted]";

const MAX_NAME_CHARS = 80;
const MAX_URL_CHARS = 2048;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_CHARS = 4096;
const MAX_BODY_CHARS = 16_384;
const MAX_CONTAINS_CHARS = 1000;
const MAX_DEPENDS_ON = 20;
const MAX_RUN_ON_CHARS = 128;
const MAX_IMPACT_WORDS_CHARS = 40;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HOST_NAME = /^[A-Za-z0-9.-]+$/;
const DAY_MS = 86_400_000;

/** Poll interval defaults and bounds for polled sources. */
const INTERVALS: Partial<
  Record<SignalSourceKind, { fallback: number; min: number; max: number }>
> = {
  http: { fallback: 60_000, min: 30_000, max: DAY_MS },
  expiry: { fallback: 21_600_000, min: 3_600_000, max: 7 * DAY_MS },
};

const RULES_FOR_SOURCE: Record<SignalSourceKind, SignalRule["kind"][]> = {
  http: ["consecutive", "rate", "threshold"],
  webhook: ["consecutive", "rate", "threshold"],
  heartbeat: ["missing"],
  expiry: ["deadline"],
};

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);
/** Hop-by-hop and framing headers the fetch layer owns. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
]);
/** Query parameter names (or `_`/`-`/`.` separated parts of them) that carry secrets. */
const SECRET_QUERY_PARTS = new Set([
  "apikey",
  "key",
  "token",
  "secret",
  "sig",
  "signature",
  "auth",
  "password",
  "passwd",
  "credential",
  "credentials",
]);
const SECRET_QUERY_WORDS = ["token", "secret", "password", "apikey", "api_key"];
const SECRET_HEADER_PARTS = [
  "token",
  "secret",
  "key",
  "password",
  "auth",
  "session",
];

function isFieldError(value: unknown): value is FieldError {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string" &&
    Object.keys(value).length === 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function intField(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | FieldError {
  return isIntegerIn(value, min, max)
    ? (value as number)
    : { error: `${field} must be a whole number from ${min} to ${max}` };
}

// --- sources -------------------------------------------------------------

function validateHeaders(
  value: unknown,
): Record<string, string> | undefined | FieldError {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return { error: "Headers must be an object" };
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS)
    return { error: `At most ${MAX_HEADERS} headers` };
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, raw] of entries) {
    if (!HEADER_NAME.test(name))
      return { error: `Invalid header name "${name.slice(0, 64)}"` };
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-"))
      return { error: `The ${name} header cannot be set` };
    if (seen.has(lower)) return { error: `Header "${name}" is listed twice` };
    seen.add(lower);
    if (typeof raw !== "string")
      return { error: `Invalid header ${name}: the value must be text` };
    if (raw.length > MAX_HEADER_VALUE_CHARS)
      return {
        error: `Invalid header ${name}: at most ${MAX_HEADER_VALUE_CHARS} characters`,
      };
    if (/[\r\n]/.test(raw))
      return { error: `Invalid header ${name}: no line breaks allowed` };
    out[name] = raw;
  }
  return entries.length ? out : undefined;
}

function validateHttpSource(
  value: Record<string, unknown>,
): HttpSource | FieldError {
  const rawUrl = typeof value.url === "string" ? value.url.trim() : "";
  if (!rawUrl) return { error: "A URL is required" };
  if (rawUrl.length > MAX_URL_CHARS)
    return { error: `The URL can be at most ${MAX_URL_CHARS} characters` };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "The URL is not valid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { error: "Only http and https URLs can be checked" };
  if (url.username || url.password)
    return { error: "Put credentials in a header, not the URL" };
  const out: HttpSource = { kind: "http", url: rawUrl };

  if (value.method !== undefined && value.method !== null) {
    if (
      value.method !== "GET" &&
      value.method !== "HEAD" &&
      value.method !== "POST"
    )
      return { error: "Method must be GET, HEAD or POST" };
    out.method = value.method;
  }
  const headers = validateHeaders(value.headers);
  if (isFieldError(headers)) return headers;
  if (headers) out.headers = headers;

  if (value.body !== undefined && value.body !== null && value.body !== "") {
    if (typeof value.body !== "string") return { error: "Body must be text" };
    if (value.body.length > MAX_BODY_CHARS)
      return { error: `Body can be at most ${MAX_BODY_CHARS} characters` };
    if (out.method !== "POST")
      return { error: "Only a POST check can send a body" };
    out.body = value.body;
  }
  if (value.expectStatus !== undefined && value.expectStatus !== null) {
    const list = value.expectStatus;
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > 20 ||
      !list.every((code) => isIntegerIn(code, 100, 599))
    )
      return {
        error: "expectStatus must list 1 to 20 status codes from 100 to 599",
      };
    out.expectStatus = [...new Set(list as number[])];
  }
  if (value.expectBody !== undefined && value.expectBody !== null) {
    if (!isRecord(value.expectBody))
      return { error: "expectBody must be an object" };
    const expectBody: NonNullable<HttpSource["expectBody"]> = {};
    const { contains, regex } = value.expectBody;
    if (contains !== undefined && contains !== null && contains !== "") {
      if (typeof contains !== "string" || contains.length > MAX_CONTAINS_CHARS)
        return {
          error: `expectBody.contains must be text of at most ${MAX_CONTAINS_CHARS} characters`,
        };
      expectBody.contains = contains;
    }
    if (regex !== undefined && regex !== null && regex !== "") {
      if (typeof regex !== "string")
        return { error: "Invalid regex: it must be text" };
      try {
        compileSafeRegex(regex);
      } catch (err) {
        return {
          error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      expectBody.regex = regex;
    }
    if (expectBody.contains !== undefined || expectBody.regex !== undefined)
      out.expectBody = expectBody;
  }
  if (value.json !== undefined && value.json !== null) {
    const json = validateJsonMapping(value.json);
    if ("error" in json) return json;
    out.json = json;
  }
  if (value.timeoutMs !== undefined && value.timeoutMs !== null) {
    const timeoutMs = intField(value.timeoutMs, "timeoutMs", 1000, 30_000);
    if (isFieldError(timeoutMs)) return timeoutMs;
    out.timeoutMs = timeoutMs;
  }
  return out;
}

function validateExpirySource(
  value: Record<string, unknown>,
): ExpirySource | FieldError {
  if (value.target !== "tls") return { error: 'Expiry target must be "tls"' };
  const host = typeof value.host === "string" ? value.host.trim() : "";
  if (!host || host.length > 253 || !HOST_NAME.test(host))
    return { error: "Host must be a host name of at most 253 characters" };
  const out: ExpirySource = { kind: "expiry", target: "tls", host };
  if (value.port !== undefined && value.port !== null) {
    const port = intField(value.port, "port", 1, 65_535);
    if (isFieldError(port)) return port;
    out.port = port;
  }
  return out;
}

export function validateSource(value: unknown): SignalSource | FieldError {
  if (!isRecord(value)) return { error: "Source must be an object" };
  switch (value.kind) {
    case "http":
      return validateHttpSource(value);
    case "webhook": {
      const out: WebhookSource = { kind: "webhook" };
      if (value.mapping !== undefined && value.mapping !== null) {
        const mapping = validateJsonMapping(value.mapping);
        if ("error" in mapping) return mapping;
        out.mapping = mapping;
      }
      return out;
    }
    case "heartbeat":
      return { kind: "heartbeat" };
    case "expiry":
      return validateExpirySource(value);
    default:
      return {
        error: "Source kind must be one of http, webhook, heartbeat, expiry",
      };
  }
}

// --- impact --------------------------------------------------------------

type ImpactSamples = Record<(typeof IMPACT_PLACEHOLDERS)[number], string>;

/** Sample values a placeholder takes while its URL is checked. */
const IMPACT_SAMPLES: ImpactSamples = {
  since: "2026-01-01T00%3A00%3A00.000Z",
  sinceMs: "0",
  until: "2026-01-01T01%3A00%3A00.000Z",
  untilMs: "3600000",
};
/** Other samples: a placeholder that changes the address between the two
 *  is outside the path and query. */
const OTHER_IMPACT_SAMPLES: ImpactSamples = {
  since: "2026-01-02T00%3A00%3A00.000Z",
  sinceMs: "86400000",
  until: "2026-01-02T01%3A00%3A00.000Z",
  untilMs: "90000000",
};
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** `url` with every known placeholder filled in from `samples`. */
function renderImpactUrl(
  url: string,
  samples: ImpactSamples,
): { url: string } | FieldError {
  let unknown: string | undefined;
  const rendered = url.replace(PLACEHOLDER, (whole, name: string) => {
    if (Object.hasOwn(samples, name))
      return samples[name as keyof ImpactSamples];
    unknown ??= whole;
    return whole;
  });
  if (unknown)
    return { error: `Unknown placeholder ${unknown} in the impact URL` };
  return { url: rendered };
}

/** The parts of a URL a placeholder may not change. */
function fixedParts(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return JSON.stringify([url.origin, url.username, url.password, url.hash]);
  } catch {
    return undefined;
  }
}

function impactWords(
  value: unknown,
  field: "noun" | "label",
): string | FieldError {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_IMPACT_WORDS_CHARS)
    return {
      error: `Impact ${field} must be 1 to ${MAX_IMPACT_WORDS_CHARS} characters`,
    };
  return text;
}

function impactPath(
  value: unknown,
  field: "countPath" | "peoplePath",
): string | FieldError {
  if (typeof value !== "string")
    return { error: `Impact ${field}: a JSONPath is required` };
  const parsed = parseJsonPath(value);
  if ("error" in parsed) return { error: `Impact ${field}: ${parsed.error}` };
  return value.trim();
}

function validateHttpImpact(
  value: Record<string, unknown>,
  words: { noun: string; label: string },
): ImpactSource | FieldError {
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (url.length > MAX_URL_CHARS)
    return {
      error: `The impact URL can be at most ${MAX_URL_CHARS} characters`,
    };
  const rendered = renderImpactUrl(url, IMPACT_SAMPLES);
  if (isFieldError(rendered)) return rendered;
  const checked = validateHttpSource({ kind: "http", url: rendered.url });
  if (isFieldError(checked)) return { error: `Impact URL: ${checked.error}` };
  const other = renderImpactUrl(url, OTHER_IMPACT_SAMPLES);
  if (
    isFieldError(other) ||
    fixedParts(other.url) === undefined ||
    fixedParts(other.url) !== fixedParts(rendered.url)
  )
    return {
      error: "Impact URL placeholders may only be in the path or query",
    };
  const headers = validateHeaders(value.headers);
  if (isFieldError(headers))
    return { error: `Impact headers: ${headers.error}` };
  const countPath = impactPath(value.countPath, "countPath");
  if (isFieldError(countPath)) return countPath;
  let peoplePath: string | undefined;
  if (value.peoplePath !== undefined && value.peoplePath !== null) {
    const path = impactPath(value.peoplePath, "peoplePath");
    if (isFieldError(path)) return path;
    peoplePath = path;
  }
  // One key order, so a stored impact and the same one sent back compare equal.
  return {
    kind: "http",
    url,
    ...(headers ? { headers } : {}),
    countPath,
    ...(peoplePath ? { peoplePath } : {}),
    ...words,
  };
}

/** The impact's own fields; {@link normalizeSignal} checks it fits the source. */
function validateImpactFields(
  value: unknown,
): ImpactSource | undefined | FieldError {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return { error: "Impact must be an object" };
  if (value.kind !== "http" && value.kind !== "events")
    return { error: "Impact kind must be http or events" };
  const noun = impactWords(value.noun, "noun");
  if (isFieldError(noun)) return noun;
  const label = impactWords(value.label, "label");
  if (isFieldError(label)) return label;
  if (value.kind === "http") return validateHttpImpact(value, { noun, label });
  if (value.count !== "fail-events" && value.count !== "value-sum")
    return { error: "Impact count must be fail-events or value-sum" };
  return { kind: "events", count: value.count, noun, label };
}

function impactFitsSource(
  impact: ImpactSource,
  source: SignalSource,
): FieldError | undefined {
  if (impact.kind === "events" && source.kind !== "webhook")
    return { error: "Event counts need a webhook signal" };
  return undefined;
}

/**
 * Where a signal's impact is counted. `null` or `undefined` clears it. An
 * http impact may name another service than `source`; event counts need a
 * webhook.
 */
export function validateImpact(
  value: unknown,
  source: SignalSource,
): ImpactSource | undefined | FieldError {
  const impact = validateImpactFields(value);
  if (impact === undefined || isFieldError(impact)) return impact;
  return impactFitsSource(impact, source) ?? impact;
}

// --- rules ---------------------------------------------------------------

function optionalRecoveries(value: unknown): number | undefined | FieldError {
  if (value === undefined || value === null) return undefined;
  return intField(value, "recoveries", 1, 50);
}

export function validateRule(value: unknown): SignalRule | FieldError {
  if (!isRecord(value)) return { error: "Rule must be an object" };
  switch (value.kind) {
    case "consecutive": {
      const failures = intField(value.failures, "failures", 1, 50);
      if (isFieldError(failures)) return failures;
      const recoveries = optionalRecoveries(value.recoveries);
      if (isFieldError(recoveries)) return recoveries;
      return recoveries === undefined
        ? { kind: "consecutive", failures }
        : { kind: "consecutive", failures, recoveries };
    }
    case "rate": {
      const windowMs = intField(value.windowMs, "windowMs", 60_000, DAY_MS);
      if (isFieldError(windowMs)) return windowMs;
      const atLeast = intField(value.atLeast, "atLeast", 1, 10_000);
      if (isFieldError(atLeast)) return atLeast;
      if (value.ratio === undefined || value.ratio === null)
        return { kind: "rate", windowMs, atLeast };
      if (
        typeof value.ratio !== "number" ||
        !(value.ratio > 0 && value.ratio <= 1)
      )
        return { error: "ratio must be above 0 and at most 1" };
      return { kind: "rate", windowMs, atLeast, ratio: value.ratio };
    }
    case "threshold": {
      if (typeof value.above !== "number" || !Number.isFinite(value.above))
        return { error: "above must be a number" };
      const forMs = intField(value.forMs, "forMs", 0, DAY_MS);
      if (isFieldError(forMs)) return forMs;
      const rule: Extract<SignalRule, { kind: "threshold" }> = {
        kind: "threshold",
        above: value.above,
        forMs,
      };
      if (value.failingAbove !== undefined && value.failingAbove !== null) {
        if (
          typeof value.failingAbove !== "number" ||
          !Number.isFinite(value.failingAbove) ||
          value.failingAbove <= value.above
        )
          return { error: "failingAbove must be greater than above" };
        rule.failingAbove = value.failingAbove;
      }
      const recoveries = optionalRecoveries(value.recoveries);
      if (isFieldError(recoveries)) return recoveries;
      if (recoveries !== undefined) rule.recoveries = recoveries;
      return rule;
    }
    case "missing": {
      const hasEvery = value.everyMs !== undefined && value.everyMs !== null;
      const hasCron =
        value.cron !== undefined && value.cron !== null && value.cron !== "";
      if (hasEvery === hasCron) return { error: "Use one of everyMs or cron" };
      const graceMs =
        value.graceMs === undefined || value.graceMs === null
          ? 0
          : intField(value.graceMs, "graceMs", 0, DAY_MS);
      if (isFieldError(graceMs)) return graceMs;
      if (hasEvery) {
        const everyMs = intField(value.everyMs, "everyMs", 60_000, 31 * DAY_MS);
        if (isFieldError(everyMs)) return everyMs;
        return { kind: "missing", everyMs, graceMs };
      }
      const cron = typeof value.cron === "string" ? value.cron.trim() : "";
      if (!parseCron(cron))
        return { error: `Invalid cron expression: "${String(value.cron)}"` };
      if (!nextRun(cron))
        return { error: `"${cron}" never runs within a year` };
      return { kind: "missing", cron, graceMs };
    }
    case "deadline": {
      const warnDays = intField(value.warnDays, "warnDays", 1, 365);
      if (isFieldError(warnDays)) return warnDays;
      const failDays = intField(value.failDays, "failDays", 0, 365);
      if (isFieldError(failDays)) return failDays;
      if (failDays >= warnDays)
        return { error: "warnDays must be greater than failDays" };
      return { kind: "deadline", warnDays, failDays };
    }
    default:
      return {
        error:
          "Rule kind must be one of consecutive, rate, threshold, missing, deadline",
      };
  }
}

export function defaultRuleFor(kind: SignalSourceKind): SignalRule | null {
  switch (kind) {
    case "http":
      return { kind: "consecutive", failures: 3, recoveries: 2 };
    case "webhook":
      return { kind: "rate", windowMs: 300_000, atLeast: 5 };
    case "expiry":
      return { kind: "deadline", warnDays: 14, failDays: 3 };
    case "heartbeat":
      return null;
  }
}

// --- fields --------------------------------------------------------------

/**
 * Every caller-writable signal field and its validator, in the order errors
 * are reported. Fields not listed (id, createdBy, createdAt, updatedAt,
 * hookSecret) are never taken from caller input.
 */
const SIGNAL_FIELDS: Record<string, FieldValidator> = {
  name: (v) => {
    const name = typeof v === "string" ? v.trim() : "";
    if (!name) return { error: "Name is required" };
    if (name.length > MAX_NAME_CHARS)
      return { error: `Name can be at most ${MAX_NAME_CHARS} characters` };
    return name;
  },
  project: (v, ctx) => {
    if (typeof v !== "string" || !v.trim())
      return { error: "Project is required" };
    const project = v.trim();
    return ctx.projectExists(project)
      ? project
      : { error: `Unknown project "${project.slice(0, 128)}"` };
  },
  enabled: (v) => v !== false,
  source: (v) => validateSource(v),
  intervalMs: (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v))
      return { error: "intervalMs must be a whole number of milliseconds" };
    return v;
  },
  rule: (v) => validateRule(v),
  severity: (v) =>
    typeof v === "string" && (SEVERITIES as readonly string[]).includes(v)
      ? (v as Severity)
      : { error: `Severity must be one of ${SEVERITIES.join(", ")}` },
  provider: (v) => v === true || undefined,
  selfReported: (v) => v === true || undefined,
  dependsOn: async (v, ctx) => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || !v.every((id) => typeof id === "string"))
      return { error: "dependsOn must be a list of signal ids" };
    const ids = [...new Set(v as string[])];
    if (ids.length > MAX_DEPENDS_ON)
      return {
        error: `A signal can depend on at most ${MAX_DEPENDS_ON} signals`,
      };
    for (const id of ids) {
      if (ctx.selfId !== undefined && id === ctx.selfId)
        return { error: "A signal cannot depend on itself" };
      if (!(await ctx.signalExists(id)))
        return { error: `Unknown signal "${id.slice(0, 128)}"` };
    }
    return ids.length ? ids : undefined;
  },
  maintenance: (v) => validateMaintenanceWindows(v),
  impact: (v) => validateImpactFields(v),
  owner: (v, ctx) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return { error: "The owner must be a person" };
    const name = v.trim();
    if (!name) return undefined;
    if (name.length > MAX_NAME_CHARS)
      return { error: "The owner must be a person" };
    return ctx.resolveOwner ? ctx.resolveOwner(name) : name;
  },
  runOn: (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return { error: "runOn must be a runner id" };
    const runOn = v.trim();
    if (!runOn) return undefined;
    if (runOn.length > MAX_RUN_ON_CHARS)
      return { error: `runOn can be at most ${MAX_RUN_ON_CHARS} characters` };
    return runOn;
  },
};

/**
 * Validate the caller-writable fields present in `input`. A field is touched
 * only when the caller named it, so an update leaves the rest alone.
 */
export async function validateSignalInput(
  input: Record<string, unknown>,
  ctx: SignalValidationContext,
): Promise<{ fields: SignalFields; touched: Set<string> } | FieldError> {
  const fields: Record<string, unknown> = {};
  const touched = new Set<string>();
  for (const [field, validate] of Object.entries(SIGNAL_FIELDS)) {
    if (!(field in input)) continue;
    const value = await validate(input[field], ctx);
    if (isFieldError(value)) return value;
    fields[field] = value;
    touched.add(field);
  }
  return { fields: fields as SignalFields, touched };
}

/** Cross-field rules, run on the whole record before every write. Pure. */
export function normalizeSignal(next: Signal): Signal | FieldError {
  const out: Signal = { ...next };
  if (!out.name?.trim()) return { error: "Name is required" };
  if (!out.project?.trim()) return { error: "Project is required" };
  if (!out.source) return { error: "Source is required" };
  const kind = out.source.kind;

  if (!out.rule) {
    const rule = defaultRuleFor(kind);
    if (!rule) return { error: "A heartbeat needs a schedule" };
    out.rule = rule;
  }
  if (!RULES_FOR_SOURCE[kind].includes(out.rule.kind))
    return { error: `${out.rule.kind} does not fit a ${kind} signal` };

  const interval = INTERVALS[kind];
  if (interval) {
    const ms = out.intervalMs ?? interval.fallback;
    if (!isIntegerIn(ms, interval.min, interval.max))
      return {
        error: `intervalMs must be from ${interval.min} to ${interval.max} for a ${kind} signal`,
      };
    out.intervalMs = ms;
  } else {
    delete out.intervalMs;
  }

  if (out.provider && out.selfReported)
    return { error: "A signal cannot be both a provider and self-reported" };
  if (!out.provider) delete out.provider;
  if (!out.selfReported) delete out.selfReported;

  if (
    out.source.kind === "http" &&
    out.source.method === "HEAD" &&
    (out.source.json || out.source.expectBody)
  )
    return { error: "A HEAD check has no body to map or match" };

  if (out.dependsOn) {
    const deps = out.dependsOn.filter((id) => id !== out.id);
    if (deps.length) out.dependsOn = deps;
    else delete out.dependsOn;
  }
  if (!out.severity) out.severity = "major";
  if (out.maintenance === undefined) delete out.maintenance;
  if (out.impact === undefined) delete out.impact;
  else {
    const misfit = impactFitsSource(out.impact, out.source);
    if (misfit) return misfit;
  }
  if (out.runOn === undefined) delete out.runOn;
  return out;
}

// --- secrets -------------------------------------------------------------

export function isSecretHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    SECRET_HEADERS.has(lower) ||
    SECRET_HEADER_PARTS.some((part) => lower.includes(part))
  );
}

export function generateHookSecret(): string {
  return randomBytes(24).toString("hex");
}

export function hookPathFor(
  signal: Pick<Signal, "id" | "hookSecret" | "source">,
): string | undefined {
  const kind = signal.source.kind;
  if ((kind !== "webhook" && kind !== "heartbeat") || !signal.hookSecret)
    return undefined;
  return `/incident-hooks/${signal.id}/${signal.hookSecret}`;
}

function isSecretQueryName(name: string): boolean {
  let lower: string;
  try {
    lower = decodeURIComponent(name.replace(/\+/g, " ")).toLowerCase();
  } catch {
    lower = name.toLowerCase();
  }
  return (
    SECRET_QUERY_WORDS.some((word) => lower.includes(word)) ||
    lower.split(/[-_.]/).some((part) => SECRET_QUERY_PARTS.has(part))
  );
}

function decodedQueryValue(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** `[?&]name=value` pairs of a URL's query, before any fragment. */
const QUERY_PAIR = /([?&])([^=&#]*)=([^&#]*)/g;

function splitFragment(raw: string): [string, string] {
  const hash = raw.indexOf("#");
  return hash < 0 ? [raw, ""] : [raw.slice(0, hash), raw.slice(hash)];
}

/**
 * Replace the values of secret-looking query parameters (api_key, token,
 * key, secret, sig, signature, auth and the like) with {@link REDACTED}.
 * Works on the text, so every other byte of the URL is kept as it was.
 */
export function redactSecretQuery(raw: string): string {
  const [head, fragment] = splitFragment(raw);
  if (!head.includes("?")) return raw;
  const query = head.indexOf("?");
  return (
    head.slice(0, query) +
    head
      .slice(query)
      .replace(QUERY_PAIR, (pair, sep: string, name: string, value: string) =>
        value && isSecretQueryName(name) ? `${sep}${name}=${REDACTED}` : pair,
      ) +
    fragment
  );
}

function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    out[name] = isSecretHeader(name) ? REDACTED : value;
  return out;
}

/** The signal as it may leave the server: no hook secret, no secret header values. */
export function redactSignal(signal: Signal): RedactedSignal {
  const { hookSecret: _secret, ...rest } = signal;
  const out: RedactedSignal = { ...rest };
  const hookPath = hookPathFor(signal);
  if (hookPath) out.hookPath = hookPath;
  if (signal.source.kind === "http") {
    const source: HttpSource = {
      ...signal.source,
      url: redactSecretQuery(signal.source.url),
    };
    if (signal.source.headers)
      source.headers = redactHeaders(signal.source.headers);
    if (source.body !== undefined) source.body = REDACTED;
    out.source = source;
  }
  if (signal.impact?.kind === "http") {
    const impact = {
      ...signal.impact,
      url: redactSecretQuery(signal.impact.url),
    };
    if (signal.impact.headers)
      impact.headers = redactHeaders(signal.impact.headers);
    out.impact = impact;
  }
  return out;
}

type Restored<T> = T | { error: string };

export interface RestoreOptions {
  /** A test run: restore only for the stored method and path too. */
  sameRequest?: boolean;
}

function pathOf(raw: string): string | undefined {
  try {
    return new URL(raw).pathname;
  } catch {
    return undefined;
  }
}

function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether a value sent back redacted may take the stored one: only when the
 * stored source is http and points at the same origin as the new one (for a
 * test run, also the same method and path). A secret never follows a signal
 * to another address.
 */
function restoreCheck(
  stored: SignalSource | undefined,
  next: HttpSource,
  what: string,
  opts: RestoreOptions = {},
): { stored: HttpSource } | { error: string } {
  if (stored?.kind !== "http") return { error: `Enter the ${what} again` };
  const from = originOf(stored.url);
  if (from === undefined || from !== originOf(next.url))
    return { error: `Enter the ${what} again for the new address` };
  if (
    opts.sameRequest &&
    ((stored.method ?? "GET") !== (next.method ?? "GET") ||
      pathOf(stored.url) !== pathOf(next.url))
  )
    return { error: `Enter the ${what} again to test another method or path` };
  return { stored };
}

/**
 * Restore secret header values a client sent back as {@link REDACTED} from
 * the stored source (same name, case-insensitive). Only for the same origin;
 * a redacted value with nothing to restore is an error.
 */
export function restoreRedactedHeaders(
  stored: SignalSource | undefined,
  next: HttpSource,
  opts: RestoreOptions = {},
): Restored<{ headers?: Record<string, string> }> {
  if (!next.headers) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(next.headers)) {
    if (value !== REDACTED) {
      out[name] = value;
      continue;
    }
    const check = restoreCheck(stored, next, `${name} value`, opts);
    if ("error" in check) return check;
    const kept = Object.entries(check.stored.headers ?? {}).find(
      ([storedName]) => storedName.toLowerCase() === name.toLowerCase(),
    )?.[1];
    if (kept === undefined || kept === REDACTED)
      return { error: `Enter the ${name} value again` };
    out[name] = kept;
  }
  return Object.keys(out).length ? { headers: out } : {};
}

/** Raw query values per parameter name, in order. */
function queryValues(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const [head] = splitFragment(raw);
  const query = head.indexOf("?");
  if (query < 0) return out;
  for (const [, , name, value] of head.slice(query).matchAll(QUERY_PAIR)) {
    const list = out.get(name!) ?? [];
    list.push(value!);
    out.set(name!, list);
  }
  return out;
}

function restoreRedactedUrl(
  stored: SignalSource | undefined,
  next: HttpSource,
  opts: RestoreOptions,
): Restored<{ url: string }> {
  const [head, fragment] = splitFragment(next.url);
  const query = head.indexOf("?");
  if (query < 0) return { url: next.url };
  let storedValues: Map<string, string[]> | undefined;
  const used = new Map<string, number>();
  let failure: { error: string } | undefined;
  const rest = head
    .slice(query)
    .replace(QUERY_PAIR, (pair, sep: string, name: string, value: string) => {
      if (failure || decodedQueryValue(value) !== REDACTED) return pair;
      const check = restoreCheck(stored, next, `${name} value`, opts);
      if ("error" in check) {
        failure = check;
        return pair;
      }
      storedValues ??= queryValues(check.stored.url);
      const index = used.get(name) ?? 0;
      used.set(name, index + 1);
      const kept = storedValues.get(name)?.[index];
      if (kept === undefined || decodedQueryValue(kept) === REDACTED) {
        failure = { error: `Enter the ${name} value again` };
        return pair;
      }
      return `${sep}${name}=${kept}`;
    });
  return failure ?? { url: head.slice(0, query) + rest + fragment };
}

/**
 * Restore every value a client sent back as {@link REDACTED} (secret query
 * parameters, secret headers, the body) from the stored source. Use it on
 * every write and on every test run of a draft against a stored signal.
 */
export function restoreRedactedSource(
  stored: SignalSource | undefined,
  next: SignalSource,
  opts: RestoreOptions = {},
): Restored<{ source: SignalSource }> {
  if (next.kind !== "http") return { source: next };
  const url = restoreRedactedUrl(stored, next, opts);
  if ("error" in url) return url;
  const headers = restoreRedactedHeaders(stored, next, opts);
  if ("error" in headers) return headers;
  const source: HttpSource = { ...next, url: url.url };
  if (headers.headers) source.headers = headers.headers;
  else delete source.headers;
  if (next.body === REDACTED) {
    const check = restoreCheck(stored, next, "body", opts);
    if ("error" in check) return check;
    if (check.stored.body === undefined || check.stored.body === REDACTED)
      return { error: "Enter the body again" };
    source.body = check.stored.body;
  }
  return { source };
}

type HttpImpact = Extract<ImpactSource, { kind: "http" }>;

function impactRequest(impact: HttpImpact): HttpSource {
  return {
    kind: "http",
    url: impact.url,
    ...(impact.headers ? { headers: impact.headers } : {}),
  };
}

function sameOrigin(a: string, b: string): boolean {
  const from = originOf(a);
  return from !== undefined && from === originOf(b);
}

/**
 * Restore the secret query values and header values of an http impact sent
 * back as {@link REDACTED}, from the stored impact, or else from the stored
 * signal's own http source, only for the same origin. `fromSource` names
 * the fields (`query.<name>`, `headers.<name>`, never values) taken from the
 * source, for the audit.
 */
export function restoreRedactedImpact(
  stored: ImpactSource | undefined,
  next: ImpactSource,
  storedSource?: SignalSource,
): Restored<{ impact: ImpactSource; fromSource?: string[] }> {
  if (next.kind !== "http") return { impact: next };
  const request = impactRequest(next);
  const fromImpact =
    stored?.kind === "http" ? impactRequest(stored) : undefined;
  const fromSource = storedSource?.kind === "http" ? storedSource : undefined;
  const base =
    fromImpact && sameOrigin(fromImpact.url, next.url)
      ? fromImpact
      : fromSource && sameOrigin(fromSource.url, next.url)
        ? fromSource
        : (fromImpact ?? fromSource);
  const inImpact = (failure: { error: string }) => ({
    error: failure.error.replace(/^Enter the /, "Enter the impact "),
  });
  const url = restoreRedactedUrl(base, request, {});
  if ("error" in url) return inImpact(url);
  const headers = restoreRedactedHeaders(base, request);
  if ("error" in headers) return inImpact(headers);
  const impact: HttpImpact = { ...next, url: url.url };
  if (headers.headers) impact.headers = headers.headers;
  else delete impact.headers;
  const restored = restoredSecretFields(request);
  return base === fromSource && restored.length
    ? { impact, fromSource: restored }
    : { impact };
}

/** The fields of a draft source sent back as {@link REDACTED}, by name only
 *  (`query.<name>`, `headers.<name>`, `body`): what a restore fills in. */
export function restoredSecretFields(next: SignalSource): string[] {
  if (next.kind !== "http") return [];
  const out: string[] = [];
  for (const [name, values] of queryValues(next.url))
    if (values.some((value) => decodedQueryValue(value) === REDACTED))
      out.push(`query.${name}`);
  for (const [name, value] of Object.entries(next.headers ?? {}))
    if (value === REDACTED) out.push(`headers.${name}`);
  if (next.body === REDACTED) out.push("body");
  return out;
}

/**
 * The secret values a source sends: secret query values (as written and
 * decoded), secret header values and the body. Whatever comes back must not
 * carry them out of the server.
 */
export function sourceSecretValues(source: HttpSource): string[] {
  const out: string[] = [];
  for (const [name, values] of queryValues(source.url))
    if (isSecretQueryName(name))
      for (const value of values) out.push(value, decodedQueryValue(value));
  for (const [name, value] of Object.entries(source.headers ?? {}))
    if (isSecretHeader(name)) out.push(value);
  if (source.body !== undefined) out.push(source.body);
  return out.filter((value) => value && value !== REDACTED);
}
