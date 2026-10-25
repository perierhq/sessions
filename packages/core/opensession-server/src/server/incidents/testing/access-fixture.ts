// Test fixture: a static access environment (projects, connections, Runners,
// credentials, models) installed through the environment seam for each test.
// Tests mutate `spec` in place; the environment reads it live.
// Not on any live import chain (excluded from the side-effect scan).
import { afterEach, beforeEach } from "bun:test";
import type { AgentAccess } from "../../../shared/incident-access";
import type { AutomationDescendantPolicy } from "../../types";
import {
  type AccessCredentialInfo,
  type AccessEnvironment,
  type AccessRunnerInfo,
  type ConnectionStatus,
  __setAccessEnvironmentForTest,
  isOwnerLogin,
  ownerRosterOf,
} from "../access/environment";
import type { TeamMember } from "../../config";
import type { AgentRun } from "../../../shared/incident-response";
import { createIncident, updateIncident } from "../incident-store";
import { emptyResponse } from "../response/ledger";
import { __setIdentitiesForTest } from "../../shared/user-mappings";

export interface StaticAccessSpec {
  projects?: string[];
  connections?: Record<string, ConnectionStatus>;
  runners?: AccessRunnerInfo[];
  credentials?: AccessCredentialInfo[];
  models?: string[];
}

export function staticAccessEnvironment(
  spec: StaticAccessSpec,
): AccessEnvironment {
  return {
    projectExists: (id) => (spec.projects ?? []).includes(id),
    repoExists: (id) => (spec.projects ?? []).includes(id),
    connection: (name) => {
      if (name.startsWith("opensession-")) return "internal";
      return spec.connections?.[name] ?? "missing";
    },
    runner: (ref) =>
      (spec.runners ?? []).find((r) => r.id === ref) ??
      (spec.runners ?? []).find((r) => r.name === ref) ??
      null,
    credential: (ref) =>
      (spec.credentials ?? []).find((c) => c.id === ref) ??
      (spec.credentials ?? []).find((c) => c.service === ref) ??
      null,
    model: (id) => {
      const value = id.trim().toLowerCase();
      return (spec.models ?? []).find((m) => m.toLowerCase() === value) ?? null;
    },
    isOwner: isOwnerLogin,
    ownerRoster: ownerRosterOf,
  };
}

const runner = (
  id: string,
  name: string,
  over: Partial<AccessRunnerInfo> = {},
): AccessRunnerInfo => ({
  id,
  name,
  platform: "linux",
  isolated: true,
  commands: true,
  userRestricted: false,
  reserved: false,
  maintenance: false,
  allowedRepos: [],
  connected: true,
  ...over,
});

const credential = (
  id: string,
  service: string,
  host: string,
  owner: string,
  over: Partial<AccessCredentialInfo> = {},
): AccessCredentialInfo => ({
  id,
  service,
  host,
  owner,
  kind: "api",
  scope: "personal",
  injectionHeader: "Authorization",
  ...over,
});

export function defaultAccessSpec(): Required<StaticAccessSpec> {
  return {
    projects: ["acme", "acme-api"],
    connections: {
      sentry: "ok",
      logs: "ok",
      "people-only": "user-gated",
      "opensession-admin": "internal",
    },
    runners: [
      runner("rn-prod", "prod-1"),
      runner("rn-shared", "shared-1", { isolated: false }),
      runner("rn-named", "named-1", { userRestricted: true }),
      runner("rn-win", "win-1", { platform: "win32" }),
    ],
    credentials: [
      credential("kc-proxy", "proxy-api", "api.proxy.example.test", "Ada"),
      credential("kc-shared", "status-api", "status.example.test", "Bo", {
        scope: "workspace",
      }),
      credential("kc-login", "admin-login", "admin.example.test", "Ada", {
        kind: "login",
      }),
      credential("kc-fwd", "fwd-proxy", "proxy.example.test", "Ada", {
        injectionHeader: "Proxy-Authorization",
      }),
    ],
    models: ["pi/anthropic/claude-opus-5-5", "pi/openai/gpt-6.1"],
  };
}

/** The roster the fixture installs: credential owners "Ada" and "Bo". */
export const ACCESS_TEST_ROSTER: TeamMember[] = [
  { name: "Ada Lovelace", github: "ada" },
  { name: "Bo Example", github: "bo" },
];

export function useAccessTestEnv(): { spec: Required<StaticAccessSpec> } {
  const holder = { spec: defaultAccessSpec() };
  let restoreRoster: (() => void) | undefined;
  beforeEach(() => {
    restoreRoster = __setIdentitiesForTest(ACCESS_TEST_ROSTER);
    const fresh = defaultAccessSpec();
    for (const key of Object.keys(fresh) as Array<keyof typeof fresh>)
      (holder.spec as Record<string, unknown>)[key] = fresh[key];
    __setAccessEnvironmentForTest(staticAccessEnvironment(holder.spec));
  });
  afterEach(() => {
    __setAccessEnvironmentForTest(undefined);
    restoreRoster?.();
    restoreRoster = undefined;
  });
  return holder;
}

/** An investigator on `acme` in code mode with nothing granted. */
export function agentAccessFixture(
  over: Partial<AgentAccess> = {},
): AgentAccess {
  return {
    incidentId: "inc-1",
    project: "acme",
    role: "investigator",
    signalId: null,
    overrideApplied: false,
    defaults: false,
    connections: [],
    deniedTools: {},
    mode: "code",
    repos: ["acme"],
    runners: [],
    hosts: [],
    credentials: [],
    model: null,
    egress: null,
    narrowed: [],
    revision: "r1",
    summary: "Investigator · no connections · can edit acme",
    ...over,
  };
}

/** A descendant policy for the incidents automation on `acme`, no binding. */
export const descendantFixture: AutomationDescendantPolicy = {
  automationId: "incidents-acme",
  automationName: "Incidents",
  repo: "acme",
  publicationRepo: "example/acme",
  baseBranch: "main",
  mcpServers: [],
  allowedRunners: [],
  publication: "branch-pr-only",
};

/**
 * An incident in the store whose investigator run `sessionId` was taken
 * over by `by`; returns the incident id. Needs useIncidentTestKernel.
 */
export async function supersededIncidentFixture(
  sessionId: string,
  by: string,
): Promise<string> {
  const at = new Date().toISOString();
  const incident = await createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-a"],
    primarySignalId: "sig-a",
    at,
    detail: "Search failing",
  });
  const run = (id: string, over: Partial<AgentRun> = {}): AgentRun => ({
    role: "investigator",
    round: 1,
    attempt: 1,
    sessionId: id,
    model: "pi/anthropic/claude-opus-5-5",
    provider: "anthropic",
    workspace: { kind: "sandbox", provider: "daytona" },
    accessSummary: "Investigator · no connections · can edit acme",
    accessRevision: "r1",
    status: "running",
    startedAt: at,
    turnSentAt: at,
    costUsd: 0,
    tokens: 0,
    reminded: false,
    ...over,
  });
  await updateIncident(incident.id, (c) => ({
    ...c,
    response: {
      ...emptyResponse({ now: at, maxRounds: 3, phase: "investigating" }),
      agents: [run(sessionId, { supersededBy: by }), run(by, { attempt: 2 })],
    },
  }));
  return incident.id;
}
