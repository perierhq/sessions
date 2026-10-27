// Signal observations: per-signal daily JSONL files (UTC days of each
// observation's `at`) written by an async batch writer, plus an in-memory
// ring per lane. Appends touch memory only; files are written off-thread of
// the caller and never synchronously.
import { appendFile, mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Observation, Signal } from "../../shared/incidents";
import { createAuditWriter } from "../audit";
import { legacyCatalogDirectory } from "../catalog-documents";
import { previousRun } from "../cron";

export const OBSERVATION_RETENTION_DAYS = 30;
export const RING_PER_LANE = 720;
export const MAX_RING_LANES = 25;

const NAMESPACE = "incident-observations";
const DAY_MS = 86_400_000;
const MAX_QUERY_MS = 31 * DAY_MS;
export const DEFAULT_HYDRATION_LOOKBACK_MS = 2 * DAY_MS;
export const MAX_HYDRATION_LOOKBACK_MS = 31 * DAY_MS;
const READ_CHUNK_BYTES = 65_536;
/** A longer line is garbage (no observation comes near it); skip it. */
const MAX_LINE_CHARS = 1_048_576;
const SIGNAL_ID = /^sig-[A-Za-z0-9-]{1,80}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Ring key and lane filter of the main lane. */
export const MAIN_LANE = "";
const MAIN = MAIN_LANE;

type Rings = Map<string, Observation[]>;

let rings = new Map<string, Rings>();
let hydrated = new Set<string>();
let hydrating = new Map<string, Promise<void>>();
let pendingWrites = new Set<Promise<void>>();
/** Bumped by forgetObservations so a hydration already running is dropped. */
let generations = new Map<string, number>();
/** Files whose tail this process has checked for a torn last line. */
let tailChecked = new Set<string>();
/** Resolved observation directory per OPENSESSION_STATE_DIR value. */
const directories = new Map<string, Promise<string>>();
let writer: ReturnType<typeof createAuditWriter> | undefined;

function assertSignalId(signalId: string): void {
  if (!SIGNAL_ID.test(signalId)) throw new Error("Invalid signal id");
}

function directoryKey(): string {
  const stateDir = process.env.OPENSESSION_STATE_DIR;
  return stateDir ? `state:${stateDir}` : `home:${process.env.HOME ?? ""}`;
}

/**
 * The observation directory for the current state dir. The lookup starts
 * synchronously (it reads the environment before its first await), so a
 * caller captures the directory of the moment it asked.
 */
function observationDirectory(key = directoryKey()): Promise<string> {
  let directory = directories.get(key);
  if (!directory) {
    directory = legacyCatalogDirectory(NAMESPACE);
    directories.set(key, directory);
    directory.catch(() => directories.delete(key));
  }
  return directory;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The observation with `at` as an ISO instant (UTC, milliseconds), so string
 * order is time order; null when `at` is not a time.
 */
function normalizeObservation(observation: Observation): Observation | null {
  const ms = Date.parse(observation.at);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms).toISOString();
  return at === observation.at ? observation : { ...observation, at };
}

/** A crash can leave a file without its final newline; start on a new line. */
async function needsLeadingNewline(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function observationWriter(): ReturnType<typeof createAuditWriter> {
  return (writer ??= createAuditWriter(async (file, text) => {
    const split = file.indexOf("\n");
    const directory = await observationDirectory(file.slice(0, split));
    const path = join(directory, file.slice(split + 1));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (!tailChecked.has(path)) {
        tailChecked.add(path);
        if (await needsLeadingNewline(path)) text = `\n${text}`;
      }
      await appendFile(path, text, { mode: 0o600 });
    } catch (error) {
      // The append may have left a torn line; check the tail again next time.
      tailChecked.delete(path);
      throw error;
    }
  }));
}

function laneKey(observation: Observation): string {
  return observation.lane ?? MAIN;
}

function ringsFor(signalId: string): Rings {
  let lanes = rings.get(signalId);
  if (!lanes) {
    lanes = new Map();
    rings.set(signalId, lanes);
  }
  return lanes;
}

/** The ring for a lane, or undefined when a new side lane would pass the cap. */
function ringFor(lanes: Rings, key: string): Observation[] | undefined {
  let ring = lanes.get(key);
  if (ring) return ring;
  const sideLanes = lanes.size - (lanes.has(MAIN) ? 1 : 0);
  if (key !== MAIN && sideLanes >= MAX_RING_LANES - 1) return undefined;
  ring = [];
  lanes.set(key, ring);
  return ring;
}

