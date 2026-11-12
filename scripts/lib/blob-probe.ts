/**
 * The pure half of scripts/blob-probe.ts: how the Blob app reads what the
 * server sends, and the checks each scenario makes. Every decoder here
 * mirrors a Swift one in packages/clients/ios, named next to it, and is as
 * tolerant as that one: a field the server adds or drops never loses an
 * item. No network, no clock, no environment, so blob-probe.test.ts can feed
 * it fixtures.
 */

// ── Small readers ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  // SAFETY: a non-null, non-array object; every field is read as unknown.
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ── Options ─────────────────────────────────────────────────────────────────

export const SCENARIOS = [
  "open",
  "talk",
  "history",
  "brief-lifecycle",
  "answer",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** What an owner may run with --owner-read-only: nothing that writes. */
export const READ_ONLY_SCENARIOS: readonly Scenario[] = ["open", "history"];

export interface ProbeOptions {
  scenarios: Scenario[];
  ownerReadOnly: boolean;
  message: string;
  /** An open needs-you item in the probe user's inbox, for `answer`. */
  item: string | null;
  briefTimeoutMs: number;
  replyTimeoutMs: number;
  help: boolean;
}

export const DEFAULT_MESSAGE =
  "This is an automated check from blob-probe. Say hello in one short sentence.";

export function parseProbeArgs(argv: readonly string[]):
  | ProbeOptions
  | {
      error: string;
    } {
  const options: ProbeOptions = {
    scenarios: [],
    ownerReadOnly: false,
    message: DEFAULT_MESSAGE,
    item: null,
    briefTimeoutMs: 180_000,
    replyTimeoutMs: 300_000,
    help: false,
  };
  const seconds = (flag: string, raw: string | undefined) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? value * 1000
      : { error: `${flag} needs a number of seconds` };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--owner-read-only") options.ownerReadOnly = true;
    else if (arg === "--message") {
      const value = next()?.trim();
      if (!value) return { error: "--message needs text" };
      options.message = value;
    } else if (arg === "--item") {
      const value = next()?.trim();
      if (!value) return { error: "--item needs an item id" };
      options.item = value;
    } else if (arg === "--brief-timeout" || arg === "--reply-timeout") {
      const ms = seconds(arg, next());
      if (typeof ms !== "number") return ms;
      if (arg === "--brief-timeout") options.briefTimeoutMs = ms;
      else options.replyTimeoutMs = ms;
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else {
      for (const name of arg.split(",").filter(Boolean)) {
        const scenario = SCENARIOS.find((s) => s === name);
        if (!scenario) return { error: `unknown scenario ${name}` };
        if (!options.scenarios.includes(scenario))
          options.scenarios.push(scenario);
      }
    }
  }
  if (!options.scenarios.length)
    options.scenarios = options.ownerReadOnly
      ? [...READ_ONLY_SCENARIOS]
      : [...SCENARIOS];
  return options;
}

// ── Server and auth ─────────────────────────────────────────────────────────

/** The base URL without a trailing slash, or an error. */
export function serverBase(
  raw: string | undefined,
): string | { error: string } {
  const value = raw?.trim();
  if (!value) return { error: "OPENSESSION_URL is not set" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "OPENSESSION_URL is not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { error: "OPENSESSION_URL must be http or https" };
  return url.toString().replace(/\/+$/, "");
}

/** The socket URL the app derives (ServerConnection.wsURL): same host,
 *  ws for http and wss otherwise, path /ws. */
export function socketUrl(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

/** The web session token from OPENSESSION_PROBE_TOKEN: the bare token, or
 *  the cookie as copied from a browser (`opensession_auth=<token>`). */
export function probeToken(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const cookie = /(?:^|;\s*)opensession_auth=([^;\s]+)/.exec(value);
  const token = cookie ? cookie[1]! : value.replace(/^Bearer\s+/i, "");
  return /^[A-Za-z0-9._~-]+$/.test(token) ? token : null;
}

/** Who the token signs in as, from GET /api/auth/status. */
export interface SignedIn {
  login: string;
  /** What the app sends as `user` (ServerConfig.userName). */
  name: string;
}

export function parseAuthStatus(value: unknown): SignedIn | { error: string } {
  const status = obj(value);
  if (!status) return { error: "auth status is not JSON" };
  if (status.required === false)
    return {
      error:
        "this server runs without sign-in, so there is no probe member to sign in as",
    };
  if (status.authenticated !== true)
    return {
      error: status.reconnectRequired
        ? "the probe member's GitHub authorization lapsed: sign it in again"
        : "the token does not sign in (expired or revoked)",
    };
  const login = str(status.login) ?? "";
  const name = str(status.name)?.trim() || login;
  if (!login) return { error: "auth status names no login" };
  return { login, name };
}

/** Whether the signed-in person is the instance owner, read from the
 *  owner-only GET /api/blob/github (routes/blob-github.ts): 200 for the
 *  owner, 403 for anyone else. Anything else is unknown, and the probe then
 *  treats them as the owner. */
export type OwnerGate = "owner" | "member" | "unknown";

export function ownerFromStatus(status: number): OwnerGate {
  if (status === 200) return "owner";
  if (status === 403) return "member";
  return "unknown";
}

/** The scenarios to run, or why not. A member runs what was asked; an owner
 *  (or someone the probe can't tell from one) runs only read-only ones, and
 *  only with --owner-read-only. */
export function planRun(
  gate: OwnerGate,
  options: Pick<ProbeOptions, "scenarios" | "ownerReadOnly">,
): { run: Scenario[]; skipped: Scenario[] } | { refuse: string } {
  if (gate === "member") {
    return options.ownerReadOnly
      ? splitReadOnly(options.scenarios)
      : { run: options.scenarios, skipped: [] };
  }
  if (!options.ownerReadOnly)
    return {
      refuse:
        gate === "owner"
          ? "signed in as the instance owner. Run as the blob-probe member, or pass --owner-read-only for open (without start) and history."
          : "could not tell whether this is the instance owner (GET /api/blob/github answered neither 200 nor 403). Run as the blob-probe member, or pass --owner-read-only.",
    };
  return splitReadOnly(options.scenarios);
}

function splitReadOnly(scenarios: Scenario[]) {
  return {
    run: scenarios.filter((s) => READ_ONLY_SCENARIOS.includes(s)),
    skipped: scenarios.filter((s) => !READ_ONLY_SCENARIOS.includes(s)),
  };
}

/** The server's `error` string from a JSON body, or "". */
export function errorMessage(body: unknown): string {
  const record = obj(body);
  return str(record?.error) ?? str(record?.message) ?? "";
}

/** POST /api/supervisor/ensure: the session Blob talks to, the ones before
 *  each rotation (newest first), and the effort and speed a send carries. */
export interface Ensured {
  sessionId: string;
  previousSessionIds: string[];
  effort: string | null;
  speed: string | null;
}

export function parseEnsure(body: unknown): Ensured | null {
  const record = obj(body);
  const sessionId = str(record?.sessionId);
  if (!record || !sessionId) return null;
  const session = obj(record.session);
  return {
    sessionId,
    previousSessionIds: list(record.previousSessionIds).filter(
      (id): id is string => typeof id === "string" && !!id,
    ),
    effort: str(session?.effort) || null,
    speed: str(session?.speed) || null,
  };
}

/** GET /api/blob/glossary: how many terms, or null when it isn't a list. */
export function glossaryCount(body: unknown): number | null {
  const terms = obj(body)?.terms;
  return Array.isArray(terms) ? terms.length : null;
}

// ── Items (OS1API.SupervisorItem) ───────────────────────────────────────────

export interface ProbeItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  options: string[];
  project: string | null;
  state: string;
  /** `revision`, else `updatedAt`; an integer of at least 0, else null. */
  revision: number | null;
  steps: string[];
  runsWhen: string | null;
}

export function parseItem(value: unknown): ProbeItem | null {
  const item = obj(value);
  const id = str(item?.id);
  const title = str(item?.title);
  if (!item || !id || title === undefined) return null;
  const rawRevision = num(item.revision) ?? num(item.updatedAt);
  const act = obj(item.act);
  return {
    id,
    kind: str(item.kind) ?? "fyi",
    title,
    body: str(item.body) ?? "",
    options: list(item.options)
      .map((o) => (typeof o === "string" ? o.trim() : ""))
      .filter(Boolean),
    project: str(item.project) ?? null,
    state: str(item.state) ?? "open",
    revision:
      rawRevision !== undefined &&
      rawRevision >= 0 &&
      Number.isSafeInteger(rawRevision)
        ? rawRevision
        : null,
    steps: list(act?.steps).filter(
      (s): s is string => typeof s === "string" && !!s.trim(),
    ),
    runsWhen: str(act?.runsWhen) ?? null,
  };
}

/** GET /api/supervisor/items, items without an id or title skipped. */
export function parseItems(value: unknown): ProbeItem[] {
  return list(obj(value)?.items)
    .map(parseItem)
    .filter((item): item is ProbeItem => item !== null);
}

// ── The brief (OS1API.SupervisorBriefResponse, BlobBrief) ───────────────────

export interface ProbeDecision {
  item: ProbeItem;
  recommended: string | null;
}

export interface ProbeBrief {
  day: string;
  asOf: number;
  say: string;
  seenAt: number | null;
  handled: string[];
  decisions: ProbeDecision[];
  laterCount: number;
}

export interface ProbeBriefResponse {
  state: "ready" | "preparing" | "none";
  brief: ProbeBrief | null;
  newSince: string[];
  preparingSince: number | null;
  /** A line that brings a put-away brief back, when the server sends one
   *  (`reopen` beside or inside `brief`, a string or `{ line }`). */
  reopen: string | null;
}

function reopenLine(value: unknown): string | null {
  const line = str(value) ?? str(obj(value)?.line);
  return line?.trim() || null;
}

export function parseBriefResponse(value: unknown): ProbeBriefResponse {
  const response = obj(value) ?? {};
  const rawState = str(response.state);
  const state =
    rawState === "ready" || rawState === "preparing" ? rawState : "none";
  const raw = obj(response.brief);
  const brief: ProbeBrief | null = raw
    ? {
        day: str(raw.day) ?? "",
        asOf: num(raw.asOf) ?? 0,
        say: str(raw.say) ?? "",
        seenAt: num(raw.seenAt) ?? null,
        handled: list(raw.handled)
          .map((h) => str(obj(h)?.line)?.trim() ?? "")
          .filter(Boolean),
        decisions: list(raw.decisions).flatMap((d) => {
          const decision = obj(d);
          const item = parseItem(decision?.item);
          return item
            ? [{ item, recommended: str(decision?.recommended) ?? null }]
            : [];
        }),
        laterCount: Math.max(0, num(obj(raw.later)?.count) ?? 0),
      }
    : null;
  return {
    state,
    brief,
    newSince: list(obj(response.newSince)?.itemIds).filter(
      (id): id is string => typeof id === "string",
    ),
    preparingSince: num(response.preparingSince) ?? null,
    reopen: reopenLine(response.reopen) ?? reopenLine(raw?.reopen),
  };
}

/** The brief as one card (SupervisorBrief.key). */
export function briefKey(brief: ProbeBrief): string {
  return `${brief.day}@${Math.trunc(brief.asOf)}`;
}

/** The item with `option` first, where the decision view puts the
 *  recommended one (BlobBrief.recommending). */
export function recommending(
  option: string | null,
  item: ProbeItem,
): ProbeItem {
  const index = option ? item.options.indexOf(option) : -1;
  if (index <= 0) return item;
  const options = [...item.options];
  options.unshift(...options.splice(index, 1));
  return { ...item, options };
}

/** The brief's open decisions, recommended option first (BlobBrief.decisions). */
export function briefDecisions(brief: ProbeBrief): ProbeItem[] {
  return brief.decisions
    .filter((d) => d.item.state === "open")
    .map((d) => recommending(d.recommended, d.item));
}

/** "Handled 4 things · 3 can wait", or either half, or null (BlobBriefView). */
export function briefSummary(brief: ProbeBrief): string | null {
  const handled = brief.handled.length;
  const parts = [
    handled === 0
      ? null
      : handled === 1
        ? "Handled 1 thing"
        : `Handled ${handled} things`,
    brief.laterCount === 0 ? null : `${brief.laterCount} can wait`,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" \u00B7 ") : null;
}

/** What Blob shows for the brief, as text. */
export function renderBrief(response: ProbeBriefResponse): string[] {
  const { brief } = response;
  if (!brief)
    return [
      response.state === "preparing"
        ? "Blob thinks: Putting your brief together."
        : "No brief: Blob stays idle.",
    ];
  const lines = [
    `brief ${briefKey(brief)} (${brief.seenAt === null ? "unseen" : "seen"})`,
    `Blob says: ${brief.say || "(nothing)"}`,
  ];
  const summary = briefSummary(brief);
  if (summary) lines.push(summary);
  for (const line of brief.handled) lines.push(`  \u2713 ${line}`);
  const decisions = briefDecisions(brief);
  decisions.forEach((item, index) => {
    lines.push(
      `decision ${index + 1}: ${item.title} [${item.id} rev ${item.revision ?? "none"}]`,
    );
    item.options.forEach((option, o) =>
      lines.push(`    ${o === 0 ? "\u25B8" : "-"} ${option}`),
    );
    item.steps.forEach((step, s) => lines.push(`    step ${s + 1}. ${step}`));
    if (item.runsWhen) lines.push(`    Runs when ${item.runsWhen}`);
  });
  if (response.reopen) lines.push(`reopen: ${response.reopen}`);
  if (response.newSince.length)
    lines.push(`${response.newSince.length} new since the brief`);
  return lines;
}

// ── Verdicts ────────────────────────────────────────────────────────────────

export interface Verdict {
  status: "PASS" | "FAIL" | "SKIP";
  reason: string;
}

export const pass = (reason: string): Verdict => ({ status: "PASS", reason });
export const fail = (reason: string): Verdict => ({ status: "FAIL", reason });
export const skip = (reason: string): Verdict => ({ status: "SKIP", reason });

/** `open`: a ready brief Blob can say, whose decisions can be answered. */
export function checkOpen(
  response: ProbeBriefResponse,
  timedOut: boolean,
): Verdict {
  if (response.state === "preparing")
    return fail(
      timedOut
        ? "the brief was still being written when the wait ran out"
        : "the brief is still being written",
    );
  if (response.state === "none" || !response.brief)
    return fail(
      "no brief: none written yet, and none started (quiet hours, or opened without start)",
    );
  const { brief } = response;
  if (!brief.day)
    return fail("the brief has no day, so it can't be marked seen");
  if (!brief.say.trim()) return fail("the brief says nothing");
  const unbound = briefDecisions(brief).filter((d) => d.revision === null);
  if (unbound.length)
    return fail(
      `${unbound.length} decision(s) carry no revision, so an answer can't bind to the card: ${unbound.map((d) => d.id).join(", ")}`,
    );
  const empty = briefDecisions(brief).filter((d) => !d.options.length);
  if (empty.length)
    return fail(
      `${empty.length} decision(s) have no options to tap: ${empty.map((d) => d.id).join(", ")}`,
    );
  const count = briefDecisions(brief).length;
  return pass(
    `brief ${briefKey(brief)} ready, ${count} open decision${count === 1 ? "" : "s"}`,
  );
}

/** `brief-lifecycle`: after seen and Done, the brief is still there, and
 *  while decisions are open the owner has a way back to it. */
export function checkBriefAfterDone(
  before: ProbeBriefResponse,
  after: ProbeBriefResponse,
): Verdict {
  if (!before.brief) return skip("no brief to put away");
  if (!after.brief || after.state === "none")
    return fail("the brief is gone after it was seen");
  if (
    briefKey(after.brief) !== briefKey(before.brief) &&
    after.state === "ready"
  )
    return pass(
      `a newer brief (${briefKey(after.brief)}) took its place, so there is nothing to reopen`,
    );
  if (after.brief.seenAt === null)
    return fail("the brief still reads as unseen after POST /brief/seen");
  const open = briefDecisions(after.brief).length;
  if (!open) return pass("seen, and no decisions are left open");
  if (!after.reopen)
    return fail(
      `${open} decision(s) still open, but the server sends no reopen line: after Done, Blob only offers items raised since the brief (BlobBrief.apply), so these are out of reach from the home`,
    );
  return pass(
    `${open} decision(s) still open, reachable through "${after.reopen}"`,
  );
}

/** The server's answer to an answer (closeResponse in routes/supervisor.ts). */
export function answerOutcome(
  status: number,
  body: unknown,
): "ok" | "changed" | "closed" | "not-found" | "other" {
  const error = str(obj(body)?.error);
  if (status >= 200 && status < 300) return "ok";
  if (status === 409 && error === "changed") return "changed";
  if (status === 409) return "closed";
  if (status === 404) return "not-found";
  return "other";
}

/** A stale revision: one the item had before, or never had. */
export function staleRevision(revision: number): number {
  return revision > 0 ? revision - 1 : revision + 1;
}

/** `answer`: a stale revision changes nothing, the current one closes it. */
export function checkAnswer(
  stale: { status: number; body: unknown },
  stillOpen: ProbeItem | null,
  fresh: { status: number; body: unknown } | null,
): Verdict {
  const first = answerOutcome(stale.status, stale.body);
  if (first !== "changed")
    return fail(
      `a stale revision answered ${stale.status} (${first}), expected 409 changed`,
    );
  if (!stillOpen || stillOpen.state !== "open")
    return fail("the item did not stay open after the stale answer");
  if (!fresh) return fail("no answer was sent with the current revision");
  const second = answerOutcome(fresh.status, fresh.body);
  if (second !== "ok")
    return fail(
      `the current revision answered ${fresh.status} (${second}), expected 200`,
    );
  const state = parseItem(obj(fresh.body)?.item)?.state;
  if (state && state !== "answered")
    return fail(`the item is ${state} after the answer, expected answered`);
  return pass("stale revision: 409 changed; current revision: answered");
}

// ── Sending (OS1API.deliverPromptBody, Outbox) ──────────────────────────────

/** What Blob tells the server about the space a reply gets, on a phone
 *  (BlobSurfaceReport's default). */
export const PHONE_SURFACE = { app: "blob", panes: 1, width: "compact" };

export interface PromptBody {
  content: string;
  clientId: string;
  busy: "steer";
  user?: string;
  effort?: string;
  fastMode: boolean;
  speed: string;
  surface: typeof PHONE_SURFACE;
}

/** The body the outbox posts to /api/sessions/:id/prompt for a Blob
 *  message: `sendSteer`, so `busy: "steer"`, with the session's effort and
 *  speed and the outbox item's id as `clientId`. */
export function promptBody(input: {
  content: string;
  clientId: string;
  user: string;
  effort?: string | null;
  speed?: string | null;
}): PromptBody {
  const speed = input.speed || "standard";
  const body: PromptBody = {
    content: input.content,
    clientId: input.clientId,
    busy: "steer",
    // SpeedSetting.wireFastMode / wireSpeed for a speed this client can name.
    fastMode: speed !== "standard",
    speed,
    surface: PHONE_SURFACE,
  };
  if (input.user) body.user = input.user;
  if (input.effort) body.effort = input.effort;
  return body;
}

/** How an outbox delivery ended (OS1API.deliverPrompt). */
export type Delivery =
  | { kind: "delivered"; status: string }
  | { kind: "retry"; reason: string }
  | { kind: "rejected"; reason: string };

export function deliveryOutcome(status: number, body: unknown): Delivery {
  const decoded = obj(body);
  if (status >= 200 && status < 300)
    return { kind: "delivered", status: str(decoded?.status) ?? "started" };
  const reason =
    str(decoded?.error) ?? str(decoded?.message) ?? `HTTP ${status}`;
  // 401 and 5xx: the outbox holds the message and tries again.
  if (status === 401 || status >= 500) return { kind: "retry", reason };
  return { kind: "rejected", reason };
}

// ── The reply (BlobReply) ───────────────────────────────────────────────────

export interface SplitReply {
  /** The reply opened with a ```say fence. */
  scripted: boolean;
  /** The fence was closed. */
  closed: boolean;
  /** What Blob says, cues and the delivery hint stripped. */
  say: string;
  /** What is only shown. */
  show: string;
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([^`\s]*)\s*$/;

function startsBlock(line: string): boolean {
  const s = line.trim();
  return (
    s.startsWith("```") ||
    s.startsWith("~~~") ||
    s.startsWith("|") ||
    /^(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(s)
  );
}

function plainSay(text: string): string {
  return text
    .replace(/\{#[^}\s]+\}/g, "")
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The reply split as Blob splits it: a ```say fence first is the script,
 *  else the first paragraph. Only `scripted` and `closed` decide the
 *  check; `say` is for showing what Blob would read. */
export function splitReply(markdown: string): SplitReply {
  const lines = markdown.split("\n");
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index++;
  const open = FENCE.exec(lines[index] ?? "");
  if (open && open[2]!.toLowerCase() === "say") {
    const marker = open[1]!;
    const script: string[] = [];
    let closed = false;
    for (index++; index < lines.length; index++) {
      const close = FENCE.exec(lines[index]!);
      if (close) {
        if (
          !close[2] &&
          close[1]![0] === marker[0] &&
          close[1]!.length >= marker.length
        ) {
          closed = true;
          index++;
        }
        break;
      }
      if (lines[index]!.trim()) script.push(lines[index]!.trim());
    }
    return {
      scripted: true,
      closed,
      say: plainSay(script.join(" ")),
      show: lines.slice(index).join("\n").trim(),
    };
  }
  const said: string[] = [];
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || startsBlock(line)) break;
    said.push(line.trim());
  }
  return {
    scripted: false,
    closed: false,
    say: plainSay(said.join(" ")),
    show: lines.slice(index).join("\n").trim(),
  };
}

// ── The transcript (SessionViewModel, as Blob uses it) ──────────────────────

export interface Entry {
  id: string;
  type: string;
  content: string;
  timestamp: string | null;
  sourceMessageIds: string[];
  isReasoning: boolean;
  isError: boolean;
  /** An operational notice (a runner line, a worker report), not a message. */
  notice: boolean;
}

export function parseEntry(value: unknown): Entry | null {
  const entry = obj(value);
  const id = str(entry?.id);
  const type = str(entry?.type);
  if (!entry || !id || !type) return null;
  return {
    id,
    type,
    content: str(entry.content) ?? "",
    timestamp: str(entry.timestamp) ?? null,
    sourceMessageIds: list(entry.sourceMessageIds).filter(
      (s): s is string => typeof s === "string",
    ),
    isReasoning: entry.isReasoning === true,
    isError: entry.isError === true,
    notice: obj(entry.notice) !== null,
  };
}

function parseEntries(value: unknown): Entry[] {
  return list(value)
    .map(parseEntry)
    .filter((e): e is Entry => e !== null);
}

export interface Cursor {
  truncated: boolean;
  firstSeq: number | null;
  startOffset: number | null;
  rev: string | null;
}

function parseCursor(frame: Obj): Cursor {
  return {
    truncated: frame.truncated === true,
    firstSeq: num(frame.firstSeq) ?? null,
    startOffset: num(frame.startOffset) ?? null,
    rev: str(frame.rev) ?? null,
  };
}

/** One watched session as the app's view model holds it: durable entries,
 *  the live reply text, and whether a run is going. */
export class SessionStream {
  entries: Entry[] = [];
  liveText = "";
  isRunning = false;
  isStreaming = false;
  initialized = false;
  cursor: Cursor = {
    truncated: false,
    firstSeq: null,
    startOffset: null,
    rev: null,
  };
  /** A history page was asked for and hasn't come. */
  loadingEarlier = false;
  /** `error` frames for this session, in order. */
  errors: string[] = [];

  constructor(readonly sessionId: string) {}

  /** Applies one socket frame. True when it was about this session. */
  apply(raw: unknown): boolean {
    const frame = obj(raw);
    if (!frame) return false;
    const type = str(frame.type);
    const sessionId = str(frame.sessionId);
    if (type === "error") {
      if (sessionId && sessionId !== this.sessionId) return false;
      this.errors.push(str(frame.message) ?? str(frame.error) ?? "error");
      return true;
    }
    if (sessionId !== this.sessionId) return false;
    switch (type) {
      case "transcript_init":
        this.entries = parseEntries(frame.entries);
        this.cursor = parseCursor(frame);
        this.initialized = true;
        this.loadingEarlier = false;
        return true;
      case "transcript_history": {
        const known = new Set(this.entries.map((e) => e.id));
        const older = parseEntries(frame.entries).filter(
          (e) => !known.has(e.id),
        );
        this.entries = [...older, ...this.entries];
        this.cursor = parseCursor(frame);
        this.loadingEarlier = false;
        return true;
      }
      case "transcript_append":
        for (const entry of parseEntries(frame.entries)) {
          const at = this.entries.findIndex((e) => e.id === entry.id);
          if (at >= 0) this.entries[at] = entry;
          else this.entries.push(entry);
        }
        return true;
      case "stream_start":
        this.liveText = "";
        return true;
      case "stream_text":
        this.isStreaming = true;
        // Blob reads live text as the reply, so thinking stays out of it.
        if (frame.kind !== "reasoning") this.liveText += str(frame.text) ?? "";
        return true;
      case "stream_done":
        this.isStreaming = false;
        return true;
      case "session_status": {
        const running = frame.isRunning === true && !obj(frame.safety);
        this.isRunning = running;
        if (!running) this.isStreaming = false;
        return true;
      }
      default:
        return true;
    }
  }

  /** The next `load_history` frame Blob's "load earlier" sends, or null
   *  when there is nothing older (SessionViewModel.requestHistoryPage). */
  historyRequest(limit?: number): HistoryRequest | null {
    if (!this.cursor.truncated) return null;
    const { firstSeq, startOffset, rev } = this.cursor;
    const request: HistoryRequest = {
      type: "load_history",
      sessionId: this.sessionId,
    };
    if (firstSeq !== null && firstSeq > 1) {
      request.beforeSeq = firstSeq;
      if (limit) request.limit = limit;
    } else if (startOffset !== null && startOffset > 0) {
      request.beforeOffset = startOffset;
      if (rev) request.beforeRev = rev;
    }
    // Neither cursor: the cursor-less request gets the whole transcript.
    return request;
  }
}

/** OS1Socket.loadHistory / loadWholeHistory. */
export interface HistoryRequest {
  type: "load_history";
  sessionId: string;
  beforeSeq?: number;
  limit?: number;
  beforeOffset?: number;
  beforeRev?: string;
}

export interface WatchFrame {
  type: "watch";
  sessionId: string;
  supportsSeq: true;
  supportsChangeSeq: true;
}

/** The watch frame the app sends (OS1Socket.watch, no resume cursor). */
export function watchFrame(sessionId: string): WatchFrame {
  return {
    type: "watch",
    sessionId,
    supportsSeq: true,
    supportsChangeSeq: true,
  };
}

/** One message's turn, timed the way BlobTextTalk and BlobMetrics see it:
 *  sent, accepted (the server's user entry carries the outbox id), first
 *  token of the reply, settled. Times are whatever clock the caller uses. */
export class TalkTurn {
  acceptedAt: number | null = null;
  firstTokenAt: number | null = null;
  settledAt: number | null = null;
  /** The live text already streaming when the message landed: another
   *  turn's, never the answer (BlobTextTalk.accepted). */
  private foreignText: string | null = null;

  constructor(
    readonly clientId: string,
    readonly sentAt: number,
  ) {}

  acceptedIndex(stream: SessionStream): number {
    for (let i = stream.entries.length - 1; i >= 0; i--) {
      const e = stream.entries[i]!;
      if (
        e.type === "user" &&
        (e.id === this.clientId || e.sourceMessageIds.includes(this.clientId))
      )
        return i;
    }
    return -1;
  }

  /** Whether the live text answers this message (BlobTextTalk.ownsStream). */
  ownsStream(stream: SessionStream): boolean {
    const at = this.acceptedIndex(stream);
    if (at < 0 || this.foreignText === null) return false;
    if (stream.entries.slice(at + 1).some((e) => e.type === "user"))
      return false;
    return !this.foreignText || !stream.liveText.startsWith(this.foreignText);
  }

  /** The finished reply: the last assistant text after the message, not
   *  thinking and not the block that was streaming when it landed. */
  replyEntry(stream: SessionStream): Entry | null {
    if (stream.isStreaming) return null;
    const at = this.acceptedIndex(stream);
    if (at < 0) return null;
    const foreign = this.foreignText?.trim() ?? "";
    const after = stream.entries.slice(at + 1);
    for (let i = after.length - 1; i >= 0; i--) {
      const e = after[i]!;
      if (
        e.type === "assistant" &&
        !e.isReasoning &&
        (!foreign || !e.content.startsWith(foreign))
      )
        return e;
    }
    return null;
  }

  /** The entries after the message: what the turn did. */
  turnEntries(stream: SessionStream): Entry[] {
    const at = this.acceptedIndex(stream);
    return at < 0 ? [] : stream.entries.slice(at + 1);
  }

  /** The run has finished and its reply is in (BlobTextTalk.settled). */
  settled(stream: SessionStream): boolean {
    return (
      !stream.isRunning &&
      !stream.isStreaming &&
      this.replyEntry(stream) !== null
    );
  }

  /** Call after every frame applied to `stream`. */
  observe(stream: SessionStream, now: number): void {
    if (this.acceptedAt === null && this.acceptedIndex(stream) >= 0) {
      this.acceptedAt = now;
      this.foreignText = stream.liveText;
    }
    if (this.acceptedAt === null) return;
    if (
      this.firstTokenAt === null &&
      stream.isStreaming &&
      stream.liveText &&
      this.ownsStream(stream)
    )
      this.firstTokenAt = now;
    if (this.settledAt === null && this.settled(stream)) {
      this.settledAt = now;
      // A reply that landed whole, without live text, came with its first token.
      this.firstTokenAt ??= now;
    }
  }
}

export interface TalkResult {
  delivery: Delivery;
  acceptedMs: number | null;
  firstTokenMs: number | null;
  settleMs: number | null;
  reply: string | null;
  errors: string[];
}

/** Times relative to the turn: sent→accepted, accepted→first token,
 *  accepted→settled. */
export function talkResult(
  turn: TalkTurn,
  stream: SessionStream,
  delivery: Delivery,
  errorsBefore: number,
): TalkResult {
  const from = (at: number | null, start: number | null) =>
    at === null || start === null ? null : Math.round(at - start);
  const turnErrors = turn
    .turnEntries(stream)
    .filter((e) => e.isError)
    .map((e) => `error entry: ${e.content.slice(0, 160) || e.id}`);
  return {
    delivery,
    acceptedMs: from(turn.acceptedAt, turn.sentAt),
    firstTokenMs: from(turn.firstTokenAt, turn.acceptedAt),
    settleMs: from(turn.settledAt, turn.acceptedAt),
    reply: turn.replyEntry(stream)?.content ?? null,
    errors: [
      ...stream.errors.slice(errorsBefore).map((m) => `error event: ${m}`),
      ...turnErrors,
    ],
  };
}

export function checkTalk(result: TalkResult): Verdict {
  if (result.delivery.kind !== "delivered")
    return fail(`the message was not delivered: ${result.delivery.reason}`);
  if (result.acceptedMs === null)
    return fail(
      "the server's copy of the message never arrived on the socket (no user entry with the outbox id)",
    );
  if (result.errors.length) return fail(result.errors.join("; "));
  if (result.settleMs === null || result.reply === null)
    return fail("the reply did not settle before the wait ran out");
  const split = splitReply(result.reply);
  if (!split.scripted)
    return fail(
      "the reply has no ```say block, so Blob falls back to its first paragraph",
    );
  if (!split.closed) return fail("the reply's ```say block is never closed");
  if (!split.say) return fail("the reply's ```say block is empty");
  return pass(
    `say block present; accepted ${result.acceptedMs} ms after send, first token ${result.firstTokenMs ?? "?"} ms and settled ${result.settleMs} ms after accepted`,
  );
}

// ── History (BlobHistoryView) ───────────────────────────────────────────────

export interface Exchange {
  at: string | null;
  said: string;
  reply: string;
}

/** Your messages with the reply each got: the last assistant text before
 *  the next message of yours. Notices and thinking aren't exchanges. */
export function exchanges(entries: readonly Entry[]): Exchange[] {
  const out: Exchange[] = [];
  let current: Exchange | null = null;
  for (const e of entries) {
    if (e.notice) continue;
    if (e.type === "user") {
      if (current?.reply) out.push(current);
      current = { at: e.timestamp, said: e.content, reply: "" };
    } else if (
      current &&
      e.type === "assistant" &&
      !e.isReasoning &&
      e.content.trim()
    ) {
      current.reply = e.content;
    }
  }
  if (current?.reply) out.push(current);
  return out;
}

export interface HistoryRead {
  current: { sessionId: string; exchanges: number; complete: boolean };
  previous: Array<{
    sessionId: string;
    exchanges: number;
    error: string | null;
  }>;
}

export function checkHistory(read: HistoryRead): Verdict {
  if (!read.current.complete)
    return fail(
      `the current session's history stopped paging before its start (${read.current.exchanges} exchanges read)`,
    );
  if (!read.previous.length)
    return pass(
      `no rotation yet: ${read.current.exchanges} exchange(s) in the current session, all reachable`,
    );
  const latest = read.previous[0]!;
  if (latest.error)
    return fail(
      `the session before the last rotation (${latest.sessionId}) could not be read: ${latest.error}`,
    );
  if (!latest.exchanges)
    return fail(
      `the session before the last rotation (${latest.sessionId}) has no exchanges to show`,
    );
  const older = read.previous.reduce((n, p) => n + p.exchanges, 0);
  return pass(
    `${read.current.exchanges} exchange(s) now, ${older} before ${read.previous.length} rotation(s), reachable through previousSessionIds`,
  );
}

/** First words of a message, for printing history without dumping it. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
