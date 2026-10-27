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
import { type CommitDetails, fetchCommit } from "../lib/api/prs";
import { apiResourceSWRConfig, apiSWRKey } from "../lib/api-swr";
import { createCoalescer } from "../lib/coalescer";
import { miniRange, stripRefreshMs } from "../lib/incidents/signal-summary";
import type { WSServerMessage } from "../lib/types";
import type { AgentAuditView, ProjectSettingsView } from "../lib/api/incidents";
import type {
  IncidentAccessSettingsView,
  IncidentAgentsAccessView,
} from "../../shared/incident-access";
import type { SignalWindow } from "../../shared/findings";
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
    refreshInterval: (latest: StripResponse | undefined) =>
      stripRefreshMs(latest),
  };
}

/**
 * A signal's mini strip on the home: the last few intervals up to now. One
 * key per signal; the range is taken inside the fetcher, so every refresh
 * reads up to its own now without a new key (and a new cache entry) each
 * minute.
 */
export function useMiniSignalStrip(
  signal: SignalView,
): SWRResponse<StripResponse> {
  return useSWR<StripResponse>(
    apiSWRKey.incidentSignalMini(signal.id),
    () => fetchSignalStrip(signal.id, miniRange(signal, Date.now())),
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

/** A findings window refreshes on its bucket only while it reaches past
 *  now; a closed window's data never changes. */
export function signalWindowRefreshMs(
  to: string,
  latest: StripResponse | undefined,
  now: number,
): number {
  return Date.parse(to) > now ? stripRefreshMs(latest) : 0;
}

function signalWindowConfig(
  w: Pick<SignalWindow, "to">,
): SWRConfiguration<StripResponse> {
  return {
    ...apiResourceSWRConfig<StripResponse>(0),
    refreshInterval: (latest: StripResponse | undefined) =>
      signalWindowRefreshMs(w.to, latest, Date.now()),
  };
}

/** A commit's patch never changes: no refetch on focus either. */
export function findingsCommitConfig(): SWRConfiguration<CommitDetails | null> {
  return {
    ...apiResourceSWRConfig<CommitDetails | null>(0),
    revalidateOnFocus: false,
  };
}

/**
 * A findings block's signal window: every lane of the signal from `from` to
 * `to` (the block narrows to its lane with `windowStrip`). Its key is not an
 * incident key, so incident writes don't refetch it.
 */
export function useSignalWindow(
  w: SignalWindow | null,
): SWRResponse<StripResponse> {
  return useSWR<StripResponse>(
    w ? apiSWRKey.findingsWindow(w.signalId, w.from, w.to) : null,
    () => fetchSignalStrip(w!.signalId, { from: w!.from, to: w!.to }),
    signalWindowConfig(w ?? { to: "" }),
  );
}

/** A findings block's commit, with its patch. `null` data: no checkout has it. */
export function useIncidentCommit(
  sha: string | null,
  repo: string,
): SWRResponse<CommitDetails | null> {
  return useSWR<CommitDetails | null>(
    sha ? apiSWRKey.findingsCommit(sha, repo) : null,
    () => fetchCommit(sha!, repo, { includeChanges: true }),
    findingsCommitConfig(),
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

export { type Coalescer, createCoalescer } from "../lib/coalescer";

const coalescer = createCoalescer(revalidateIncidents, INCIDENT_REVALIDATE_MS);
