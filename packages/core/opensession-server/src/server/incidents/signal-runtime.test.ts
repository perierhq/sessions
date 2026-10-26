import { beforeEach, expect, spyOn, test } from "bun:test";
import { decideIncidentOps } from "./engine";
import { listIncidents, updateIncident } from "./incident-store";
import { transitionIncident } from "./lifecycle";
import {
  __resetObservationsForTest,
  appendObservations,
  flushObservations,
  recentObservations,
} from "./observation-store";
import {
  __resetSignalRuntimeForTest,
  __setIncidentEngineForTest,
  allSignalEvaluations,
  bootSignalRuntime,
  forgetSignal,
  getSignalEvaluation,
  ingestObservations,
  onSignalStateChange,
  reevaluateSignal,
} from "./signal-runtime";
import { __setOwnerRosterForTest } from "./owner";
import {
  __setProjectSettingsContextForTest,
  patchProjectSettings,
} from "./response/project-settings";
import { createSignal, getSignal, updateSignal } from "./signal-store";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const kit = useIncidentTestKernel();
beforeEach(() => {
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
});
const T0 = Date.parse("2026-10-20T10:00:00Z");
let clock = T0;
const make = async (over: Record<string, unknown> = {}) => {
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
const feed = async (id: string, ...results: Array<"ok" | "fail">) => {
  for (const result of results) {
    clock += 60_000;
    await ingestObservations(
      id,
      [{ at: new Date(clock).toISOString(), result, detail: "" }],
      clock,
    );
  }
};
beforeEach(() => {
  clock = T0;
});

test("three failures open one incident owned by the signal's creator", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail");
  expect(await listIncidents()).toEqual([]);
  await feed(s.id, "fail");
  expect(await listIncidents()).toEqual([
    expect.objectContaining({
      state: "investigating",
      owner: "Ada",
      signalIds: [s.id],
    }),
  ]);
  const states = kit.audits.filter((a) => a.kind === "incident_signal_state");
  expect(states.map((a) => a.to)).toEqual(["ok", "failing"]);
  expect(states[0]).toMatchObject({ signalId: s.id, from: null, to: "ok" });
  expect(states[1]).toMatchObject({
    from: "ok",
    to: "failing",
    reason: expect.any(String),
  });
  expect(getSignalEvaluation(s.id)?.state).toBe("failing");
  expect(allSignalEvaluations().get(s.id)?.state).toBe("failing");
});

test("a signal the automation principal made opens incidents a person owns", async () => {
  __setOwnerRosterForTest([{ name: "Ada Lovelace" }, { name: "Bo Diddley" }]);
  try {
    const s = await createSignal(
      {
        name: "Search",
        project: "acme",
        source: { kind: "http", url: "https://acme.example.test" },
      },
      "Automation",
      { automation: true },
    );
    if ("error" in s) throw new Error(s.error);
    // Stored before signals had owners: only the creator is on record.
    const { owner: _owner, ...legacy } = s;
    const stored = kit.store().catalogDocumentGet("incident-signals", s.id);
    const put = kit.store().putCatalogDocument({
      op: "put",
      namespace: "incident-signals",
      key: s.id,
      expectedRev: stored?.rev ?? null,
      value: JSON.stringify(legacy),
      requestId: crypto.randomUUID(),
    });
    if (put.status !== "committed") throw new Error(put.status);
    expect((await getSignal(s.id))?.owner).toBeUndefined();
    await feed(s.id, "fail", "fail", "fail");
    expect(await listIncidents()).toEqual([
      expect.objectContaining({ owner: "Ada", signalIds: [s.id] }),
    ]);
  } finally {
    __setOwnerRosterForTest(undefined);
  }
});

test("a second failing signal in the project joins the same incident", async () => {
  const a = await make();
  const b = await make({ name: "Api" });
  await feed(a.id, "fail", "fail", "fail");
  await feed(b.id, "fail", "fail", "fail");
  const all = await listIncidents();
  expect(all).toHaveLength(1);
  expect(all[0]!.signalIds).toEqual([a.id, b.id]);
});

