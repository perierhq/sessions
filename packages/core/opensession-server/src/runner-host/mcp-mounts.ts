/**
 * How a run host mounts the opensession-* MCP servers for its run.
 *
 * The tools execute in the gateway (run-rpc.ts) because they close over live
 * opensession state. Pi runs inside the run host and consumes MCP servers
 * in-process (mcp-runtime.ts), so by default every opensession-* server is a
 * relay connected in-process, and all of them share one run-rpc client: no
 * child process, and one /rpc-ws connection instead of one per server.
 *
 * OPENSESSION_MCP_PROXY_MODE=per-server restores the previous shape, one
 * `opensession mcp-proxy` stdio process per server (about 90 MB RSS each),
 * for rollback. The run host reads it from the gateway's environment file.
 *
 * Either way each server keeps its name, its deferred listing and its call
 * timeout, so tool ids, policies, tool_search and scope filters see the same
 * servers.
 */

import type { InProcessRelayMcpConfig } from "../server/mcp-runtime";
import { createRunRpcClient, type RunRpcTarget } from "./run-rpc-client";
import { createRunRpcMcpServer } from "./run-rpc-mcp-server";

export type McpProxyMode = "in-process" | "per-server";

export const MCP_PROXY_MODE_ENV = "OPENSESSION_MCP_PROXY_MODE";

/** The configured mode. Anything but `per-server` means the default. */
export function mcpProxyMode(
  env: Record<string, string | undefined> = process.env,
): McpProxyMode {
  return env[MCP_PROXY_MODE_ENV]?.trim().toLowerCase() === "per-server"
    ? "per-server"
    : "in-process";
}

/** The per-run env a stdio proxy needs to reach run-rpc. */
function proxyEnv(target: RunRpcTarget): Record<string, string> {
  return "wsUrl" in target
    ? {
        OPENSESSION_RPC_WS_URL: target.wsUrl,
        OPENSESSION_RPC_WS_HOST: target.wsHost,
        OPENSESSION_RPC_WS_AUTH: target.wsAuth,
        OPENSESSION_RPC_TOKEN: target.token,
      }
    : {
        OPENSESSION_RPC_SOCKET: target.socket,
        OPENSESSION_RPC_TOKEN: target.token,
      };
}

/**
 * The run's `inProcessMcp` entries for `names`, or undefined when there is
 * nothing to mount. `proxyArgv` launches the stdio proxy and is used only in
 * per-server mode.
 */
export function runRpcMcpMounts(opts: {
  names: readonly string[];
  target: RunRpcTarget;
  mode: McpProxyMode;
  proxyArgv: readonly string[];
}): Record<string, unknown> | undefined {
  if (!opts.names.length || !opts.target.token) return undefined;
  const out: Record<string, unknown> = {};
  if (opts.mode === "per-server") {
    const [command, ...args] = opts.proxyArgv;
    const env = proxyEnv(opts.target);
    for (const name of opts.names)
      out[name] = {
        command,
        args,
        env: { ...env, OPENSESSION_MCP_SERVER: name },
      };
    return out;
  }
  // Opens nothing yet: the socket or WS is reached on the first request.
  const rpc = createRunRpcClient(opts.target);
  for (const name of opts.names) {
    const relay: InProcessRelayMcpConfig = {
      type: "run-rpc-relay",
      createServer: () => createRunRpcMcpServer(name, rpc),
    };
    out[name] = relay;
  }
  return out;
}
