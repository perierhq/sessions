import { beforeEach, expect, test } from "bun:test";
import type { Signal } from "../../shared/incidents";
import {
  __resetObservationsForTest,
  recentObservations,
} from "./observation-store";
import {
  __resetSchedulerForTest,
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
      await runSchedulerTick(t, { runSource, prune: noPrune })
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
  const first = await runSchedulerTick(T0, { runSource, prune: noPrune });
  expect(first.started).toHaveLength(4);
  expect(
    (await runSchedulerTick(T0 + 5_000, { runSource, prune: noPrune })).started,
  ).toHaveLength(0);
  release();
  await first.settled;
  expect(
    (await runSchedulerTick(T0 + 10_000, { runSource, prune: noPrune }))
      .started,
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
      await runSchedulerTick(T0, { runSource, prune: noPrune })
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
    await runSchedulerTick(T0, { runSource, prune: noPrune })
  ).settled;
  expect(getSignalEvaluation(s.id)).not.toBeNull();
  await deleteSignal(s.id, "Ada");
  expect(
    (await runSchedulerTick(T0 + 60_000, { runSource, prune: noPrune }))
      .started,
  ).toEqual([]);
  expect(signalNextRunAt(s.id)).toBeUndefined();
  expect(getSignalEvaluation(s.id)).toBeNull();
});

test("a disabled signal is forgotten and stops being polled", async () => {
  const s = await httpSignal();
  const runSource = async () => okRun(T0);
  await (
    await runSchedulerTick(T0, { runSource, prune: noPrune })
  ).settled;
  await updateSignal(s.id, { enabled: false }, "Ada");
  expect(
    (await runSchedulerTick(T0 + 60_000, { runSource, prune: noPrune }))
      .started,
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
  await (
    await runSchedulerTick(T0 + 7_200_000, { prune: noPrune })
  ).settled;
  await (
    await runSchedulerTick(T0 + 7_240_000, { prune: noPrune })
  ).settled;
  expect(
    recentObservations(hb.id).filter((o) => o.detail === "Missed check-in"),
  ).toHaveLength(1);
  expect(getSignalEvaluation(hb.id)?.state).toBe("failing");
});

test("time rules run every 30 seconds, not every tick", async () => {
  const s = await httpSignal();
  const runSource = async () => okRun(T0);
  await (
    await runSchedulerTick(T0, { runSource, prune: noPrune })
  ).settled;
  const first = getSignalEvaluation(s.id);
  // No run is due and no time pass is due: the evaluation is untouched.
  await (
    await runSchedulerTick(T0 + 5_000, { prune: noPrune })
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
      await runSchedulerTick(t, { prune })
    ).settled;
  expect(pruned).toBe(2);
});
