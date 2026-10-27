/**
 * Gateway memory diagnostics.
 *
 * The gateway can grow slowly over days, and nothing it exposes says where
 * the memory went. This module answers three questions without restarting
 * under an inspector:
 *
 * - `memoryReport()`: process and JSC heap figures plus the sizes of the
 *   long-lived in-process collections, for GET /api/admin/memory.
 * - `writeHeapSnapshot()`: a V8-format heap snapshot (loadable in Chrome
 *   DevTools) under `<state>/diagnostics/`, mode 0600, for
 *   POST /api/admin/memory/heap-snapshot. Generating one pauses the gateway
 *   for as long as JSC takes to walk the heap, and the file holds every
 *   secret in memory, so it is only ever written on an explicit admin request.
 * - `startMemoryDiagnosticsLog()`: one `[memory]` line every ten minutes so
 *   growth can be read back from the journal after the fact.
 *
 * Collections come from two places: every Map or Set parked on
 * `globalThis.__*` (found by scanning, so new ones are covered for free) and
 * module-level ones registered through memory-gauges.ts.
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MEMORY_GAUGES_GLOBAL_KEY, memoryGauges } from "./memory-gauges";
import { statePath } from "./paths";

export const MEMORY_LOG_INTERVAL_MS = 10 * 60_000;
const LOG_TOP_COLLECTIONS = 8;
const REPORT_TOP_OBJECT_TYPES = 25;

export interface CollectionSize {
  /** `global.__name` for globalThis state, `<module>.<variable>` otherwise. */
  name: string;
  /** Entries in the collection itself. */
  size: number;
  /** Total entries across its values when those are collections too (for
   *  example sessionId → Set<subscriber>). */
  nested?: number;
}

export interface MemoryReport {
  at: string;
  pid: number;
  uptimeSec: number;
  bunVersion: string;
  /** process.memoryUsage(), bytes. */
  memoryUsage: NodeJS.MemoryUsage;
  /** Linux only: /proc/self/status memory lines, bytes. */
  proc?: Record<string, number>;
  /** bun:jsc heapStats(), when available. */
  heap?: {
    heapSize: number;
    heapCapacity: number;
    extraMemorySize: number;
    objectCount: number;
    protectedObjectCount: number;
    globalObjectCount: number;
    protectedGlobalObjectCount: number;
    topObjectTypes: { type: string; count: number }[];
  };
  /** bun:jsc memoryUsage(): the allocator's view, bytes. */
  allocator?: Record<string, number>;
  /** Largest first. */
  collections: CollectionSize[];
}

function collectionLength(value: unknown): number | undefined {
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function measure(name: string, value: Map<unknown, unknown> | Set<unknown>) {
  const entry: CollectionSize = { name, size: value.size };
  const first = value.values().next();
  if (!first.done && collectionLength(first.value) !== undefined) {
    let nested = 0;
    for (const inner of value.values()) nested += collectionLength(inner) ?? 0;
    entry.nested = nested;
  }
  return entry;
}

function weight(entry: CollectionSize): number {
  return Math.max(entry.size, entry.nested ?? 0);
}

/**
 * Sizes of every tracked long-lived collection, largest first. Cheap: one
 * pass over globalThis's own keys, the registered gauges, and the values of
 * collections whose values are collections.
 */
export function collectionSizes(
  root: object = globalThis,
  gauges = memoryGauges(),
): CollectionSize[] {
  const sizes: CollectionSize[] = [];
  for (const key of Object.getOwnPropertyNames(root)) {
    if (!key.startsWith("__") || key === MEMORY_GAUGES_GLOBAL_KEY) continue;
    // Descriptor, not property access: never run a getter from a scan.
    const value = Object.getOwnPropertyDescriptor(root, key)?.value;
    if (value instanceof Map || value instanceof Set)
      sizes.push(measure(`global.${key}`, value));
  }
  for (const [name, gauge] of gauges) {
    try {
      const size = gauge();
      if (Number.isFinite(size)) sizes.push({ name, size });
    } catch {
      // A broken gauge must not take the report down with it.
    }
  }
  return sizes.sort(
    (a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name),
  );
}

const PROC_STATUS_KEYS = [
  "VmRSS",
  "VmHWM",
  "RssAnon",
  "RssFile",
  "RssShmem",
  "VmSwap",
] as const;

/** Pure: the memory lines of /proc/<pid>/status, converted to bytes. */
export function parseProcStatus(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of PROC_STATUS_KEYS) {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
    if (match) out[key] = Number(match[1]) * 1024;
  }
  return out;
}

