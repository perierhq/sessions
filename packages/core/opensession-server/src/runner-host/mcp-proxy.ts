/**
 * mcp-proxy — a stdio MCP server that forwards tools/list and tools/call to
 * the opensession process over its run-rpc unix socket (src/server/run-rpc.ts).
 *
 * One process per opensession-* server (OPENSESSION_MCP_SERVER names which
 * one). Run hosts no longer start these by default: they serve every
 * opensession-* server in-process over one shared run-rpc client
 * (mcp-mounts.ts). This entry stays for OPENSESSION_MCP_PROXY_MODE=per-server
 * (rollback) and for any stdio-only MCP consumer. The tool implementations
 * close over live opensession state and must execute there.
 *
 * Env (set in the injected MCP config by mcp-mounts.ts):
 *   OPENSESSION_RPC_SOCKET  — opensession's run-rpc unix socket path, OR
 *   OPENSESSION_RPC_WS_URL  — opensession's /rpc-ws WebSocket route (remote
 *                     sandboxes, where a unix socket can't cross the boundary)
 *   OPENSESSION_RPC_WS_HOST — WS mode: this run's hostId (the rpc-ws upgrade is
 *                     authenticated per ws-transport run, not per rpc token)
 *   OPENSESSION_RPC_WS_AUTH — WS mode: the run's wsToken, the upgrade bearer
 *   OPENSESSION_RPC_TOKEN   — per-run bearer sent IN each frame (maps to session +
 *                     user via dispatchRunRpc; also the unix-socket bearer)
 *   OPENSESSION_MCP_SERVER  — which interactive server to proxy (e.g. opensession-sessions)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRunRpcClient } from "./run-rpc-client";
import { createRunRpcMcpServer } from "./run-rpc-mcp-server";

const SOCK = process.env.OPENSESSION_RPC_SOCKET || "";
const WS_URL = process.env.OPENSESSION_RPC_WS_URL || "";
const WS_HOST = process.env.OPENSESSION_RPC_WS_HOST || "";
const WS_AUTH = process.env.OPENSESSION_RPC_WS_AUTH || "";
const TOKEN = process.env.OPENSESSION_RPC_TOKEN || "";
const SERVER_NAME = process.env.OPENSESSION_MCP_SERVER || "";
if (
  (!SOCK && !WS_URL) ||
  !TOKEN ||
  !SERVER_NAME ||
  (WS_URL && (!WS_HOST || !WS_AUTH))
) {
  console.error(
    "mcp-proxy: OPENSESSION_RPC_SOCKET or OPENSESSION_RPC_WS_URL (+ OPENSESSION_RPC_WS_HOST/OPENSESSION_RPC_WS_AUTH), plus OPENSESSION_RPC_TOKEN and OPENSESSION_MCP_SERVER are required",
  );
  process.exit(2);
}

const rpc = createRunRpcClient(
  WS_URL
    ? { wsUrl: WS_URL, wsHost: WS_HOST, wsAuth: WS_AUTH, token: TOKEN }
    : { socket: SOCK, token: TOKEN },
);

await createRunRpcMcpServer(SERVER_NAME, rpc).connect(
  new StdioServerTransport(),
);
