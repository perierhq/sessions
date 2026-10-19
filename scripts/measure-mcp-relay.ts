/**
 * Relay processes and memory for one run's opensession-* MCP servers —
 * `bun scripts/measure-mcp-relay.ts [servers]`.
 *
 * Mounts N fake built-in servers (default 25) the way a run host does, in
 * both OPENSESSION_MCP_PROXY_MODE settings, lists every server and calls one
 * tool on each, then counts the relay processes the run started and their
 * RSS. In-process mode also reports how much this process grew, which is
 * what those relays cost instead.
 *
 * From source the proxies run as `bun run mcp-proxy.ts`; a compiled
 * `opensession mcp-proxy` loads the whole bundle and sits higher.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A disposable state dir and config, set before the server modules load.
const home = mkdtempSync(join(tmpdir(), "mcp-relay-measure-"));
process.env.OPENSESSION_STATE_DIR = home;
process.env.OPENSESSION_CONFIG = join(home, "config.json");

const { createMcpRuntime, splitMcpMigrationBoundary } =
  await import("../packages/core/opensession-server/src/server/mcp-runtime");
const { descendantProcesses, startFakeRunRpcGateway } =
  await import("../packages/core/opensession-server/src/server/testing/run-rpc-mcp-fixture");
const { getConfigAsync } =
  await import("../packages/core/opensession-server/src/server/config");
const { mcpProxyArgv } =
  await import("../packages/core/opensession-server/src/runner-host/exe");
const { runRpcMcpMounts } =
  await import("../packages/core/opensession-server/src/runner-host/mcp-mounts");
type McpProxyMode =
  import("../packages/core/opensession-server/src/runner-host/mcp-mounts").McpProxyMode;
await getConfigAsync();

const count = Number(process.argv[2] || 25);
const names = Array.from({ length: count }, (_, i) => `opensession-s${i}`);
const proxyEntry = join(
  import.meta.dir,
  "../packages/core/opensession-server/src/runner-host/mcp-proxy.ts",
);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function measure(mode: McpProxyMode) {
  const dir = mkdtempSync(join(home, "run-"));
  const gateway = await startFakeRunRpcGateway({ dir, names });
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(),
    legacyProxyMcp: splitMcpMigrationBoundary(
      runRpcMcpMounts({
        names,
        target: { socket: gateway.socket, token: gateway.token },
        mode,
        proxyArgv: mcpProxyArgv(process.execPath, proxyEntry),
      }),
    ).legacyProxy,
  });
  try {
    const tools = await runtime.catalog();
    for (const name of names)
      await runtime.callExact(`${name}_echo`, {}, { toolCallId: name });
    Bun.gc(true);
    const grown = process.memoryUsage().rss - before;
    const relays = await descendantProcesses(/mcp-proxy/);
    const relayRss = relays.reduce(
      (sum: number, p: { rssKb: number }) => sum + p.rssKb * 1024,
      0,
    );
    return {
      mode,
      tools: tools.length,
      relays: relays.length,
      relayRss,
      grown,
    };
  } finally {
    await runtime.close();
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = [await measure("per-server"), await measure("in-process")];
rmSync(home, { recursive: true, force: true });
console.log(`${count} opensession-* servers, one run\n`);
console.log("mode        tools  relay procs  relay RSS   run host grew");
for (const r of rows)
  console.log(
    `${r.mode.padEnd(11)} ${String(r.tools).padStart(5)}  ${String(r.relays).padStart(11)}  ${mb(r.relayRss).padStart(9)}   ${mb(Math.max(0, r.grown)).padStart(10)}`,
  );
const [old, now] = rows;
console.log(
  `\nsaved per run: ${old!.relays - now!.relays} processes, about ${mb(old!.relayRss + Math.max(0, old!.grown) - Math.max(0, now!.grown))}`,
);
// The config watcher keeps the event loop alive.
process.exit(0);
