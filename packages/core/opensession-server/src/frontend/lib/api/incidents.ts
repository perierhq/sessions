// Typed client for the incident routes: signals, incidents and strips
// (routes/incidents.ts), project settings, pairing, decisions and the agent
// audit (routes/incident-response.ts), and access settings
// (routes/incident-access.ts). The one place to follow a server rename.
//
// The response and access routes may be absent on a server that does not
// run them: their reads resolve `null` on a 404 so the UI can render what it
// has. Writes always throw.

import type { HttpPreview } from "../../../server/incidents/sources/http";
import type { ProductionRunnerView } from "../../../server/incidents/response/runners";
import type { RoleModels } from "../../../server/incidents/response/models";
import type {
  AccessPreview,
  AccessProfileFields,
  IncidentAccessSettingsView,
  IncidentAgentRole,
  IncidentAgentsAccessView,
  ProjectAccessGrants,
} from "../../../shared/incident-access";
import type {
  AgentRun,
  IncidentProjectSettings,
  LedgerEntry,
  NightRule,
  OwnerDecision,
  ProjectSpend,
  RedactedProjectSettings,
} from "../../../shared/incident-response";
import type {
  Incident,
  IncidentSummary,
  Observation,
  Signal,
  SignalSource,
  SignalView,
  StripResponse,
} from "../../../shared/incidents";
import { ApiError, request } from "./request";

export type { ProductionRunnerView, RoleModels };

export type SignalInput = Partial<
  Pick<
    Signal,
    | "name"
    | "project"
    | "enabled"
    | "source"
    | "intervalMs"
    | "rule"
    | "severity"
    | "provider"
    | "selfReported"
    | "dependsOn"
    | "maintenance"
    | "impact"
    | "runOn"
  >
>;

export interface SignalTestResult {
  observations: Observation[];
  preview?: HttpPreview;
  /** Webhook drafts: what each mapping path matched in the payload. */
  matches?: Record<string, unknown[]>;
}

export interface SignalTestInput {
  source: SignalSource;
  /** Webhook drafts: the payload to map. */
  payload?: string;
  provider?: boolean;
  /** Restores `[redacted]` values from this stored signal. */
  signalId?: string;
}

export interface ProjectSettingsView {
  settings: RedactedProjectSettings;
  runners: ProductionRunnerView[];
  models: RoleModels | { error: string };
  spend: ProjectSpend;
}

export type ProjectSettingsInput = Partial<
  Pick<
    IncidentProjectSettings,
    | "agentsPaused"
    | "autonomy"
    | "vetoMs"
    | "watchMs"
    | "maxRounds"
    | "neverWithoutYou"
    | "budget"
    | "agents"
    | "productionRunners"
    | "actions"
  >
> & { night?: NightRule | null };

export interface ProductionPairing {
  code: string;
  expiresAt: number;
  command: string;
}

export interface AgentToolCall {
  at: string;
  tool: string;
  summary: string;
}

/** One agent in "What the agents did" (routes/incident-response.ts). */
export interface AgentAuditAgent {
  role: AgentRun["role"];
  round: number;
  attempt: number;
  sessionId: string;
  model: string;
  provider: string;
  independence?: AgentRun["independence"];
  independenceLabel?: string;
  /** The agent's access summary at spawn. */
  access: string;
  workspace: AgentRun["workspace"];
  workspaceLabel: string;
  status: AgentRun["status"];
  costUsd: number;
  toolCalls: AgentToolCall[];
}

export interface AgentAuditView {
  ledger: LedgerEntry[];
  droppedLedger: number;
  agents: AgentAuditAgent[];
}

export interface AccessPreviewInput {
  project: string;
  role: IncidentAgentRole;
  signalId?: string;
  draft?: unknown;
}

const seg = encodeURIComponent;

/** A route answering 404: that part of the server is not installed (or the
 *  thing asked for does not exist), never an error to show. */
export function isSeamMissing(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404;
}

async function orNull<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (isSeamMissing(error)) return null;
    throw error;
  }
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ── Signals and incidents ──

export async function fetchSignals(): Promise<SignalView[]> {
  const body = await request<{ signals: SignalView[] }>("/incident-signals", {
    label: "Failed to load signals",
  });
  return body.signals;
}

export function fetchSignal(id: string): Promise<SignalView> {
  return request<SignalView>(`/incident-signals/${seg(id)}`, {
    label: "Failed to load the signal",
  });
}

export function createSignalApi(input: SignalInput): Promise<SignalView> {
  return request<SignalView>("/incident-signals", {
    method: "POST",
    body: input,
    label: "Failed to add the signal",
  });
}

export function updateSignalApi(
  id: string,
  input: SignalInput,
): Promise<SignalView> {
  return request<SignalView>(`/incident-signals/${seg(id)}`, {
    method: "PUT",
    body: input,
    label: "Failed to save the signal",
  });
}

export async function deleteSignalApi(id: string): Promise<void> {
  await request<{ ok: true }>(`/incident-signals/${seg(id)}`, {
    method: "DELETE",
    label: "Failed to delete the signal",
  });
}

export function testSignalApi(
  body: SignalTestInput,
): Promise<SignalTestResult> {
  return request<SignalTestResult>("/incident-signals/test", {
    method: "POST",
    body,
    label: "Test run failed",
  });
}

export function fetchSignalStrip(
  id: string,
  range?: { from: string; to: string },
): Promise<StripResponse> {
  return request<StripResponse>(
    `/incident-signals/${seg(id)}/strip${query({ from: range?.from, to: range?.to })}`,
    { label: "Failed to load the strip" },
  );
}

