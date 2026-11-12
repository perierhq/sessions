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
 *   open             ensure, glossary, the timezone prefs, brief with
 *                    start=1, poll until ready
 *   talk             send a message like the app, read the reply until settled
 *   history          page GET /api/supervisor/history as Blob does, back to
 *                    an exchange from before the latest rotation
 *   brief-lifecycle  mark the brief seen, Done, read it again
 *   answer           stale revision → 409 changed, read again → answered
 *
 * Options:
 *   --owner-read-only   allow running as the instance owner: only open
 *                       (no ensure, no start, no timezone write) and
 *                       history; every HTTP request must be a GET
 *   --message <text>    what `talk` sends
 *   --item <id>         an open needs-you item in the probe member's inbox
 *                       for `answer` (no server route creates one)
 *   --allow-answer      without --item, `answer` answers the brief's first
 *                       decision (never with --owner-read-only)
 *   --brief-timeout <s> how long `open` polls a brief being written (180)
 *   --reply-timeout <s> how long `talk` waits for the reply to settle (300)
 *
 * It refuses to run as the instance owner unless --owner-read-only is given.
 * The token rides only in the Authorization header and is never printed.
 * Setup: packages/clients/ios/README.md, "Testing Blob without the app".
 * Pure parts and checks: scripts/lib/blob-probe.ts.
 */
import {
  assertReadOnlyMethod,
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
  historyFoundEarlier,
  outboxNext,
  ownerFromStatus,
  parseAuthStatus,
  parseBriefResponse,
  parseEnsure,
  parseHistoryPage,
  parseItems,
  parseProbeArgs,
  planRun,
  prependPage,
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
  type PastExchange,
  type ProbeBriefResponse,
  type ProbeItem,
  type ProbeOptions,
  type PromptBody,
  type Scenario,
  type SignedIn,
  type Verdict,
  timezoneToSet,
} from "./lib/blob-probe";

const HTTP_TIMEOUT_MS = 20_000;
const PREPARING_POLL_MS = 10_000;
const SOCKET_PING_MS = 20_000;
const HISTORY_PAGE = 200;
const HISTORY_MAX_PAGES = 25;
const PREVIOUS_MAX = 3;
const SESSION_NOT_FOUND = "Session not found";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line = "") => console.log(line ? `  ${line}` : "");

// ── HTTP ────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: unknown;
}

export class Api {
  constructor(
    readonly base: string,
    private readonly token: string,
    /** --owner-read-only: GET only, and no socket. */
    readonly readOnly: boolean,
  ) {}

  get authorization(): string {
    return `Bearer ${this.token}`;
  }

