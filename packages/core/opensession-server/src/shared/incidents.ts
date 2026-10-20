// Wire types for signals, observations and incidents, shared by the server
// and the frontend. Types, constant lists and small guards only.

export const SIGNAL_STATES = [
  "ok",
  "slow",
  "failing",
  "flaky",
  "upcoming",
  "external",
  "unknown",
] as const;
export type SignalState = (typeof SIGNAL_STATES)[number];

export type ObservationResult = "ok" | "fail" | "unknown";

export interface Observation {
  at: string;
  result: ObservationResult;
  value?: number;
  detail: string;
  sourceUrl?: string;
  /** A JSON component drawn as its own lane. */
  lane?: string;
}

export const SEVERITIES = ["critical", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type JsonScalar = string | number | boolean | null;

export interface JsonResultMapping {
  path: string;
  ok: JsonScalar[];
  fail?: JsonScalar[];
}

export interface JsonLaneMapping {
  items: string;
  name: string;
  result: JsonResultMapping;
  value?: string;
}

export const STATUS_PAGE_PRESETS = [
  "statuspage",
  "instatus",
  "betterstack",
  "kener",
  "cachet",
  "plain",
] as const;
export type StatusPagePreset = (typeof STATUS_PAGE_PRESETS)[number];

/** Setup notes shown next to a preset, where its endpoint needs one. */
export const STATUS_PAGE_PRESET_HINTS: Readonly<
  Partial<Record<StatusPagePreset, string>>
> = {
  cachet:
    "Point it at /api/v1/components. Cachet returns one page of components at a time; add ?per_page=100 (or more) so every component is counted.",
};

export interface JsonMapping {
  preset?: StatusPagePreset;
  result?: JsonResultMapping;
  value?: string;
  detail?: string;
  lanes?: JsonLaneMapping;
  aggregate?: "worst-lane";
  lanesInclude?: string[];
}

export interface HttpSource {
  kind: "http";
  url: string;
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  expectStatus?: number[];
  expectBody?: { contains?: string; regex?: string };
  json?: JsonMapping;
  timeoutMs?: number;
}

export interface WebhookSource {
  kind: "webhook";
  mapping?: JsonMapping;
}

export interface HeartbeatSource {
  kind: "heartbeat";
}

export interface ExpirySource {
  kind: "expiry";
  target: "tls";
  host: string;
  port?: number;
}

export type SignalSource =
  | HttpSource
  | WebhookSource
  | HeartbeatSource
  | ExpirySource;
export type SignalSourceKind = SignalSource["kind"];

export type SignalRule =
  | { kind: "consecutive"; failures: number; recoveries?: number }
  | { kind: "rate"; windowMs: number; atLeast: number; ratio?: number }
  | {
      kind: "threshold";
      above: number;
      forMs: number;
      failingAbove?: number;
      recoveries?: number;
    }
  | {
      kind: "missing";
      everyMs?: number;
      /** 5-field cron, evaluated in UTC. */
      cron?: string;
      graceMs: number;
    }
  | { kind: "deadline"; warnDays: number; failDays: number };

/**
 * `start`/`end` are ISO instants for `once` and `HH:MM` wall-clock times for
 * `weekly`. Weekly `days` use 0 = Sunday.
 */
export type MaintenanceWindow =
  | { kind: "once"; start: string; end: string; note?: string }
  | {
      kind: "weekly";
      days: number[];
      start: string;
      end: string;
      timeZone: string;
      note?: string;
    };

export interface Signal {
  id: string;
  name: string;
  project: string;
  enabled: boolean;
  source: SignalSource;
  intervalMs?: number;
  rule: SignalRule;
  severity: Severity;
  provider?: boolean;
  selfReported?: boolean;
  dependsOn?: string[];
  maintenance?: MaintenanceWindow[];
  /** Runner id; stored only, every source runs locally for now. */
  runOn?: string;
  hookSecret?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type RedactedSignal = Omit<Signal, "hookSecret"> & { hookPath?: string };

export interface SignalEvaluation {
  signalId: string;
  state: SignalState;
  since: string;
  at: string;
  reason: string;
  inMaintenance: boolean;
  lastObservationAt?: string;
}

export interface SignalView extends RedactedSignal {
  evaluation: SignalEvaluation | null;
  lastObservation?: Observation;
  nextRunAt?: string;
}

export const INCIDENT_STATES = [
  "heads-up",
  "investigating",
  "fix-ready",
  "veto",
  "deploying",
  "watching",
  "resolved",
  "needs-you",
  "paused",
  "waiting-on-provider",
  "rolled-back",
  "closed-without-action",
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const TERMINAL_INCIDENT_STATES = [
  "resolved",
  "closed-without-action",
] as const;

export const SIDE_INCIDENT_STATES = [
  "needs-you",
  "paused",
  "waiting-on-provider",
  "rolled-back",
  "closed-without-action",
] as const;

export type FixedBy =
  | "agents"
  | "agents-with-you"
  | "by-hand"
  | "provider-recovered";

export interface IncidentOpener {
  kind: "rule" | "automation" | "agent" | "owner";
  ref?: string;
}

export type IncidentEventKind =
  | "opened"
  | "state"
  | "reopened"
  | "signal-attached"
  | "signal-state"
  | "finding";

export type StripMarkerKind =
  | "detected"
  | "sent-back"
  | "fix-ready"
  | "released"
  | "deploy"
  | "rolled-back"
  | "resolved"
  | "reopened";

export interface IncidentEvent {
  id: string;
  at: string;
  kind: IncidentEventKind;
  by: string;
  detail: string;
  from?: IncidentState;
  to?: IncidentState;
  signalId?: string;
  signalState?: SignalState;
  marker?: StripMarkerKind;
}

export interface IncidentFinding {
  id: string;
  kind: "disagreement" | "external";
  at: string;
  signalId: string;
  againstSignalId?: string;
  detail: string;
  resolvedAt?: string;
}

export interface Incident {
  id: string;
  project: string;
  title: string;
  state: IncidentState;
  resumeState?: IncidentState;
  severity: Severity;
  owner: string;
  openedBy: IncidentOpener;
  signalIds: string[];
  primarySignalId: string;
  openedAt: string;
  updatedAt: string;
  lastProblemAt: string;
  closedAt?: string;
  fixedBy?: FixedBy;
  findings: IncidentFinding[];
  events: IncidentEvent[];
  droppedEvents: number;
}

export type IncidentSummary = Omit<Incident, "events"> & {
  eventCount: number;
  lastEvent?: IncidentEvent;
};

export interface StripBar {
  start: string;
  end: string;
  result: ObservationResult | null;
  count: number;
  value?: number;
  sample?: Observation;
}

export interface StripLane {
  id: string;
  signalId: string;
  lane?: string;
  label: string;
  bars: StripBar[];
}

export interface StripMarker {
  at: string;
  kind: StripMarkerKind;
  label: string;
  incidentId: string;
}

export interface StripResponse {
  from: string;
  to: string;
  bucketMs: number;
  lanes: StripLane[];
  markers: StripMarker[];
  nextRunAt?: string;
}

const SIGNAL_STATE_SET: ReadonlySet<string> = new Set(SIGNAL_STATES);
const INCIDENT_STATE_SET: ReadonlySet<string> = new Set(INCIDENT_STATES);
const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(
  TERMINAL_INCIDENT_STATES,
);

export function isSignalState(v: unknown): v is SignalState {
  return typeof v === "string" && SIGNAL_STATE_SET.has(v);
}

export function isIncidentState(v: unknown): v is IncidentState {
  return typeof v === "string" && INCIDENT_STATE_SET.has(v);
}

export function isTerminalIncidentState(s: IncidentState): boolean {
  return TERMINAL_STATE_SET.has(s);
}

export function isOpenIncident(i: Pick<Incident, "state">): boolean {
  return !isTerminalIncidentState(i.state);
}

const HOUR_MS = 3_600_000;
const DEFAULT_INTERVAL_MS = { http: 60_000, expiry: 6 * HOUR_MS } as const;

/** How often a signal is expected to produce an observation. */
export function stripIntervalMs(
  signal: Pick<Signal, "source" | "rule" | "intervalMs">,
): number {
  switch (signal.source.kind) {
    case "http":
    case "expiry":
      return signal.intervalMs ?? DEFAULT_INTERVAL_MS[signal.source.kind];
    case "heartbeat":
      return (signal.rule.kind === "missing" && signal.rule.everyMs) || HOUR_MS;
    case "webhook":
      return 60_000;
  }
}
