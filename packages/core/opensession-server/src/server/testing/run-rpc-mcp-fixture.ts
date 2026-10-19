/**
 * A stand-in gateway for the run-rpc MCP path, for tests and the relay
 * process measurement (scripts/measure-mcp-relay.ts).
 *
 * Serves the production run-rpc handler on a private unix socket and a
 * minimal /rpc-ws bridge over the same dispatch core, with a fake set of
 * opensession-* servers. Nothing binds until startFakeRunRpcGateway().
 */
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "../inprocess-mcp";
import {
  dispatchRunRpc,
  handleRpc,
  registerInteractiveMcpBuilder,
  registerRunToken,
  unregisterRunToken,
} from "../run-rpc";

export interface FakeToolCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeRunRpcGateway {
  readonly token: string;
  readonly socket: string;
  readonly wsUrl: string;
  /** Every tool call that reached a server, in order. */
  readonly calls: FakeToolCall[];
  /** Tools whose call saw its abort signal fire. */
  readonly aborted: string[];
  /** rpc-ws connections opened so far. */
  wsConnections(): number;
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
}): Promise<FakeRunRpcGateway> {
  const token = crypto.randomUUID();
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

  const socket = join(opts.dir, "rpc.sock");
  const unix = Bun.serve({
    unix: socket,
    idleTimeout: 0,
    fetch: (req: Request) => handleRpc(req),
  } as unknown as Parameters<typeof Bun.serve>[0]);

  // Same frame protocol as run-ws.ts's rpc-ws handler.
  let wsOpened = 0;
  const aborts = new Map<string, AbortController>();
  const ws = Bun.serve<undefined, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (new URL(req.url).pathname !== "/rpc-ws")
        return new Response("not found", { status: 404 });
      return server.upgrade(req, { data: undefined })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open() {
        wsOpened++;
      },
      async message(sock, message) {
        const frame = JSON.parse(String(message));
        if (frame?.t === "ping") return void sock.send('{"t":"pong"}');
        const id = String(frame?.id || "");
        if (frame?.t === "cancel") return void aborts.get(id)?.abort();
        const abort = new AbortController();
        aborts.set(id, abort);
        const d = await dispatchRunRpc(String(frame.path), frame, abort.signal);
        const [status, body] =
          d.kind === "immediate" ? [d.status, d.body] : [200, await d.done];
        aborts.delete(id);
        try {
          sock.send(JSON.stringify({ id, status, body }));
        } catch {}
      },
    },
  });

  return {
    token,
    socket,
    wsUrl: `ws://127.0.0.1:${ws.port}/rpc-ws`,
    calls,
    aborted,
    bound,
    wsConnections: () => wsOpened,
    async stop() {
      unix.stop(true);
      ws.stop(true);
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