test("a signal failing for 30+ minutes still takes a new failure in", async () => {
  const a = await make();
  const b = await make({ name: "Api" });
  await feed(a.id, "fail", "fail", "fail");
  // Still failing: no state change, so no new report on the incident.
  await feed(a.id, ...Array<"fail">(35).fill("fail"));
  await feed(b.id, "fail", "fail", "fail");
  const all = await listIncidents();
  expect(all).toHaveLength(1);
  expect(all[0]!.signalIds).toEqual([a.id, b.id]);
});

test("flapping never opens a second incident", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "ok", "ok", "fail", "fail", "fail");
  expect(await listIncidents()).toHaveLength(1);
});

test("a heads-up closes on recovery and stays closed while it flaps", async () => {
  const s = await make();
  await feed(s.id, "ok", "fail", "ok", "fail", "ok", "fail");
  expect((await listIncidents())[0]!.state).toBe("heads-up");
  await feed(s.id, ...Array<"ok">(10).fill("ok"));
  expect((await listIncidents())[0]!.state).toBe("closed-without-action");
  await feed(s.id, "fail", "ok", "fail", "ok", "fail");
  expect(getSignalEvaluation(s.id)?.state).toBe("flaky");
  const all = await listIncidents();
  expect(all).toHaveLength(1);
  expect(all[0]!.state).toBe("closed-without-action");
});

const closeByHand = async (id: string) => {
  const closed = await updateIncident(id, (c) =>
    transitionIncident(c, "closed-without-action", {
      by: "Ada",
      detail: "Closed by Ada",
      at: new Date(clock).toISOString(),
    }),
  );
  if (!closed || "error" in closed) throw new Error("close failed");
  return closed;
};

test("a project that pauses new incidents opens none; resumed, it does", async () => {
  __setProjectSettingsContextForTest({
    projectExists: (id) => id === "acme",
    runnerProblem: () => null,
    modelProblem: () => null,
  });
  try {
    await patchProjectSettings("acme", (s) => ({
      ...s,
      incidentsPaused: true,
    }));
    const s = await make();
    await feed(s.id, "fail", "fail", "fail", "fail");
    expect(getSignalEvaluation(s.id)?.state).toBe("failing");
    expect(await listIncidents()).toEqual([]);
    await patchProjectSettings("acme", (s) => ({
      ...s,
      incidentsPaused: false,
    }));
    await feed(s.id, "ok", "ok", "fail", "fail", "fail");
    expect(await listIncidents()).toHaveLength(1);
  } finally {
    __setProjectSettingsContextForTest(undefined);
  }
});

test("closed without action, a flapping signal reopens and opens nothing", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "ok", "ok");
  const [open] = await listIncidents();
  await closeByHand(open!.id);
  // 50 minutes of three failures, two passes: past the reopen window.
  for (let i = 0; i < 10; i++)
    await feed(s.id, "fail", "fail", "fail", "ok", "ok");
  const all = await listIncidents();
  expect(all).toHaveLength(1);
  expect(all[0]!.state).toBe("closed-without-action");
  expect(all[0]!.events.filter((e) => e.kind === "reopened")).toEqual([]);
  // Each flap it stayed closed through is counted, once.
  expect(all[0]!.quiet?.flaps).toBe(10);
});

test("after a close, a new problem reopens once it stays failing", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "ok", "ok");
  const [open] = await listIncidents();
  await closeByHand(open!.id);
  // Healthy a quarter of an hour, then failing.
  await feed(s.id, ...Array<"ok">(15).fill("ok"));
  await feed(s.id, "fail", "fail", "fail");
  expect(getSignalEvaluation(s.id)?.state).toBe("failing");
  // Still failing, not yet long enough: no change, nothing reopened.
  await feed(s.id, ...Array<"fail">(9).fill("fail"));
  expect((await listIncidents())[0]!.state).toBe("closed-without-action");
  await feed(s.id, "fail");
  const all = await listIncidents();
  expect(all).toHaveLength(1);
  expect(all[0]!.state).toBe("investigating");
  expect(all[0]!.events.at(-1)).toMatchObject({ kind: "reopened" });
});