function insertSorted(ring: Observation[], observation: Observation): void {
  const last = ring.at(-1);
  if (!last || last.at <= observation.at) {
    ring.push(observation);
  } else {
    let index = ring.length;
    while (index > 0 && ring[index - 1]!.at > observation.at) index--;
    ring.splice(index, 0, observation);
  }
  if (ring.length > RING_PER_LANE) ring.splice(0, ring.length - RING_PER_LANE);
}

function addToRings(signalId: string, observations: Observation[]): void {
  const lanes = ringsFor(signalId);
  for (const observation of observations) {
    const ring = ringFor(lanes, laneKey(observation));
    if (ring) insertSorted(ring, observation);
  }
}

/** Observations with an unreadable `at` are dropped. */
export function appendObservations(
  signalId: string,
  input: Observation[],
): void {
  assertSignalId(signalId);
  const observations: Observation[] = [];
  for (const observation of input) {
    const normalized = normalizeObservation(observation);
    if (normalized) observations.push(normalized);
  }
  if (!observations.length) return;
  addToRings(signalId, observations);
  const key = directoryKey();
  void observationDirectory(key);
  const out = observationWriter();
  let resolveWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    resolveWritten = resolve;
  });
  pendingWrites.add(written);
  void written.then(() => pendingWrites.delete(written));
  // All lines of one call land in the same batch: the writer only swaps its
  // queue across an await, and these pushes are synchronous.
  observations.forEach((observation, index) => {
    out.push({
      file: `${key}\n${signalId}/${observation.at.slice(0, 10)}.jsonl`,
      line: JSON.stringify(observation),
      written: index === observations.length - 1 ? resolveWritten : undefined,
    });
  });
}

/**
 * Resolves once every observation appended before the call has been written
 * (or its write failed). Later appends are not waited for, so a steady
 * stream of observations cannot hold a flush open.
 */
export async function flushObservations(): Promise<void> {
  await Promise.all([...pendingWrites]);
}

/** Drop a signal's memory (rings, hydration); its day files stay. */
export function forgetObservations(signalId: string): void {
  if (!SIGNAL_ID.test(signalId)) return;
  rings.delete(signalId);
  hydrated.delete(signalId);
  hydrating.delete(signalId);
  generations.set(signalId, (generations.get(signalId) ?? 0) + 1);
}

export function recentObservations(
  signalId: string,
  lane?: string | "*",
): Observation[] {
  const lanes = rings.get(signalId);
  if (!lanes) return [];
  if (lane !== "*") return [...(lanes.get(lane ?? MAIN) ?? [])];
  const merged: Observation[] = [];
  for (const ring of lanes.values()) merged.push(...ring);
  return merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function isObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object") return false;
  const { at, result } = value as Partial<Observation>;
  return (
    typeof at === "string" &&
    (result === "ok" || result === "fail" || result === "unknown")
  );
}

function parseLine(line: string): Observation | null {
  if (!line.trim()) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObservation(value) ? normalizeObservation(value) : null;
  } catch {
    // A torn line after a crash or a full disk; keep the rest.
    return null;
  }
}

/**
 * Stream a day file line by line, handing each readable observation to
 * `visit`. Torn or garbage lines are skipped; a missing file is empty.
 * Reading stops as soon as `done()` returns true.
 */
async function scanDayFile(
  directory: string,
  signalId: string,
  day: string,
  visit: (observation: Observation) => void,
  done: () => boolean = () => false,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(join(directory, signalId, `${day}.jsonl`), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let skipping = false;
    let position = 0;
    const take = (line: string) => {
      const observation = parseLine(line);
      if (observation) visit(observation);
    };
    while (!done()) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      carry += decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      for (
        let newline = carry.indexOf("\n");
        newline >= 0;
        newline = carry.indexOf("\n", start)
      ) {
        if (!skipping) take(carry.slice(start, newline));
        skipping = false;
        start = newline + 1;
        if (done()) return;
      }
      carry = carry.slice(start);
      if (carry.length > MAX_LINE_CHARS) {
        carry = "";
        skipping = true;
      }
    }
    if (done()) return;
    carry += decoder.end();
    if (!skipping) take(carry);
  } finally {
    await handle.close();
  }
}

