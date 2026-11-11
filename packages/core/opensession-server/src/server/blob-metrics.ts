/**
 * Blob turn metrics: one small record per turn the Blob app sends, with
 * timings and counts only. No transcript text and no audio ever arrive
 * here; the app sends lengths, kinds and ids (BlobMetrics.swift).
 *
 * `POST /api/blob/metrics` takes a batch (routes/blob-metrics.ts). Storage
 * follows the supervisor inbox (supervisor-inbox.ts): catalog documents in
 * `blob-metrics`, one per person per UTC day (`<person>.<YYYY-MM-DD>`),
 * each a bounded list of turns, plus one small index per person
 * (`<person>.days`) naming the days that hold data. Every append is one
 * compare-and-set on the day document and one on the index; the index is
 * what retention walks, so dropping a day older than RETENTION_DAYS never
 * lists the namespace. Reads fetch the days of the window by key.
 *
 * The rate limit is in memory, per person, like Blob speech
 * (blob-speech.ts). Nothing runs at import.
 */
import { catalogDocuments } from "./catalog-documents";
import { canonicalName } from "./shared/user-store-key";

export const BLOB_METRICS_NAMESPACE = "blob-metrics";
export const RETENTION_DAYS = 90;
/** Most turns one person's day document keeps; the newest win. */
export const MAX_TURNS_PER_DAY = 1_000;
/** Most turns one request may carry. */
export const MAX_BATCH = 100;
/** Largest request body, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Batches one person may post per minute. */
export const METRICS_PER_MINUTE = 30;
/** Most distinct UTC days one batch may touch; turns of older days in the
 *  batch are rejected. Bounds the day documents one request writes. */
export const MAX_DAYS_PER_BATCH = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest duration kept, in ms: anything above is a stuck clock. */
const MAX_MS = 60 * 60 * 1000;
const MAX_COUNT = 100_000;
/** A device clock this far ahead of the server is rejected. */
const FUTURE_SLACK_MS = 10 * 60 * 1000;
const MAX_BLOCK_KINDS = 16;

export const INPUT_MODES = ["voice", "typed", "chip", "ask"] as const;
export const TRANSCRIBERS = ["parakeet", "fish", "apple"] as const;
/** Why a voice turn's text came from the transcriber it came from
 *  (BlobTextTalk.finalText). `parakeet-*` other than `parakeet` say why
 *  Parakeet was picked but did not write the text. */
/** Why Parakeet, picked, did not write a voice turn's text. */
export const PARAKEET_MISSES = [
  "parakeet-absent",
  "parakeet-downloading",
  "parakeet-loading-timeout",
  "parakeet-failed",
  "parakeet-error",
  "parakeet-empty",
  "parakeet-deadline",
  "parakeet-skipped",
] as const;
export const TRANSCRIBER_REASONS = [
  "parakeet",
  ...PARAKEET_MISSES,
  "fish",
  "fish-missed",
  "apple-chosen",
  "too-short",
] as const;
export const END_OF_SPEECH = ["auto", "tap"] as const;
export const INTERRUPTIONS = ["hush", "tap"] as const;
export const OUTCOMES = ["answered", "failed", "abandoned"] as const;
export const POSTURES = ["closed", "open"] as const;
/** Why an abandoned voice turn never went out (BlobTextTalk.dropVoice):
 *  `nothing-heard` ended with no text, `moved-on` the owner sent something
 *  else first, `backgrounded` the app left the screen with nothing heard,
 *  `no-endpoint` the listen ran to its cap without an end of speech. */
export const DROPS = [
  "nothing-heard",
  "moved-on",
  "backgrounded",
  "no-endpoint",
] as const;
/** BlobParakeet.State when a voice turn was dropped. */
export const PARAKEET_STATES = [
  "absent",
  "downloading",
  "paused",
  "downloaded",
  "loading",
  "ready",
  "failed",
] as const;

