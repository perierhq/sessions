/**
 * How a run host mounts the opensession-* MCP servers for its run.
 *
 * The tools execute in the gateway (run-rpc.ts) because they close over live
 * opensession state. Pi runs inside the run host and consumes MCP servers
 * in-process (mcp-runtime.ts), so by default every opensession-* server is a
 * relay connected in-process, and all of them share one run-rpc client: no
 * child process, and one /rpc-ws connection instead of one per server.
 *
 * `per-server` mode (RunHostSpec.mcpProxyMode, set by the gateway from
 * OPENSESSION_MCP_PROXY_MODE; mcp-proxy-mode.ts) restores the previous shape,
 * one `opensession mcp-proxy` stdio process per server (about 90 MB RSS
 * each), for rollback.
 *
 * Either way each server keeps its name, its deferred listing and its call
 * timeout, so tool ids, policies, tool_search and scope filters see the same
 * servers.
 */

import type { InProcessRelayMcpConfig } from "../server/mcp-runtime";
import type { McpProxyMode } from "./mcp-proxy-mode";
import { createRunRpcClient, type RunRpcTarget } from "./run-rpc-client";
import { createRunRpcMcpServer } from "./run-rpc-mcp-server";

export {
  MCP_PROXY_MODE_ENV,
  mcpProxyMode,
  type McpProxyMode,
} from "./mcp-proxy-mode";

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

/** A run's opensession-* mounts and what releases them. */
export interface RunRpcMcpMounts {
  /** The run's `inProcessMcp` entries. */
  mounts: Record<string, unknown>;
  /** Closes the shared run-rpc client (its WS connection and keepalive).
   *  Call once the run is over: the MCP runtime closes each server's
   *  transport, but the client they share outlives them. */
  close(): void;
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
  /** Overrides for the shared client (tests). */
  client?: Parameters<typeof createRunRpcClient>[1];
}): RunRpcMcpMounts | undefined {
  if (!opts.names.length || !opts.target.token) return undefined;
  const mounts: Record<string, unknown> = {};
  if (opts.mode === "per-server") {
    const [command, ...args] = opts.proxyArgv;
    const env = proxyEnv(opts.target);
    for (const name of opts.names)
      mounts[name] = {
        command,
        args,
        env: { ...env, OPENSESSION_MCP_SERVER: name },
      };
    // Each proxy owns its own client and exits with its stdio.
    return { mounts, close: () => {} };
  }
  // Opens nothing yet: the socket or WS is reached on the first request.
  //
  // Over the unix socket every call is a fetch from this process, so relay
  // calls now share the run host's fetch concurrency limit
  // (BUN_CONFIG_MAX_HTTP_REQUESTS, Bun's default when unset) with the
  // model's streaming requests; each per-server proxy had its own. rpc-ws
  // carries every call on one WebSocket instead of a fetch per call.
  const rpc = createRunRpcClient(opts.target, opts.client);
  for (const name of opts.names) {
    const relay: InProcessRelayMcpConfig = {
      type: "run-rpc-relay",
      createServer: () => createRunRpcMcpServer(name, rpc),
    };
    mounts[name] = relay;
  }
  return { mounts, close: () => rpc.close() };
}