test("after a close, failing for an hour reopens even after a flap", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "ok", "ok");
  const [open] = await listIncidents();
  await closeByHand(open!.id);
  await feed(s.id, "fail", "fail", "fail");
  await feed(s.id, ...Array<"fail">(59).fill("fail"));
  expect((await listIncidents())[0]!.state).toBe("closed-without-action");
  await feed(s.id, "fail");
  expect((await listIncidents())[0]!.state).toBe("investigating");
});

test("no duplicate and no new events after a restart", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "ok");
  await flushObservations();
  const before = await listIncidents();
  kit.audits.length = 0;
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  await bootSignalRuntime(clock);
  expect(getSignalEvaluation(s.id)?.state).toBe("failing");
  expect(await listIncidents()).toEqual(before);
  // Boot takes states back without auditing them as changes.
  expect(kit.audits).toEqual([]);
});

test("an observation arriving during boot waits for the replay", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail");
  await flushObservations();
  const before = await listIncidents();
  kit.audits.length = 0;
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  const boot = bootSignalRuntime(clock);
  clock += 60_000;
  const during = ingestObservations(
    s.id,
    [{ at: new Date(clock).toISOString(), result: "ok", detail: "" }],
    clock,
  );
  const direct = reevaluateSignal(s, clock);
  await Promise.all([boot, during, direct]);
  // The ingest saw the replayed `failing` as its previous state: one ok is
  // not a recovery, nothing is audited as a change from nothing, and boot
  // did not overwrite the newer evaluation.
  expect(getSignalEvaluation(s.id)).toMatchObject({
    state: "failing",
    lastObservationAt: new Date(clock).toISOString(),
  });
  expect(kit.audits.filter((a) => a.kind === "incident_signal_state")).toEqual(
    [],
  );
  expect(await listIncidents()).toEqual(before);
});

test("boot opens an incident for a signal that went bad while nothing covered it", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail");
  // Written by an earlier process: the third failure never reached the engine.
  clock += 60_000;
  appendObservations(s.id, [
    { at: new Date(clock).toISOString(), result: "fail", detail: "" },
  ]);
  await flushObservations();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  await bootSignalRuntime(clock);
  expect(await listIncidents()).toEqual([
    expect.objectContaining({ state: "investigating", signalIds: [s.id] }),
  ]);
});

test("a provider back from a long restart resolves its finding", async () => {
  const p = await make({ name: "Status", provider: true });
  const a = await make();
  await feed(p.id, "fail", "fail", "fail");
  await feed(a.id, "fail", "fail", "fail");
  expect((await listIncidents())[0]).toMatchObject({
    state: "waiting-on-provider",
    signalIds: [a.id, p.id],
  });
  await flushObservations();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  // Down for longer than three intervals: the provider replays unknown.
  clock += 600_000;
  await bootSignalRuntime(clock);
  expect(getSignalEvaluation(p.id)?.state).toBe("unknown");
  await feed(p.id, "ok");
  expect(getSignalEvaluation(p.id)?.state).toBe("ok");
  const [incident] = await listIncidents();
  expect(incident!.state).toBe("investigating");
  expect(incident!.findings).toEqual([
    expect.objectContaining({
      kind: "external",
      signalId: p.id,
      resolvedAt: expect.any(String),
    }),
  ]);
});

test("boot does not reopen an incident closed while the signal was failing", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "fail");
  const [open] = await listIncidents();
  const closed = await updateIncident(open!.id, (c) =>
    transitionIncident(c, "resolved", {
      by: "Ada",
      detail: "Known, fixed upstream",
      at: new Date(clock).toISOString(),
    }),
  );
  if (!closed || "error" in closed) throw new Error("close failed");
  await feed(s.id, "fail");
  await flushObservations();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  await bootSignalRuntime(clock);
  expect(getSignalEvaluation(s.id)?.state).toBe("failing");
  expect(await listIncidents()).toEqual([closed]);
});