export type BlobInputMode = (typeof INPUT_MODES)[number];
export type BlobTranscriber = (typeof TRANSCRIBERS)[number];
export type BlobTranscriberReason = (typeof TRANSCRIBER_REASONS)[number];
export type BlobParakeetMiss = (typeof PARAKEET_MISSES)[number];
export type BlobEndOfSpeech = (typeof END_OF_SPEECH)[number];
export type BlobInterruption = (typeof INTERRUPTIONS)[number];
export type BlobOutcome = (typeof OUTCOMES)[number];
export type BlobPosture = (typeof POSTURES)[number];
export type BlobDrop = (typeof DROPS)[number];
export type BlobParakeetState = (typeof PARAKEET_STATES)[number];

/** One Blob turn, as the app measured it. Durations are milliseconds. */
export interface BlobTurnMetric {
  turnId: string;
  /** When the message went out, ms epoch. */
  startedAt: number;
  input: BlobInputMode;
  transcriber?: BlobTranscriber;
  /** Time spent in the transcriber that wrote the text; for Apple, how long
   *  it took to finish its last phrase after the owner stopped. */
  transcribeMs?: number;
  transcriberReason?: BlobTranscriberReason;
  /** With Parakeet picked and Fish asked until it is ready (reason `fish`
   *  or `fish-missed`): why Parakeet did not write the text. */
  parakeetMiss?: BlobParakeetMiss;
  /** How long a Parakeet load took, from `warm()` to ready. Only on the
   *  first turn that used that load or waited for it; never a partial time
   *  of a load given up on or let go. */
  parakeetLoadMs?: number;
  /** How long the recording waited for a Parakeet load still under way
   *  when the owner stopped talking; absent when it did not wait. */
  parakeetWaitMs?: number;
  endOfSpeech?: BlobEndOfSpeech;
  speechMs?: number;
  sendToAcceptedMs?: number;
  acceptedToFirstTokenMs?: number;
  firstTokenToFirstAudioMs?: number;
  /** `fish:<model>` or `apple:<quality>`, e.g. `fish:s2.1-pro`. */
  voice?: string;
  sentencesSpoken?: number;
  interrupted?: BlobInterruption;
  /** Length of what the owner said or typed, in characters. */
  inputChars?: number;
  replyChars?: number;
  /** Block kinds the reply showed (docs/blocks.md), e.g. `metrics`, `list`. */
  blocks?: string[];
  thinkingSteps?: number;
  outcome: BlobOutcome;
  /** This turn asked again what the previous one asked, within 60 s. */
  reasked?: boolean;
  appVersion?: string;
  build?: string;
  posture?: BlobPosture;
  /** The reply's transcript entry id in the supervisor session. */
  replyEntryId?: string;
  /** On an abandoned voice turn: why it never went out. */
  dropped?: BlobDrop;
  /** On a dropped voice turn: where Parakeet was. */
  parakeetState?: BlobParakeetState;
}

interface DayDocument {
  user: string;
  day: string;
  turns: BlobTurnMetric[];
}

interface DaysIndex {
  user: string;
  days: string[];
}

// ── Validation ──────────────────────────────────────────────────────────────

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9._:+-]{1,64}$/;
const KIND = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function oneOf<T extends string>(
  values: readonly T[],
  raw: unknown,
): T | undefined {
  return values.find((value) => value === raw);
}

function duration(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    return undefined;
  return Math.min(MAX_MS, Math.round(raw));
}

function count(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    return undefined;
  return Math.min(MAX_COUNT, Math.floor(raw));
}

function token(raw: unknown, pattern: RegExp): string | undefined {
  return typeof raw === "string" && pattern.test(raw) ? raw : undefined;
}

/**
 * One turn from the wire, cleaned, or null when it is unusable: no id, no
 * start time inside the retention window, or no input mode or outcome.
 * Optional fields that don't fit their shape are dropped, never guessed.
 * Free text has nowhere to go: every string is an enum, an id or a short
 * token.
 */