  /** One request as OS1API makes it: Bearer token, JSON body. A network
   *  failure is status 0 with the reason; the token never appears in it.
   *  Read-only, anything but GET throws before it is sent. */
  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    assertReadOnlyMethod(method, this.readOnly);
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
    // A socket can send prompts; read-only has no use for one.
    if (this.api.readOnly)
      return Promise.reject(new Error("read-only: no socket"));
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

/** Opens a socket and watches one session until its transcript_init. A
 *  "Session not found" (the session isn't on disk yet) is watched again on
 *  the outbox's backoff, inside its 120 s window. */
async function watch(
  api: Api,
  sessionId: string,
): Promise<{ socket: Socket; stream: SessionStream }> {
  const stream = new SessionStream(sessionId);
  const socket = new Socket(api, (frame) => stream.apply(frame));
  await socket.open();
  const startedAt = Date.now();
  for (let attempts = 1; ; attempts++) {
    const errorsBefore = stream.errors.length;
    socket.send(watchFrame(sessionId));
    const ready = await socket.until(
      () => stream.initialized || stream.errors.length > errorsBefore,
      HTTP_TIMEOUT_MS,
    );
    if (stream.initialized) return { socket, stream };
    const error = stream.errors[errorsBefore];
    const next =
      error === SESSION_NOT_FOUND
        ? outboxNext(
            { kind: "missing", reason: error },
            attempts,
            Date.now() - startedAt,
            Math.random(),
          )
        : null;
    if (!next || "done" in next) {
      socket.close();
      throw new Error(
        next && "done" in next && next.done.kind === "rejected"
          ? next.done.reason
          : (error ?? (ready ? "no transcript" : "no transcript_init in 20 s")),
      );
    }
    say(`watch: ${error}, again in ${Math.round(next.waitMs / 1000)} s`);
    await sleep(next.waitMs);
  }
}

// ── Shared state ────────────────────────────────────────────────────────────

export interface Context {
  api: Api;
  me: SignedIn;
  ensured: Ensured | null;
  options: ProbeOptions;
}

/** POST /api/supervisor/ensure { user }, once per run, as on app launch.
 *  Never read-only: the Api refuses the POST. */
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

/** GET /api/supervisor/items?state=open (OS1API.supervisorItems). */
async function readItems(ctx: Context): Promise<ProbeItem[]> {
  const query = new URLSearchParams({
    state: "open",
    user: ctx.me.name,
    limit: "100",
  });
  const reply = await ctx.api.call("GET", `/api/supervisor/items?${query}`);
  if (reply.status !== 200) throw new Error(`items failed: ${errorOf(reply)}`);
  return parseItems(reply.body);
}

/** BlobHomeView's launch task: reads the prefs and, when the server has no
 *  zone, gives it this machine's (OS1API.ensureSupervisorTimezone). The app
 *  ignores a failure here, so the probe only reports it. Read-only, it
 *  says what it would set and sends nothing. */
async function launchTimezone(ctx: Context): Promise<void> {
  const query = new URLSearchParams({ user: ctx.me.name });
  const prefs = await ctx.api.call("GET", `/api/supervisor/prefs?${query}`);
  if (prefs.status !== 200) {
    say(`prefs: ${errorOf(prefs)} (the app carries on)`);
    return;
  }
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = timezoneToSet(prefs.body, device);
  if (!zone) {
    say("prefs: a timezone is set, left alone");
    return;
  }
  if (ctx.api.readOnly) {
    say(`prefs: no timezone; the app would set ${zone} (read-only: not sent)`);
    return;
  }
  const set = await ctx.api.call("PUT", "/api/supervisor/prefs", {
    user: ctx.me.name,
    timezone: zone,
  });
  say(
    set.status === 200
      ? `prefs: no timezone, set ${zone}`
      : `prefs: setting ${zone} failed: ${errorOf(set)} (the app carries on)`,
  );
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function openScenario(ctx: Context): Promise<Verdict> {
  if (ctx.api.readOnly) {
    say(
      "read-only: no ensure (it can rotate the supervisor and start its watch goal), so no session id",
    );
  } else {
    const ensured = await ensure(ctx);
    say(
      `supervisor ${ensured.sessionId}, ${ensured.previousSessionIds.length} earlier session(s)`,
    );
  }
  const glossary = await ctx.api.call("GET", "/api/blob/glossary");
  const terms = glossary.status === 200 ? glossaryCount(glossary.body) : null;
  say(
    terms === null
      ? `glossary: ${errorOf(glossary)}`
      : `glossary: ${terms} term(s)`,
  );
  await launchTimezone(ctx);
  // The owner's open is read-only: no start, so no brief turn on their budget.
  const start = !ctx.api.readOnly;
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

/** Sends like the outbox: the same clientId on every try; a 404 tried
 *  again on the outbox's backoff for 120 s from queueing; 401, 5xx and
 *  network errors held the same way; any other answer final. */
async function deliver(
  ctx: Context,
  sessionId: string,
  body: PromptBody,
): Promise<Delivery> {
  const queuedAt = Date.now();
  for (let attempts = 1; ; attempts++) {
    const reply = await ctx.api.call(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
      body,
    );
    const delivery: Delivery = reply.status
      ? deliveryOutcome(reply.status, reply.body)
      : { kind: "retry", reason: errorOf(reply) };
    const next = outboxNext(
      delivery,
      attempts,
      Date.now() - queuedAt,
      Math.random(),
    );
    if ("done" in next) return next.done;
    say(
      `send attempt ${attempts} held (${delivery.kind === "delivered" ? "" : delivery.reason}), again in ${Math.round(next.waitMs / 1000)} s`,
    );
    await sleep(next.waitMs);
  }
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
    // The first send, from a bare Session(id:): no effort or speed override.
    const body = promptBody({
      content: ctx.options.message,
      clientId,
      user: ctx.me.name,
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

/** Every page of a session's transcript, as "load earlier" walks it. Only
 *  to tell whether the sessions before a rotation hold exchanges at all. */
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

/** Blob's history as the app reads it: GET /api/supervisor/history, then
 *  each older page with the `before` the last one returned, until an
 *  exchange from before the latest rotation is in or history ends. */
async function readHistoryPages(
  ctx: Context,
  currentSessionId: string | null,
): Promise<
  Omit<
    HistoryRead,
    "currentSessionId" | "previousSessionIds" | "earlierInTranscripts"
  >
> {
  let held: PastExchange[] = [];
  let before: string | null = null;
  for (let pages = 1; pages <= HISTORY_MAX_PAGES; pages++) {
    const query = before ? `?${new URLSearchParams({ before })}` : "";
    const reply = await ctx.api.call("GET", `/api/supervisor/history${query}`);
    const read = { exchanges: held, pages, complete: false };
    if (reply.status === 404)
      return { ...read, missingRoute: true, error: null };
    if (reply.status !== 200)
      return { ...read, missingRoute: false, error: errorOf(reply) };
    const page = parseHistoryPage(reply.body);
    if (!page)
      return {
        ...read,
        missingRoute: false,
        error: `page ${pages} doesn't decode as OS1API.SupervisorHistoryPage`,
      };
    held = prependPage(held, page);
    const complete = page.before === null || page.before === before;
    if (complete || historyFoundEarlier(held, currentSessionId))
      return {
        exchanges: held,
        pages,
        complete,
        missingRoute: false,
        error: null,
      };
    before = page.before;
  }
  return {
    exchanges: held,
    pages: HISTORY_MAX_PAGES,
    complete: false,
    missingRoute: false,
    error: null,
  };
}

async function historyScenario(ctx: Context): Promise<Verdict> {
  const ensured = ctx.api.readOnly ? null : await ensure(ctx);
  if (!ensured)
    say(
      "read-only: no ensure, so the current session can't be told apart; exchanges from two sessions prove a rotation",
    );
  const pages = await readHistoryPages(ctx, ensured?.sessionId ?? null);
  say(
    `history: ${pages.exchanges.length} exchange(s) in ${pages.pages} page(s)${pages.complete ? ", to the start" : ""}`,
  );
  for (const e of pages.exchanges.slice(-2))
    say(
      `  ${e.at === null ? "?" : new Date(e.at).toISOString()} [${e.sessionId}] you: ${excerpt(e.said, 60)} / Blob: ${excerpt(e.reply ?? "", 60)}`,
    );
  const read: HistoryRead = {
    ...pages,
    currentSessionId: ensured?.sessionId ?? null,
    previousSessionIds: ensured?.previousSessionIds ?? null,
    earlierInTranscripts: null,
  };
  // History returned nothing from before the rotation: whether there was
  // anything to return is read from those sessions' own transcripts.
  if (
    ensured?.previousSessionIds.length &&
    read.complete &&
    !read.missingRoute &&
    !read.error &&
    !read.exchanges.some((e) => e.sessionId !== ensured.sessionId)
  ) {
    let found = 0;
    for (const id of ensured.previousSessionIds.slice(0, PREVIOUS_MAX)) {
      try {
        found += exchanges((await readWhole(ctx, id)).stream.entries).length;
      } catch (error) {
        say(
          `before rotation ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    read.earlierInTranscripts = found;
    say(`the sessions before the rotation hold ${found} exchange(s)`);
  }
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

/** The item to answer: --item from the open items, or with --allow-answer
 *  the brief's first open decision, recommended option first. */
async function answerTarget(
  ctx: Context,
): Promise<{ item: ProbeItem; source: "items" | "brief" } | Verdict> {
  const id = ctx.options.item;
  if (id) {
    const item = (await readItems(ctx)).find((i) => i.id === id);
    if (!item) return fail(`no open item ${id} in ${ctx.me.name}'s inbox`);
    if (item.kind !== "needs-you")
      return fail(`item ${id} is ${item.kind}, not needs-you`);
    return { item, source: "items" };
  }
  if (!ctx.options.allowAnswer)
    return skip(
      "the server has no route that posts an item to an inbox (only the supervisor's own tools do); pass --item <id> with an open needs-you item in the probe member's inbox, or --allow-answer to answer the brief's first decision",
    );
  const response = await readBrief(ctx, false);
  const item = response.brief ? briefDecisions(response.brief)[0] : undefined;
  if (!item)
    return skip(
      `--allow-answer: the brief has no open decision (state ${response.state})`,
    );
  return { item, source: "brief" };
}

/** After 409 changed, Blob reads again where the card came from
 *  (BlobBrief.refresh: the brief, else the items) and shows the new card. */
async function rereadItem(
  ctx: Context,
  id: string,
  source: "items" | "brief",
): Promise<ProbeItem | null> {
  if (source === "brief") {
    const response = await readBrief(ctx, false);
    const found = response.brief
      ? briefDecisions(response.brief).find((d) => d.id === id)
      : undefined;
    if (found) return found;
  }
  return (await readItems(ctx)).find((i) => i.id === id) ?? null;
}

async function answerScenario(ctx: Context): Promise<Verdict> {
  const target = await answerTarget(ctx);
  if ("status" in target) return target;
  const { item, source } = target;
  const id = item.id;
  if (item.steps.length)
    return skip(
      `item ${id} approves ${item.steps.length} step(s); the probe answers only items that run nothing`,
    );
  if (item.revision === null) return fail(`item ${id} carries no revision`);
  say(`decision (${source}): ${item.title} [${id} rev ${item.revision}]`);
  const path = `/api/supervisor/items/${encodeURIComponent(id)}/answer`;
  const answer = item.options[0] ?? "ok";
  const stale = await ctx.api.call("POST", path, {
    user: ctx.me.name,
    answer,
    revision: staleRevision(item.revision),
  });
  say(`stale revision ${staleRevision(item.revision)}: ${errorOf(stale)}`);
  // One read and one answer again, as the owner taps the new card once.
  const reread = await rereadItem(ctx, id, source);
  let fresh: Reply | null = null;
  if (reread && reread.revision !== null) {
    const again = reread.options[0] ?? answer;
    fresh = await ctx.api.call("POST", path, {
      user: ctx.me.name,
      answer: again,
      revision: reread.revision,
    });
    say(
      `read again: rev ${reread.revision}, answering "${again}": HTTP ${fresh.status}`,
    );
  }
  return checkAnswer(stale, reread, fresh);
}

export const RUNNERS: Record<Scenario, (ctx: Context) => Promise<Verdict>> = {
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
  // Read-only from the first request: an owner who planRun lets through
  // has --owner-read-only, and a member who passed it gets the same.
  const api = new Api(base, token, options.ownerReadOnly);

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
