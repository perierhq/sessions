import { beforeEach, expect, test } from "bun:test";
import { __resetObservationsForTest } from "../incidents/observation-store";
import { __resetSchedulerForTest } from "../incidents/scheduler";
import { __resetSignalRuntimeForTest } from "../incidents/signal-runtime";
import { getSignal, listSignals } from "../incidents/signal-store";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import { handleIncidentsRoutes } from "./incidents";

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
  expect((await res!.json()).createdBy).toBe("Grace");
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

test("other paths fall through", async () => {
  expect(await call("GET", "/api/automations")).toBeUndefined();
  expect(await call("PATCH", "/api/incident-signals")).toBeUndefined();
});
