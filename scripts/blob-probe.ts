#!/usr/bin/env bun
/**
 * A headless Blob: makes the calls the Blob app makes, in the order it makes
 * them, against a running server, and says what Blob would show and whether
 * each flow works. For testing Blob's real flows without the app.
 *
 *   OPENSESSION_URL=https://sessions.example.test \
 *   OPENSESSION_PROBE_TOKEN=<web session token> \
 *   bun scripts/blob-probe.ts [scenario[,scenario]] [options]
 *
 * Scenarios (all, in this order, when none is named):
 *   open             ensure, glossary, brief with start=1, poll until ready
 *   talk             send a message like the app, read the reply until settled
 *   history          current session's history, then previous sessions
 *   brief-lifecycle  mark the brief seen, Done, read it again
 *   answer           stale revision → 409 changed, current revision → answered
 *
 * Options:
 *   --owner-read-only   allow running as the instance owner: only open
 *                       (without start) and history
 *   --message <text>    what `talk` sends
 *   --item <id>         an open needs-you item in the probe member's inbox
 *                       for `answer` (no server route creates one)
 *   --brief-timeout <s> how long `open` polls a brief being written (180)
 *   --reply-timeout <s> how long `talk` waits for the reply to settle (300)
 *
 * It refuses to run as the instance owner unless --owner-read-only is given.
 * The token rides only in the Authorization header and is never printed.
 * Setup: packages/clients/ios/README.md, "Testing Blob without the app".
 * Pure parts and checks: scripts/lib/blob-probe.ts.
 */
import {
  briefDecisions,
  briefKey,
  checkAnswer,
  checkBriefAfterDone,
  checkHistory,
  checkOpen,
  checkTalk,
  deliveryOutcome,
  errorMessage,
  excerpt,
  exchanges,
  fail,
  glossaryCount,
  ownerFromStatus,
  parseAuthStatus,
  parseBriefResponse,
  parseEnsure,
  parseItems,
  parseProbeArgs,
  planRun,
  probeToken,
  promptBody,
  renderBrief,
  SessionStream,
  serverBase,
  skip,
  socketUrl,
  splitReply,
  staleRevision,
  TalkTurn,
  talkResult,
  watchFrame,
  type Delivery,
  type Ensured,
  type HistoryRead,
  type ProbeBriefResponse,
  type ProbeOptions,
  type PromptBody,
  type Scenario,
  type SignedIn,
  type Verdict,
} from "./lib/blob-probe";

const HTTP_TIMEOUT_MS = 20_000;
const PREPARING_POLL_MS = 10_000;
const SOCKET_PING_MS = 20_000;
const HISTORY_PAGE = 200;
const HISTORY_MAX_PAGES = 25;
const PREVIOUS_MAX = 3;
const SEND_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line = "") => console.log(line ? `  ${line}` : "");

// ── HTTP ────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: unknown;
}

class Api {
  constructor(
    readonly base: string,
    private readonly token: string,
  ) {}

  get authorization(): string {
    return `Bearer ${this.token}`;
  }

  /** One request as OS1API makes it: Bearer token, JSON body. A network
   *  failure is status 0 with the reason; the token never appears in it. */
  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    const headers = new Headers({ Authorization: this.authorization });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    try {
      const response = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: "manual",
      });
      const text = await response.text();
      return { status: response.status, body: parseJson(text) };
    } catch (error) {
      return {
        status: 0,
        body: { error: error instanceof Error ? error.name : "network error" },
      };
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function errorOf(reply: Reply): string {
  const message = errorMessage(reply.body);
  return reply.status
    ? `HTTP ${reply.status}${message ? ` (${message})` : ""}`
    : `no response (${message || "network error"})`;
}

// ── Socket ──────────────────────────────────────────────────────────────────

/** The app's /ws connection: Bearer token on the upgrade, a ping every
 *  20 s, every frame handed to `onFrame`. */
class Socket {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private waiters = new Set<() => void>();
  closed: string | null = null;

  constructor(
    private readonly api: Api,
    private readonly onFrame: (frame: unknown) => void,
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      // SAFETY: Bun's WebSocket takes `{ headers }` as its second argument,
      // as scripts/ws-stdio-proxy.ts uses it; the DOM type knows only protocols.
      const ws = new WebSocket(socketUrl(this.api.base), {
        headers: { Authorization: this.api.authorization },
      } as unknown as string[]);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("the socket did not open in 20 s"));
        ws.close();
      }, HTTP_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ping = setInterval(
          () => this.send({ type: "ping" }),
          SOCKET_PING_MS,
        );
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the socket failed to open (signed out, or no /ws)"));
      };
      ws.onclose = (event) => {
        this.closed = `closed (${event.code})`;
        this.wake();
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        this.onFrame(parseJson(event.data));
        this.wake();
      };
    });
  }

  send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(frame));
  }

  /** Resolves when `done()` is true after a frame, or false at the timeout
   *  or when the socket closes. */
  async until(done: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (this.closed) return false;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(left, 1000));
        this.waiters.add(wake);
      });
    }
    return true;
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }
}

