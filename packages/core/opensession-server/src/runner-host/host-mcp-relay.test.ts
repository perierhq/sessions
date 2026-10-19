/**
 * One run host end to end with its opensession-* servers in-process: a real
 * host.ts process, runAgent and pi-runner, with pi's SDK scripted by a
 * preload (server/testing/fake-pi-mcp-preload.ts) and a stand-in gateway
 * serving the production run-rpc unix socket and /rpc-ws route.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  descendantProcesses,
  startFakeRunRpcGateway,
  type FakeRunRpcGateway,
} from "../server/testing/run-rpc-mcp-fixture";
import { MCP_PROXY_MODE_ENV } from "./mcp-proxy-mode";
import { HOST_SOCK_NAME, rpcSocketPath } from "./protocol";

const HOST = join(import.meta.dir, "host.ts");
const PRELOAD = join(
  import.meta.dir,
  "../server/testing/fake-pi-mcp-preload.ts",
);
const NAMES = ["opensession-a", "opensession-b"];

let root: string;
let gateway: FakeRunRpcGateway | undefined;
let host: ReturnType<typeof Bun.spawn> | undefined;

beforeEach(() => {
  // Short: the gateway and host sockets live under it (macOS caps unix
  // socket paths at 104 bytes).
  root = mkdtempSync("/tmp/os-host-relay-");
});

afterEach(async () => {
  host?.kill();
  await host?.exited;
  host = undefined;
  await gateway?.stop();
  gateway = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in 15s");
    await Bun.sleep(25);
  }
}

/** A run host for one scripted pi turn; resolves with the host's dir. */
async function startHost(gw: FakeRunRpcGateway, ws: boolean) {
  const state = join(root, "state");
  const hostDir = join(root, "h");
  const cwd = join(root, "cwd");
  for (const dir of [state, hostDir, cwd]) mkdirSync(dir, { recursive: true });
  const accountId = `acct-${crypto.randomUUID()}`;
  const accounts = join(root, "codex-accounts.json");
  writeFileSync(
    accounts,
    JSON.stringify({
      accounts: [
        {
          id: accountId,
          name: "org-key",
          kind: "api_key",
          value: "test-runtime-key",
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const piConfig = join(root, "pi.json");
  writeFileSync(piConfig, JSON.stringify({ enabled: true }));
  const specPath = join(hostDir, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      // The /rpc-ws upgrade checks this host id with its wsToken.
      hostId: gw.wsHost,
      osSessionId: "relay-test",
      lifecycle: "auxiliary",
      transcriptTarget: "none",
      prompt: "use the tools",
      cwd,
      mode: "ask",
      model: "pi/openai/gpt-6.1-sol",
      accountId,
      accountStrict: true,
      mcpServers: [],
      proxyMcpServers: NAMES,
      mcpProxyMode: "in-process",
      rpcToken: gw.token,
    }),
  );
  host = Bun.spawn([process.execPath, "--preload", PRELOAD, HOST, specPath], {
    cwd,
    env: {
      PATH: process.env.PATH || "",
      HOME: root,
      TMPDIR: join(root, "tmp"),
      OPENSESSION_STATE_DIR: state,
      OPENSESSION_SESSIONS_DIR: join(root, "sessions"),
      OPENSESSION_CONFIG: join(root, "config.json"),
      OPENSESSION_PI_CONFIG: piConfig,
      OPENSESSION_RUN_JOURNAL: join(hostDir, "journal.json"),
      // The host's own env asks for rollback; the spec's mode must win.
      [MCP_PROXY_MODE_ENV]: "per-server",
      ...(ws
        ? {
            OPENSESSION_RPC_WS_URL: gw.wsUrl,
            OPENSESSION_RUN_WS_TOKEN: gw.wsAuth,
          }
        : {}),
      FAKE_PI_ACCOUNTS: accounts,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(host.stdout as ReadableStream).text(),
    new Response(host.stderr as ReadableStream).text(),
  ]).then((parts) => parts.join("\n"));
  return { hostDir, output };
}

/** Attaches as the gateway's client and waits for the run's terminal event. */
async function attach(hostDir: string) {
  const sockPath = join(hostDir, HOST_SOCK_NAME);
  await waitUntil(() => {
    if (host!.exitCode !== null) throw new Error("host exited early");
    return existsSync(sockPath);
  });
  const messages: any[] = [];
  let buffered = "";
  const client = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_socket, data) {
        buffered += data.toString();
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          messages.push(JSON.parse(buffered.slice(0, newline)));
          buffered = buffered.slice(newline + 1);
        }
      },
    },
  });
  // The socket stream is live-only: a run that ended before we attached
  // reports its terminal event in `hello`.
  const terminal = () =>
    messages.find((m) => m.t === "end")?.done ??
    messages.find((m) => m.t === "hello" && m.state === "ended")?.done;
  await waitUntil(() => !!terminal());
  return {
    done: terminal(),
    shutdown: () => client.write(JSON.stringify({ t: "shutdown" }) + "\n"),
  };
}

for (const ws of [false, true]) {
  const via = ws ? "rpc-ws" : "the unix socket";

  test(`a run host serves its opensession-* servers in-process over ${via}`, async () => {
    mkdirSync(join(root, "sessions"));
    const gw = (gateway = await startFakeRunRpcGateway({
      dir: root,
      names: NAMES,
      socket: rpcSocketPath(join(root, "sessions")),
    }));
    const { hostDir, output } = await startHost(gw, ws);
    try {
      const run = await attach(hostDir);
      expect(run.done).toMatchObject({
        type: "done",
        result: JSON.stringify({
          server: "opensession-b",
          args: { value: "via host" },
        }),
      });
      expect(gw.calls).toEqual([
        { server: "opensession-a", tool: "wait", args: {} },
        { server: "opensession-b", tool: "echo", args: { value: "via host" } },
      ]);
      // Ending the turn closed its MCP runtime, which cancelled the call the
      // turn left in flight.
      await waitUntil(() => gw.aborted.includes("opensession-a_wait"));
      // The relays ran inside the host: no stdio proxy, despite its env.
      expect(await descendantProcesses(/mcp-proxy/)).toEqual([]);
      if (ws) {
        // One shared connection, closed at run end while the host lingers.
        expect(gw.wsConnections()).toBe(1);
        await waitUntil(() => gw.openWsConnections() === 0);
      }
      run.shutdown();
    } catch (e) {
      host!.kill();
      throw new Error(`${e}\n--- host output ---\n${await output}`);
    }
    expect(await host!.exited).toBe(0);
    expect(await output).toContain(
      "opensession MCP: 2 server(s), in-process relay",
    );
  }, 30_000);
}
