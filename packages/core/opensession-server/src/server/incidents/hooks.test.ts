import { beforeEach, expect, spyOn, test } from "bun:test";
import { incidentHookRoutes } from "./hooks";
import {
  __resetObservationsForTest,
  flushObservations,
  recentObservations,
} from "./observation-store";
import { listIncidents } from "./incident-store";
import {
  __resetSignalRuntimeForTest,
  __setIncidentEngineForTest,
  bootSignalRuntime,
  getSignalEvaluation,
  ingestObservations,
  intakeSettled,
} from "./signal-runtime";
import { createSignal, getSignal, updateSignal } from "./signal-store";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

const kit = useIncidentTestKernel();
beforeEach(() => {
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
});

const routes = incidentHookRoutes();
const call = (method: "GET" | "POST", path: string, body?: string) => {
  const url = new URL(`https://hooks.example.test${path}`);
  return routes.get(`${method} /incident-hooks/*`)!(
    new Request(url, { method, body }),
    url,
  );
};
const make = async (input: Record<string, unknown>) => {
  const s = await createSignal(
    { name: "Hook", project: "acme", ...input },
    "Ada",
  );
  if ("error" in s) throw new Error(s.error);
  return s;
};

test("registers POST and GET intake", () => {
  expect([...routes.keys()].sort()).toEqual([
    "GET /incident-hooks/*",
    "POST /incident-hooks/*",
  ]);
});

test("webhook events become observations", async () => {
  const w = await make({ source: { kind: "webhook" } });
  const res = await call(
    "POST",
    `/incident-hooks/${w.id}/${w.hookSecret}`,
    "TypeError: x is undefined",
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(recentObservations(w.id)).toEqual([
    expect.objectContaining({
      result: "fail",
      detail: "TypeError: x is undefined",
    }),
  ]);
});

test("webhook mappings apply to the payload", async () => {
  const w = await make({
    source: {
      kind: "webhook",
      mapping: { result: { path: "$.status", ok: ["resolved"] } },
    },
  });
  await call(
    "POST",
    `/incident-hooks/${w.id}/${w.hookSecret}`,
    JSON.stringify({ status: "resolved" }),
  );
  expect(recentObservations(w.id).map((o) => o.result)).toEqual(["ok"]);
});

test("one indistinguishable 404 for every wrong door", async () => {
  const w = await make({ source: { kind: "webhook" } });
  const h = await make({
    source: { kind: "http", url: "https://acme.example.test" },
  });
  for (const [m, p] of [
    ["POST", `/incident-hooks/sig-nope/${w.hookSecret}`],
    ["POST", `/incident-hooks/${w.id}/${"0".repeat(48)}`],
    ["POST", `/incident-hooks/${w.id}/${w.hookSecret}0`],
    ["POST", `/incident-hooks/${h.id}/x`],
    ["GET", `/incident-hooks/${w.id}/${w.hookSecret}`],
    ["POST", `/incident-hooks/${w.id}/${w.hookSecret}/fail`],
  ] as const) {
    const res = await call(m, p);
    expect([res.status, await res.json()]).toEqual([
      404,
      { error: "Not found" },
    ]);
  }
  expect((await call("POST", "/incident-hooks/only-one-part")).status).toBe(
    400,
  );
  expect(
    (await call("POST", `/incident-hooks/${w.id}/${w.hookSecret}/fail/x`))
      .status,
  ).toBe(400);
  expect(recentObservations(w.id)).toEqual([]);
});

test("a signal switched away from a hook keeps its secret but takes nothing", async () => {
  const w = await make({ source: { kind: "webhook" } });
  await updateSignal(
    w.id,
    { source: { kind: "http", url: "https://acme.example.test" } },
    "Ada",
  );
  expect((await getSignal(w.id))?.hookSecret).toBe(w.hookSecret);
  const res = await call(
    "POST",
    `/incident-hooks/${w.id}/${w.hookSecret}`,
    "x",
  );
  expect([res.status, await res.json()]).toEqual([404, { error: "Not found" }]);
  expect(recentObservations(w.id)).toEqual([]);
});

test("disabled and oversized", async () => {
  const w = await make({ source: { kind: "webhook" }, enabled: false });
  expect(
    await (
      await call("POST", `/incident-hooks/${w.id}/${w.hookSecret}`, "x")
    ).json(),
  ).toEqual({ ok: false, skipped: "disabled" });
  expect(recentObservations(w.id)).toEqual([]);
  const on = await make({ source: { kind: "webhook" } });
  expect(
    (
      await call(
        "POST",
        `/incident-hooks/${on.id}/${on.hookSecret}`,
        "x".repeat(262_145),
      )
    ).status,
  ).toBe(413);
  const hb = await make({
    source: { kind: "heartbeat" },
    rule: { kind: "missing", everyMs: 3_600_000, graceMs: 0 },
  });
  expect(
    (
      await call(
        "POST",
        `/incident-hooks/${hb.id}/${hb.hookSecret}`,
        "x".repeat(10_001),
      )
    ).status,
  ).toBe(413);
  expect(recentObservations(on.id)).toEqual([]);
  expect(recentObservations(hb.id)).toEqual([]);
});

test("heartbeats check in by GET or POST, and can report failure", async () => {
  const hb = await make({
    source: { kind: "heartbeat" },
    rule: { kind: "missing", cron: "0 3 * * *", graceMs: 1_800_000 },
  });
  expect(
    (await call("GET", `/incident-hooks/${hb.id}/${hb.hookSecret}`)).status,
  ).toBe(200);
  await call(
    "POST",
    `/incident-hooks/${hb.id}/${hb.hookSecret}/fail`,
    "disk full\nmore",
  );
  await call("GET", `/incident-hooks/${hb.id}/${hb.hookSecret}/fail`);
  await call(
    "POST",
    `/incident-hooks/${hb.id}/${hb.hookSecret}`,
    "\n  backup done  \n",
  );
  expect(recentObservations(hb.id).map((o) => [o.result, o.detail])).toEqual([
    ["ok", "Checked in"],
    ["fail", "disk full"],
    ["fail", "Reported a failure"],
    ["ok", "backup done"],
  ]);
});

test("a stalled engine never holds a hook answer; evaluation keeps its order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let applied = 0;
  __setIncidentEngineForTest({
    apply: async () => {
      await gate;
      applied++;
      return [];
    },
  });
  try {
    const w = await make({
      source: { kind: "webhook" },
      rule: { kind: "consecutive", failures: 3 },
    });
    const path = `/incident-hooks/${w.id}/${w.hookSecret}`;
    for (const [i, body] of ["a", "b", "c", "d"].entries()) {
      // The third failure opens an incident: its apply never returns yet.
      const res = await Promise.race([
        call("POST", path, body),
        Bun.sleep(1_000).then(() => null),
      ]);
      expect([i, res?.status]).toEqual([i, 200]);
    }
    expect(recentObservations(w.id).map((o) => o.detail)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(applied).toBe(0);
    release();
    await intakeSettled();
    expect(applied).toBe(1);
    expect(getSignalEvaluation(w.id)).toMatchObject({
      state: "failing",
      lastObservationAt: recentObservations(w.id).at(-1)!.at,
    });
    // Evaluations run in arrival order; one that starts late reads every
    // observation recorded by then.
    const states = kit.audits
      .filter((a) => a.kind === "incident_signal_state")
      .map((a) => a.to);
    expect(states.at(-1)).toBe("failing");
    expect(states.filter((to) => to === "failing")).toHaveLength(1);
  } finally {
    __setIncidentEngineForTest(undefined);
  }
});

test("an evaluation that throws after a hook answer is logged", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const w = await make({ source: { kind: "webhook" } });
    const path = `/incident-hooks/${w.id}/${w.hookSecret}`;
    __setIncidentEngineForTest({
      decide: () => {
        throw new Error("engine down");
      },
    });
    expect((await call("POST", path, "a")).status).toBe(200);
    await intakeSettled();
    expect(error).toHaveBeenCalled();
  } finally {
    __setIncidentEngineForTest(undefined);
    error.mockRestore();
  }
});

