import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HeapSnapshotBusyError,
  collectionSizes,
  memoryLogLine,
  memoryReport,
  parseProcStatus,
  writeHeapSnapshot,
} from "./memory-diagnostics";
import { registerMemoryGauge } from "./memory-gauges";

describe("collectionSizes", () => {
  test("measures globalThis maps and sets plus registered gauges, largest first", () => {
    const root = {
      __watchers: new Map([
        ["s1", new Set([1, 2, 3])],
        ["s2", new Set([4])],
      ]),
      __flags: new Set(["a", "b", "c", "d"]),
      __notACollection: { size: 99 },
      notPrefixed: new Map([[1, 1]]),
      __osMemoryGauges: new Map([[1, 1]]),
    };
    const gauges = new Map<string, () => number>([
      ["module.cache", () => 2],
      [
        "module.broken",
        () => {
          throw new Error("gone");
        },
      ],
    ]);
    expect(collectionSizes(root, gauges)).toEqual([
      { name: "global.__flags", size: 4 },
      { name: "global.__watchers", size: 2, nested: 4 },
      { name: "module.cache", size: 2 },
    ]);
  });

  test("never runs a getter on globalThis", () => {
    const root = {};
    let read = false;
    Object.defineProperty(root, "__lazy", {
      enumerable: true,
      get() {
        read = true;
        return new Map();
      },
    });
    expect(collectionSizes(root, new Map())).toEqual([]);
    expect(read).toBe(false);
  });

  test("the default scan includes registered module gauges", () => {
    registerMemoryGauge("memory-diagnostics.test.fixture", () => 7);
    const sizes = collectionSizes();
    expect(sizes).toContainEqual({
      name: "memory-diagnostics.test.fixture",
      size: 7,
    });
  });
});

test("parseProcStatus converts the memory lines to bytes", () => {
  const text = [
    "Name:\topensession",
    "VmHWM:\t 6000000 kB",
    "VmRSS:\t 4300000 kB",
    "RssAnon:\t 4180000 kB",
    "RssFile:\t  110000 kB",
    "RssShmem:\t       0 kB",
    "VmSwap:\t  745000 kB",
    "Threads:\t14",
  ].join("\n");
  expect(parseProcStatus(text)).toEqual({
    VmRSS: 4300000 * 1024,
    VmHWM: 6000000 * 1024,
    RssAnon: 4180000 * 1024,
    RssFile: 110000 * 1024,
    RssShmem: 0,
    VmSwap: 745000 * 1024,
  });
});

test("memoryLogLine is one line with rss, heap and the top collections", () => {
  const mib = 1024 * 1024;
  const line = memoryLogLine(
    {
      rss: 512 * mib,
      heapUsed: 128 * mib,
      heapTotal: 256 * mib,
      external: 8 * mib,
      arrayBuffers: 4 * mib,
    },
    [
      { name: "global.__sessionWatchers", size: 12, nested: 30 },
      { name: "jsonl-parser.parseCache", size: 9 },
      { name: "pr-info.cache", size: 0 },
    ],
    7200,
  );
  expect(line).not.toContain("\n");
  expect(line).toBe(
    "[memory] rss=512.0MB heapUsed=128.0MB heapTotal=256.0MB external=8.0MB arrayBuffers=4.0MB uptime=2.0h top: global.__sessionWatchers=12/30 jsonl-parser.parseCache=9",
  );
});

test("memoryReport carries process, heap and collection figures", async () => {
  const report = await memoryReport();
  expect(report.pid).toBe(process.pid);
  expect(report.memoryUsage.rss).toBeGreaterThan(0);
  expect(report.memoryUsage.heapUsed).toBeGreaterThan(0);
  expect(report.heap?.objectCount).toBeGreaterThan(0);
  expect(report.heap?.topObjectTypes.length).toBeGreaterThan(0);
  expect(Array.isArray(report.collections)).toBe(true);
});

describe("writeHeapSnapshot", () => {
  const savedStateDir = process.env.OPENSESSION_STATE_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "os-heap-snapshot-test-"));
    process.env.OPENSESSION_STATE_DIR = dir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
    else process.env.OPENSESSION_STATE_DIR = savedStateDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes under the state dir with mode 0600", async () => {
    const result = await writeHeapSnapshot(() => '{"snapshot":{}}');
    expect(result.path.startsWith(join(dir, "diagnostics") + "/")).toBe(true);
    expect(result.path.endsWith(".heapsnapshot")).toBe(true);
    expect(result.bytes).toBe(15);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(await Bun.file(result.path).text()).toBe('{"snapshot":{}}');
  });

  test("runs one at a time", async () => {
    let generated = 0;
    const first = writeHeapSnapshot(() => {
      generated++;
      return "{}";
    });
    // The first call is still awaiting mkdir; a second one is refused.
    await expect(writeHeapSnapshot(() => "{}")).rejects.toBeInstanceOf(
      HeapSnapshotBusyError,
    );
    await first;
    expect(generated).toBe(1);
    // And the lock is released afterwards.
    await expect(writeHeapSnapshot(() => "{}")).resolves.toHaveProperty("path");
  });
});
