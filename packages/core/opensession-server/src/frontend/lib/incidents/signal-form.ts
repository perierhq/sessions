// The signal editor's draft: what each field holds while it is edited, the
// defaults per kind, and the round trip to and from the signal routes. The
// server stays the authority; these checks only stop the obvious mistakes
// before a round trip. Pure.
import type {
  HttpSource,
  ImpactSource,
  JsonMapping,
  MaintenanceWindow,
  Severity,
  SignalRule,
  SignalSource,
  SignalSourceKind,
  SignalView,
} from "../../../shared/incidents";
import type { SignalInput } from "../api/incidents";
import { WEBHOOK_BASE_URL } from "../brand";

/** What the server sends in place of a stored secret, and keeps it when
 *  sent back unchanged (server `signal-validation.ts`). */
export const REDACTED = "[redacted]";

export interface HeaderDraft {
  name: string;
  value: string;
  /** Stored and hidden: the value is `[redacted]` until one is typed. */
  hidden?: boolean;
}

export interface ImpactDraft {
  kind: "none" | "http" | "events";
  url: string;
  headers: HeaderDraft[];
  countPath: string;
  peoplePath: string;
  count: "fail-events" | "value-sum";
  noun: string;
  label: string;
}

export interface SignalDraft {
  id?: string;
  /** Webhook and heartbeat signals, once saved. */
  hookPath?: string;
  name: string;
  project: string;
  enabled: boolean;
  severity: Severity;
  kind: SignalSourceKind;
  url: string;
  method: "GET" | "HEAD" | "POST";
  headers: HeaderDraft[];
  body: string;
  expectStatus: string;
  contains: string;
  regex: string;
  json?: JsonMapping;
  timeoutMs: number;
  webhookMapping?: JsonMapping;
  schedule: "every" | "cron";
  everyMs: number;
  cron: string;
  graceMs: number;
  host: string;
  port: string;
  rule: SignalRule;
  intervalMs: number;
  provider: boolean;
  selfReported: boolean;
  dependsOn: string[];
  runOn: string;
  maintenance: MaintenanceWindow[];
  impact?: ImpactDraft;
}

/** A field the editor can point an error at. */
export type DraftField =
  | keyof SignalDraft
  | "impactNoun"
  | "impactLabel"
  | "impactUrl"
  | "impactCountPath"
  | "impactHeaders"
  | "impactPeoplePath";

/** What the editor sends: a signal's writable fields, where `impact: null`
 *  clears a stored impact and `runOn: ""` checks from this server. */
export type SignalWrite = SignalInput;

export type DraftResult =
  | { input: SignalWrite }
  | { field: DraftField; error: string };