test("a hook call during boot waits for the replay", async () => {
  const w = await make({ name: "Zz hook", source: { kind: "webhook" } });
  const now = Date.now();
  // Others restored first keep the boot replay busy while the call lands.
  for (let i = 0; i < 20; i++) {
    const other = await make({
      name: `Other ${i}`,
      source: { kind: "webhook" },
    });
    await ingestObservations(
      other.id,
      [{ at: new Date(now - 60_000).toISOString(), result: "ok", detail: "" }],
      now,
    );
  }
  for (let i = 0; i < 5; i++)
    await ingestObservations(
      w.id,
      [
        {
          at: new Date(now - 60_000 + i).toISOString(),
          result: "fail",
          detail: "",
        },
      ],
      now,
    );
  expect(getSignalEvaluation(w.id)?.state).toBe("failing");
  await flushObservations();
  const before = await listIncidents();
  expect(before).toHaveLength(1);
  kit.audits.length = 0;
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
  const boot = bootSignalRuntime();
  const res = await call(
    "POST",
    `/incident-hooks/${w.id}/${w.hookSecret}`,
    "again",
  );
  await boot;
  await intakeSettled();
  expect(res.status).toBe(200);
  expect(getSignalEvaluation(w.id)?.state).toBe("failing");
  expect(kit.audits.filter((a) => a.kind === "incident_signal_state")).toEqual(
    [],
  );
  expect(await listIncidents()).toEqual(before);
});
