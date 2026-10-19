/**
 * Which shape a run's opensession-* MCP servers take (mcp-mounts.ts).
 *
 * The gateway decides at launch and records the answer in the run-host spec
 * (`RunHostSpec.mcpProxyMode`), so it reaches every launcher's hosts: systemd
 * units, Runner-launched hosts (whose env is a fixed allowlist) and sandboxes
 * alike, and a run keeps the mode it started with across restarts. The host
 * falls back to its own env only for specs written before the field existed.
 *
 * No runtime imports: the gateway's spec builders and the host both load it.
 */

import type { McpProxyMode } from "@tellahq/opensession-protocol/runner";

export type { McpProxyMode };

/** The gateway-side rollback switch: `per-server` restores one stdio proxy
 *  per server. Anything else means the in-process default. */
export const MCP_PROXY_MODE_ENV = "OPENSESSION_MCP_PROXY_MODE";

/** The mode `env` asks for. Anything but `per-server` means the default. */
export function mcpProxyMode(
  env: Record<string, string | undefined> = process.env,
): McpProxyMode {
  return env[MCP_PROXY_MODE_ENV]?.trim().toLowerCase() === "per-server"
    ? "per-server"
    : "in-process";
}

/** What a gateway records in a new spec: the configured mode, or nothing
 *  when the run proxies no servers. */
export function launchMcpProxyMode(
  proxyMcpServers: readonly string[] | undefined,
  env: Record<string, string | undefined> = process.env,
): McpProxyMode | undefined {
  return proxyMcpServers?.length ? mcpProxyMode(env) : undefined;
}

/** The mode a host uses: the spec's, else (an older spec) its own env. */
export function hostMcpProxyMode(
  specMode: unknown,
  env: Record<string, string | undefined> = process.env,
): McpProxyMode {
  return specMode === "per-server" || specMode === "in-process"
    ? specMode
    : mcpProxyMode(env);
}