export function cleanTurnMetric(
  raw: unknown,
  now: number,
): BlobTurnMetric | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const get = (field: string): unknown => Reflect.get(raw, field);
  const turnId = token(get("turnId"), ID);
  const startedAt = get("startedAt");
  const input = oneOf(INPUT_MODES, get("input"));
  const outcome = oneOf(OUTCOMES, get("outcome"));
  if (
    !turnId ||
    !input ||
    !outcome ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < now - RETENTION_DAYS * DAY_MS ||
    startedAt > now + FUTURE_SLACK_MS
  )
    return null;
  const turn: BlobTurnMetric = {
    turnId,
    startedAt: Math.round(startedAt),
    input,
    outcome,
  };
  const set = <K extends keyof BlobTurnMetric>(
    key: K,
    value: BlobTurnMetric[K] | undefined,
  ) => {
    if (value !== undefined) turn[key] = value;
  };
  set("transcriber", oneOf(TRANSCRIBERS, get("transcriber")));
  set("transcribeMs", duration(get("transcribeMs")));
  set(
    "transcriberReason",
    oneOf(TRANSCRIBER_REASONS, get("transcriberReason")),
  );
  // A Parakeet miss only says something next to the Fish it fell back to.
  if (
    turn.transcriberReason === "fish" ||
    turn.transcriberReason === "fish-missed"
  )
    set("parakeetMiss", oneOf(PARAKEET_MISSES, get("parakeetMiss")));
  set("parakeetLoadMs", duration(get("parakeetLoadMs")));
  set("parakeetWaitMs", duration(get("parakeetWaitMs")));
  set("endOfSpeech", oneOf(END_OF_SPEECH, get("endOfSpeech")));
  set("speechMs", duration(get("speechMs")));
  set("sendToAcceptedMs", duration(get("sendToAcceptedMs")));
  set("acceptedToFirstTokenMs", duration(get("acceptedToFirstTokenMs")));
  set("firstTokenToFirstAudioMs", duration(get("firstTokenToFirstAudioMs")));
  set("voice", token(get("voice"), TOKEN));
  set("sentencesSpoken", count(get("sentencesSpoken")));
  set("interrupted", oneOf(INTERRUPTIONS, get("interrupted")));
  set("inputChars", count(get("inputChars")));
  set("replyChars", count(get("replyChars")));
  const blocks = get("blocks");
  if (Array.isArray(blocks)) {
    const kinds = [
      ...new Set(
        blocks.filter(
          (kind): kind is string => typeof kind === "string" && KIND.test(kind),
        ),
      ),
    ].slice(0, MAX_BLOCK_KINDS);
    if (kinds.length) turn.blocks = kinds;
  }
  set("thinkingSteps", count(get("thinkingSteps")));
  if (get("reasked") === true) turn.reasked = true;
  set("appVersion", token(get("appVersion"), TOKEN));
  set("build", token(get("build"), TOKEN));
  set("posture", oneOf(POSTURES, get("posture")));
  set("replyEntryId", token(get("replyEntryId"), ID));
  // A drop reason only says something on a turn that never went out.
  if (turn.outcome === "abandoned") {
    set("dropped", oneOf(DROPS, get("dropped")));
    if (turn.dropped)
      set("parakeetState", oneOf(PARAKEET_STATES, get("parakeetState")));
  }
  return turn;
}

export type BatchResult =
  | { ok: true; turns: BlobTurnMetric[]; rejected: number }
  | { ok: false; error: string };

/** A request body: `{ turns: [...] }` with at most MAX_BATCH turns. Turns
 *  that fail cleaning, or fall on a day older than the batch's newest
 *  MAX_DAYS_PER_BATCH days, are counted as rejected; the rest are kept. */
