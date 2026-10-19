/**
 * Client side of run-rpc (src/server/run-rpc.ts): how a run reaches the
 * opensession-* MCP servers that execute inside the gateway.
 *
 * One client serves every server a run has. Each request names its server in
 * the body, so a single unix-socket route or a single /rpc-ws connection
 * carries all of them. Used by the in-process relay in the run host
 * (mcp-mounts.ts) and by the per-server stdio proxy (mcp-proxy.ts).
 *
 * Importing this module has no live effects: the WS connection and its
 * keepalive start on the first request.
 */

/** Where the gateway's run-rpc is and the run's bearer. */
export type RunRpcTarget =
  /** Host-local runs: opensession's run-rpc unix socket. */
  | { socket: string; token: string }
  /** Remote sandboxes, where a unix socket can't cross the boundary: the
   *  /rpc-ws route. The upgrade authenticates this run's hostId + wsToken;
   *  every frame still carries `token` for dispatchRunRpc. */
  | { wsUrl: string; wsHost: string; wsAuth: string; token: string };

export interface RunRpcCallOptions {
  /** Total retry budget for connection-level failures. */
  timeoutMs?: number;
  /** Aborting cancels the call on the gateway side too. */
  signal?: AbortSignal;
}

export interface RunRpcClient {
  /** One request for `server`. Resolves with the answered body; throws on
   *  an answered error or when the gateway stays unreachable. */
  call(
    path: string,
    server: string,
    body: Record<string, unknown>,
    options?: RunRpcCallOptions,
  ): Promise<Record<string, any>>;
  /** Drops the WS connection and its keepalive, if any. */
  close(): void;
}

/**
 * An error the opensession side answered with. Most are terminal, but an
 * unknown run token is special: after an opensession restart the detached
 * engine and this client are still alive before boot recovery has
 * re-registered the token. Retrying that one answer lets the client bridge the
 * recovery gap.
 */
export class RunRpcError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function rpcError(status: number, data: any): RunRpcError {
  const message = data?.error || `opensession RPC ${status}`;
  // A token that is genuinely invalid is no more privileged by waiting: this
  // only gives an in-flight detached run time for the restarted server to
  // restore its in-memory token registry. All other answered authz/tool
  // errors remain immediate failures.
  return new RunRpcError(
    message,
    message === "unauthorized (unknown run token)",
  );
}

/**
 * The body of an answered call. Long calls stream heartbeat padding before
 * the JSON, so a call cut short by a restart arrives as a 200 with no body.
 * That is not an answer, and the tool may already have acted, so it is not
 * retried either.
 */
function answeredBody(status: number, data: any): Record<string, any> {
  if (status !== 200) throw rpcError(status, data);
  if (!data || typeof data !== "object")
    throw new RunRpcError(
      "opensession closed the call before answering, probably a restart. The tool may or may not have finished: check its result before calling it again.",
    );
  // Long tool calls report failures in the body instead of the status.
  if (typeof data.error === "string" && data.error)
    throw rpcError(status, data);
  return data;
}

