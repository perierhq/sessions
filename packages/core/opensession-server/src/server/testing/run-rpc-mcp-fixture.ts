/**
 * A stand-in gateway for the run-rpc MCP path, for tests and the relay
 * process measurement (scripts/measure-mcp-relay.ts).
 *
 * Serves the production run-rpc handler on a private unix socket and the
 * production /rpc-ws route (run-ws.ts: upgrade auth with a registered
 * hostId + wsToken, frame dispatch, close handling), with a fake set of
 * opensession-* servers. Nothing binds until startFakeRunRpcGateway().
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "../inprocess-mcp";
import {
  handleRpc,
  registerInteractiveMcpBuilder,
  registerRunToken,
  unregisterRunToken,
} from "../run-rpc";
import {
  handleSandboxWsUpgrade,
  registerRunWsHost,
  sandboxWsClose,
  sandboxWsMessage,
  sandboxWsOpen,
  unregisterRunWsHost,
} from "../run-ws";

export interface FakeToolCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeRunRpcGateway {
  readonly token: string;
  readonly socket: string;
  readonly wsUrl: string;
  /** The run host id and wsToken the /rpc-ws upgrade accepts. */
  readonly wsHost: string;
  readonly wsAuth: string;
  /** Every tool call that reached a server, in order. */
  readonly calls: FakeToolCall[];
  /** Tools whose call saw its abort signal fire. */
  readonly aborted: string[];
  /** rpc-ws connections opened so far. */
  wsConnections(): number;
  /** rpc-ws connections open right now. */
  openWsConnections(): number;
  /** Closes every rpc-ws connection from the gateway side, as a gateway
   *  restart or a network drop would. */
  dropWsConnections(): void;
  /** Forget the run token, as a restarted gateway does until boot recovery
   *  re-registers it; `restoreToken` registers it again. */
  forgetToken(): void;
  restoreToken(): void;
  /** Keepalive pings received over rpc-ws so far. */
  wsPings(): number;
  /** Unbinds the unix socket, as a gateway that is restarting has;
   *  `resumeSocket` binds it again. */
  pauseSocket(): void;
  resumeSocket(): void;
  /** Names bound for the run; drop one to simulate a policy unbinding it. */
  bound: Set<string>;
  stop(): Promise<void>;
}

/**
 * `names` become opensession-* servers with three tools each:
 *  - echo: returns its server and arguments (`value`)
 *  - fail: answers with an MCP tool error
 *  - wait: blocks until the call is cancelled
 */
export async function startFakeRunRpcGateway(opts: {
  dir: string;
  names: readonly string[];
  /** Where to bind run-rpc; default `<dir>/rpc.sock`. */
  socket?: string;
}): Promise<FakeRunRpcGateway> {
  const token = crypto.randomUUID();
  const wsHost = `rh-fixture-${crypto.randomUUID()}`;
  const wsAuth = crypto.randomUUID();
  const calls: FakeToolCall[] = [];
  const aborted: string[] = [];
  const bound = new Set(opts.names);
  registerRunToken(token, { sessionId: "relay-fixture" });
  const build = (name: string) =>
    createSdkMcpServer({
      name,
      tools: [
        tool(
          "echo",
          `Echo from ${name}`,
          { value: z.unknown().optional() },
          async (args: Record<string, unknown>) => {
            calls.push({ server: name, tool: "echo", args });
            return {
              content: [
                { type: "text", text: JSON.stringify({ server: name, args }) },
              ],
            };
          },
        ),
        tool("fail", `Always fails on ${name}`, {}, async () => {
          calls.push({ server: name, tool: "fail", args: {} });
          return {
            content: [{ type: "text", text: `${name} refused` }],
            isError: true,
          };
        }),
        tool("wait", `Waits on ${name}`, {}, async (_args, extra: any) => {
          calls.push({ server: name, tool: "wait", args: {} });
          await new Promise<void>((resolve) => {
            const signal = extra?.signal as AbortSignal | undefined;
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          aborted.push(`${name}_wait`);
          return { content: [{ type: "text", text: "cancelled" }] };
        }),
      ],
    });
  registerInteractiveMcpBuilder(() =>
    Object.fromEntries([...bound].map((name) => [name, build(name)])),
  );

  const socket = opts.socket ?? join(opts.dir, "rpc.sock");
  const bindUnix = () =>
    Bun.serve({
      unix: socket,
      idleTimeout: 0,
      fetch: (req: Request) => handleRpc(req),
    } as unknown as Parameters<typeof Bun.serve>[0]);
  let unix: ReturnType<typeof Bun.serve> | undefined = bindUnix();

  // The gateway's own /rpc-ws route, wired the way opensession.ts wires it.
  registerRunWsHost(wsHost, wsAuth);
  let wsOpened = 0;
  let pings = 0;
  const live = new Set<{ close(): void }>();
  const ws = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      return (
        handleSandboxWsUpgrade(req, server, new URL(req.url).pathname) ??
        undefined
      );
    },
    websocket: {
      open(sock) {
        wsOpened++;
        live.add(sock);
        sandboxWsOpen(sock);
      },
      message(sock, message) {
        if (String(message) === '{"t":"ping"}') pings++;
        sandboxWsMessage(sock, message as string | Buffer);
      },
      close(sock) {
        live.delete(sock);
        sandboxWsClose(sock);
      },
    },
  });

  return {
    token,
    socket,
    wsUrl: `ws://127.0.0.1:${ws.port}/rpc-ws`,
    wsHost,
    wsAuth,
    calls,
    aborted,
    bound,
    wsConnections: () => wsOpened,
    openWsConnections: () => live.size,
    dropWsConnections() {
      for (const sock of [...live]) sock.close();
    },
    forgetToken: () => unregisterRunToken(token),
    restoreToken: () => registerRunToken(token, { sessionId: "relay-fixture" }),
    wsPings: () => pings,
    pauseSocket() {
      unix?.stop(true);
      unix = undefined;
      rmSync(socket, { force: true });
    },
    resumeSocket() {
      unix ??= bindUnix();
    },
    async stop() {
      unix?.stop(true);
      ws.stop(true);
      unregisterRunWsHost(wsHost);
      unregisterRunToken(token);
      registerInteractiveMcpBuilder(() => ({}));
    },
  };
}

export interface ChildProcessInfo {
  pid: number;
  rssKb: number;
  command: string;
}

/** This process's descendants whose command line matches `match`. */
export async function descendantProcesses(
  match: RegExp,
): Promise<ChildProcessInfo[]> {
  const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,rss=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const rows = text
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      command: m[4]!,
    }));
  const inTree = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows)
      if (!inTree.has(row.pid) && inTree.has(row.ppid)) {
        inTree.add(row.pid);
        grew = true;
      }
  }
  return rows
    .filter(
      (row) =>
        row.pid !== process.pid &&
        inTree.has(row.pid) &&
        match.test(row.command),
    )
    .map(({ pid, rssKb, command }) => ({ pid, rssKb, command }));
}