async function procStatus(): Promise<Record<string, number> | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return parseProcStatus(await readFile("/proc/self/status", "utf8"));
  } catch {
    return undefined;
  }
}

type JscModule = typeof import("bun:jsc");

async function jsc(): Promise<JscModule | undefined> {
  try {
    return await import("bun:jsc");
  } catch {
    return undefined;
  }
}

/** Full report for GET /api/admin/memory. heapStats() walks the heap, so
 *  this is on-demand only; the periodic log line skips it. */
export async function memoryReport(): Promise<MemoryReport> {
  const report: MemoryReport = {
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    bunVersion: Bun.version,
    memoryUsage: process.memoryUsage(),
    collections: collectionSizes(),
  };
  const proc = await procStatus();
  if (proc) report.proc = proc;
  const runtime = await jsc();
  if (runtime) {
    try {
      const stats = runtime.heapStats();
      report.heap = {
        heapSize: stats.heapSize,
        heapCapacity: stats.heapCapacity,
        extraMemorySize: stats.extraMemorySize,
        objectCount: stats.objectCount,
        protectedObjectCount: stats.protectedObjectCount,
        globalObjectCount: stats.globalObjectCount,
        protectedGlobalObjectCount: stats.protectedGlobalObjectCount,
        topObjectTypes: Object.entries(stats.objectTypeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, REPORT_TOP_OBJECT_TYPES)
          .map(([type, count]) => ({ type, count })),
      };
    } catch {
      // Older runtimes: the process figures above still stand.
    }
    try {
      report.allocator = { ...runtime.memoryUsage() };
    } catch {
      // As above.
    }
  }
  return report;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Pure: the single `[memory]` journal line. */
export function memoryLogLine(
  usage: NodeJS.MemoryUsage,
  collections: readonly CollectionSize[],
  uptimeSec: number,
): string {
  const top = collections
    .filter((c) => weight(c) > 0)
    .slice(0, LOG_TOP_COLLECTIONS)
    .map(
      (c) =>
        `${c.name}=${c.size}${c.nested !== undefined ? `/${c.nested}` : ""}`,
    )
    .join(" ");
  return (
    `[memory] rss=${mb(usage.rss)} heapUsed=${mb(usage.heapUsed)}` +
    ` heapTotal=${mb(usage.heapTotal)} external=${mb(usage.external)}` +
    ` arrayBuffers=${mb(usage.arrayBuffers)} uptime=${(uptimeSec / 3600).toFixed(1)}h` +
    (top ? ` top: ${top}` : "")
  );
}

const diagnosticsGlobal = globalThis as typeof globalThis & {
  __osMemoryDiagnostics?: {
    timer?: ReturnType<typeof setInterval>;
    snapshotRunning: boolean;
  };
};

function diagnosticsState() {
  return (diagnosticsGlobal.__osMemoryDiagnostics ??= {
    snapshotRunning: false,
  });
}

function logMemoryLine(): void {
  try {
    console.log(
      memoryLogLine(process.memoryUsage(), collectionSizes(), process.uptime()),
    );
  } catch (error) {
    console.warn("[memory] diagnostics line failed:", error);
  }
}

/** Idempotent; called once from opensession.ts boot, never at import. */
export function startMemoryDiagnosticsLog(
  intervalMs = MEMORY_LOG_INTERVAL_MS,
): void {
  const state = diagnosticsState();
  if (state.timer) return;
  logMemoryLine();
  state.timer = setInterval(logMemoryLine, intervalMs);
  state.timer.unref?.();
}

export class HeapSnapshotBusyError extends Error {
  constructor() {
    super("A heap snapshot is already being written");
  }
}

export interface HeapSnapshotResult {
  path: string;
  bytes: number;
  durationMs: number;
}

/** Snapshots kept in `<state>/diagnostics/`; older ones are deleted. */
export const KEEP_HEAP_SNAPSHOTS = 3;
/** Free space left after a snapshot is written, so it cannot fill the disk
 *  the gateway's own state lives on. */
export const SNAPSHOT_FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;
const PARTIAL_SUFFIX = ".partial";
const SNAPSHOT_NAME = /^heap-.*\.heapsnapshot$/;

/**
 * Write a V8-format heap snapshot to `<state>/diagnostics/` with mode 0600
 * and return where it went. One at a time: a second call while one is in
 * flight throws HeapSnapshotBusyError. `generate` is injectable for tests.
 *
 * Written under a `.partial` name and renamed on success, so a failed write
 * never leaves a truncated snapshot; a snapshot that would leave less than
 * SNAPSHOT_FREE_SPACE_MARGIN_BYTES free is refused. Snapshots hold every
 * string on the heap, credentials included, so only the newest
 * KEEP_HEAP_SNAPSHOTS are kept.
 */
export async function writeHeapSnapshot(
  generate: () => string = () => Bun.generateHeapSnapshot("v8"),
  options: {
    /** Bytes free in `dir`; defaults to statfs. */
    freeBytes?: (dir: string) => Promise<number>;
    write?: (path: string, data: string) => Promise<void>;
  } = {},
): Promise<HeapSnapshotResult> {
  const state = diagnosticsState();
  if (state.snapshotRunning) throw new HeapSnapshotBusyError();
  state.snapshotRunning = true;
  const startedAt = new Date();
  const path = statePath(
    `diagnostics/heap-${startedAt.toISOString().replace(/[:.]/g, "-")}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.heapsnapshot`,
  );
  const dir = dirname(path);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let snapshot: string | null = generate();
    const bytes = Buffer.byteLength(snapshot);
    const freeBytes =
      options.freeBytes ??
      (async (target: string) => {
        const fs = await statfs(target);
        return fs.bavail * fs.bsize;
      });
    if ((await freeBytes(dir)) < bytes + SNAPSHOT_FREE_SPACE_MARGIN_BYTES)
      throw new Error(
        `Not enough free disk space for a ${Math.ceil(bytes / 1024 / 1024)} MB heap snapshot`,
      );
    // "wx": never follow or overwrite an existing file at that path.
    const write =
      options.write ??
      ((target: string, data: string) =>
        writeFile(target, data, { mode: 0o600, flag: "wx" }));
    const partial = `${path}${PARTIAL_SUFFIX}`;
    try {
      await write(partial, snapshot);
      snapshot = null;
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      throw error;
    }
    return {
      path,
      bytes,
      durationMs: Date.now() - startedAt.getTime(),
    };
  } finally {
    await pruneHeapSnapshots(dir).catch((error) =>
      console.warn("[memory] heap snapshot cleanup failed:", error),
    );
    state.snapshotRunning = false;
  }
}

/** Keep the newest snapshots and drop partial files a failed write left.
 *  Only this module's own `heap-*` files are touched. */
async function pruneHeapSnapshots(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names)
    if (
      name.endsWith(PARTIAL_SUFFIX) &&
      SNAPSHOT_NAME.test(name.slice(0, -PARTIAL_SUFFIX.length))
    )
      await rm(join(dir, name), { force: true });
  const files = names.filter((name) => SNAPSHOT_NAME.test(basename(name)));
  files.sort();
  for (const old of files.slice(
    0,
    Math.max(0, files.length - KEEP_HEAP_SNAPSHOTS),
  ))
    await rm(join(dir, old), { force: true });
}
