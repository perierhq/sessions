// Signal observations: per-signal daily JSONL files (UTC days of each
// observation's `at`) written by an async batch writer, plus an in-memory
// ring per lane. Appends touch memory only; files are written off-thread of
// the caller and never synchronously.
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Observation } from "../../shared/incidents";
import { createAuditWriter } from "../audit";
import { legacyCatalogDirectory } from "../catalog-documents";

export const OBSERVATION_RETENTION_DAYS = 30;
export const RING_PER_LANE = 720;
export const MAX_RING_LANES = 25;

const NAMESPACE = "incident-observations";
const DAY_MS = 86_400_000;
const MAX_QUERY_MS = 31 * DAY_MS;
const SIGNAL_ID = /^sig-[A-Za-z0-9-]{1,80}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Ring key of the main lane. */
const MAIN = "";

type Rings = Map<string, Observation[]>;

let rings = new Map<string, Rings>();
let hydrated = new Set<string>();
let hydrating = new Map<string, Promise<void>>();
let pendingWrites = new Set<Promise<void>>();
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

function observationDay(observation: Observation): string {
  const ms = Date.parse(observation.at);
  return utcDay(Number.isFinite(ms) ? ms : Date.now());
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
    if (!tailChecked.has(path)) {
      tailChecked.add(path);
      if (await needsLeadingNewline(path)) text = `\n${text}`;
    }
    await appendFile(path, text, { mode: 0o600 });
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

export function appendObservations(
  signalId: string,
  observations: Observation[],
): void {
  assertSignalId(signalId);
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
      file: `${key}\n${signalId}/${observationDay(observation)}.jsonl`,
      line: JSON.stringify(observation),
      written: index === observations.length - 1 ? resolveWritten : undefined,
    });
  });
}

/** Resolves once every observation appended so far has been written. */
export async function flushObservations(): Promise<void> {
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
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

/** Parse a day file, skipping torn or garbage lines. A missing file is empty. */
async function readDayFile(
  directory: string,
  signalId: string,
  day: string,
): Promise<Observation[]> {
  let text: string;
  try {
    text = await readFile(join(directory, signalId, `${day}.jsonl`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: Observation[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObservation(value)) out.push(value);
    } catch {
      // A torn line after a crash or a full disk; keep the rest.
    }
  }
  return out;
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

export function hydrateObservations(
  signalId: string,
  now: number = Date.now(),
): Promise<void> {
  assertSignalId(signalId);
  if (hydrated.has(signalId)) return Promise.resolve();
  let running = hydrating.get(signalId);
  if (running) return running;
  running = (async () => {
    await flushObservations();
    const directory = await observationDirectory();
    const stored = [
      ...(await readDayFile(directory, signalId, utcDay(now - DAY_MS))),
      ...(await readDayFile(directory, signalId, utcDay(now))),
    ];
    const memory = recentObservations(signalId, "*");
    const merged = mergeDistinct(stored, memory).sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
    );
    rings.delete(signalId);
    addToRings(signalId, merged);
    hydrated.add(signalId);
  })().finally(() => hydrating.delete(signalId));
  hydrating.set(signalId, running);
  return running;
}

export async function queryObservations(
  signalId: string,
  from: number,
  to: number,
): Promise<Observation[]> {
  assertSignalId(signalId);
  if (to - from > MAX_QUERY_MS)
    throw new RangeError("Observation queries span at most 31 days");
  const inRange = (observation: Observation) => {
    const at = Date.parse(observation.at);
    return at >= from && at <= to;
  };
  const oldest = rings.get(signalId)?.get(MAIN)?.[0];
  if (hydrated.has(signalId) && oldest && Date.parse(oldest.at) <= from)
    return recentObservations(signalId, "*").filter(inRange);
  await flushObservations();
  const directory = await observationDirectory();
  const out: Observation[] = [];
  for (
    let day = Date.parse(`${utcDay(from)}T00:00:00Z`);
    day <= to;
    day += DAY_MS
  )
    out.push(...(await readDayFile(directory, signalId, utcDay(day))));
  return out
    .filter(inRange)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
  tailChecked = new Set();
  directories.clear();
  writer = undefined;
}
