import type { Arguments, SWRConfiguration } from "swr";

/**
 * Shared defaults for read-only API resources. SWR keeps the last successful
 * value by key, paints it immediately on remount, then revalidates it.
 * Periodic resources opt into their own refresh interval at the call site.
 */
export const API_SWR_OPTIONS = {
  shouldRetryOnError: false,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
} satisfies SWRConfiguration;

/**
 * Do not pass `compare: undefined` through to SWR. Its configuration merge
 * treats that as an explicit override of the default comparator, then calls
 * it during the external-store snapshot check.
 */
export function apiResourceSWRConfig<Data>(
  refreshInterval: number,
  compare?: SWRConfiguration<Data>["compare"],
): SWRConfiguration<Data> {
  const config: SWRConfiguration<Data> = {
    ...API_SWR_OPTIONS,
    refreshInterval,
  };
  if (compare !== undefined) config.compare = compare;
  return config;
}

// Keep resource identities in one place so separate surfaces share both the
// cached value and an in-flight revalidation instead of merely looking alike.
export const apiSWRKey = {
  // Instance-wide reads the settings pages share: connecting a provider
  // revalidates `sandboxStatus` once for every page that shows it.
  sandboxStatus: () => ["api", "sandbox-status"] as const,
  modelCatalog: () => ["api", "models"] as const,
  repos: () => ["api", "repos"] as const,
  session: (sessionId: string) => ["api", "session", sessionId] as const,
  workspaceOverview: (workspaceKey: string) =>
    ["api", "workspace-overview", workspaceKey] as const,
  sessionDiff: (sessionId: string) =>
    ["api", "session-diff", sessionId] as const,
  sessionPr: (sessionId: string, repo?: string, branch?: string) =>
    ["api", "session-pr", sessionId, repo || "", branch || ""] as const,
  sessionPrDiff: (sessionId: string, repo?: string, branch?: string) =>
    ["api", "session-pr-diff", sessionId, repo || "", branch || ""] as const,
  sessionGit: (sessionId: string, repo?: string) =>
    ["api", "session-git", sessionId, repo || ""] as const,
  sessionAssets: (sessionId: string) =>
    ["api", "session-assets", sessionId] as const,
  sessionResources: (sessionId: string) =>
    ["api", "session-resources", sessionId] as const,
  hostSessionResources: () => ["api", "host-session-resources"] as const,
  previewPr: (repo: string, branch: string) =>
    ["api", "preview-pr", repo, branch] as const,
  previewPrDiff: (repo: string, branch: string) =>
    ["api", "preview-pr-diff", repo, branch] as const,
  // Every incident key's second element starts with "incident": the
  // incident socket messages revalidate them all by that prefix.
  incidentSignals: () => ["api", "incident-signals"] as const,
  incidentSignalMini: (id: string) =>
    ["api", "incident-signal-mini", id] as const,
  incidents: (
    status: "open" | "closed" | "all",
    project?: string,
    closedWithinMs?: number,
  ) =>
    ["api", "incidents", status, project || "", closedWithinMs ?? ""] as const,
  incident: (id: string) => ["api", "incident", id] as const,
  incidentStrip: (id: string) => ["api", "incident-strip", id] as const,
  incidentAccess: (id: string) => ["api", "incident-access", id] as const,
  incidentAgentAudit: (id: string) =>
    ["api", "incident-agent-audit", id] as const,
  incidentProjects: () => ["api", "incident-projects"] as const,
  incidentProject: (project: string) =>
    ["api", "incident-project", project] as const,
  incidentAccessSettings: (project: string) =>
    ["api", "incident-access-settings", project] as const,
  // Settings → Inboxes and the email pane (projects to move to, whether
  // the signed-in person is the instance owner).
  supportInboxes: () => ["api", "support-inboxes"] as const,
};

/**
 * Every resource keyed by one session, for `mutate(filter)` once the server
 * has learned a client-minted id. Reads issued before the create landed were
 * answered 404, and SWR keeps that answer until something asks again.
 */
export function sessionApiKeyFilter(
  sessionId: string,
): (key: Arguments) => boolean {
  return (key) =>
    Array.isArray(key) &&
    key[0] === "api" &&
    (key[2] === sessionId || key[2] === `sessions:${sessionId}`);
}