/** Opens a socket and watches one session until its transcript_init. */
async function watch(
  api: Api,
  sessionId: string,
): Promise<{ socket: Socket; stream: SessionStream }> {
  const stream = new SessionStream(sessionId);
  const socket = new Socket(api, (frame) => stream.apply(frame));
  await socket.open();
  socket.send(watchFrame(sessionId));
  const ready = await socket.until(
    () => stream.initialized || stream.errors.length > 0,
    HTTP_TIMEOUT_MS,
  );
  if (!stream.initialized) {
    socket.close();
    throw new Error(
      stream.errors[0] ??
        (ready ? "no transcript" : "no transcript_init in 20 s"),
    );
  }
  return { socket, stream };
}

// ── Shared state ────────────────────────────────────────────────────────────

interface Context {
  api: Api;
  me: SignedIn;
  ownerReadOnly: boolean;
  ensured: Ensured | null;
  options: ProbeOptions;
}

/** POST /api/supervisor/ensure { user }, once per run, as on app launch. */
async function ensure(ctx: Context): Promise<Ensured> {
  if (ctx.ensured) return ctx.ensured;
  const reply = await ctx.api.call("POST", "/api/supervisor/ensure", {
    user: ctx.me.name,
  });
  const ensured = reply.status === 200 ? parseEnsure(reply.body) : null;
  if (!ensured) throw new Error(`ensure failed: ${errorOf(reply)}`);
  ctx.ensured = ensured;
  return ensured;
}

/** GET /api/supervisor/brief, with `start=1` when Blob comes to the front
 *  (OS1API.supervisorBrief). */
async function readBrief(
  ctx: Context,
  start: boolean,
): Promise<ProbeBriefResponse> {
  const query = new URLSearchParams({ user: ctx.me.name });
  if (start) query.set("start", "1");
  const reply = await ctx.api.call("GET", `/api/supervisor/brief?${query}`);
  if (reply.status !== 200) throw new Error(`brief failed: ${errorOf(reply)}`);
  return parseBriefResponse(reply.body);
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function openScenario(ctx: Context): Promise<Verdict> {
  const ensured = await ensure(ctx);
  say(
    `supervisor ${ensured.sessionId}, ${ensured.previousSessionIds.length} earlier session(s)`,
  );
  const glossary = await ctx.api.call("GET", "/api/blob/glossary");
  const terms = glossary.status === 200 ? glossaryCount(glossary.body) : null;
  say(
    terms === null
      ? `glossary: ${errorOf(glossary)}`
      : `glossary: ${terms} term(s)`,
  );
  // The owner's open is read-only: no start, so no brief turn on their budget.
  const start = !ctx.ownerReadOnly;
  let response = await readBrief(ctx, start);
  const deadline = Date.now() + ctx.options.briefTimeoutMs;
  if (response.state === "preparing")
    say("Blob thinks: Putting your brief together.");
  while (response.state === "preparing" && Date.now() < deadline) {
    await sleep(
      Math.min(PREPARING_POLL_MS, Math.max(0, deadline - Date.now())),
    );
    response = await readBrief(ctx, false);
  }
  for (const line of renderBrief(response)) say(line);
  if (terms === null) return fail(`glossary failed: ${errorOf(glossary)}`);
  return checkOpen(response, response.state === "preparing");
}

/** Sends like the outbox: same clientId on every try, held on 401 and 5xx
 *  and network errors, given up on any other answer. */
async function deliver(
  ctx: Context,
  sessionId: string,
  body: PromptBody,
): Promise<Delivery> {
  let last: Delivery = { kind: "retry", reason: "not sent" };
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    const reply = await ctx.api.call(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
      body,
    );
    last = reply.status
      ? deliveryOutcome(reply.status, reply.body)
      : { kind: "retry", reason: errorOf(reply) };
    if (last.kind !== "retry") return last;
    say(`send attempt ${attempt} held: ${last.reason}`);
    await sleep(1000 * 2 ** attempt);
  }
  return last;
}

