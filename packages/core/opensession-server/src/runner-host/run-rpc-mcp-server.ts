/**
 * The MCP server face of one opensession-* server: tools/list and tools/call
 * forwarded to the gateway over run-rpc (run-rpc-client.ts).
 *
 * The same server runs in two places. The run host connects it in-process to
 * pi's MCP runtime (mcp-mounts.ts), one per opensession-* server and all of
 * them sharing one run-rpc client. The per-server stdio proxy (mcp-proxy.ts),
 * kept for rollback, serves exactly one over stdio. Either way the engine sees
 * the same server name, tools, schemas and errors.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RunRpcClient } from "./run-rpc-client";

/** tools/list happens during the engine's MCP init, before the turn's first
 *  output, so its retry budget must stay well under the runner's 90s
 *  liveness guard. It must also cover detached-run recovery: adoption plus
 *  reattach can take tens of seconds after the new server opens its socket. */
export const RUN_RPC_LIST_TIMEOUT_MS = 45_000;
/** Tool calls may block for many minutes (ask_human/ask_user waiting on a
 *  teammate): allow reconnect retries well past the opensession side's
 *  30-minute per-call ceiling (run-rpc.ts) instead of the default 2 minutes. */
export const RUN_RPC_CALL_TIMEOUT_MS = 32 * 60_000;

export function createRunRpcMcpServer(
  serverName: string,
  rpc: RunRpcClient,
): Server {
  const server = new Server(
    { name: `backstage-proxy-${serverName}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const data = await rpc.call(
      "/mcp/list",
      serverName,
      {},
      // Listing changes nothing, so it may be re-sent after a lost connection.
      { timeoutMs: RUN_RPC_LIST_TIMEOUT_MS, idempotent: true },
    );
    return { tools: data.tools || [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const args: Record<string, unknown> = {
        ...(req.params.arguments ?? {}),
      };
      const data = await rpc.call(
        "/mcp/call",
        serverName,
        { tool: req.params.name, args },
        {
          timeoutMs: RUN_RPC_CALL_TIMEOUT_MS,
          // The engine cancelled or timed out the call: forward that, so the
          // tool stops waiting instead of holding its answer for a dead call.
          signal: extra.signal,
        },
      );
      if (!data.result || typeof data.result !== "object")
        throw new Error("opensession answered without a tool result");
      return data.result;
    } catch (e: any) {
      return {
        content: [
          { type: "text", text: `Tool call failed: ${e?.message || e}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}