export function parseMetricsBatch(body: unknown, now: number): BatchResult {
  const turns =
    body && typeof body === "object" ? Reflect.get(body, "turns") : undefined;
  if (!Array.isArray(turns))
    return { ok: false, error: "expected { turns: BlobTurnMetric[] }" };
  if (turns.length > MAX_BATCH)
    return { ok: false, error: `at most ${MAX_BATCH} turns per batch` };
  const clean: BlobTurnMetric[] = [];
  for (const raw of turns) {
    const turn = cleanTurnMetric(raw, now);
    if (turn) clean.push(turn);
  }
  const kept = new Set(
    [...new Set(clean.map((turn) => utcDay(turn.startedAt)))]
      .sort()
      .slice(-MAX_DAYS_PER_BATCH),
  );
  const inDays = clean.filter((turn) => kept.has(utcDay(turn.startedAt)));
  return { ok: true, turns: inDays, rejected: turns.length - inDays.length };
}

// ── Rate limit ──────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000;
const MAX_TRACKED_USERS = 1_000;

/** Reviews one person may read per minute: each one reads several
 *  transcripts. */
export const REVIEWS_PER_MINUTE = 6;

/** A fixed-window per-person counter that allows `limit` calls a minute. */
function rateLimiter(limit: number) {
  const table = new Map<string, { count: number; resetAt: number }>();
  return {
    limited(user: string, now: number): boolean {
      const rec = table.get(user);
      if (!rec || rec.resetAt <= now) {
        if (table.size >= MAX_TRACKED_USERS) {
          for (const [key, value] of table)
            if (value.resetAt <= now) table.delete(key);
          if (table.size >= MAX_TRACKED_USERS) table.clear();
        }
        table.set(user, { count: 1, resetAt: now + WINDOW_MS });
        return false;
      }
      rec.count++;
      return rec.count > limit;
    },
    clear: () => table.clear(),
  };
}

const metricsLimit = rateLimiter(METRICS_PER_MINUTE);
const reviewLimit = rateLimiter(REVIEWS_PER_MINUTE);

export function blobMetricsRateLimited(
  user: string,
  now = Date.now(),
): boolean {
  return metricsLimit.limited(user, now);
}

export function blobReviewRateLimited(user: string, now = Date.now()): boolean {
  return reviewLimit.limited(user, now);
}

export function resetBlobMetricsRateLimit(): void {
  metricsLimit.clear();
  reviewLimit.clear();
}

// ── Storage ─────────────────────────────────────────────────────────────────

let documentsCache: ReturnType<typeof catalogDocuments> | undefined;
function documents() {
  return (documentsCache ??= catalogDocuments(BLOB_METRICS_NAMESPACE));
}

/** One person's key prefix, whatever case their name arrives in: the
 *  supervisor inbox's spelling (supervisor-inbox.ts supervisorInboxKey). */
export function blobMetricsPersonKey(user: string): string {
  return canonicalName(user.trim().toLowerCase());
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function dayKey(user: string, day: string): string {
  return `${blobMetricsPersonKey(user)}.${day}`;
}

function indexKey(user: string): string {
  return `${blobMetricsPersonKey(user)}.days`;
}

function cleanDay(value: unknown, user: string, day: string): DayDocument {
  const turns =
    value && typeof value === "object" ? Reflect.get(value, "turns") : null;
  return {
    user,
    day,
    turns: Array.isArray(turns)
      ? turns.filter(
          (turn): turn is BlobTurnMetric =>
            !!turn &&
            typeof turn === "object" &&
            typeof turn.turnId === "string" &&
            typeof turn.startedAt === "number",
        )
      : [],
  };
}

function cleanIndex(value: unknown, user: string): DaysIndex {
  const days =
    value && typeof value === "object" ? Reflect.get(value, "days") : null;
  return {
    user,
    days: Array.isArray(days)
      ? days.filter(
          (day): day is string =>
            typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day),
        )
      : [],
  };
}