async function talkScenario(ctx: Context): Promise<Verdict> {
  const ensured = await ensure(ctx);
  const { socket, stream } = await watch(ctx.api, ensured.sessionId);
  try {
    const clientId = crypto.randomUUID().toUpperCase();
    const errorsBefore = stream.errors.length;
    const turn = new TalkTurn(clientId, performance.now());
    // Every frame from here moves the turn on.
    const observe = () => turn.observe(stream, performance.now());
    const body = promptBody({
      content: ctx.options.message,
      clientId,
      user: ctx.me.name,
      effort: ensured.effort,
      speed: ensured.speed,
    });
    say(`you: ${ctx.options.message}`);
    const delivery = await deliver(ctx, ensured.sessionId, body);
    say(
      delivery.kind === "delivered"
        ? `outbox ${clientId}: ${delivery.status}`
        : `outbox ${clientId}: ${delivery.kind}, ${delivery.reason}`,
    );
    if (delivery.kind === "delivered") {
      await socket.until(() => {
        observe();
        return turn.settledAt !== null;
      }, ctx.options.replyTimeoutMs);
      observe();
    }
    const result = talkResult(turn, stream, delivery, errorsBefore);
    if (result.reply) {
      const split = splitReply(result.reply);
      say(`Blob says: ${split.say || "(nothing)"}`);
      if (split.show) say(`Blob shows: ${excerpt(split.show, 160)}`);
    }
    if (socket.closed) say(`socket ${socket.closed}`);
    return checkTalk(result);
  } finally {
    socket.close();
  }
}

/** Every page of a session's history, as "load earlier" walks it. */
async function readWhole(
  ctx: Context,
  sessionId: string,
): Promise<{ stream: SessionStream; complete: boolean }> {
  const { socket, stream } = await watch(ctx.api, sessionId);
  try {
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const request = stream.historyRequest(HISTORY_PAGE);
      if (!request) return { stream, complete: true };
      const before = stream.entries.length;
      stream.loadingEarlier = true;
      socket.send(request);
      const landed = await socket.until(
        () => !stream.loadingEarlier,
        HTTP_TIMEOUT_MS,
      );
      if (!landed || stream.entries.length === before)
        return { stream, complete: !stream.cursor.truncated };
    }
    return { stream, complete: !stream.cursor.truncated };
  } finally {
    socket.close();
  }
}