test("boot long after a close during a failing run opens no duplicate", async () => {
  const s = await make();
  await feed(s.id, "fail", "fail", "fail", "fail");
  const [open] = await listIncidents();
  const closed = await updateIncident(open!.id, (c) =>
    transitionIncident(c, "resolved", {
      by: "Ada",
      detail: "Known, fixed upstream",
      at: new Date(clock).toISOString(),
    }),
  );
  if (!closed || "error" in closed) throw new Error("close failed");
  // Still failing 45 minutes on: past the reopen window.
  await feed(s.id, ...Array<"fail">(45).fill("fail"));
  expect(await listIncidents()).toEqual([closed]);
  await flushObservations();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  kit.audits.length = 0;
  await bootSignalRuntime(clock);
  expect(getSignalEvaluation(s.id)?.state).toBe("failing");
  expect(await listIncidents()).toEqual([closed]);
  expect(kit.audits).toEqual([]);
});

test("boot restores every evaluation before the engine runs", async () => {
  const a = await make();
  const p = await make({ name: "Status", provider: true });
  await feed(p.id, "fail", "fail", "fail");
  await feed(a.id, "fail", "fail");
  // Written by an earlier process: the third failure never reached the engine.
  clock += 60_000;
  appendObservations(a.id, [
    { at: new Date(clock).toISOString(), result: "fail", detail: "" },
  ]);
  await flushObservations();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  await bootSignalRuntime(clock);
  // `a` is listed before the provider, and still sees it external.
  expect(await listIncidents()).toEqual([
    expect.objectContaining({
      state: "waiting-on-provider",
      signalIds: [a.id, p.id],
      resumeState: "investigating",
    }),
  ]);
});

test("related signals in two projects failing at once open one incident", async () => {
  const a = await make();
  const c = await make({ name: "Api", project: "acme-api", dependsOn: [a.id] });
  await feed(a.id, "fail", "fail");
  await feed(c.id, "fail", "fail");
  clock += 60_000;
  const at = new Date(clock).toISOString();
  await Promise.all(
    [a.id, c.id].map((id) =>
      ingestObservations(id, [{ at, result: "fail", detail: "" }], clock),
    ),
  );
  const all = await listIncidents();
  expect(all).toHaveLength(1);
  expect([...all[0]!.signalIds].sort()).toEqual([a.id, c.id].sort());
});

test("a change the engine failed on is replayed by the next observation", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  let down = true;
  let calls = 0;
  __setIncidentEngineForTest({
    decide: (...args) => {
      calls++;
      if (down) throw new Error("engine down");
      return decideIncidentOps(...args);
    },
  });
  try {
    const s = await make();
    await feed(s.id, "fail", "fail");
    down = false;
    await feed(s.id, "fail");
    // Each failed change was undone, so the next observation made it again.
    expect(await listIncidents()).toEqual([
      expect.objectContaining({ state: "investigating", signalIds: [s.id] }),
    ]);
    // A retried change is audited once, when it first happened.
    const states = () =>
      kit.audits
        .filter((a) => a.kind === "incident_signal_state")
        .map((a) => [a.from, a.to]);
    expect(states()).toEqual([
      [null, "ok"],
      ["ok", "failing"],
    ]);
    // A failed recovery leaves the earlier evaluation in place.
    down = true;
    calls = 0;
    await feed(s.id, "ok", "ok", "ok");
    expect(calls).toBeGreaterThan(0);
    expect(getSignalEvaluation(s.id)?.state).toBe("failing");
    down = false;
    await feed(s.id, "ok");
    expect(getSignalEvaluation(s.id)?.state).toBe("ok");
    expect(states()).toEqual([
      [null, "ok"],
      ["ok", "failing"],
      ["failing", "ok"],
    ]);
    expect((await listIncidents())[0]!.events.at(-1)).toMatchObject({
      kind: "signal-state",
      signalState: "ok",
    });
    expect(error).toHaveBeenCalled();
  } finally {
    __setIncidentEngineForTest(undefined);
    error.mockRestore();
  }
});

test("disabled and deleted signals take no observations", async () => {
  const s = await make({ enabled: false });
  expect(
    await ingestObservations(
      s.id,
      [{ at: new Date(clock).toISOString(), result: "fail", detail: "" }],
      clock,
    ),
  ).toBeNull();
  expect(recentObservations(s.id)).toEqual([]);
  expect(await ingestObservations("sig-missing", [], clock)).toBeNull();
});

