// The live inputs incident access is resolved against: projects and repos,
// MCP connections, Runners, keychain credentials (never a secret) and models.
// One snapshot per call, read asynchronously so the gateway thread never
// blocks. Tests replace the snapshot through __setAccessEnvironmentForTest.
import { readFile } from "node:fs/promises";
import { configuredPaths, configuredRepos } from "../../config";
import { requiresAllowedUsers } from "../../connections";
import {
  ensureKeychainLoaded,
  isCredentialOwnerLogin,
  listCredentials,
} from "../../keychain";
import { INTERNAL_MCP_CAPABILITIES } from "../../mcp-capabilities";
import { resolveModel } from "../../models";
import { isRunnerConnected } from "../../runner-ws";
import { listRunnersAsync, type RunnerPlatform } from "../../runners";
import { teammatesNamed } from "../../shared/user-mappings";

export type ConnectionStatus = "ok" | "missing" | "internal" | "user-gated";

export interface AccessRunnerInfo {
  id: string;
  name: string;
  platform: RunnerPlatform;
  /** The operator asserted descendant runs are isolated on this Runner. */
  isolated: boolean;
  /** The Runner accepts commands. */
  commands: boolean;
  /** The Runner only accepts named people. */
  userRestricted: boolean;
  /** Reserved for incidents (`reserveRunnerForIncidents`): agents reach it
   *  only through host commands and egress, on the read-only path
   *  (runner-exec.ts), and only for the projects it is bound to
   *  (`allowedRepos`). */
  reserved: boolean;
  maintenance: boolean;
  allowedRepos: string[];
  connected: boolean;
}

export interface AccessCredentialInfo {
  id: string;
  service: string;
  host: string;
  owner: string;
  kind: "api" | "login";
  scope: "personal" | "workspace";
  injectionHeader: string;
}

export interface AccessEnvironment {
  projectExists(id: string): boolean;
  repoExists(id: string): boolean;
  connection(name: string): ConnectionStatus;
  runner(idOrName: string): AccessRunnerInfo | null;
  credential(idOrService: string): AccessCredentialInfo | null;
  /** The canonical model id, or null when unknown. */
  model(id: string): string | null;
  /** Whether the verified GitHub login is the credential owner's: stable
   *  roster identities, never first names (see isCredentialOwnerLogin). */
  isOwner(login: string, owner: string): boolean;
  /** How a credential owner's name reads on the team roster: exactly one
   *  teammate with a GitHub login, nobody with a login, or a name several
   *  teammates share. */
  ownerRoster(owner: string): OwnerRoster;
}

export type OwnerRoster = "one" | "none" | "shared";

let override: AccessEnvironment | undefined;

/** Install a fixed environment (undefined restores the live one). */
export function __setAccessEnvironmentForTest(
  env: AccessEnvironment | undefined,
): void {
  override = env;
}

export function isOwnerLogin(login: string, owner: string): boolean {
  return isCredentialOwnerLogin(login, owner);
}

export function ownerRosterOf(owner: string): OwnerRoster {
  const named = teammatesNamed(owner);
  if (named.length > 1) return "shared";
  return named.length === 1 && named[0].github?.trim() ? "one" : "none";
}

export function connectionStatusFrom(
  name: string,
  servers: Record<string, unknown>,
): ConnectionStatus {
  if (
    name.startsWith("opensession-") ||
    Object.hasOwn(INTERNAL_MCP_CAPABILITIES, name)
  )
    return "internal";
  if (!Object.hasOwn(servers, name)) return "missing";
  const entry = servers[name] as {
    allowedUsers?: unknown;
    allowUnattended?: unknown;
  } | null;
  if (requiresAllowedUsers(name)) return "user-gated";
  if (Array.isArray(entry?.allowedUsers) && entry.allowedUsers.length > 0)
    // "Allow agents" lets runs without a user use it.
    return entry.allowUnattended === true ? "ok" : "user-gated";
  return "ok";
}

async function readMcpServers(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(
      await readFile(configuredPaths().mcpConfig, "utf8"),
    ) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function loadAccessEnvironment(): Promise<AccessEnvironment> {
  if (override) return override;
  const [servers, runnerList] = await Promise.all([
    readMcpServers(),
    listRunnersAsync(),
    ensureKeychainLoaded(),
  ]);
  const runners: AccessRunnerInfo[] = runnerList.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    isolated: r.permissions.automationDescendants === true,
    commands: r.permissions.commands === true,
    userRestricted: r.allowedUsers.length > 0,
    reserved: r.incidentReserved === true,
    maintenance: r.maintenance === true,
    allowedRepos: [...r.allowedRepos],
    connected: isRunnerConnected(r.id),
  }));
  const credentials: AccessCredentialInfo[] = listCredentials().map((c) => ({
    id: c.id,
    service: c.service,
    host: c.host,
    owner: c.owner,
    kind: c.kind === "login" ? "login" : "api",
    scope: c.scope === "workspace" ? "workspace" : "personal",
    injectionHeader: c.injection?.header || "Authorization",
  }));
  const repos = new Set(Object.keys(configuredRepos()));
  return {
    projectExists: (id) => repos.has(id),
    repoExists: (id) => repos.has(id),
    connection: (name) => connectionStatusFrom(name, servers),
    runner: (ref) =>
      runners.find((r) => r.id === ref) ??
      runners.find((r) => r.name === ref) ??
      null,
    credential: (ref) =>
      credentials.find((c) => c.id === ref) ??
      credentials.find((c) => c.service === ref.trim().toLowerCase()) ??
      null,
    model: (id) => resolveModel(id)?.id ?? null,
    isOwner: isOwnerLogin,
    ownerRoster: ownerRosterOf,
  };
}
