/**
 * `opensession memory …`: the running gateway's memory diagnostics, read
 * through its admin API (src/server/memory-diagnostics.ts) as the local
 * operator.
 *
 *   opensession memory [--json]   process + heap figures, largest collections
 *   opensession memory snapshot   write a heap snapshot on the server box
 *                                 (`--snapshot` also works, upstream's form)
 *
 * With --json, stdout carries one JSON document: progress and errors go to
 * stderr.
 */

import type { MemoryReport } from "../../packages/core/opensession-server/src/server/memory-diagnostics";
import { localServerCall } from "./connect";
import { bold, dim, fail, heading, info, ok } from "./ui";

/** A large heap takes a while to walk and serialize. */
const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
const SHOWN_COLLECTIONS = 25;

function mb(bytes: number | undefined): string {
  return bytes === undefined ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function uptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Pure: the human-readable report. Exported for tests. */
export function formatMemoryReport(report: MemoryReport): string[] {
  const lines: string[] = [];
  const u = report.memoryUsage;
  lines.push(
    `pid ${report.pid} · up ${uptime(report.uptimeSec)} · bun ${report.bunVersion}`,
    `rss ${mb(u.rss)} · heapUsed ${mb(u.heapUsed)} · heapTotal ${mb(u.heapTotal)} · external ${mb(u.external)} · arrayBuffers ${mb(u.arrayBuffers)}`,
  );
  if (report.proc)
    lines.push(
      `proc: rssAnon ${mb(report.proc.RssAnon)} · rssFile ${mb(report.proc.RssFile)} · swap ${mb(report.proc.VmSwap)} · peak ${mb(report.proc.VmHWM)}`,
    );
  if (report.heap)
    lines.push(
      `jsc heap: size ${mb(report.heap.heapSize)} · capacity ${mb(report.heap.heapCapacity)} · extra ${mb(report.heap.extraMemorySize)} · objects ${report.heap.objectCount} · protected ${report.heap.protectedObjectCount}`,
    );
  return lines;
}

type ServerCall = typeof localServerCall;

/** Run `fn` with console.log sent to stderr (the --json progress and error
 *  lines the shared helpers print). */
async function onStderr<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = console.error;
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

export async function memory(
  positional: string[],
  options: { json: boolean; snapshot?: boolean },
  call: ServerCall = localServerCall,
): Promise<number> {
  const quiet = <T>(fn: () => Promise<T>) =>
    options.json ? onStderr(fn) : fn();
  if (positional[0] === "snapshot" || options.snapshot) {
    const result = await quiet(async () => {
      info(dim("writing a heap snapshot; the server pauses while it runs"));
      return await call(
        "/api/admin/memory/heap-snapshot",
        { method: "POST" },
        SNAPSHOT_TIMEOUT_MS,
      );
    });
    if (!result?.ok) return 1;
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    ok(`wrote ${bold(result.path)}`);
    info(
      dim(
        `  ${mb(result.bytes)} in ${result.durationMs} ms · open it in Chrome DevTools › Memory › Load`,
      ),
    );
    return 0;
  }
  if (positional[0]) {
    fail("usage: opensession memory [--json] | memory snapshot");
    return 1;
  }

  const report = (await quiet(() => call("/api/admin/memory"))) as
    | MemoryReport
    | undefined;
  if (!report) return 1;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  heading("Gateway memory");
  for (const line of formatMemoryReport(report)) info(`  ${line}`);
  heading("Largest collections");
  const nonEmpty = report.collections.filter(
    (c) => c.size > 0 || (c.nested ?? 0) > 0,
  );
  for (const c of nonEmpty.slice(0, SHOWN_COLLECTIONS))
    info(
      `  ${String(c.size).padStart(7)}${c.nested !== undefined ? dim(` /${c.nested}`) : ""}  ${c.name}`,
    );
  info(
    dim(
      `  ${report.collections.length} tracked, ${report.collections.length - nonEmpty.length} empty · --json for all`,
    ),
  );
  if (report.heap?.topObjectTypes.length) {
    heading("Most common heap objects");
    for (const t of report.heap.topObjectTypes.slice(0, 15))
      info(`  ${String(t.count).padStart(9)}  ${t.type}`);
  }
  return 0;
}
