// SWR hooks for every incident resource. Reads revalidate on focus,
// reconnect and the incident socket messages (useIncidentLiveUpdates);
// strips also refresh on their bucket, and the signal list once a minute.
import { useEffect, useEffectEvent } from "react";
import useSWR, {
  type Arguments,
  type SWRConfiguration,
  type SWRResponse,
  mutate as revalidateApiResources,
} from "swr";
import {
  fetchAccessSettings,
  fetchAgentAudit,
  fetchIncident,
  fetchIncidentAccess,
  fetchIncidents,
  fetchIncidentStrip,
  fetchProjectSettings,
  fetchProjectSettingsList,
  fetchSignals,
  fetchSignalStrip,
  type IncidentListFilter,
} from "../lib/api/incidents";
import { apiResourceSWRConfig, apiSWRKey } from "../lib/api-swr";
import { stripRefreshMs } from "../lib/incidents/signal-summary";
import type { WSServerMessage } from "../lib/types";
import type { AgentAuditView, ProjectSettingsView } from "../lib/api/incidents";
import type {
  IncidentAccessSettingsView,
  IncidentAgentsAccessView,
} from "../../shared/incident-access";
import type { RedactedProjectSettings } from "../../shared/incident-response";
import type {
  Incident,
  IncidentSummary,
  SignalView,
  StripResponse,
} from "../../shared/incidents";

const SIGNALS_REFRESH_MS = 60_000;
/** Socket messages arrive in bursts (one per write); revalidate at most
 *  this often. */
export const INCIDENT_REVALIDATE_MS = 500;

const INCIDENT_MESSAGES: ReadonlySet<WSServerMessage["type"]> = new Set([
  "incidents_changed",
  "incident_signals_changed",
  "incident_settings_changed",
]);

/** An incident resource key: `["api", "incident…", …]`. */
export function isIncidentKey(key: Arguments): boolean {
  return (
    Array.isArray(key) &&
    key[0] === "api" &&
    String(key[1] ?? "").startsWith("incident")
  );
}

function revalidateIncidents(): void {
  void revalidateApiResources(isIncidentKey);
}

export function useSignals(): SWRResponse<SignalView[]> {
  return useSWR<SignalView[]>(
    apiSWRKey.incidentSignals(),
    fetchSignals,
    apiResourceSWRConfig<SignalView[]>(SIGNALS_REFRESH_MS),
  );
}

/** Refreshes on the strip's own bucket so an open strip keeps moving. */
function stripConfig(): SWRConfiguration<StripResponse> {
  return {
    ...apiResourceSWRConfig<StripResponse>(0),
    // A moving range (the home's mini strips) keeps the bars it has while
    // the next range loads, so they never blink empty.
    keepPreviousData: true,
    refreshInterval: (latest: StripResponse | undefined) =>
      stripRefreshMs(latest),
  };
}

export function useSignalStrip(
  id: string | null,
  range?: { from: string; to: string },
): SWRResponse<StripResponse> {
  return useSWR<StripResponse>(
    id ? apiSWRKey.incidentSignalStrip(id, range?.from, range?.to) : null,
    () => fetchSignalStrip(id!, range),
    stripConfig(),
  );
}

/** Null waits: nothing is fetched until the filter is known. */
export function useIncidents(
  filter: (IncidentListFilter & { status: "open" | "closed" | "all" }) | null,
): SWRResponse<IncidentSummary[]> {
  return useSWR<IncidentSummary[]>(
    filter
      ? apiSWRKey.incidents(
          filter.status,
          filter.project,
          filter.closedWithinMs,
        )
      : null,
    () => fetchIncidents(filter ?? {}),
    apiResourceSWRConfig<IncidentSummary[]>(0),
  );
}

export function useIncident(id: string): SWRResponse<Incident> {
  return useSWR<Incident>(
    apiSWRKey.incident(id),
    () => fetchIncident(id),
    apiResourceSWRConfig<Incident>(0),
  );
}

export function useIncidentStrip(id: string): SWRResponse<StripResponse> {
  return useSWR<StripResponse>(
    apiSWRKey.incidentStrip(id),
    () => fetchIncidentStrip(id),
    stripConfig(),
  );
}

export function useIncidentAccess(
  id: string,
): SWRResponse<IncidentAgentsAccessView | null> {
  return useSWR<IncidentAgentsAccessView | null>(
    apiSWRKey.incidentAccess(id),
    () => fetchIncidentAccess(id),
    apiResourceSWRConfig<IncidentAgentsAccessView | null>(0),
  );
}

export function useAgentAudit(
  id: string | null,
): SWRResponse<AgentAuditView | null> {
  return useSWR<AgentAuditView | null>(
    id ? apiSWRKey.incidentAgentAudit(id) : null,
    () => fetchAgentAudit(id!),
    apiResourceSWRConfig<AgentAuditView | null>(0),
  );
}

export function useProjectSettingsList(): SWRResponse<
  RedactedProjectSettings[] | null
> {
  return useSWR<RedactedProjectSettings[] | null>(
    apiSWRKey.incidentProjects(),
    fetchProjectSettingsList,
    apiResourceSWRConfig<RedactedProjectSettings[] | null>(0),
  );
}

export function useProjectSettings(
  project: string | null,
): SWRResponse<ProjectSettingsView | null> {
  return useSWR<ProjectSettingsView | null>(
    project ? apiSWRKey.incidentProject(project) : null,
    () => fetchProjectSettings(project!),
    apiResourceSWRConfig<ProjectSettingsView | null>(0),
  );
}

export function useAccessSettings(
  project: string,
): SWRResponse<IncidentAccessSettingsView | null> {
  return useSWR<IncidentAccessSettingsView | null>(
    apiSWRKey.incidentAccessSettings(project),
    () => fetchAccessSettings(project),
    apiResourceSWRConfig<IncidentAccessSettingsView | null>(0),
  );
}

/**
 * Revalidate every incident key on the incident socket messages, at most
 * once per INCIDENT_REVALIDATE_MS: the first message of a burst at once,
 * the rest folded into one trailing call.
 */
export function useIncidentLiveUpdates(
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void,
): void {
  const onMessage = useEffectEvent((msg: WSServerMessage) => {
    if (!INCIDENT_MESSAGES.has(msg.type)) return;
    coalescer.request();
  });
  useEffect(() => {
    const off = addHandler((msg) => onMessage(msg));
    return () => {
      off();
      coalescer.cancel();
    };
  }, [addHandler]);
}

export interface Coalescer {
  request(): void;
  cancel(): void;
}

/** Leading call, then at most one trailing call per window. */
export function createCoalescer(
  run: () => void,
  windowMs: number,
  now: () => number = Date.now,
): Coalescer {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    last = now();
    run();
  };
  return {
    request() {
      if (timer) return;
      const wait = last + windowMs - now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

const coalescer = createCoalescer(revalidateIncidents, INCIDENT_REVALIDATE_MS);
