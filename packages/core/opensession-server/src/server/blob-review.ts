/**
 * The Blob review: aggregated facts about how one person uses Blob, for
 * `GET /api/blob/review?days=14` (routes/blob-metrics.ts) and the
 * blob-review skill (.agents/skills/blob-review/SKILL.md).
 *
 * It reads only that person's own records:
 *
 * - their Blob turn metrics (blob-metrics.ts), by day key;
 * - their supervisor sessions (supervisor.ts), the current one and the
 *   retired ones still inside the window, at most MAX_REVIEW_SESSIONS, each
 *   one known session read through its own transcript;
 * - their supervisor inbox (supervisor-inbox.ts), one document, at most
 *   MAX_LIST items changed in the window;
 * - the tail of their supervisor ledger (supervisor-ledger.ts), one file.
 *
 * Nothing lists sessions or the catalog. The answer holds counts, timings,
 * tool names and ids, never message text: transcript content is read only
 * to measure its length. Ids of the slowest and failed turns let an agent
 * open those turns in the transcript itself.
 */
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import type { BlobTurnMetric } from "./blob-metrics";
import type { SupervisorItem } from "./supervisor-inbox";

export const DEFAULT_REVIEW_DAYS = 14;
export const MAX_REVIEW_DAYS = 90;
/** Supervisor sessions one review reads, newest first. They rotate about
 *  weekly (supervisor.ts ROTATE_AGE_MS), so 14 days touch two or three. */
export const MAX_REVIEW_SESSIONS = 6;
/** Sampled turn ids per list. */
export const SAMPLE_SIZE = 5;
/** A follow-up this soon after the reply, of about the same length, reads
 *  as asking again. */
export const REASK_WINDOW_MS = 60_000;
const TOP_TOOLS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface Distribution {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface ReviewSession {
  sessionId: string;
  entries: TranscriptEntry[];
}

export interface ReviewInput {
  now: number;
  days: number;
  timeZone: string;
  metrics: BlobTurnMetric[];
  sessions: ReviewSession[];
  items: SupervisorItem[];
  /** The inbox list hit its cap: older items in the window were left out. */
  inboxTruncated?: boolean;
  /** More supervisor sessions fell in the window than one review reads. */
  sessionsTruncated?: boolean;
  /** The ledger's tail; only its entry headings are read. */
  ledger: string;
}

/** The window a review covers: whole days back from `now`, 1 to
 *  MAX_REVIEW_DAYS. Reading and aggregating both use it, so a record is in
 *  the review exactly when it was fetched for it. */
export function reviewWindow(
  now: number,
  days: number,
): { days: number; since: number } {
  const span = Math.max(1, Math.min(MAX_REVIEW_DAYS, Math.floor(days)));
  return { days: span, since: now - span * DAY_MS };
}

/** One owner message in a supervisor transcript and what followed it, up
 *  to the next one. */
export interface TranscriptTurn {
  sessionId: string;
  entryId: string;
  at: number;
  inputChars: number;
  firstReplyMs: number | null;
  /** To the last assistant message before the next owner message. */
  durationMs: number | null;
  replyEntryId: string | null;
  replyChars: number;
  tools: string[];
  toolErrors: number;
  reasked: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function distribution(values: number[]): Distribution {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
      : null;
  return {
    n: sorted.length,
    p50: rank(0.5),
    p90: rank(0.9),
    p99: rank(0.99),
    max: sorted.at(-1) ?? null,
  };
}

function tally(values: Array<string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) if (value) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
}

function defined(values: Array<number | undefined | null>): number[] {
  return values.filter((value): value is number => typeof value === "number");
}

function epoch(timestamp: string): number {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? at : NaN;
}

function similarLength(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return Math.min(a, b) / Math.max(a, b) >= 0.7;
}

/** The local hour (0 to 23) of `at` in `timeZone`; UTC when the zone is
 *  unknown. */
export function localHour(at: number, timeZone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(at);
    return Number(hour) % 24;
  } catch {
    return new Date(at).getUTCHours();
  }
}

