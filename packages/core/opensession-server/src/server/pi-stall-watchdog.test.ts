import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PiStallWatchdog,
  PI_STALL_STEER_MINUTES,
  PI_STALL_STOP_MINUTES,
  readPiStallConfig,
  type PiStallTimers,
} from "./pi-stall-watchdog";

/** Timers that only move when the test says so. */
function manualClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: PiStallTimers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => {
      pending.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    while (true) {
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { timers, advance, armed: () => pending.size };
}

const MIN = 60_000;

function watchdog(clock = manualClock()) {
  const steers: string[] = [];
  const stops: string[] = [];
  const dog = new PiStallWatchdog({
    steerAfterMs: 10 * MIN,
    stopAfterMs: 5 * MIN,
    onSteer: (note) => steers.push(note),
    onStop: (reason) => stops.push(reason),
    timers: clock.timers,
  });
  return { dog, clock, steers, stops };
}

describe("PiStallWatchdog", () => {
  test("steers after N quiet minutes, then stops M minutes later with a reason", () => {
    const { dog, clock, steers, stops } = watchdog();
    dog.start();
    clock.advance(10 * MIN - 1);
    expect(steers).toEqual([]);
    clock.advance(1);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("10 minutes");
    clock.advance(5 * MIN - 1);
    expect(stops).toEqual([]);
    clock.advance(1);
    expect(stops).toHaveLength(1);
    expect(dog.stopReason).toBe(stops[0]);
    expect(stops[0]).toContain("15 minutes");
    // Nothing fires twice.
    clock.advance(60 * MIN);
    expect(steers).toHaveLength(1);
    expect(stops).toHaveLength(1);
  });

  test("any event starts the quiet period again, also after the steer", () => {
    const { dog, clock, steers, stops } = watchdog();
    dog.start();
    clock.advance(9 * MIN);
    dog.observe({ type: "message_update" });
    clock.advance(9 * MIN);
    expect(steers).toEqual([]);
    clock.advance(1 * MIN);
    expect(steers).toHaveLength(1);
    clock.advance(4 * MIN);
    dog.observe({ type: "message_update" });
    clock.advance(9 * MIN);
    expect(stops).toEqual([]);
    expect(dog.stopReason).toBeUndefined();
  });

  test("never fires while a tool call runs, however long it is quiet", () => {
    const { dog, clock, steers, stops } = watchdog();
    dog.start();
    dog.observe({ type: "tool_execution_start", toolCallId: "t1" });
    dog.observe({ type: "tool_execution_start", toolCallId: "t2" });
    clock.advance(120 * MIN);
    dog.observe({ type: "tool_execution_end", toolCallId: "t1" });
    clock.advance(120 * MIN);
    expect(steers).toEqual([]);
    dog.observe({ type: "tool_execution_end", toolCallId: "t2" });
    clock.advance(10 * MIN);
    expect(steers).toHaveLength(1);
    // A tool that starts after the steer holds off the stop as well.
    dog.observe({ type: "tool_execution_start", toolCallId: "t3" });
    clock.advance(60 * MIN);
    expect(stops).toEqual([]);
  });

  test("dispose cancels whatever is armed", () => {
    const { dog, clock, steers } = watchdog();
    dog.start();
    dog.dispose();
    expect(clock.armed()).toBe(0);
    clock.advance(60 * MIN);
    dog.observe({ type: "message_update" });
    clock.advance(60 * MIN);
    expect(steers).toEqual([]);
  });
});

describe("readPiStallConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const config = (body: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-stall-"));
    dirs.push(dir);
    const path = join(dir, "pi.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  test("defaults to 10 then 5 minutes", () => {
    expect(PI_STALL_STEER_MINUTES).toBe(10);
    expect(PI_STALL_STOP_MINUTES).toBe(5);
    expect(readPiStallConfig(config({ enabled: true }))).toEqual({
      steerAfterMs: 10 * MIN,
      stopAfterMs: 5 * MIN,
    });
    expect(readPiStallConfig(join(tmpdir(), "missing-pi-stall.json"))).toEqual({
      steerAfterMs: 10 * MIN,
      stopAfterMs: 5 * MIN,
    });
  });

  test("reads both from pi.json, and 0 turns the watchdog off", () => {
    expect(
      readPiStallConfig(
        config({ enabled: true, stallSteerMinutes: 20, stallStopMinutes: 2 }),
      ),
    ).toEqual({ steerAfterMs: 20 * MIN, stopAfterMs: 2 * MIN });
    expect(
      readPiStallConfig(config({ enabled: true, stallSteerMinutes: 0 })),
    ).toBeNull();
    // Nonsense falls back to the defaults.
    expect(
      readPiStallConfig(
        config({ stallSteerMinutes: "ten", stallStopMinutes: -1 }),
      ),
    ).toEqual({ steerAfterMs: 10 * MIN, stopAfterMs: 5 * MIN });
  });
});