/** Merge `incoming` into a day's turns: the same turn id replaces the
 *  stored one (a re-sent batch), the result sorted by start and bounded to
 *  the newest MAX_TURNS_PER_DAY. */
export function mergeTurns(
  stored: BlobTurnMetric[],
  incoming: BlobTurnMetric[],
): BlobTurnMetric[] {
  const byId = new Map(stored.map((turn) => [turn.turnId, turn]));
  for (const turn of incoming) byId.set(turn.turnId, turn);
  return [...byId.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-MAX_TURNS_PER_DAY);
}

/** The oldest UTC day still kept at `now`. */
export function oldestKeptDay(now: number): string {
  return utcDay(now - (RETENTION_DAYS - 1) * DAY_MS);
}

/**
 * Delete a person's day documents older than RETENTION_DAYS. A day leaves
 * the index only after its document is deleted, so a failed delete is
 * retried on the next append or read instead of leaking a document nothing
 * names.
 */
async function pruneExpiredDays(person: string, now: number): Promise<void> {
  const oldest = oldestKeptDay(now);
  const index = cleanIndex(await documents().get(indexKey(person)), person);
  const expired = index.days.filter((day) => day < oldest);
  if (!expired.length) return;
  const deleted = new Set<string>();
  for (const day of expired) {
    try {
      await documents().delete(dayKey(person, day));
      deleted.add(day);
    } catch (error) {
      console.warn(
        `[blob-metrics] could not delete ${day} for ${person}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  if (!deleted.size) return;
  await documents().update(indexKey(person), (current) => {
    const days = cleanIndex(current, person).days;
    return { user: person, days: days.filter((day) => !deleted.has(day)) };
  });
}

/**
 * Store a person's cleaned turns, grouped by UTC day, then drop their days
 * older than RETENTION_DAYS. Returns how many turns were stored.
 */
export async function appendBlobMetrics(
  user: string,
  turns: BlobTurnMetric[],
  now = Date.now(),
): Promise<number> {
  const person = user.trim();
  if (!person || turns.length === 0) return 0;
  const oldest = oldestKeptDay(now);
  const byDay = new Map<string, BlobTurnMetric[]>();
  for (const turn of turns) {
    const day = utcDay(turn.startedAt);
    if (day < oldest) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), turn]);
  }
  let stored = 0;
  for (const [day, incoming] of [...byDay].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    await documents().update(dayKey(person, day), (current) => ({
      user: person,
      day,
      turns: mergeTurns(cleanDay(current, person, day).turns, incoming),
    }));
    stored += incoming.length;
  }
  if (byDay.size)
    await documents().update(indexKey(person), (current) => {
      const index = cleanIndex(current, person);
      const days = [...new Set([...index.days, ...byDay.keys()])].sort();
      return { user: person, days };
    });
  await pruneExpiredDays(person, now);
  return stored;
}

/** A person's turns that started in the last `days` days, oldest first.
 *  Reads one document per day of the window, by key, after dropping the
 *  person's expired days, so retention holds without new appends. */
export async function readBlobMetrics(
  user: string,
  days: number,
  now = Date.now(),
): Promise<BlobTurnMetric[]> {
  const person = user.trim();
  if (!person) return [];
  await pruneExpiredDays(person, now);
  const span = Math.max(1, Math.min(RETENTION_DAYS, Math.floor(days)));
  const since = now - span * DAY_MS;
  const keys: string[] = [];
  for (let back = 0; back <= span; back++)
    keys.push(dayKey(person, utcDay(now - back * DAY_MS)));
  const rows = await documents().getMany(keys);
  return rows
    .flatMap((row) => cleanDay(row.value, person, "").turns)
    .filter((turn) => turn.startedAt >= since && turn.startedAt <= now)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** The days a person has data for, oldest first (the retention index). */
export async function blobMetricsDays(user: string): Promise<string[]> {
  const person = user.trim();
  if (!person) return [];
  return cleanIndex(await documents().get(indexKey(person)), person).days;
}
