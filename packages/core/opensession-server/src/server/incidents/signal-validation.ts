// Signal validation: caller input → Signal fields, cross-field rules, header
// redaction and hook secrets. Pure apart from the context callbacks.
import { randomBytes } from "node:crypto";
import {
  SEVERITIES,
  type ExpirySource,
  type HttpSource,
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
import { validateMaintenanceWindows } from "./maintenance";

export interface SignalValidationContext {
  projectExists(id: string): boolean;
  signalExists(id: string): Promise<boolean>;
  /** The signal being updated; it cannot depend on itself. */
  selfId?: string;
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
  for (const [name, raw] of entries) {
    if (!HEADER_NAME.test(name))
      return { error: `Invalid header name "${name.slice(0, 64)}"` };
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

/** The signal as it may leave the server: no hook secret, no secret header values. */
export function redactSignal(signal: Signal): RedactedSignal {
  const { hookSecret: _secret, ...rest } = signal;
  const out: RedactedSignal = { ...rest };
  const hookPath = hookPathFor(signal);
  if (hookPath) out.hookPath = hookPath;
  if (signal.source.kind === "http" && signal.source.headers) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(signal.source.headers))
      headers[name] = isSecretHeader(name) ? REDACTED : value;
    out.source = { ...signal.source, headers };
  }
  return out;
}

/**
 * Restore secret header values a client sent back as {@link REDACTED}: the
 * stored value for the same name (case-insensitive) wins; without one the
 * header is dropped.
 */
export function mergeRedactedHeaders(
  next: Record<string, string> | undefined,
  stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!next) return undefined;
  const storedByName = new Map<string, string>();
  for (const [name, value] of Object.entries(stored ?? {}))
    storedByName.set(name.toLowerCase(), value);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(next)) {
    if (value !== REDACTED) {
      out[name] = value;
      continue;
    }
    const kept = storedByName.get(name.toLowerCase());
    if (kept !== undefined && kept !== REDACTED) out[name] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}