export async function fetchIncidents(
  filter: { status?: "open" | "closed" | "all"; project?: string } = {},
): Promise<IncidentSummary[]> {
  const body = await request<{ incidents: IncidentSummary[] }>(
    `/incidents${query({ status: filter.status, project: filter.project })}`,
    { label: "Failed to load incidents" },
  );
  return body.incidents;
}

export function fetchIncident(id: string): Promise<Incident> {
  return request<Incident>(`/incidents/${seg(id)}`, {
    label: "Failed to load the incident",
  });
}

export function fetchIncidentStrip(id: string): Promise<StripResponse> {
  return request<StripResponse>(`/incidents/${seg(id)}/strip`, {
    label: "Failed to load the strip",
  });
}

// ── Access (absent: null) ──

const accessPath = (project: string) => `/incident-access/${seg(project)}`;

export function fetchAccessSettings(
  project: string,
): Promise<IncidentAccessSettingsView | null> {
  return orNull(
    request<IncidentAccessSettingsView>(accessPath(project), {
      label: "Failed to load access settings",
    }),
  );
}

export function putAccessGrants(
  project: string,
  grants: ProjectAccessGrants,
  expectedRevision: number,
): Promise<IncidentAccessSettingsView> {
  return request<IncidentAccessSettingsView>(`${accessPath(project)}/grants`, {
    method: "PUT",
    body: { grants, expectedRevision },
    label: "Failed to save access",
  });
}

export function putAccessProfile(
  project: string,
  role: IncidentAgentRole,
  fields: AccessProfileFields,
  expectedRevision: number,
): Promise<IncidentAccessSettingsView> {
  return request<IncidentAccessSettingsView>(
    `${accessPath(project)}/profiles/${seg(role)}`,
    {
      method: "PUT",
      body: { fields, expectedRevision },
      label: "Failed to save access",
    },
  );
}

export function putAccessOverride(
  project: string,
  role: IncidentAgentRole,
  signalId: string,
  fields: AccessProfileFields,
  expectedRevision: number,
): Promise<IncidentAccessSettingsView> {
  return request<IncidentAccessSettingsView>(
    `${accessPath(project)}/overrides/${seg(role)}/${seg(signalId)}`,
    {
      method: "PUT",
      body: { fields, expectedRevision },
      label: "Failed to save access",
    },
  );
}

export function deleteAccessOverride(
  project: string,
  role: IncidentAgentRole,
  signalId: string,
  expectedRevision: number,
): Promise<IncidentAccessSettingsView> {
  return request<IncidentAccessSettingsView>(
    `${accessPath(project)}/overrides/${seg(role)}/${seg(signalId)}${query({ expectedRevision: String(expectedRevision) })}`,
    { method: "DELETE", label: "Failed to remove the override" },
  );
}

export function resetAccessSettings(
  project: string,
): Promise<IncidentAccessSettingsView> {
  return request<IncidentAccessSettingsView>(accessPath(project), {
    method: "DELETE",
    label: "Failed to reset access",
  });
}

export function previewAccessApi(
  body: AccessPreviewInput,
): Promise<AccessPreview> {
  return request<AccessPreview>("/incident-access/preview", {
    method: "POST",
    body,
    label: "Failed to preview access",
  });
}

export function fetchIncidentAccess(
  id: string,
): Promise<IncidentAgentsAccessView | null> {
  return orNull(
    request<IncidentAgentsAccessView>(`/incidents/${seg(id)}/access`, {
      label: "Failed to load access",
    }),
  );
}

// ── Fix loop (absent: null) ──

export async function fetchProjectSettingsList(): Promise<
  RedactedProjectSettings[] | null
> {
  const body = await orNull(
    request<{ projects: RedactedProjectSettings[] }>("/incident-projects", {
      label: "Failed to load projects",
    }),
  );
  return body ? body.projects : null;
}

export function fetchProjectSettings(
  project: string,
): Promise<ProjectSettingsView | null> {
  return orNull(
    request<ProjectSettingsView>(`/incident-projects/${seg(project)}`, {
      label: "Failed to load project settings",
    }),
  );
}

export function updateProjectSettingsApi(
  project: string,
  input: ProjectSettingsInput,
): Promise<RedactedProjectSettings> {
  return request<RedactedProjectSettings>(
    `/incident-projects/${seg(project)}`,
    { method: "PUT", body: input, label: "Failed to save settings" },
  );
}

export function startProductionPairingApi(
  project: string,
): Promise<ProductionPairing> {
  return request<ProductionPairing>(
    `/incident-projects/${seg(project)}/runner-pairing`,
    { method: "POST", label: "Failed to start pairing" },
  );
}

/** 409 when the decision no longer applies, 401 when sign-in is needed,
 *  403 when only a signed-in person may make it. */
export function decideIncidentApi(
  id: string,
  decision: OwnerDecision,
  note?: string,
): Promise<Incident> {
  return request<Incident>(`/incidents/${seg(id)}/decisions`, {
    method: "POST",
    body: note === undefined ? { decision } : { decision, note },
    label: "Failed to send the decision",
  });
}

export function fetchAgentAudit(id: string): Promise<AgentAuditView | null> {
  return orNull(
    request<AgentAuditView>(`/incidents/${seg(id)}/agent-audit`, {
      label: "Failed to load what the agents did",
    }),
  );
}
