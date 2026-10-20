import { beforeEach, expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import {
  __resetObservationsForTest,
  recentObservations,
} from "./observation-store";
import {
  __resetSchedulerForTest,
  firstRunOffsetMs,
  runSchedulerTick,
  signalNextRunAt,
} from "./scheduler";
import {
  __resetSignalRuntimeForTest,
  getSignalEvaluation,
} from "./signal-runtime";
import { createSignal, deleteSignal, updateSignal } from "./signal-store";
import type { SourceRun } from "./sources";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

useIncidentTestKernel();
let T0 = Date.now();
beforeEach(() => {
  __resetSchedulerForTest();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  // createSignal stamps real time, so the clock starts now.
  T0 = Date.now();
});

const noPrune = async () => 0;
/** Run a signal the first tick it is seen (no spread). */
const immediate = () => 0;
const okRun = (at: number): SourceRun => ({
  observations: [{ at: new Date(at).toISOString(), result: "ok", detail: "" }],
});
const httpSignal = async (over: Record<string, unknown> = {}) => {
  const s = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test" },
      ...over,
    },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  return s;
};

test("each due signal runs once per interval, locally even with runOn", async () => {
  const s = await httpSignal({ runOn: "runner-1" });
  const calls: string[] = [];
  const runSource = async (sig: Signal) => {
    calls.push(sig.id);
    return okRun(T0);
  };
  for (const t of [T0, T0 + 5_000, T0 + 60_000])
    await (
      await runSchedulerTick(t, {
        runSource,
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).settled;
  expect(calls).toEqual([s.id, s.id]);
  expect(signalNextRunAt(s.id)).toBe(new Date(T0 + 120_000).toISOString());
  expect(recentObservations(s.id)).toHaveLength(2);
  expect(getSignalEvaluation(s.id)?.state).toBe("ok");
});

test("at most four in flight; disabled never runs", async () => {
  for (let i = 0; i < 6; i++) await httpSignal({ name: `S${i}` });
  const off = await httpSignal({ name: "Off", enabled: false });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ran: string[] = [];
  const runSource = async (sig: Signal) => {
    ran.push(sig.id);
    await gate;
    return okRun(T0);
  };
  const first = await runSchedulerTick(T0, {
    runSource,
    prune: noPrune,
    firstRunOffsetMs: immediate,
  });
  expect(first.started).toHaveLength(4);
  expect(
    (
      await runSchedulerTick(T0 + 5_000, {
        runSource,
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).started,
  ).toHaveLength(0);
  release();
  await first.settled;
  expect(
    (
      await runSchedulerTick(T0 + 10_000, {
        runSource,
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).started,
  ).toHaveLength(2);
  expect(ran).not.toContain(off.id);
  expect(signalNextRunAt(off.id)).toBeUndefined();
});

test("a failing run is logged and leaves the signal due at its next time", async () => {
  const s = await httpSignal();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const runSource = async (): Promise<SourceRun> => {
      throw new Error("boom");
    };
    await (
      await runSchedulerTick(T0, {
        runSource,
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).settled;
  } finally {
    console.error = original;
  }
  expect(errors).toHaveLength(1);
  expect(signalNextRunAt(s.id)).toBe(new Date(T0 + 60_000).toISOString());
  expect(recentObservations(s.id)).toEqual([]);
});

test("a deleted signal stops being polled", async () => {
  const s = await httpSignal();
  const runSource = async () => okRun(T0);
  await (
    await runSchedulerTick(T0, {
      runSource,
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  expect(getSignalEvaluation(s.id)).not.toBeNull();
  await deleteSignal(s.id, "Ada");
  expect(
    (
      await runSchedulerTick(T0 + 60_000, {
        runSource,
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).started,
  ).toEqual([]);
  expect(signalNextRunAt(s.id)).toBeUndefined();
  expect(getSignalEvaluation(s.id)).toBeNull();
});

test("a disabled signal is forgotten and stops being polled", async () => {
  const s = await httpSignal();
  const runSource = async () => okRun(T0);
  await (
    await runSchedulerTick(T0, {
      runSource,
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  await updateSignal(s.id, { enabled: false }, "Ada");
  expect(
    (
      await runSchedulerTick(T0 + 60_000, {
        runSource,
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).started,
  ).toEqual([]);
  expect(signalNextRunAt(s.id)).toBeUndefined();
  expect(getSignalEvaluation(s.id)).toBeNull();
});

test("one synthetic observation per missed heartbeat slot", async () => {
  const hb = await createSignal(
    {
      name: "Nightly",
      project: "acme",
      source: { kind: "heartbeat" },
      rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
    },
    "Ada",
  );
  if ("error" in hb) throw new Error(hb.error);
  // Slots count from creation; anchor the clock there so both ticks below
  // fall inside the same slot.
  const C = Date.parse(hb.createdAt);
  const missed = () =>
    recentObservations(hb.id).filter((o) => o.detail === "Missed check-in");
  await (
    await runSchedulerTick(C + 7_200_000, {
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  await (
    await runSchedulerTick(C + 7_240_000, {
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  expect(missed().map((o) => o.at)).toEqual([
    new Date(C + 7_200_000).toISOString(),
  ]);
  // The next slot gets its own observation.
  await (
    await runSchedulerTick(C + 10_800_000, {
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  expect(missed()).toHaveLength(2);
  expect(getSignalEvaluation(hb.id)?.state).toBe("failing");
});

test("time rules run every 30 seconds, not every tick", async () => {
  const s = await httpSignal();
  const runSource = async () => okRun(T0);
  await (
    await runSchedulerTick(T0, {
      runSource,
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  const first = getSignalEvaluation(s.id);
  // No run is due and no time pass is due: the evaluation is untouched.
  await (
    await runSchedulerTick(T0 + 5_000, {
      prune: noPrune,
      firstRunOffsetMs: immediate,
    })
  ).settled;
  expect(getSignalEvaluation(s.id)).toBe(first);
  // Ten minutes without an observation (the due run fails): the time pass
  // marks it stale.
  const original = console.error;
  console.error = () => {};
  try {
    await (
      await runSchedulerTick(T0 + 600_000, {
        runSource: async () => {
          throw new Error("unreachable");
        },
        prune: noPrune,
        firstRunOffsetMs: immediate,
      })
    ).settled;
  } finally {
    console.error = original;
  }
  expect(getSignalEvaluation(s.id)?.state).toBe("unknown");
});

test("prune runs on the first tick and then daily", async () => {
  let pruned = 0;
  const prune = async () => {
    pruned++;
    return 0;
  };
  for (const t of [T0, T0 + 60_000, T0 + 86_400_000])
    await (
      await runSchedulerTick(t, { prune, firstRunOffsetMs: immediate })
    ).settled;
  expect(pruned).toBe(2);
});

test("first runs spread over the interval by a stable offset per signal", async () => {
  const fast = await httpSignal({ intervalMs: 30_000 });
  const slow = await httpSignal({ name: "Slow", intervalMs: 600_000 });
  const ran: string[] = [];
  const runSource = async (sig: Signal) => {
    ran.push(sig.id);
    return okRun(T0);
  };
  const fastAt = T0 + firstRunOffsetMs(fast.id, 30_000);
  const slowAt = T0 + firstRunOffsetMs(slow.id, 600_000);
  await (
    await runSchedulerTick(T0, { runSource, prune: noPrune })
  ).settled;
  expect(signalNextRunAt(fast.id)).toBe(
    new Date(fastAt === T0 ? T0 + 30_000 : fastAt).toISOString(),
  );
  expect(signalNextRunAt(slow.id)).toBe(
    new Date(slowAt === T0 ? T0 + 600_000 : slowAt).toISOString(),
  );
  await (
    await runSchedulerTick(Math.max(fastAt, slowAt), {
      runSource,
      prune: noPrune,
    })
  ).settled;
  expect(ran.sort()).toEqual([fast.id, slow.id].sort());
  // Stable, inside min(interval, 60 s), and not the same for every signal.
  const ids = Array.from({ length: 20 }, (_, i) => `sig-${i}`);
  for (const id of ids) {
    expect(firstRunOffsetMs(id, 600_000)).toBe(firstRunOffsetMs(id, 600_000));
    expect(firstRunOffsetMs(id, 600_000)).toBeLessThan(60_000);
    expect(firstRunOffsetMs(id, 10_000)).toBeLessThan(10_000);
  }
  expect(
    new Set(ids.map((id) => firstRunOffsetMs(id, 60_000))).size,
  ).toBeGreaterThan(10);
});