export const RULE_KINDS_FOR: Record<SignalSourceKind, SignalRule["kind"][]> = {
  http: ["consecutive", "rate", "threshold"],
  webhook: ["consecutive", "rate", "threshold"],
  heartbeat: ["missing"],
  expiry: ["deadline"],
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How often a check may run, per kind (server bounds: http 30 s to a day,
 *  expiry 1 h to 7 days). */
export const INTERVALS = {
  http: [30_000, 60_000, 120_000, 300_000, 900_000, 3_600_000],
  expiry: [3_600_000, 21_600_000, 86_400_000],
} as const;

/** How often a job is expected to check in. */
export const HEARTBEAT_INTERVALS = [
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  24 * HOUR_MS,
  7 * 24 * HOUR_MS,
];

export const GRACE_CHOICES = [0, 5, 10, 30, 60].map((m) => m * MINUTE_MS);
export const TIMEOUT_CHOICES = [5_000, 10_000, 20_000, 30_000, 60_000];

/** A fresh rule of `kind`, with the numbers a first signal usually wants. */
export function defaultRule(kind: SignalRule["kind"]): SignalRule {
  switch (kind) {
    case "consecutive":
      return { kind: "consecutive", failures: 3, recoveries: 2 };
    case "rate":
      return { kind: "rate", windowMs: 300_000, atLeast: 5 };
    case "threshold":
      return { kind: "threshold", above: 1500, forMs: 300_000 };
    case "missing":
      return { kind: "missing", everyMs: HOUR_MS, graceMs: 10 * MINUTE_MS };
    case "deadline":
      return { kind: "deadline", warnDays: 14, failDays: 3 };
  }
}

const KIND_RULE: Record<SignalSourceKind, SignalRule["kind"]> = {
  http: "consecutive",
  webhook: "rate",
  heartbeat: "missing",
  expiry: "deadline",
};

export function defaultDraft(
  kind: SignalSourceKind,
  project: string,
): SignalDraft {
  return {
    name: "",
    project,
    enabled: true,
    severity: "major",
    kind,
    url: "",
    method: "GET",
    headers: [],
    body: "",
    expectStatus: "",
    contains: "",
    regex: "",
    timeoutMs: 10_000,
    schedule: "every",
    everyMs: HOUR_MS,
    cron: "",
    graceMs: 10 * MINUTE_MS,
    host: "",
    port: "443",
    rule: defaultRule(KIND_RULE[kind]),
    intervalMs: kind === "expiry" ? 21_600_000 : 60_000,
    provider: false,
    selfReported: false,
    dependsOn: [],
    runOn: "",
    maintenance: [],
  };
}

/** A new kind of check under the same name: the basics stay, the source
 *  and rule start over at the new kind's defaults. */
export function switchKind(
  d: SignalDraft,
  kind: SignalSourceKind,
): SignalDraft {
  const next = defaultDraft(kind, d.project);
  next.name = d.name;
  next.severity = d.severity;
  next.enabled = d.enabled;
  next.dependsOn = d.dependsOn;
  next.maintenance = d.maintenance;
  if (d.id) next.id = d.id;
  if (d.impact && !(d.impact.kind === "events" && kind !== "webhook"))
    next.impact = d.impact;
  return next;
}

function headerDrafts(headers: Record<string, string> | undefined) {
  return Object.entries(headers ?? {}).map(([name, value]): HeaderDraft =>
    value === REDACTED ? { name, value, hidden: true } : { name, value },
  );
}

function impactDraft(
  impact: ImpactSource | undefined,
): ImpactDraft | undefined {
  if (!impact) return undefined;
  const base: ImpactDraft = {
    kind: impact.kind,
    url: "",
    headers: [],
    countPath: "",
    peoplePath: "",
    count: "fail-events",
    noun: impact.noun,
    label: impact.label,
  };
  if (impact.kind === "events") base.count = impact.count;
  else {
    base.url = impact.url;
    base.headers = headerDrafts(impact.headers);
    base.countPath = impact.countPath;
    base.peoplePath = impact.peoplePath ?? "";
  }
  return base;
}

export function draftFromSignal(signal: SignalView): SignalDraft {
  const d = defaultDraft(signal.source.kind, signal.project);
  d.id = signal.id;
  if (signal.hookPath) d.hookPath = signal.hookPath;
  d.name = signal.name;
  d.enabled = signal.enabled;
  d.severity = signal.severity;
  d.rule = signal.rule;
  if (signal.intervalMs) d.intervalMs = signal.intervalMs;
  d.provider = !!signal.provider;
  d.selfReported = !!signal.selfReported;
  d.dependsOn = signal.dependsOn ?? [];
  d.runOn = signal.runOn ?? "";
  d.maintenance = signal.maintenance ?? [];
  const impact = impactDraft(signal.impact);
  if (impact) d.impact = impact;
  const source = signal.source;
  switch (source.kind) {
    case "http":
      d.url = source.url;
      d.method = source.method ?? "GET";
      d.headers = headerDrafts(source.headers);
      d.body = source.body ?? "";
      d.expectStatus = (source.expectStatus ?? []).join(", ");
      d.contains = source.expectBody?.contains ?? "";
      d.regex = source.expectBody?.regex ?? "";
      if (source.json) d.json = source.json;
      d.timeoutMs = source.timeoutMs ?? 10_000;
      break;
    case "webhook":
      if (source.mapping) d.webhookMapping = source.mapping;
      break;
    case "heartbeat":
      if (signal.rule.kind === "missing") {
        d.schedule = signal.rule.cron ? "cron" : "every";
        d.everyMs = signal.rule.everyMs ?? HOUR_MS;
        d.cron = signal.rule.cron ?? "";
        d.graceMs = signal.rule.graceMs;
      }
      break;
    case "expiry":
      d.host = source.host;
      d.port = String(source.port ?? 443);
      break;
  }
  return d;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const HTTP_URL = /^https?:\/\/\S+$/i;

function isHttpUrl(url: string): boolean {
  if (!HTTP_URL.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Header rows as the wire wants them, or the first bad name. Empty rows
 *  are dropped; a hidden value nobody retyped goes back as `[redacted]`. */
function headerRecord(
  rows: HeaderDraft[],
): Record<string, string> | null | "invalid" {
  const out: Record<string, string> = {};
  let any = false;
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!HEADER_NAME.test(name)) return "invalid";
    out[name] = row.hidden && !row.value ? REDACTED : row.value;
    any = true;
  }
  return any ? out : null;
}

function statusList(text: string): number[] | null | "invalid" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const codes: number[] = [];
  for (const part of trimmed.split(",")) {
    const code = part.trim();
    if (!/^\d{3}$/.test(code)) return "invalid";
    const n = Number(code);
    if (n < 100 || n > 599) return "invalid";
    codes.push(n);
  }
  return codes;
}

function impactInput(
  d: SignalDraft,
):
  | { impact: ImpactSource | null | undefined }
  | { field: DraftField; error: string } {
  const draft = d.impact;
  if (!draft) return { impact: undefined };
  if (draft.kind === "none") return { impact: null };
  const noun = draft.noun.trim();
  const label = draft.label.trim();
  if (!noun)
    return {
      field: "impactNoun",
      error: "Say what the number counts, like searches failed",
    };
  if (!label)
    return {
      field: "impactLabel",
      error: "Name where it is counted, like the request log",
    };
  if (draft.kind === "events")
    return { impact: { kind: "events", count: draft.count, noun, label } };
  const url = draft.url.trim();
  if (!isHttpUrl(url))
    return { field: "impactUrl", error: "Use an http or https URL" };
  const countPath = draft.countPath.trim();
  if (!countPath)
    return {
      field: "impactCountPath",
      error: "Give the JSON path of the count",
    };
  const headers = headerRecord(draft.headers);
  if (headers === "invalid")
    return {
      field: "impactHeaders",
      error: "Header names use letters, digits and - only",
    };
  const impact: Extract<ImpactSource, { kind: "http" }> = {
    kind: "http",
    url,
    countPath,
    noun,
    label,
  };
  if (headers) impact.headers = headers;
  const peoplePath = draft.peoplePath.trim();
  if (peoplePath) impact.peoplePath = peoplePath;
  return { impact };
}

function sourceAndRule(
  d: SignalDraft,
):
  | { source: SignalSource; rule: SignalRule }
  | { field: DraftField; error: string } {
  switch (d.kind) {
    case "http": {
      const url = d.url.trim();
      if (!isHttpUrl(url))
        return { field: "url", error: "Use an http or https URL" };
      const headers = headerRecord(d.headers);
      if (headers === "invalid")
        return {
          field: "headers",
          error: "Header names use letters, digits and - only",
        };
      const expectStatus = statusList(d.expectStatus);
      if (expectStatus === "invalid")
        return {
          field: "expectStatus",
          error: "Use status codes like 200, 204",
        };
      const source: HttpSource = { kind: "http", url, method: d.method };
      if (headers) source.headers = headers;
      if (d.method === "POST" && d.body) source.body = d.body;
      if (expectStatus) source.expectStatus = expectStatus;
      const expectBody: NonNullable<HttpSource["expectBody"]> = {};
      if (d.contains) expectBody.contains = d.contains;
      if (d.regex) expectBody.regex = d.regex;
      if (d.method !== "HEAD" && (d.contains || d.regex))
        source.expectBody = expectBody;
      if (d.json && d.method !== "HEAD") source.json = d.json;
      source.timeoutMs = d.timeoutMs;
      return { source, rule: d.rule };
    }
    case "webhook": {
      const source: SignalSource = { kind: "webhook" };
      if (d.webhookMapping) source.mapping = d.webhookMapping;
      return { source, rule: d.rule };
    }
    case "heartbeat": {
      if (d.schedule === "cron") {
        const cron = d.cron.trim();
        if (!cron) return { field: "cron", error: "Enter a cron schedule" };
        return {
          source: { kind: "heartbeat" },
          rule: { kind: "missing", cron, graceMs: d.graceMs },
        };
      }
      return {
        source: { kind: "heartbeat" },
        rule: { kind: "missing", everyMs: d.everyMs, graceMs: d.graceMs },
      };
    }
    case "expiry": {
      const host = d.host.trim();
      if (!host) return { field: "host", error: "Enter a host name" };
      const port = Number(d.port.trim());
      if (!/^\d+$/.test(d.port.trim()) || port < 1 || port > 65535)
        return { field: "port", error: "Use a port from 1 to 65535" };
      return {
        source: { kind: "expiry", target: "tls", host, port },
        rule: d.rule,
      };
    }
  }
}

/** The draft as the routes take it, or the first field to fix. Every
 *  optional field is sent, so an edit can also clear it. */
export function draftToInput(d: SignalDraft): DraftResult {
  const name = d.name.trim();
  if (!name) return { field: "name", error: "Give the signal a name" };
  const built = sourceAndRule(d);
  if ("field" in built) return built;
  const impact = impactInput(d);
  if ("field" in impact) return impact;
  const input: SignalWrite = {
    name,
    project: d.project,
    enabled: d.enabled,
    severity: d.severity,
    source: built.source,
    rule: built.rule,
    provider: d.provider,
    selfReported: d.selfReported,
    dependsOn: d.dependsOn,
    runOn: d.runOn,
    maintenance: d.maintenance,
  };
  if (d.kind === "http" || d.kind === "expiry") input.intervalMs = d.intervalMs;
  if (impact.impact !== undefined) input.impact = impact.impact;
  return { input };
}

/** Where a webhook posts, or a job checks in. */
export function hookUrl(hookPath: string): string {
  return `${WEBHOOK_BASE_URL.replace(/\/$/, "")}${hookPath}`;
}

/** An interval as a select option: "30 s", "2 min", "6 h", "7 days". */
export function intervalLabel(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} min`;
  if (ms < 24 * HOUR_MS) return `${Math.round(ms / HOUR_MS)} h`;
  const days = Math.round(ms / (24 * HOUR_MS));
  return days === 1 ? "1 day" : `${days} days`;
}

/** Interval options, with the stored value kept when it is not a choice. */
export function intervalOptions(
  choices: readonly number[],
  current: number,
): Array<{ value: string; label: string }> {
  const values = choices.includes(current)
    ? [...choices]
    : [...choices, current].sort((a, b) => a - b);
  return values.map((ms) => ({ value: String(ms), label: intervalLabel(ms) }));
}

/** The signal kinds, as "What to watch" offers them. */
export const KIND_LABELS: Record<SignalSourceKind, string> = {
  http: "A URL",
  webhook: "Incoming events",
  heartbeat: "A job that checks in",
  expiry: "A certificate",
};

export const RULE_LABELS: Record<SignalRule["kind"], string> = {
  consecutive: "In a row",
  rate: "Rate",
  threshold: "Threshold",
  missing: "Missed check-in",
  deadline: "Days left",
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};
