// Wire types for incident agent access profiles, shared by the server and the
// frontend: roles, project grants, per-role profiles, per-signal overrides,
// resolved access and its preview. Types, constant lists, defaults and small
// pure helpers only.

import type { IncidentState } from "./incidents";

export const INCIDENT_AGENT_ROLES = ["investigator", "verifier"] as const;
export type IncidentAgentRole = (typeof INCIDENT_AGENT_ROLES)[number];

export function isIncidentAgentRole(v: unknown): v is IncidentAgentRole {
  return (
    typeof v === "string" &&
    (INCIDENT_AGENT_ROLES as readonly string[]).includes(v)
  );
}

export const ACCESS_MODES = ["ask", "code"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** Ask (read-only) is narrower than code. */
export function modeWithin(mode: AccessMode, max: AccessMode): boolean {
  return ACCESS_MODES.indexOf(mode) <= ACCESS_MODES.indexOf(max);
}

export const CREDENTIAL_GRANT_MODES = ["once", "standing"] as const;
export type CredentialGrantMode = (typeof CREDENTIAL_GRANT_MODES)[number];

/** Once is narrower than standing. */
export function grantModeWithin(
  mode: CredentialGrantMode,
  max: CredentialGrantMode,
): boolean {
  return (
    CREDENTIAL_GRANT_MODES.indexOf(mode) <= CREDENTIAL_GRANT_MODES.indexOf(max)
  );
}

export interface HostGrant {
  /** Runner id. */
  runner: string;
  /** SSH alias the Runner reaches, when the host is not the Runner itself. */
  ssh?: string;
  access: "read-only";
}

export function hostGrantKey(h: Pick<HostGrant, "runner" | "ssh">): string {
  return h.ssh ? `${h.runner}>${h.ssh}` : h.runner;
}

export type EgressRoute =
  | { route: "server" }
  | { route: "runner"; runner: string }
  | { route: "proxy"; url: string; credential?: string };
export type EgressGrant = EgressRoute & { hosts?: string[] };

export function egressRouteKey(r: EgressRoute): string {
  switch (r.route) {
    case "server":
      return "server";
    case "runner":
      return `runner:${r.runner}`;
    case "proxy":
      return `proxy:${r.url}`;
  }
}

export interface ProjectCredentialGrant {
  credential: string;
  mode: CredentialGrantMode;
  /** Display name of who granted it. */
  grantedBy: string;
  /** GitHub login of the verified sign-in that granted it: the identity a
   *  personal credential's ownership is checked against. A personal grant
   *  without it is dropped at resolution. */
  grantedByLogin?: string;
  grantedAt: string;
}

export interface ProfileCredential {
  credential: string;
  mode: CredentialGrantMode;
}

/** The project's ceiling: profiles and overrides must fit inside it. */
export interface ProjectAccessGrants {
  connections: string[];
  repos: string[];
  runners: string[];
  hosts: HostGrant[];
  credentials: ProjectCredentialGrant[];
  egress: EgressGrant[];
  maxMode: AccessMode;
}

export const ACCESS_PROFILE_FIELDS = [
  "connections",
  "deniedTools",
  "mode",
  "repos",
  "runners",
  "hosts",
  "credentials",
  "model",
  "egress",
] as const;
export type AccessProfileField = (typeof ACCESS_PROFILE_FIELDS)[number];

export interface AccessProfileFields {
  connections?: string[];
  deniedTools?: string[];
  mode?: AccessMode;
  repos?: string[];
  runners?: string[];
  hosts?: HostGrant[];
  credentials?: ProfileCredential[];
  model?: string | null;
  egress?: EgressGrant | null;
}
export type CompleteAccessProfile = Required<AccessProfileFields>;

export interface SignalAccessOverride {
  signalId: string;
  role: IncidentAgentRole;
  fields: AccessProfileFields;
  updatedBy: string;
  updatedAt: string;
}

export interface IncidentAccessSettings {
  project: string;
  revision: number;
  grants: ProjectAccessGrants;
  profiles: Record<IncidentAgentRole, CompleteAccessProfile>;
  overrides: SignalAccessOverride[];
  updatedBy: string;
  updatedAt: string;
}

export interface CredentialInfo {
  service: string;
  host: string;
  owner: string;
  scope: "personal" | "workspace";
  kind: "api" | "login";
}

export interface IncidentAccessSettingsView extends IncidentAccessSettings {
  isDefault: boolean;
  credentialInfo: Record<string, CredentialInfo>;
}

/**
 * What an incident agent could reach when its session was created. Every
 * later resolution for the agent is intersected with it, so widening the
 * settings reaches only agents spawned afterwards.
 */
export interface AccessSpawnSnapshot {
  /** hostGrantKey of each host. */
  hosts: string[];
  credentials: Array<{ credential: string; mode: CredentialGrantMode }>;
  egress: {
    route: "server" | "runner" | "proxy";
    runner?: string;
    proxyUrl?: string;
    proxyCredential?: string;
    hosts: string[];
  } | null;
}

/** Carried on an incident agent's descendant policy; re-resolved on use. */
export interface IncidentAgentBinding {
  incidentId: string;
  role: IncidentAgentRole;
  signalId: string | null;
  accessRevision: string;
  spawn: AccessSpawnSnapshot;
}

export interface ResolvedHost {
  runner: string;
  runnerName: string;
  ssh?: string;
  access: "read-only";
}

export interface ResolvedCredential {
  credential: string;
  service: string;
  host: string;
  mode: CredentialGrantMode;
  scope: "personal" | "workspace";
}

export interface ResolvedEgress {
  route: "server" | "runner" | "proxy";
  runner?: string;
  runnerName?: string;
  proxyUrl?: string;
  proxyCredential?: string;
  hosts: string[];
}

export interface AccessNarrowing {
  field: AccessProfileField;
  item: string;
  reason: string;
}

export interface AgentAccess {
  incidentId: string;
  project: string;
  role: IncidentAgentRole;
  signalId: string | null;
  overrideApplied: boolean;
  defaults: boolean;
  connections: string[];
  /** Tool name → refusal message. */
  deniedTools: Record<string, string>;
  mode: AccessMode;
  repos: string[];
  runners: string[];
  hosts: ResolvedHost[];
  credentials: ResolvedCredential[];
  model: string | null;
  egress: ResolvedEgress | null;
  narrowed: AccessNarrowing[];
  revision: string;
  summary: string;
}

export interface AccessPreview {
  access: AgentAccess | null;
  error?: string;
  tools: string[];
  warnings: string[];
}

export interface IncidentAgentsAccessView {
  incidentId: string;
  investigator: AccessPreview;
  verifier: AccessPreview;
}

export const INCIDENT_ACCESS_SERVER = "opensession-incident-access";

export function defaultProjectGrants(project: string): ProjectAccessGrants {
  return {
    connections: [],
    repos: [project],
    runners: [],
    hosts: [],
    credentials: [],
    egress: [{ route: "server" }],
    maxMode: "code",
  };
}

export function defaultRoleProfile(
  role: IncidentAgentRole,
  project: string,
): CompleteAccessProfile {
  return {
    connections: [],
    deniedTools: [],
    mode: role === "verifier" ? "ask" : "code",
    repos: [project],
    runners: [],
    hosts: [],
    credentials: [],
    model: null,
    egress: { route: "server" },
  };
}

export function defaultIncidentAccessSettings(
  project: string,
  now: string,
): IncidentAccessSettings {
  return {
    project,
    revision: 0,
    grants: defaultProjectGrants(project),
    profiles: {
      investigator: defaultRoleProfile("investigator", project),
      verifier: defaultRoleProfile("verifier", project),
    },
    overrides: [],
    updatedBy: "sessions",
    updatedAt: now,
  };
}

/**
 * The incident states in which its agents may run. An allowlist, so a state
 * added later refuses until it is listed here. Not listed: a heads-up and
 * waiting on a provider (agents are stopped there), paused, and the closed
 * states.
 */
export const AGENT_INCIDENT_STATES: readonly IncidentState[] = [
  "investigating",
  "fix-ready",
  "veto",
  "deploying",
  "watching",
  "needs-you",
  "rolled-back",
];

export function incidentAllowsAgents(state: string): boolean {
  return (AGENT_INCIDENT_STATES as readonly string[]).includes(state);
}