test("disabling a signal forgets its evaluation", async () => {
  const s = await make();
  await feed(s.id, "ok");
  expect(getSignalEvaluation(s.id)).not.toBeNull();
  const off = await updateSignal(s.id, { enabled: false }, "Ada");
  if (!off || "error" in off) throw new Error("update failed");
  expect(await reevaluateSignal(off, clock)).toBeNull();
  expect(getSignalEvaluation(s.id)).toBeNull();
  await feed(s.id, "ok");
  forgetSignal(s.id);
  expect(getSignalEvaluation(s.id)).toBeNull();
});

test("a disabled signal does not hold a heads-up open", async () => {
  const a = await make();
  const b = await make({ name: "Api" });
  await feed(b.id, "ok", "fail", "ok", "fail", "ok", "fail");
  await feed(a.id, "ok", "fail", "ok", "fail", "ok", "fail");
  expect((await listIncidents())[0]).toMatchObject({
    state: "heads-up",
    signalIds: [b.id, a.id],
  });
  const off = await updateSignal(b.id, { enabled: false }, "Ada");
  if (!off || "error" in off) throw new Error("update failed");
  await reevaluateSignal(off, clock);
  await feed(a.id, ...Array<"ok">(10).fill("ok"));
  expect((await listIncidents())[0]!.state).toBe("closed-without-action");
});

test("a listener cannot change the evaluation it is told", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const seen: string[] = [];
  const offA = onSignalStateChange((_s, cur, prev) => {
    (cur as { state: string }).state = "ok";
    if (prev) (prev as { reason: string }).reason = "changed";
  });
  const offB = onSignalStateChange((_s, cur, prev) =>
    seen.push(`${prev?.reason ?? "-"}>${cur.state}`),
  );
  const s = await make();
  await feed(s.id, "ok");
  await Bun.sleep(0);
  const ok = getSignalEvaluation(s.id)!;
  await feed(s.id, "fail", "fail", "fail");
  await Bun.sleep(0);
  offA();
  offB();
  warn.mockRestore();
  expect(seen).toEqual([`->ok`, `${ok.reason}>failing`]);
  expect(getSignalEvaluation(s.id)?.state).toBe("failing");
  expect(ok.reason).not.toBe("changed");
});

test("state listeners hear each change once, not each observation", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const seen: string[] = [];
  const off = onSignalStateChange((s, cur, prev) =>
    seen.push(`${s.id}:${prev?.state ?? "-"}>${cur.state}`),
  );
  onSignalStateChange(() => {
    throw new Error("boom");
  });
  const s = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://acme.example.test" },
    },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  let t = Date.parse("2026-10-20T10:00:00Z");
  for (const result of ["ok", "fail", "fail", "fail", "fail"] as const) {
    t += 60_000;
    await ingestObservations(
      s.id,
      [{ at: new Date(t).toISOString(), result, detail: "x" }],
      t,
    );
  }
  await Bun.sleep(0);
  expect(seen).toEqual([`${s.id}:->ok`, `${s.id}:ok>failing`]);
  expect(warn).toHaveBeenCalled();
  off();
  t += 60_000;
  await ingestObservations(
    s.id,
    [{ at: new Date(t).toISOString(), result: "ok", detail: "x" }],
    t,
  );
  t += 60_000;
  await ingestObservations(
    s.id,
    [{ at: new Date(t).toISOString(), result: "ok", detail: "x" }],
    t,
  );
  await Bun.sleep(0);
  expect(seen).toHaveLength(2);
  warn.mockRestore();
});

test("the boot replay tells no state listener", async () => {
  const s = await make();
  appendObservations(s.id, [
    { at: new Date(T0 + 60_000).toISOString(), result: "fail", detail: "" },
  ]);
  await flushObservations();
  __resetSignalRuntimeForTest();
  const seen: string[] = [];
  onSignalStateChange((signal, cur) => seen.push(`${signal.id}:${cur.state}`));
  await bootSignalRuntime(T0 + 120_000);
  await Bun.sleep(0);
  expect(getSignalEvaluation(s.id)).not.toBeNull();
  expect(seen).toEqual([]);
});
