import { beforeEach, expect, test } from "bun:test";
import type {
  IncidentSummary,
  Observation,
  ObservationResult,
  StripBar,
} from "../../shared/incidents";
import {
  type NewIncident,
  createIncident,
  updateIncident,
} from "../incidents/incident-store";
import { transitionIncident } from "../incidents/lifecycle";
import {
  __resetObservationsForTest,
  appendObservations,
  flushObservations,
} from "../incidents/observation-store";
import { __resetSchedulerForTest } from "../incidents/scheduler";
import { __resetSignalRuntimeForTest } from "../incidents/signal-runtime";
import {
  createSignal,
  deleteSignal,
  getSignal,
  listSignals,
  setSignalRunOnCheck,
} from "../incidents/signal-store";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import {
  MAX_CONCURRENT_TEST_RUNS,
  __setTestRunSourceForTest,
  handleIncidentsRoutes,
} from "./incidents";
import { routeHandlers } from "./index";

const kit = useIncidentTestKernel();
beforeEach(() => {
  __resetSchedulerForTest();
  __resetSignalRuntimeForTest();
  __resetObservationsForTest();
});

const call = async (method: string, path: string, body?: unknown) => {
  const url = new URL(`http://localhost${path}`);
  const res = await handleIncidentsRoutes({
    req: new Request(url, {
      method,
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: { login: "ada", name: "Ada Lovelace" },
  });
  return res ? { status: res.status, json: await res.json() } : undefined;
};
const httpBody = {
  name: "Search",
  project: "acme",
  source: {
    kind: "http",
    url: "https://acme.example.test/health?api_key=k3y",
    headers: { Authorization: "Bearer s3cret" },
  },
};

test("create, read, list: redacted and attributed", async () => {
  const created = await call("POST", "/api/incident-signals", httpBody);
  expect(created?.status).toBe(200);
  expect(created?.json).toMatchObject({
    createdBy: "Ada",
    evaluation: null,
    source: { headers: { Authorization: "[redacted]" } },
  });
  const hook = await call("POST", "/api/incident-signals", {
    name: "Errors",
    project: "acme",
    source: { kind: "webhook" },
  });
  expect(hook?.json.hookPath).toMatch(
    /^\/incident-hooks\/sig-[^/]+\/[0-9a-f]{48}$/,
  );
  expect(hook?.json).not.toHaveProperty("hookSecret");
  const one = await call("GET", `/api/incident-signals/${created?.json.id}`);
  expect(one?.json).toMatchObject({ id: created?.json.id, evaluation: null });
  const list = await call("GET", "/api/incident-signals");
  expect(list?.json.signals).toHaveLength(2);
  const text = JSON.stringify([created, one, list]);
  expect(text).not.toContain("s3cret");
  expect(text).not.toContain("k3y");
  for (const audit of kit.audits) {
    expect(JSON.stringify(audit)).not.toContain("s3cret");
    expect(JSON.stringify(audit)).not.toContain("k3y");
  }
});

test("validation errors and attribution without sign-in", async () => {
  expect(
    (await call("POST", "/api/incident-signals", { ...httpBody, project: "x" }))
      ?.status,
  ).toBe(400);
  const url = new URL("http://localhost/api/incident-signals");
  const res = await handleIncidentsRoutes({
    req: new Request(url, {
      method: "POST",
      body: JSON.stringify({ ...httpBody, user: "Grace" }),
    }),
    url,
    path: url.pathname,
    publicPrefix: "/backstage",
    authUser: null,
  });
  // A claimed name is never taken: without sign-in the author is anonymous.
  expect((await res!.json()).createdBy).toBe("Anonymous");
  expect((await call("POST", "/api/incident-signals", "[1, 2]"))?.json).toEqual(
    { error: "Body must be a JSON object" },
  );
});

test("update keeps redacted headers; errors and deletes", async () => {
  const { json } = (await call("POST", "/api/incident-signals", httpBody))!;
  const put = await call("PUT", `/api/incident-signals/${json.id}`, {
    ...httpBody,
    name: "Search API",
    source: {
      ...httpBody.source,
      url: "https://acme.example.test/health?api_key=[redacted]",
      headers: { Authorization: "[redacted]" },
    },
  });
  expect(put?.status).toBe(200);
  expect(put?.json.name).toBe("Search API");
  const stored = await getSignal(json.id);
  expect(stored?.source.kind === "http" && stored.source.headers).toEqual({
    Authorization: "Bearer s3cret",
  });
  expect(stored?.source.kind === "http" && stored.source.url).toBe(
    "https://acme.example.test/health?api_key=k3y",
  );
  expect(
    (
      await call("PUT", `/api/incident-signals/${json.id}`, {
        rule: { kind: "deadline", warnDays: 1, failDays: 3 },
      })
    )?.status,
  ).toBe(400);
  expect(
    (await call("PUT", "/api/incident-signals/sig-missing", { name: "X" }))
      ?.status,
  ).toBe(404);
  expect(
    (await call("POST", "/api/incident-signals", "{not json"))?.json,
  ).toEqual({ error: "Invalid JSON" });
  expect(
    (await call("DELETE", `/api/incident-signals/${json.id}`))?.json,
  ).toEqual({ ok: true });
  expect((await call("GET", `/api/incident-signals/${json.id}`))?.status).toBe(
    404,
  );
  expect(
    (await call("DELETE", `/api/incident-signals/${json.id}`))?.status,
  ).toBe(404);
});

test("test run previews without storing", async () => {
  const w = await call("POST", "/api/incident-signals/test", {
    source: {
      kind: "webhook",
      mapping: { result: { path: "$.status", ok: ["resolved"] } },
    },
    payload: '{"status":"resolved"}',
  });
  expect(w?.status).toBe(200);
  expect(w?.json.observations[0].result).toBe("ok");
  const local = await call("POST", "/api/incident-signals/test", {
    source: { kind: "http", url: "http://127.0.0.1:9/" },
  });
  expect(local?.json.observations[0]).toMatchObject({
    result: "unknown",
    detail: expect.stringMatching(/^Refused: /),
  });
  expect(
    (
      await call("POST", "/api/incident-signals/test", {
        source: { kind: "heartbeat" },
      })
    )?.json,
  ).toEqual({ error: "Nothing to test for a heartbeat" });
  expect(
    (
      await call("POST", "/api/incident-signals/test", {
        source: { kind: "x" },
      })
    )?.status,
  ).toBe(400);
  expect(await listSignals()).toEqual([]);
});

test("a test run restores secrets only from the stored signal", async () => {
  const redacted = {
    kind: "http",
    url: "http://127.0.0.1:9/",
    headers: { Authorization: "[redacted]" },
  };
  const orphan = await call("POST", "/api/incident-signals/test", {
    source: redacted,
  });
  expect(orphan?.status).toBe(400);
  const { json } = (await call("POST", "/api/incident-signals", {
    ...httpBody,
    source: { ...httpBody.source, url: "http://127.0.0.1:9/" },
  }))!;
  const restored = await call("POST", "/api/incident-signals/test", {
    signalId: json.id,
    source: redacted,
  });
  expect(restored?.status).toBe(200);
  expect(JSON.stringify(restored?.json)).not.toContain("s3cret");
  expect(kit.audits.filter((a) => a.kind === "incident_signal_tested")).toEqual(
    [
      {
        kind: "incident_signal_tested",
        signalId: json.id,
        fields: ["headers.Authorization"],
        by: "Ada",
      },
    ],
  );
  // Same origin, another path or method: the secret is asked for again.
  for (const other of [
    { url: "http://127.0.0.1:9/admin" },
    { method: "POST", body: "{}" },
  ])
    expect(
      (
        await call("POST", "/api/incident-signals/test", {
          signalId: json.id,
          source: { ...redacted, ...other },
        })
      )?.json,
    ).toEqual({
      error:
        "Enter the Authorization value again to test another method or path",
    });
  // Nothing restored, nothing to audit.
  kit.audits.length = 0;
  await call("POST", "/api/incident-signals/test", {
    signalId: json.id,
    source: { ...redacted, headers: { Authorization: "Bearer typed" } },
  });
  expect(kit.audits).toEqual([]);
  expect(
    (
      await call("POST", "/api/incident-signals/test", {
        signalId: json.id,
        source: { ...redacted, url: "http://127.0.0.2:9/" },
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await call("POST", "/api/incident-signals/test", {
        signalId: "sig-missing",
        source: redacted,
      })
    )?.status,
  ).toBe(404);
});

test("at most three test runs at once; the rest get 429", async () => {
  expect(MAX_CONCURRENT_TEST_RUNS).toBe(3);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  __setTestRunSourceForTest(async () => {
    started++;
    await gate;
    return { observations: [] };
  });
  try {
    const draft = {
      source: { kind: "http", url: "https://acme.example.test/" },
    };
    const running = [1, 2, 3].map(() =>
      call("POST", "/api/incident-signals/test", draft),
    );
    while (started < 3) await Bun.sleep(1);
    expect(await call("POST", "/api/incident-signals/test", draft)).toEqual({
      status: 429,
      json: { error: "Too many test runs at once" },
    });
    // A webhook preview runs nothing and is never turned away.
    expect(
      (
        await call("POST", "/api/incident-signals/test", {
          source: { kind: "webhook" },
          payload: "x",
        })
      )?.status,
    ).toBe(200);
    release();
    expect((await Promise.all(running)).map((r) => r?.status)).toEqual([
      200, 200, 200,
    ]);
    expect(
      (await call("POST", "/api/incident-signals/test", draft))?.status,
    ).toBe(200);
  } finally {
    __setTestRunSourceForTest(undefined);
  }
});

test("other paths fall through", async () => {
  expect(await call("GET", "/api/automations")).toBeUndefined();
  expect(await call("PATCH", "/api/incident-signals")).toBeUndefined();
});

const newIncident = (over: Partial<NewIncident> = {}): NewIncident => ({
  project: "acme",
  title: "Search",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule", ref: "sig-a" },
  signalIds: ["sig-a"],
  primarySignalId: "sig-a",
  at: new Date().toISOString(),
  detail: "3 failures in a row",
  ...over,
});
const obs = (at: number, result: ObservationResult): Observation => ({
  at: new Date(at).toISOString(),
  result,
  detail: "",
});
const seedSignal = async (over: Record<string, unknown> = {}) => {
  const s = await createSignal({ ...httpBody, ...over }, "Ada");
  if ("error" in s) throw new Error(s.error);
  return s;
};
const ids = (json: { incidents: IncidentSummary[] }) =>
  json.incidents.map((i) => i.id);

test("incident list and detail", async () => {
  const a = await createIncident(
    newIncident({ at: new Date(Date.now() - 3_600_000).toISOString() }),
  );
  const b = await createIncident(newIncident({ project: "acme-api" }));
  const closed = await updateIncident(a.id, (c) =>
    transitionIncident(c, "closed-without-action", {
      by: "sessions",
      detail: "x",
      at: new Date().toISOString(),
    }),
  );
  expect(closed && "state" in closed && closed.state).toBe(
    "closed-without-action",
  );
  const all = await call("GET", "/api/incidents");
  expect(ids(all?.json)).toEqual([b.id, a.id]);
  expect(all?.json.incidents[0]).not.toHaveProperty("events");
  expect(all?.json.incidents[0].eventCount).toBe(1);
  expect(ids((await call("GET", "/api/incidents?status=open"))?.json)).toEqual([
    b.id,
  ]);
  expect(
    ids((await call("GET", "/api/incidents?status=closed"))?.json),
  ).toEqual([a.id]);
  expect(ids((await call("GET", "/api/incidents?project=acme"))?.json)).toEqual(
    [a.id],
  );
  expect((await call("GET", "/api/incidents?status=nope"))?.status).toBe(400);
  // Open ones always; closed ones only within the window.
  expect(
    ids((await call("GET", "/api/incidents?closedWithinMs=3600000"))?.json),
  ).toEqual([b.id, a.id]);
  const old = await updateIncident(a.id, (c) => ({
    ...c,
    closedAt: new Date(Date.now() - 7_200_000).toISOString(),
  }));
  expect(old && "closedAt" in old).toBe(true);
  expect(
    ids((await call("GET", "/api/incidents?closedWithinMs=3600000"))?.json),
  ).toEqual([b.id]);
  expect((await call("GET", "/api/incidents?closedWithinMs=-1"))?.status).toBe(
    400,
  );
  expect(
    (await call("GET", `/api/incidents/${b.id}`))?.json.events[0].kind,
  ).toBe("opened");
  expect((await call("GET", "/api/incidents/inc-missing"))?.status).toBe(404);
});

test("signal strip: range, lanes, markers, validation", async () => {
  const s = await seedSignal(); // http, intervalMs 60_000
  const now = Date.now();
  appendObservations(s.id, [
    obs(now - 90_000, "fail"),
    obs(now - 30_000, "ok"),
    { ...obs(now - 30_000, "fail"), lane: "API" },
  ]);
  await flushObservations();
  await createIncident(
    newIncident({
      signalIds: [s.id],
      primarySignalId: s.id,
      at: new Date(now - 60_000).toISOString(),
    }),
  );
  await createIncident(newIncident({ signalIds: ["sig-other"] }));
  const res = await call(
    "GET",
    `/api/incident-signals/${s.id}/strip?from=${new Date(now - 180_000).toISOString()}&to=${new Date(now).toISOString()}`,
  );
  expect(res?.status).toBe(200);
  expect(res?.json).toMatchObject({
    from: new Date(now - 180_000).toISOString(),
    to: new Date(now).toISOString(),
    bucketMs: 60_000,
    lanes: [
      { id: s.id, label: "Search" },
      { id: `${s.id}:API`, label: "API" },
    ],
    markers: [{ kind: "detected", label: "Detected" }],
  });
  expect(res?.json.lanes[0].bars.map((b: StripBar) => b.result)).toEqual([
    null,
    "fail",
    "ok",
  ]);
  // Default range: 120 intervals back from now.
  const fallback = await call("GET", `/api/incident-signals/${s.id}/strip`);
  expect(fallback?.json.lanes[0].bars).toHaveLength(120);
  expect(
    (await call("GET", `/api/incident-signals/${s.id}/strip?from=nope`))?.json,
  ).toEqual({ error: "Invalid range" });
  expect(
    (
      await call(
        "GET",
        `/api/incident-signals/${s.id}/strip?from=2026-03-01T00:00:00Z&to=2026-01-01T00:00:00Z`,
      )
    )?.json,
  ).toEqual({ error: "Invalid range" });
  expect(
    (
      await call(
        "GET",
        `/api/incident-signals/${s.id}/strip?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`,
      )
    )?.json,
  ).toEqual({ error: "Range over 31 days" });
  expect(
    (await call("GET", "/api/incident-signals/sig-missing/strip"))?.status,
  ).toBe(404);
});

test("expiry strips keep the lowest value per bar", async () => {
  const s = await seedSignal({
    source: { kind: "expiry", target: "tls", host: "acme.example.test" },
  });
  const now = Date.now();
  appendObservations(s.id, [
    { ...obs(now - 120_000, "ok"), value: 20 },
    { ...obs(now - 60_000, "ok"), value: 19.9 },
  ]);
  await flushObservations();
  const res = await call(
    "GET",
    `/api/incident-signals/${s.id}/strip?from=${new Date(now - 3_600_000).toISOString()}&to=${new Date(now).toISOString()}`,
  );
  const values = res?.json.lanes[0].bars
    .map((b: StripBar) => b.value)
    .filter((v: number | undefined) => v !== undefined);
  expect(values).toEqual([19.9]);
});

test("incident strip survives a deleted signal", async () => {
  const s = await seedSignal();
  const now = Date.now();
  appendObservations(s.id, [obs(now - 30_000, "fail")]);
  await flushObservations();
  const inc = await createIncident(
    newIncident({
      signalIds: [s.id],
      primarySignalId: s.id,
      at: new Date(now - 60_000).toISOString(),
    }),
  );
  await deleteSignal(s.id, "Ada");
  const res = await call("GET", `/api/incidents/${inc.id}/strip`);
  expect(res?.status).toBe(200);
  expect(res?.json.bucketMs).toBe(60_000);
  expect(res?.json.lanes[0]).toMatchObject({ id: s.id, label: s.id });
  expect(
    res?.json.lanes[0].bars.some((b: StripBar) => b.result === "fail"),
  ).toBe(true);
  expect(res?.json.markers).toEqual([
    expect.objectContaining({ kind: "detected", incidentId: inc.id }),
  ]);
  // Fifteen minutes of lead-in before the opening.
  expect(Date.parse(res?.json.from)).toBeLessThanOrEqual(
    now - 60_000 - 900_000,
  );
  expect((await call("GET", "/api/incidents/inc-missing/strip"))?.status).toBe(
    404,
  );
});

test("incident strip lanes follow the incident's signals", async () => {
  const a = await seedSignal({ name: "Api", intervalMs: 120_000 });
  const b = await seedSignal({ name: "Web", intervalMs: 30_000 });
  const now = Date.now();
  const inc = await createIncident(
    newIncident({
      signalIds: [b.id, a.id],
      primarySignalId: b.id,
      at: new Date(now - 60_000).toISOString(),
    }),
  );
  const res = await call("GET", `/api/incidents/${inc.id}/strip`);
  expect(res?.json.bucketMs).toBe(30_000);
  expect(res?.json.lanes.map((l: { label: string }) => l.label)).toEqual([
    "Web",
    "Api",
  ]);
});

test("registered in the route chain", () => {
  expect(routeHandlers).toContain(handleIncidentsRoutes);
});

test("only a signed-in person may point a signal at a production Runner", async () => {
  setSignalRunOnCheck(async () => null);
  try {
    const url = new URL("http://localhost/api/incident-signals");
    const asClaimed = await handleIncidentsRoutes({
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify({
          ...httpBody,
          runOn: "runner-prod",
          user: "Ada",
        }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser: null,
    });
    expect(asClaimed?.status).toBe(400);
    const asAutomation = await handleIncidentsRoutes({
      req: new Request(url, {
        method: "POST",
        body: JSON.stringify({ ...httpBody, runOn: "runner-prod" }),
      }),
      url,
      path: url.pathname,
      publicPrefix: "/backstage",
      authUser: { login: "bot", name: "Bot", automation: true } as never,
    });
    expect(asAutomation?.status).toBe(400);
    const signedIn = await call("POST", "/api/incident-signals", {
      ...httpBody,
      runOn: "runner-prod",
    });
    expect(signedIn?.status).toBe(200);
    expect(signedIn?.json).toMatchObject({
      runOn: "runner-prod",
      createdBy: "Ada",
    });
  } finally {
    setSignalRunOnCheck(undefined);
  }
});