/** Union of two lists where an identical observation counts once per copy. */
function mergeDistinct(
  stored: Observation[],
  memory: Observation[],
): Observation[] {
  const counts = new Map<string, number>();
  for (const observation of stored) {
    const key = JSON.stringify(observation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = [...stored];
  for (const observation of memory) {
    const key = JSON.stringify(observation);
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else out.push(observation);
  }
  return out;
}

function byAt(a: Observation, b: Observation): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

/** Longest gap between the last few runs of a cron schedule, or null. */
function cronPeriodMs(cron: string, now: number): number | null {
  let latest = previousRun(cron, new Date(now));
  if (!latest) return null;
  let period = 0;
  for (let i = 0; i < 4; i++) {
    const before = previousRun(cron, new Date(latest.getTime() - 60_000));
    if (!before) return i ? period : null;
    period = Math.max(period, latest.getTime() - before.getTime());
    latest = before;
  }
  return period;
}

/**
 * How far back hydration must read for a signal's rules to see their last
 * check-in: two days, or a heartbeat's schedule plus its grace when longer,
 * at most 31 days.
 */
export function hydrationLookbackMs(
  signal: Pick<Signal, "rule">,
  now: number = Date.now(),
): number {
  let need = DEFAULT_HYDRATION_LOOKBACK_MS;
  const rule = signal.rule;
  if (rule?.kind === "missing") {
    const period =
      rule.everyMs ?? (rule.cron ? cronPeriodMs(rule.cron, now) : null);
    need =
      period === null
        ? MAX_HYDRATION_LOOKBACK_MS
        : Math.max(need, period + (rule.graceMs ?? 0));
  }
  return Math.min(MAX_HYDRATION_LOOKBACK_MS, need);
}

/**
 * Load a signal's recent observations into memory once: the day files from
 * `now - lookbackMs` (two days by default, at most 31) to `now`, merged with
 * anything appended before hydration. Pass {@link hydrationLookbackMs} of the
 * signal.
 */
export function hydrateObservations(
  signalId: string,
  now: number = Date.now(),
  lookbackMs: number = DEFAULT_HYDRATION_LOOKBACK_MS,
): Promise<void> {
  assertSignalId(signalId);
  if (hydrated.has(signalId)) return Promise.resolve();
  let running = hydrating.get(signalId);
  if (running) return running;
  const generation = generations.get(signalId) ?? 0;
  const span = Math.min(
    MAX_HYDRATION_LOOKBACK_MS,
    Math.max(0, Number.isFinite(lookbackMs) ? lookbackMs : 0),
  );
  running = (async () => {
    await flushObservations();
    const directory = await observationDirectory();
    const stored: Rings = new Map();
    for (
      let day = Date.parse(`${utcDay(now - span)}T00:00:00Z`);
      day <= now;
      day += DAY_MS
    )
      await scanDayFile(directory, signalId, utcDay(day), (observation) => {
        const ring = ringFor(stored, laneKey(observation));
        if (ring) insertSorted(ring, observation);
      });
    if ((generations.get(signalId) ?? 0) !== generation) return;
    const memory = recentObservations(signalId, "*");
    const merged = mergeDistinct([...stored.values()].flat(), memory).sort(
      byAt,
    );
    rings.delete(signalId);
    addToRings(signalId, merged);
    hydrated.add(signalId);
  })().finally(() => {
    if (hydrating.get(signalId) === running) hydrating.delete(signalId);
  });
  hydrating.set(signalId, running);
  return running;
}

export interface ObservationQueryOptions {
  /** One lane ({@link MAIN_LANE} for the main lane) or `"*"` (default). */
  lane?: string;
}

export interface ObservationScanOptions extends ObservationQueryOptions {
  /** Checked after each observation handed to `visit` (and before each
   *  read): once it returns true the scan stops reading and resolves. */
  until?: () => boolean;
}

/**
 * Hand every observation of `[from, to]` (and of the lane asked for) to
 * `visit`, streaming day files rather than loading them, in no promised
 * order. Feed a strip bucketer with it so a long range is never held in
 * memory. Spans at most 31 days. `until` ends the scan early.
 */
export async function scanObservations(
  signalId: string,
  from: number,
  to: number,
  visit: (observation: Observation) => void,
  opts: ObservationScanOptions = {},
): Promise<void> {
  assertSignalId(signalId);
  if (!Number.isFinite(from) || !Number.isFinite(to))
    throw new RangeError("Observation queries need a finite range");
  if (to - from > MAX_QUERY_MS)
    throw new RangeError("Observation queries span at most 31 days");
  const lane = opts.lane ?? "*";
  const wanted = (observation: Observation) => {
    if (lane !== "*" && laneKey(observation) !== lane) return false;
    const at = Date.parse(observation.at);
    return at >= from && at <= to;
  };
  const filtered = (observation: Observation) => {
    if (wanted(observation)) visit(observation);
  };
  const until = opts.until ?? (() => false);
  const oldest = rings.get(signalId)?.get(lane === "*" ? MAIN : lane)?.[0];
  if (hydrated.has(signalId) && oldest && Date.parse(oldest.at) <= from) {
    for (const observation of recentObservations(signalId, lane)) {
      if (until()) return;
      filtered(observation);
    }
    return;
  }
  await flushObservations();
  const directory = await observationDirectory();
  for (
    let day = Date.parse(`${utcDay(from)}T00:00:00Z`);
    day <= to && !until();
    day += DAY_MS
  )
    await scanDayFile(directory, signalId, utcDay(day), filtered, until);
}

/** Whether `lane` ({@link MAIN_LANE} for the main lane) has an observation
 *  in `[from, to]`: the in-memory ring first, then a scan that stops at the
 *  first match. Spans at most 31 days. */
export async function hasObservation(
  signalId: string,
  from: number,
  to: number,
  lane: string,
): Promise<boolean> {
  assertSignalId(signalId);
  const inRange = (observation: Observation) => {
    const at = Date.parse(observation.at);
    return at >= from && at <= to;
  };
  if (rings.get(signalId)?.get(lane)?.some(inRange)) return true;
  let found = false;
  await scanObservations(
    signalId,
    from,
    to,
    () => {
      found = true;
    },
    { lane, until: () => found },
  );
  return found;
}

/** The observation of `lane` ({@link MAIN_LANE} for the main lane) closest
 *  to `at`, at most `toleranceMs` away, or null: the in-memory ring first,
 *  then a scan of that span that stops at an exact match. */
export async function nearestObservation(
  signalId: string,
  at: number,
  toleranceMs: number,
  lane: string,
): Promise<Observation | null> {
  assertSignalId(signalId);
  let best: Observation | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  const consider = (observation: Observation) => {
    const gap = Math.abs(Date.parse(observation.at) - at);
    if (gap <= toleranceMs && gap < bestGap) {
      best = observation;
      bestGap = gap;
    }
  };
  for (const observation of rings.get(signalId)?.get(lane) ?? [])
    consider(observation);
  if (bestGap === 0) return best;
  await scanObservations(
    signalId,
    at - toleranceMs,
    at + toleranceMs,
    consider,
    {
      lane,
      until: () => bestGap === 0,
    },
  );
  return best;
}

/** The times (epoch ms, sorted) of every observation of `lane`
 *  ({@link MAIN_LANE} for the main lane) on the UTC day holding `dayMs`:
 *  one scan of that day (the in-memory ring when it reaches back that far,
 *  else the day file), so a caller with many times on one day asks once. */
export async function observationTimes(
  signalId: string,
  dayMs: number,
  lane: string,
): Promise<number[]> {
  const from = Date.parse(`${utcDay(dayMs)}T00:00:00Z`);
  const times: number[] = [];
  await scanObservations(
    signalId,
    from,
    from + DAY_MS - 1,
    (observation) => times.push(Date.parse(observation.at)),
    { lane },
  );
  return times.sort((a, b) => a - b);
}

/** {@link scanObservations}, collected and sorted by `at`. */
export async function queryObservations(
  signalId: string,
  from: number,
  to: number,
  opts: ObservationQueryOptions = {},
): Promise<Observation[]> {
  const out: Observation[] = [];
  await scanObservations(signalId, from, to, (o) => out.push(o), opts);
  return out.sort(byAt);
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Delete day files older than the retention in every signal directory,
 * including those of deleted signals, and remove directories left empty.
 */
export async function pruneObservations(
  now: number = Date.now(),
): Promise<number> {
  await flushObservations();
  const directory = await observationDirectory();
  const cutoff = utcDay(now - OBSERVATION_RETENTION_DAYS * DAY_MS);
  let removed = 0;
  for (const signalId of await listDirectory(directory)) {
    if (!SIGNAL_ID.test(signalId)) continue;
    const signalDirectory = join(directory, signalId);
    const files = await listDirectory(signalDirectory);
    let kept = 0;
    for (const file of files) {
      const day = DAY_FILE.exec(file)?.[1];
      if (!day || day >= cutoff) {
        kept++;
        continue;
      }
      await rm(join(signalDirectory, file), { force: true });
      tailChecked.delete(join(signalDirectory, file));
      removed++;
    }
    if (!kept) await rmdir(signalDirectory).catch(() => {});
  }
  return removed;
}

export function __resetObservationsForTest(): void {
  rings = new Map();
  hydrated = new Set();
  hydrating = new Map();
  pendingWrites = new Set();
  generations = new Map();
  tailChecked = new Set();
  directories.clear();
  writer = undefined;
}
