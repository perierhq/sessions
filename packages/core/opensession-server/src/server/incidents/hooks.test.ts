import { beforeEach, expect, test } from "bun:test";
import { incidentHookRoutes } from "./hooks";
import {
  __resetObservationsForTest,
  recentObservations,
} from "./observation-store";
import { __resetSignalRuntimeForTest } from "./signal-runtime";
import { createSignal, getSignal, updateSignal } from "./signal-store";
import { useIncidentTestKernel } from "./testing/kernel-fixture";

useIncidentTestKernel();
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