const REPLY_BUCKETS: Array<[string, number]> = [
  ["<=120", 120],
  ["<=280", 280],
  ["<=600", 600],
  ["<=1200", 1200],
  [">1200", Infinity],
];

function replyBuckets(lengths: number[]): Record<string, number> {
  const out = Object.fromEntries(REPLY_BUCKETS.map(([label]) => [label, 0]));
  for (const length of lengths) {
    const bucket = REPLY_BUCKETS.find(([, max]) => length <= max)!;
    out[bucket[0]]!++;
  }
  return out;
}

// ── Transcript ──────────────────────────────────────────────────────────────

/** An owner message: a user entry that is neither a system boundary, a
 *  recorded context payload nor a delivery notice. */
export function isOwnerMessage(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.turnBoundary || entry.contextInjection)
    return false;
  return !classifyEntry(entry).notice;
}

/** Owner turns in one supervisor transcript, in order. */
export function transcriptTurns(session: ReviewSession): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const entry of session.entries) {
    const at = epoch(entry.timestamp);
    if (entry.type === "user") {
      if (!isOwnerMessage(entry)) {
        // A system-triggered turn starts here: what follows is not the
        // owner's turn.
        if (entry.turnBoundary) current = null;
        continue;
      }
      const previous = turns.at(-1);
      const inputChars = entry.content.trim().length;
      current = {
        sessionId: session.sessionId,
        entryId: entry.id,
        at,
        inputChars,
        firstReplyMs: null,
        durationMs: null,
        replyEntryId: null,
        replyChars: 0,
        tools: [],
        toolErrors: 0,
        reasked: false,
      };
      if (previous && Number.isFinite(at)) {
        const settledAt =
          previous.durationMs === null
            ? previous.at
            : previous.at + previous.durationMs;
        if (
          at - settledAt >= 0 &&
          at - settledAt <= REASK_WINDOW_MS &&
          similarLength(previous.inputChars, inputChars)
        )
          current.reasked = true;
      }
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (entry.type === "tool_use") {
      current.tools.push(entry.toolName || "unknown");
    } else if (entry.type === "tool_result") {
      if (entry.isError) current.toolErrors++;
    } else if (entry.type === "assistant" && !entry.isReasoning) {
      const elapsed = Number.isFinite(at) ? at - current.at : NaN;
      if (Number.isFinite(elapsed) && elapsed >= 0) {
        current.firstReplyMs ??= elapsed;
        current.durationMs = elapsed;
      }
      current.replyEntryId = entry.id;
      current.replyChars = entry.content.trim().length;
    }
  }
  return turns;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function metricSample(turn: BlobTurnMetric, link: TranscriptTurn | undefined) {
  return {
    turnId: turn.turnId,
    startedAt: new Date(turn.startedAt).toISOString(),
    input: turn.input,
    outcome: turn.outcome,
    ...(turn.dropped ? { dropped: turn.dropped } : {}),
    timeToFirstTokenMs: firstTokenMs(turn),
    ...(link ? { sessionId: link.sessionId, entryId: link.entryId } : {}),
    ...(turn.replyEntryId ? { replyEntryId: turn.replyEntryId } : {}),
  };
}

function transcriptSample(turn: TranscriptTurn) {
  return {
    sessionId: turn.sessionId,
    entryId: turn.entryId,
    at: Number.isFinite(turn.at) ? new Date(turn.at).toISOString() : null,
    durationMs: turn.durationMs,
    toolCalls: turn.tools.length,
    toolErrors: turn.toolErrors,
    ...(turn.replyEntryId ? { replyEntryId: turn.replyEntryId } : {}),
  };
}

function firstTokenMs(turn: BlobTurnMetric): number | null {
  return turn.sendToAcceptedMs !== undefined &&
    turn.acceptedToFirstTokenMs !== undefined
    ? turn.sendToAcceptedMs + turn.acceptedToFirstTokenMs
    : null;
}

/** The transcript turn a metric belongs to: the one holding its reply
 *  entry, else the owner message closest to its start within a minute. */
function linkMetric(
  turn: BlobTurnMetric,
  byReply: Map<string, TranscriptTurn>,
  ordered: TranscriptTurn[],
): TranscriptTurn | undefined {
  if (turn.replyEntryId) {
    const found = byReply.get(turn.replyEntryId);
    if (found) return found;
  }
  let best: TranscriptTurn | undefined;
  let bestGap = REASK_WINDOW_MS;
  for (const candidate of ordered) {
    const gap = Math.abs(candidate.at - turn.startedAt);
    if (gap <= bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

function parakeetMiss(turn: BlobTurnMetric): string | undefined {
  if (turn.parakeetMiss) return turn.parakeetMiss;
  const reason = turn.transcriberReason;
  return reason?.startsWith("parakeet-") ? reason : undefined;
}

function appStats(metrics: BlobTurnMetric[]) {
  // Voice turns that went out; the dropped ones are counted in `drops`.
  const voice = metrics.filter(
    (turn) => turn.input === "voice" && !turn.dropped,
  );
  const dropped = metrics.filter((turn) => turn.dropped);
  const spoken = metrics.filter(
    (turn) => turn.sentencesSpoken !== undefined && turn.sentencesSpoken > 0,
  );
  const interrupted = metrics.filter((turn) => turn.interrupted);
  const transcribers: Record<string, { turns: number; ms: Distribution }> = {};
  const byTranscriber = new Map<string, BlobTurnMetric[]>();
  for (const turn of voice) {
    const name = turn.transcriber ?? "unknown";
    byTranscriber.set(name, [...(byTranscriber.get(name) ?? []), turn]);
  }
  // Builds that send transcriberReason time only the transcriber that wrote
  // the text; older ones timed the whole fallback chain. Timings come from
  // the newer turns only, so the two meanings never mix.
  const timed = voice.filter((turn) => turn.transcriberReason !== undefined);
  for (const [name, turns] of byTranscriber)
    transcribers[name] = {
      turns: turns.length,
      ms: distribution(
        defined(
          turns
            .filter((t) => t.transcriberReason !== undefined)
            .map((t) => t.transcribeMs),
        ),
      ),
    };
  return {
    turns: metrics.length,
    byInput: tally(metrics.map((turn) => turn.input)),
    byOutcome: tally(metrics.map((turn) => turn.outcome)),
    failureRate: rate(
      metrics.filter((turn) => turn.outcome !== "answered").length,
      metrics.length,
    ),
    latencyMs: {
      speech: distribution(defined(voice.map((t) => t.speechMs))),
      transcribe: distribution(defined(timed.map((t) => t.transcribeMs))),
      sendToAccepted: distribution(
        defined(metrics.map((t) => t.sendToAcceptedMs)),
      ),
      acceptedToFirstToken: distribution(
        defined(metrics.map((t) => t.acceptedToFirstTokenMs)),
      ),
      firstTokenToFirstAudio: distribution(
        defined(metrics.map((t) => t.firstTokenToFirstAudioMs)),
      ),
      sendToFirstToken: distribution(defined(metrics.map(firstTokenMs))),
    },
    transcribers,
    transcriberReasons: tally(voice.map((turn) => turn.transcriberReason)),
    // Every Parakeet miss: the reason itself when Apple wrote the text, or
    // parakeetMiss when Fish was asked in Parakeet's place.
    parakeetMisses: tally(timed.map(parakeetMiss)),
    parakeetLoadMs: distribution(defined(timed.map((t) => t.parakeetLoadMs))),
    parakeetWaitMs: distribution(defined(timed.map((t) => t.parakeetWaitMs))),
    // Voice turns from builds before transcriberReason, left out of the
    // transcribe timings above.
    untimedVoiceTurns: voice.length - timed.length,
    endOfSpeech: tally(voice.map((turn) => turn.endOfSpeech)),
    // Voice turns that never went out, and why: Blob said so on screen.
    drops: {
      count: dropped.length,
      byReason: tally(dropped.map((turn) => turn.dropped)),
      transcriberReasons: tally(dropped.map((turn) => turn.transcriberReason)),
      parakeetStates: tally(dropped.map((turn) => turn.parakeetState)),
    },
    voices: tally(metrics.map((turn) => turn.voice)),
    sentencesSpoken: distribution(
      defined(spoken.map((t) => t.sentencesSpoken)),
    ),
    interruptions: {
      rate: rate(interrupted.length, spoken.length),
      byKind: tally(interrupted.map((turn) => turn.interrupted)),
    },
    reasks: {
      rate: rate(metrics.filter((turn) => turn.reasked).length, metrics.length),
      count: metrics.filter((turn) => turn.reasked).length,
    },
    replyChars: distribution(defined(metrics.map((t) => t.replyChars))),
    blocks: tally(metrics.flatMap((turn) => turn.blocks ?? [])),
    thinkingSteps: distribution(defined(metrics.map((t) => t.thinkingSteps))),
    posture: tally(metrics.map((turn) => turn.posture)),
    appVersions: tally(
      metrics.map((turn) =>
        turn.appVersion
          ? `${turn.appVersion}${turn.build ? ` (${turn.build})` : ""}`
          : undefined,
      ),
    ),
  };
}

function transcriptStats(turns: TranscriptTurn[], timeZone: string) {
  const toolTurns = new Map<string, { calls: number; turns: number }>();
  for (const turn of turns) {
    const counts = tally(turn.tools);
    for (const [name, calls] of Object.entries(counts)) {
      const row = toolTurns.get(name) ?? { calls: 0, turns: 0 };
      row.calls += calls;
      row.turns += 1;
      toolTurns.set(name, row);
    }
  }
  const hours = Array.from({ length: 24 }, () => 0);
  for (const turn of turns)
    if (Number.isFinite(turn.at)) hours[localHour(turn.at, timeZone)]!++;
  const unanswered = turns.filter((turn) => !turn.replyEntryId);
  const reasked = turns.filter((turn) => turn.reasked);
  const replied = turns.filter((turn) => turn.replyEntryId);
  return {
    ownerMessages: turns.length,
    unanswered: unanswered.length,
    unansweredRate: rate(unanswered.length, turns.length),
    reasks: { count: reasked.length, rate: rate(reasked.length, turns.length) },
    latencyMs: {
      firstReply: distribution(defined(turns.map((t) => t.firstReplyMs))),
      turn: distribution(defined(turns.map((t) => t.durationMs))),
    },
    toolCallsPerTurn: distribution(turns.map((turn) => turn.tools.length)),
    toolErrors: turns.reduce((sum, turn) => sum + turn.toolErrors, 0),
    topTools: [...toolTurns]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
      .slice(0, TOP_TOOLS),
    inputChars: distribution(turns.map((turn) => turn.inputChars)),
    replyChars: distribution(replied.map((turn) => turn.replyChars)),
    replyLengthBuckets: replyBuckets(replied.map((turn) => turn.replyChars)),
    hours,
    busiestHours: hours
      .map((count, hour) => ({ hour, count }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count || a.hour - b.hour)
      .slice(0, 3),
  };
}

function inboxStats(items: SupervisorItem[], truncated: boolean) {
  const answered = items.filter((item) => item.state === "answered");
  const closed = items.filter((item) => item.state !== "open");
  const withOptions = answered.filter((item) => item.options?.length);
  const leads = items.filter((item) => item.source.startsWith("lead:"));
  const leadAnswered = leads.filter((item) => item.state === "answered");
  const recommended = (list: SupervisorItem[]) =>
    list.filter(
      (item) =>
        item.options?.length &&
        item.answer?.trim().toLowerCase() ===
          item.options[0]!.trim().toLowerCase(),
    ).length;
  return {
    items: items.length,
    truncated,
    byKind: tally(items.map((item) => item.kind)),
    byState: tally(items.map((item) => item.state)),
    bySource: tally(
      items.map((item) =>
        item.source.startsWith("lead:") ? "lead" : item.source,
      ),
    ),
    byProject: tally(items.map((item) => item.project)),
    answerRate: rate(answered.length, closed.length),
    dismissRate: rate(
      items.filter((item) => item.state === "dismissed").length,
      closed.length,
    ),
    expiredRate: rate(
      items.filter((item) => item.state === "expired").length,
      closed.length,
    ),
    answeredBy: tally(answered.map((item) => item.answeredBy)),
    timeToAnswerMs: distribution(
      defined(
        answered.map((item) =>
          item.answeredAt === undefined
            ? undefined
            : item.answeredAt - (item.notifiedAt ?? item.createdAt),
        ),
      ),
    ),
    recommendedChosenRate: rate(recommended(withOptions), withOptions.length),
    heldForQuietHours: items.filter((item) => item.heldUntil).length,
    leads: {
      proposals: leads.length,
      byState: tally(leads.map((item) => item.state)),
      recommendedChosenRate: rate(
        recommended(leadAnswered),
        leadAnswered.filter((item) => item.options?.length).length,
      ),
    },
  };
}

/** Ledger entries written since `since`: the dated `## ` headings
 *  (supervisor-ledger.ts). */
export function ledgerEntriesSince(ledger: string, since: number): number {
  let count = 0;
  for (const match of ledger.matchAll(
    /^## (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/gm,
  )) {
    const at = Date.parse(`${match[1]}T${match[2]}:00Z`);
    if (Number.isFinite(at) && at >= since) count++;
  }
  return count;
}

/** The whole review from already-read records. Pure: tested directly. */
export function aggregateBlobReview(input: ReviewInput) {
  const { days, since } = reviewWindow(input.now, input.days);
  const metrics = input.metrics.filter(
    (turn) => turn.startedAt >= since && turn.startedAt <= input.now,
  );
  const turns = input.sessions
    .flatMap(transcriptTurns)
    .filter((turn) => Number.isFinite(turn.at) && turn.at >= since)
    .sort((a, b) => a.at - b.at);
  // `updatedAt`, the field the inbox list filters on (listSupervisorItems
  // `since`): an item asked earlier and answered in the window counts.
  const items = input.items.filter((item) => item.updatedAt >= since);
  const byReply = new Map(
    turns
      .filter((turn) => turn.replyEntryId)
      .map((turn) => [turn.replyEntryId!, turn]),
  );
  const slowest = metrics
    .filter((turn) => firstTokenMs(turn) !== null)
    .sort((a, b) => firstTokenMs(b)! - firstTokenMs(a)!)
    .slice(0, SAMPLE_SIZE);
  const failed = metrics
    .filter((turn) => turn.outcome !== "answered")
    .slice(-SAMPLE_SIZE)
    .reverse();
  const annoying = metrics
    .filter((turn) => turn.interrupted || turn.reasked)
    .slice(-SAMPLE_SIZE)
    .reverse();
  return {
    window: {
      days,
      since: new Date(since).toISOString(),
      until: new Date(input.now).toISOString(),
      timeZone: input.timeZone,
    },
    sources: {
      appTurns: metrics.length,
      supervisorSessions: input.sessions.map((session) => session.sessionId),
      sessionsTruncated: input.sessionsTruncated ?? false,
      inboxItems: items.length,
      inboxTruncated: input.inboxTruncated ?? false,
    },
    app: appStats(metrics),
    transcript: transcriptStats(turns, input.timeZone),
    inbox: inboxStats(items, input.inboxTruncated ?? false),
    ledger: { entries: ledgerEntriesSince(input.ledger, since) },
    samples: {
      slowest: slowest.map((turn) =>
        metricSample(turn, linkMetric(turn, byReply, turns)),
      ),
      failed: failed.map((turn) =>
        metricSample(turn, linkMetric(turn, byReply, turns)),
      ),
      interruptedOrReasked: annoying.map((turn) =>
        metricSample(turn, linkMetric(turn, byReply, turns)),
      ),
      slowestTranscript: turns
        .filter((turn) => turn.durationMs !== null)
        .sort((a, b) => b.durationMs! - a.durationMs!)
        .slice(0, SAMPLE_SIZE)
        .map(transcriptSample),
      unansweredTranscript: turns
        .filter((turn) => !turn.replyEntryId)
        .slice(-SAMPLE_SIZE)
        .reverse()
        .map(transcriptSample),
      reaskedTranscript: turns
        .filter((turn) => turn.reasked)
        .slice(-SAMPLE_SIZE)
        .reverse()
        .map(transcriptSample),
    },
  };
}

export type BlobReview = ReturnType<typeof aggregateBlobReview>;

// ── Reading ─────────────────────────────────────────────────────────────────

export interface BlobReviewSources {
  now(): number;
  metrics(user: string, days: number, now: number): Promise<BlobTurnMetric[]>;
  /** The person's supervisor session ids, current first, then retired
   *  ones newest first. */
  supervisorSessionIds(user: string): Promise<string[]>;
  /** One known session, read once: its last activity (ms epoch, null when
   *  unknown) and its transcript, fetched only when asked for. Null when
   *  the session is gone. */
  session(sessionId: string): Promise<{
    lastActivity: number | null;
    transcript(): Promise<TranscriptEntry[]>;
  } | null>;
  /** Items changed since `since`, newest first; `truncated` when the list
   *  hit its cap. */
  inbox(
    user: string,
    since: number,
  ): Promise<{ items: SupervisorItem[]; truncated: boolean }>;
  ledger(user: string): Promise<string>;
  timeZone(user: string): Promise<string>;
}

const defaultSources: BlobReviewSources = {
  now: Date.now,
  metrics: async (user, days, now) =>
    (await import("./blob-metrics")).readBlobMetrics(user, days, now),
  supervisorSessionIds: async (user) =>
    (await import("./supervisor")).supervisorSessionIds(user),
  session: async (sessionId) => {
    const session = await (
      await import("./session-cache")
    ).readNativeSessionNonBlocking(sessionId);
    if (!session) return null;
    const at = Date.parse(session.lastActivity);
    return {
      lastActivity: Number.isFinite(at) ? at : null,
      transcript: async () =>
        (await import("./sessions")).mergedSessionTranscriptAsync(session),
    };
  },
  inbox: async (user, since) => {
    const inbox = await import("./supervisor-inbox");
    const items = await inbox.listSupervisorItems(user, {
      since,
      limit: inbox.MAX_LIST,
    });
    return { items, truncated: items.length >= inbox.MAX_LIST };
  },
  ledger: async (user) => {
    const ledger = await import("./supervisor-ledger");
    return (
      await ledger.readSupervisorLedgerTail(user, ledger.LEDGER_MAX_BYTES)
    ).text;
  },
  timeZone: async (user) =>
    (await import("./shared/user-mappings")).timezoneForUser(user) || "UTC",
};

/** Read one person's records for the last `days` days and aggregate them. */
export async function buildBlobReview(
  user: string,
  days: number,
  overrides: Partial<BlobReviewSources> = {},
): Promise<BlobReview> {
  const sources = { ...defaultSources, ...overrides };
  const now = sources.now();
  const { days: span, since } = reviewWindow(now, days);
  const sessions: ReviewSession[] = [];
  let sessionsTruncated = false;
  for (const sessionId of new Set(await sources.supervisorSessionIds(user))) {
    const session = await sources.session(sessionId);
    if (!session) continue;
    // Retired sessions are newest first: once one ended before the window,
    // every older one did too.
    if (session.lastActivity !== null && session.lastActivity < since) break;
    if (sessions.length >= MAX_REVIEW_SESSIONS) {
      sessionsTruncated = true;
      break;
    }
    sessions.push({ sessionId, entries: await session.transcript() });
  }
  const [metrics, inbox, ledger, timeZone] = await Promise.all([
    sources.metrics(user, span, now),
    sources.inbox(user, since),
    sources.ledger(user),
    sources.timeZone(user),
  ]);
  return aggregateBlobReview({
    now,
    days: span,
    timeZone,
    metrics,
    sessions,
    sessionsTruncated,
    items: inbox.items,
    inboxTruncated: inbox.truncated,
    ledger,
  });
}