export function createRunRpcClient(
  target: RunRpcTarget,
  opts: { retryDelayMs?: number; keepaliveMs?: number } = {},
): RunRpcClient {
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  const keepaliveMs = opts.keepaliveMs ?? 30_000;
  const ws = "wsUrl" in target ? target : undefined;
  const socket = "socket" in target ? target.socket : "";
  const where = ws ? ws.wsUrl : socket;
  let closed = false;

  // ── WS transport: one persistent connection, request/response frames by
  // id. Frames out: {id, path, token, server, tool?, args?}; frames in:
  // {id, status, body}. A dropped connection rejects the in-flight waiters as
  // retryable, the same as a unix-socket connect failure (the attempt is
  // re-sent after reconnect until the deadline).
  const wsDialUrl = ws
    ? `${ws.wsUrl}${ws.wsUrl.includes("?") ? "&" : "?"}host=${encodeURIComponent(ws.wsHost)}`
    : "";
  let wsLive: WebSocket | null = null;
  let wsDialing: Promise<WebSocket> | null = null;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const wsPending = new Map<
    string,
    {
      resolve: (v: { status: number; body: any }) => void;
      reject: (e: unknown) => void;
    }
  >();

  const ensureWs = (): Promise<WebSocket> => {
    if (closed) return Promise.reject(new Error("run-rpc client closed"));
    if (wsLive && wsLive.readyState === WebSocket.OPEN)
      return Promise.resolve(wsLive);
    if (wsDialing) return wsDialing;
    // Keepalive: quiet minutes-long tool calls must not look idle to
    // Bun.serve's per-socket timer on the opensession side.
    keepalive ??= setInterval(() => {
      try {
        if (wsLive?.readyState === WebSocket.OPEN) wsLive.send('{"t":"ping"}');
      } catch {}
    }, keepaliveMs);
    (keepalive as { unref?: () => void }).unref?.();
    wsDialing = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      let sock: WebSocket;
      try {
        // Bun extension: custom headers on the client handshake.
        sock = new WebSocket(wsDialUrl, {
          headers: { authorization: `Bearer ${ws!.wsAuth}` },
        } as unknown as string[]);
      } catch (e) {
        wsDialing = null;
        reject(e);
        return;
      }
      sock.onopen = () => {
        wsLive = sock;
        wsDialing = null;
        if (!settled) {
          settled = true;
          resolve(sock);
        }
      };
      sock.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg?.t === "pong") return;
        const waiter = wsPending.get(String(msg?.id || ""));
        if (waiter) {
          wsPending.delete(String(msg.id));
          waiter.resolve({ status: Number(msg.status) || 0, body: msg.body });
        }
      };
      sock.onclose = () => {
        if (wsLive === sock) wsLive = null;
        wsDialing = null;
        const err = new Error("rpc-ws connection dropped");
        for (const [id, w] of [...wsPending]) {
          wsPending.delete(id);
          w.reject(err); // retryable: call()'s loop re-sends after reconnect
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      sock.onerror = () => {}; // onclose follows and owns the rejection
    });
    return wsDialing;
  };

  const onceWs = async (
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> => {
    const sock = await ensureWs();
    const id = crypto.randomUUID();
    const res = await new Promise<{ status: number; body: any }>(
      (resolve, reject) => {
        wsPending.set(id, { resolve, reject });
        // Our caller gave up: tell opensession to cancel the tool call.
        signal?.addEventListener(
          "abort",
          () => {
            if (!wsPending.delete(id)) return;
            try {
              sock.send(JSON.stringify({ t: "cancel", id }));
            } catch {}
            reject(signal.reason);
          },
          { once: true },
        );
        try {
          sock.send(JSON.stringify({ id, path, ...body }));
        } catch (e) {
          wsPending.delete(id);
          reject(e);
        }
      },
    );
    return answeredBody(res.status, res.body);
  };

  const onceSocket = async (
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, any>> => {
    // Aborting drops the request, which cancels the tool call on the far side.
    const res = await fetch(`http://backstage${path}`, {
      method: "POST",
      signal,
      // Bun extension: route the request over a unix socket.
      unix: socket,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    } as any);
    let data: any = null;
    try {
      data = await res.json();
    } catch {}
    return answeredBody(res.status, data);
  };

  return {
    /**
     * Connection-level failures (socket gone, WS dropped: opensession
     * restarting) retry until the deadline. Answered errors surface
     * immediately, except an unknown run token during restart recovery.
     */
    async call(path, server, body, options = {}) {
      const timeoutMs = options.timeoutMs ?? 120_000;
      const signal = options.signal;
      const frame = { token: target.token, server, ...body };
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown;
      for (;;) {
        signal?.throwIfAborted();
        try {
          return await (ws
            ? onceWs(path, frame, signal)
            : onceSocket(path, frame, signal));
        } catch (e) {
          if (signal?.aborted) throw e;
          if (e instanceof RunRpcError && !e.retryable) throw e;
          lastErr = e; // connect failure: opensession likely restarting
        }
        if (closed) throw new Error("run-rpc client closed");
        if (Date.now() >= deadline) {
          throw new Error(
            `opensession unreachable at ${where} for ${Math.round(timeoutMs / 1000)}s: ${lastErr}`,
          );
        }
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    },
    close() {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      keepalive = undefined;
      try {
        wsLive?.close();
      } catch {}
      wsLive = null;
    },
  };
}
