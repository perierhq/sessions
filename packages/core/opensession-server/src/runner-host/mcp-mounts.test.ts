import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpRuntime,
  splitMcpMigrationBoundary,
  type McpRuntime,
} from "../server/mcp-runtime";
import {
  descendantProcesses,
  startFakeRunRpcGateway,
  type FakeRunRpcGateway,
} from "../server/testing/run-rpc-mcp-fixture";
import { mcpProxyArgv } from "./exe";
import {
  mcpProxyMode,
  runRpcMcpMounts,
  type McpProxyMode,
  type RunRpcMcpMounts,
} from "./mcp-mounts";
import { createRunRpcClient, type RunRpcTarget } from "./run-rpc-client";

const PROXY_ENTRY = join(import.meta.dir, "mcp-proxy.ts");
const PROXY_PROCESS = /mcp-proxy/;
/** The built-in servers a full interactive run mounts. */
const BUILT_IN = [
  "admin",
  "ask",
  "assets",
  "charts",
  "databases",
  "goals",
  "humans",
  "keychain",
  "local-files",
  "memory",
  "papercuts",
  "portals",
  "publish",
  "repos",
  "runners",
  "schedule",
  "scripts",
  "search",
  "self-deploy",
  "sessions",
  "slack",
  "todos",
  "walkthrough",
  "web",
  "workflows",
].map((name) => `opensession-${name}`);

let dir: string;
let gateway: FakeRunRpcGateway | undefined;
const runtimes: McpRuntime[] = [];
const mountSets: RunRpcMcpMounts[] = [];
let previousState: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-mounts-"));
  previousState = process.env.OPENSESSION_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = dir;
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const mounts of mountSets.splice(0)) mounts.close();
  await gateway?.stop();
  gateway = undefined;
  if (previousState === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previousState;
  rmSync(dir, { recursive: true, force: true });
});

async function start(names: readonly string[]) {
  gateway = await startFakeRunRpcGateway({ dir, names });
  return gateway;
}

/** Where the fake gateway's run-rpc is, over either transport. */
function targetOf(gw: FakeRunRpcGateway, ws = false): RunRpcTarget {
  return ws
    ? { wsUrl: gw.wsUrl, wsHost: gw.wsHost, wsAuth: gw.wsAuth, token: gw.token }
    : { socket: gw.socket, token: gw.token };
}

/** The run's mounts, closed after the test. */
function mountsFor(
  names: readonly string[],
  mode: McpProxyMode,
  target: RunRpcTarget,
  client?: Parameters<typeof createRunRpcClient>[1],
) {
  const mounts = runRpcMcpMounts({
    names,
    target,
    mode,
    proxyArgv: mcpProxyArgv(process.execPath, PROXY_ENTRY),
    client,
  })!;
  mountSets.push(mounts);
  return mounts;
}

/** The run's MCP runtime, wired the way pi-runner wires a run host's. */
async function runtimeFor(
  names: readonly string[],
  mode: McpProxyMode,
  opts: {
    ws?: boolean;
    deniedToolIds?: string[];
    client?: Parameters<typeof createRunRpcClient>[1];
  } = {},
) {
  const mounts = mountsFor(names, mode, targetOf(gateway!, opts.ws), {
    retryDelayMs: 20,
    ...opts.client,
  });
  const split = splitMcpMigrationBoundary(mounts.mounts);
  expect(Object.keys(split.sdk)).toEqual([]);
  const runtime = await createMcpRuntime({
    mcpServers: [],
    deniedToolIds: new Set(opts.deniedToolIds ?? []),
    inProcessMcp: split.sdk,
    legacyProxyMcp: split.legacyProxy,
    callTimeoutMs: 20_000,
  });
  runtimes.push(runtime);
  return Object.assign(runtime, { mounts });
}

const call = (
  runtime: McpRuntime,
  id: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
) => runtime.callExact(id, args, { toolCallId: "tc-1", signal });

async function waitUntil(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in 10s");
    await Bun.sleep(25);
  }
}