async function historyScenario(ctx: Context): Promise<Verdict> {
  const ensured = await ensure(ctx);
  const current = await readWhole(ctx, ensured.sessionId);
  const now = exchanges(current.stream.entries);
  say(`current session: ${now.length} exchange(s)`);
  for (const e of now.slice(-2))
    say(
      `  ${e.at ?? "?"} you: ${excerpt(e.said, 60)} / Blob: ${excerpt(e.reply, 60)}`,
    );
  const read: HistoryRead = {
    current: {
      sessionId: ensured.sessionId,
      exchanges: now.length,
      complete: current.complete,
    },
    previous: [],
  };
  for (const id of ensured.previousSessionIds.slice(0, PREVIOUS_MAX)) {
    try {
      const earlier = await readWhole(ctx, id);
      const found = exchanges(earlier.stream.entries);
      read.previous.push({
        sessionId: id,
        exchanges: found.length,
        error: null,
      });
      const last = found.at(-1);
      say(
        `before rotation ${id}: ${found.length} exchange(s)${last ? `, last: ${excerpt(last.said, 60)}` : ""}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      read.previous.push({ sessionId: id, exchanges: 0, error: message });
      say(`before rotation ${id}: ${message}`);
    }
  }
  if (ensured.previousSessionIds.length)
    say(
      "note: the app's ensure decodes only sessionId (OS1API.SupervisorEnsure), so Blob's history view pages the current session only",
    );
  return checkHistory(read);
}

async function briefLifecycleScenario(ctx: Context): Promise<Verdict> {
  const before = await readBrief(ctx, false);
  if (before.state !== "ready" || !before.brief)
    return skip(`no ready brief to put away (state ${before.state})`);
  const brief = before.brief;
  say(
    `brief ${briefKey(brief)}, ${briefDecisions(brief).length} open decision(s)`,
  );
  // BlobBrief.shown: the page is on screen, so it is marked seen.
  const seen = await ctx.api.call("POST", "/api/supervisor/brief/seen", {
    user: ctx.me.name,
    day: brief.day,
  });
  if (seen.status !== 200) return fail(`marking seen failed: ${errorOf(seen)}`);
  say("seen: POST /api/supervisor/brief/seen ok");
  // BlobBrief.dismiss: "Done" is local to the app; it makes no call.
  say("Done: put away on the device (no server call)");
  const after = await readBrief(ctx, false);
  for (const line of renderBrief(after)) say(line);
  return checkBriefAfterDone(before, after);
}

async function answerScenario(ctx: Context): Promise<Verdict> {
  if (!ctx.options.item)
    return skip(
      "the server has no route that posts an item to an inbox (only the supervisor's own tools do); pass --item <id> with an open needs-you item in the probe member's inbox",
    );
  const id = ctx.options.item;
  const read = async () => {
    const query = new URLSearchParams({
      state: "open",
      user: ctx.me.name,
      limit: "100",
    });
    const reply = await ctx.api.call("GET", `/api/supervisor/items?${query}`);
    if (reply.status !== 200)
      throw new Error(`items failed: ${errorOf(reply)}`);
    return parseItems(reply.body).find((item) => item.id === id) ?? null;
  };
  const item = await read();
  if (!item) return fail(`no open item ${id} in ${ctx.me.name}'s inbox`);
  if (item.kind !== "needs-you")
    return fail(`item ${id} is ${item.kind}, not needs-you`);
  if (item.steps.length)
    return skip(
      `item ${id} approves ${item.steps.length} step(s); the probe answers only items that run nothing`,
    );
  if (item.revision === null) return fail(`item ${id} carries no revision`);
  say(`decision: ${item.title} [rev ${item.revision}]`);
  const answer = item.options[0] ?? "ok";
  const path = `/api/supervisor/items/${encodeURIComponent(id)}/answer`;
  const stale = await ctx.api.call("POST", path, {
    user: ctx.me.name,
    answer,
    revision: staleRevision(item.revision),
  });
  say(`stale revision ${staleRevision(item.revision)}: ${errorOf(stale)}`);
  const reread = await read();
  let fresh: Reply | null = null;
  if (reread?.revision !== null && reread?.revision !== undefined) {
    fresh = await ctx.api.call("POST", path, {
      user: ctx.me.name,
      answer,
      revision: reread.revision,
    });
    say(
      `revision ${reread.revision}, answering "${answer}": HTTP ${fresh.status}`,
    );
  }
  return checkAnswer(stale, reread, fresh);
}

const RUNNERS: Record<Scenario, (ctx: Context) => Promise<Verdict>> = {
  open: openScenario,
  talk: talkScenario,
  history: historyScenario,
  "brief-lifecycle": briefLifecycleScenario,
  answer: answerScenario,
};

// ── Main ────────────────────────────────────────────────────────────────────

function parseOptions() {
  const options = parseProbeArgs(process.argv.slice(2));
  if ("error" in options) {
    console.error(`blob-probe: ${options.error} (--help for usage)`);
    process.exit(2);
  }
  return options;
}

async function main(): Promise<number> {
  const options = parseOptions();
  if (options.help) {
    const doc = (await Bun.file(import.meta.path).text()).split("*/")[0]!;
    console.log(doc.replace(/^#!.*\n\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
    return 0;
  }
  const base = serverBase(process.env.OPENSESSION_URL);
  if (typeof base !== "string") {
    console.error(`blob-probe: ${base.error}`);
    return 2;
  }
  const token = probeToken(process.env.OPENSESSION_PROBE_TOKEN);
  if (!token) {
    console.error(
      "blob-probe: OPENSESSION_PROBE_TOKEN is not set, or is not a web session token",
    );
    return 2;
  }
  const api = new Api(base, token);

  const status = await api.call("GET", "/api/auth/status");
  const me =
    status.status === 200
      ? parseAuthStatus(status.body)
      : { error: errorOf(status) };
  if ("error" in me) {
    console.error(`blob-probe: ${me.error}`);
    return 2;
  }
  const gate = ownerFromStatus(
    (await api.call("GET", "/api/blob/github")).status,
  );
  const plan = planRun(gate, options);
  if ("refuse" in plan) {
    console.error(`blob-probe: refusing to run: ${plan.refuse}`);
    return 2;
  }
  console.log(
    `blob-probe: ${new URL(base).host} as ${me.name} (@${me.login}, ${gate})`,
  );

  const ctx: Context = {
    api,
    me,
    ownerReadOnly: gate !== "member" || options.ownerReadOnly,
    ensured: null,
    options,
  };
  const verdicts: Array<[Scenario, Verdict]> = [];
  for (const scenario of plan.skipped)
    verdicts.push([
      scenario,
      skip("not read-only: skipped with --owner-read-only"),
    ]);
  for (const scenario of plan.run) {
    console.log(`\n\u2500\u2500 ${scenario}`);
    let verdict: Verdict;
    try {
      verdict = await RUNNERS[scenario](ctx);
    } catch (error) {
      verdict = fail(error instanceof Error ? error.message : String(error));
    }
    console.log(`${verdict.status} ${scenario}: ${verdict.reason}`);
    verdicts.push([scenario, verdict]);
  }
  console.log("");
  for (const [scenario, verdict] of verdicts)
    if (verdict.status === "SKIP")
      console.log(`SKIP ${scenario}: ${verdict.reason}`);
  const failed = verdicts.filter(([, v]) => v.status === "FAIL").length;
  console.log(
    `${verdicts.filter(([, v]) => v.status === "PASS").length} passed, ${failed} failed, ${verdicts.filter(([, v]) => v.status === "SKIP").length} skipped`,
  );
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