describe("mcpProxyMode", () => {
  test("defaults to the in-process relay", () => {
    expect(mcpProxyMode({})).toBe("in-process");
    expect(mcpProxyMode({ OPENSESSION_MCP_PROXY_MODE: "" })).toBe("in-process");
    expect(mcpProxyMode({ OPENSESSION_MCP_PROXY_MODE: "bogus" })).toBe(
      "in-process",
    );
  });

  test("per-server is the rollback switch", () => {
    expect(mcpProxyMode({ OPENSESSION_MCP_PROXY_MODE: "per-server" })).toBe(
      "per-server",
    );
    expect(mcpProxyMode({ OPENSESSION_MCP_PROXY_MODE: " Per-Server " })).toBe(
      "per-server",
    );
  });
});

describe("runRpcMcpMounts", () => {
  const socketTarget = { socket: "/tmp/x.sock", token: "tok" };

  test("mounts nothing without servers or a run token", () => {
    for (const mode of ["in-process", "per-server"] as const) {
      expect(
        runRpcMcpMounts({
          names: [],
          target: socketTarget,
          mode,
          proxyArgv: ["bun"],
        }),
      ).toBeUndefined();
      expect(
        runRpcMcpMounts({
          names: ["opensession-a"],
          target: { socket: "/tmp/x.sock", token: "" },
          mode,
          proxyArgv: ["bun"],
        }),
      ).toBeUndefined();
    }
  });

  test("in-process mode mounts one relay per server and no command", () => {
    const { mounts } = runRpcMcpMounts({
      names: BUILT_IN,
      target: socketTarget,
      mode: "in-process",
      proxyArgv: ["bun", "run", "proxy.ts"],
    })!;
    expect(Object.keys(mounts)).toEqual(BUILT_IN);
    for (const value of Object.values(mounts)) {
      expect(value).toMatchObject({ type: "run-rpc-relay" });
      expect(value).not.toHaveProperty("command");
    }
  });

  test("per-server mode keeps the old stdio proxy configs", () => {
    expect(
      runRpcMcpMounts({
        names: ["opensession-a", "opensession-b"],
        target: socketTarget,
        mode: "per-server",
        proxyArgv: ["bun", "run", "proxy.ts"],
      })?.mounts,
    ).toEqual({
      "opensession-a": {
        command: "bun",
        args: ["run", "proxy.ts"],
        env: {
          OPENSESSION_RPC_SOCKET: "/tmp/x.sock",
          OPENSESSION_RPC_TOKEN: "tok",
          OPENSESSION_MCP_SERVER: "opensession-a",
        },
      },
      "opensession-b": {
        command: "bun",
        args: ["run", "proxy.ts"],
        env: {
          OPENSESSION_RPC_SOCKET: "/tmp/x.sock",
          OPENSESSION_RPC_TOKEN: "tok",
          OPENSESSION_MCP_SERVER: "opensession-b",
        },
      },
    });
    expect(
      runRpcMcpMounts({
        names: ["opensession-a"],
        target: {
          wsUrl: "ws://gw/rpc-ws",
          wsHost: "h",
          wsAuth: "w",
          token: "t",
        },
        mode: "per-server",
        proxyArgv: ["opensession", "mcp-proxy"],
      })?.mounts,
    ).toEqual({
      "opensession-a": {
        command: "opensession",
        args: ["mcp-proxy"],
        env: {
          OPENSESSION_RPC_WS_URL: "ws://gw/rpc-ws",
          OPENSESSION_RPC_WS_HOST: "h",
          OPENSESSION_RPC_WS_AUTH: "w",
          OPENSESSION_RPC_TOKEN: "t",
          OPENSESSION_MCP_SERVER: "opensession-a",
        },
      },
    });
  });
});

describe("in-process relay", () => {
  test("serves all built-in servers with no relay process", async () => {
    await start(BUILT_IN);
    const runtime = await runtimeFor(BUILT_IN, "in-process");
    // Listing stays deferred, as with the per-server proxies.
    expect(runtime.hasCatalog).toBe(true);
    expect(await runtime.catalog({ hydrate: false })).toEqual([]);

    const tools = await runtime.catalog();
    expect(tools).toHaveLength(BUILT_IN.length * 3);
    expect(new Set(tools.map((t) => t.server))).toEqual(new Set(BUILT_IN));
    expect(tools.find((t) => t.id === "opensession-web_echo")).toMatchObject({
      server: "opensession-web",
      name: "echo",
      label: "opensession-web: echo",
      description: "Echo from opensession-web",
      inputSchema: {
        type: "object",
        properties: { value: {} },
      },
    });
    expect(await descendantProcesses(PROXY_PROCESS)).toEqual([]);
  });

  test("lists the same catalog the per-server proxies did", async () => {
    const names = ["opensession-a", "opensession-b", "opensession-c"];
    await start(names);
    const shape = (tools: Awaited<ReturnType<McpRuntime["catalog"]>>) =>
      tools
        .map(({ id, server, name, label, description, inputSchema }) => ({
          id,
          server,
          name,
          label,
          description,
          inputSchema,
        }))
        .sort((x, y) => x.id.localeCompare(y.id));
    const relay = shape(
      await (await runtimeFor(names, "in-process")).catalog(),
    );
    const proxied = shape(
      await (await runtimeFor(names, "per-server")).catalog(),
    );
    expect(relay).toEqual(proxied);
    expect(relay.map((t) => t.id)).toContain("opensession-b_fail");
  });

  test("dispatches each call to its own server", async () => {
    const names = ["opensession-a", "opensession-b", "opensession-c"];
    const gw = await start(names);
    const runtime = await runtimeFor(names, "in-process");
    const result = await call(runtime, "opensession-b_echo", { value: 1 });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ server: "opensession-b", args: { value: 1 } }),
      },
    ]);
    await call(runtime, "opensession-c_echo");
    expect(gw.calls.map((c) => c.server)).toEqual([
      "opensession-b",
      "opensession-c",
    ]);
  });

  test("keeps tool policy and per-server binding", async () => {
    const names = ["opensession-a", "opensession-b"];
    const gw = await start(names);
    gw.bound.delete("opensession-b");
    const runtime = await runtimeFor(names, "in-process", {
      deniedToolIds: ["opensession-a_fail"],
    });
    const ids = (await runtime.catalog()).map((t) => t.id);
    expect(ids.sort()).toEqual(["opensession-a_echo", "opensession-a_wait"]);
    await expect(call(runtime, "opensession-a_fail")).rejects.toThrow(
      "not permitted by this run's tool policy",
    );
    await expect(call(runtime, "opensession-b_echo")).rejects.toThrow(
      /MCP server "opensession-b" is not available in this session: .*not bound by this run's MCP policy/,
    );
  });

  test("errors read the same as through the per-server proxies", async () => {
    const names = ["opensession-a", "opensession-b"];
    const gw = await start(names);
    gw.bound.delete("opensession-b");
    const errors = async (mode: McpProxyMode) => {
      const runtime = await runtimeFor(names, mode);
      const out: string[] = [];
      for (const id of ["opensession-a_fail", "opensession-b_echo"])
        await call(runtime, id).then(
          () => out.push("ok"),
          (e: Error) => out.push(e.message),
        );
      return out;
    };
    const relay = await errors("in-process");
    expect(relay[0]).toBe("opensession-a refused");
    expect(await errors("per-server")).toEqual(relay);
  });

  test("a call cut short without an answer fails clearly", async () => {
    await start(["opensession-a"]);
    const cut = Bun.serve({
      unix: join(dir, "cut.sock"),
      async fetch(req) {
        if (new URL(req.url).pathname === "/mcp/list")
          return Response.json({
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          });
        return new Response("   ", {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const mounts = mountsFor(["opensession-a"], "in-process", {
        socket: join(dir, "cut.sock"),
        token: "t",
      });
      const runtime = await createMcpRuntime({
        mcpServers: [],
        deniedToolIds: new Set(),
        legacyProxyMcp: splitMcpMigrationBoundary(mounts.mounts).legacyProxy,
      });
      runtimes.push(runtime);
      await expect(call(runtime, "opensession-a_echo")).rejects.toThrow(
        /closed the call before answering/,
      );
    } finally {
      cut.stop(true);
    }
  });

  test("cancelling a call cancels the tool in the gateway", async () => {
    const gw = await start(["opensession-a", "opensession-b"]);
    const runtime = await runtimeFor(
      ["opensession-a", "opensession-b"],
      "in-process",
    );
    await runtime.catalog();
    const abort = new AbortController();
    const pending = call(runtime, "opensession-b_wait", {}, abort.signal);
    await waitUntil(() => gw.calls.some((c) => c.tool === "wait"));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await waitUntil(() => gw.aborted.includes("opensession-b_wait"));
    // The relay still serves other calls afterwards.
    expect((await call(runtime, "opensession-a_echo")).content).toHaveLength(1);
  });

  test("closing the run's runtime cancels its in-flight calls", async () => {
    const gw = await start(["opensession-a"]);
    const runtime = await runtimeFor(["opensession-a"], "in-process");
    const pending = call(runtime, "opensession-a_wait");
    pending.catch(() => {});
    await waitUntil(() => gw.calls.some((c) => c.tool === "wait"));
    await runtime.close();
    await expect(pending).rejects.toThrow();
    await waitUntil(() => gw.aborted.includes("opensession-a_wait"));
  });

  test("shares one rpc-ws connection across all servers", async () => {
    const names = BUILT_IN.slice(0, 5);
    const gw = await start(names);
    const runtime = await runtimeFor(names, "in-process", { ws: true });
    expect(await runtime.catalog()).toHaveLength(names.length * 3);
    await call(runtime, `${names[3]}_echo`, { value: "ws" });
    expect(gw.calls.at(-1)).toEqual({
      server: names[3]!,
      tool: "echo",
      args: { value: "ws" },
    });
    // Cancellation crosses the WS as a cancel frame.
    const abort = new AbortController();
    const pending = call(runtime, `${names[1]}_wait`, {}, abort.signal);
    await waitUntil(() => gw.calls.some((c) => c.tool === "wait"));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await waitUntil(() => gw.aborted.includes(`${names[1]}_wait`));
    expect(gw.wsConnections()).toBe(1);
  });
});

describe("the shared run-rpc client", () => {
  test("closing the mounts closes the rpc-ws connection and its keepalive", async () => {
    const names = ["opensession-a", "opensession-b"];
    const gw = await start(names);
    const runtime = await runtimeFor(names, "in-process", {
      ws: true,
      client: { keepaliveMs: 20 },
    });
    await call(runtime, "opensession-a_echo");
    await waitUntil(() => gw.wsPings() > 0);
    // Closing the runtime closes each server, not the client they share.
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(gw.openWsConnections()).toBe(1);
    runtime.mounts.close();
    await waitUntil(() => gw.openWsConnections() === 0);
    const pings = gw.wsPings();
    await Bun.sleep(150);
    expect(gw.wsPings()).toBe(pings);
    expect(gw.wsConnections()).toBe(1);
  });
});

describe("per-server rollback", () => {
  test("starts one stdio proxy per server, as before", async () => {
    const names = ["opensession-a", "opensession-b", "opensession-c"];
    // Proxies closed by earlier tests may still be exiting.
    await waitUntil(
      async () => (await descendantProcesses(PROXY_PROCESS)).length === 0,
    );
    const gw = await start(names);
    const runtime = await runtimeFor(names, "per-server");
    expect(await runtime.catalog()).toHaveLength(names.length * 3);
    expect(await descendantProcesses(PROXY_PROCESS)).toHaveLength(names.length);
    await call(runtime, "opensession-c_echo", { value: 3 });
    expect(gw.calls.at(-1)).toMatchObject({
      server: "opensession-c",
      args: { value: 3 },
    });
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await waitUntil(
      async () => (await descendantProcesses(PROXY_PROCESS)).length === 0,
    );
  });
});
