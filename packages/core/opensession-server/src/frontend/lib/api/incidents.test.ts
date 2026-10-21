import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./request";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const calls: Array<{ url: string; method: string; body?: string }> = [];
function serve(routes: Record<string, { status: number; body: unknown }>) {
  calls.length = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // SAFETY: every request this client sends has a JSON string body or none.
      const sent = init?.body as string | undefined;
      calls.push({ url, method: init?.method ?? "GET", body: sent });
      const hit = Object.entries(routes).find(([path]) => url.endsWith(path));
      const { status, body } = hit?.[1] ?? {
        status: 404,
        body: { error: "Not found" },
      };
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
}

const api = await import("./incidents");

test("plan 1 routes", async () => {
  serve({
    "/api/incident-signals": {
      status: 200,
      body: { signals: [{ id: "sig-a" }] },
    },
    "/api/incidents?status=open&project=acme": {
      status: 200,
      body: { incidents: [{ id: "inc-1" }] },
    },
  });
  // SAFETY: the client passes the list through unchanged; only ids are compared.
  expect(await api.fetchSignals()).toEqual([{ id: "sig-a" }] as never);
  // SAFETY: as above, the list passes through unchanged.
  expect(await api.fetchIncidents({ status: "open", project: "acme" })).toEqual(
    [{ id: "inc-1" }] as never,
  );
});

test("strip range is passed as ISO query parameters", async () => {
  serve({});
  await api
    .fetchSignalStrip("sig-a", {
      from: "2026-10-20T09:00:00.000Z",
      to: "2026-10-20T10:00:00.000Z",
    })
    .catch(() => undefined);
  expect(calls[0]!.url).toContain(
    "/api/incident-signals/sig-a/strip?from=2026-10-20T09%3A00%3A00.000Z&to=2026-10-20T10%3A00%3A00.000Z",
  );
});

test("ids are encoded in the path", async () => {
  serve({});
  await api.fetchIncident("inc 1/x").catch(() => undefined);
  expect(calls[0]!.url).toEndWith("/api/incidents/inc%201%2Fx");
});

test("a missing plan resolves null, other failures throw", async () => {
  serve({
    "/api/incident-access/acme": {
      status: 500,
      body: { error: "Stored access settings for acme are unreadable: x" },
    },
  });
  expect(await api.fetchProjectSettings("acme")).toBeNull();
  expect(await api.fetchProjectSettingsList()).toBeNull();
  expect(await api.fetchIncidentAccess("inc-1")).toBeNull();
  expect(await api.fetchAgentAudit("inc-1")).toBeNull();
  await expect(api.fetchAccessSettings("acme")).rejects.toThrow("unreadable");
  expect(api.isSeamMissing(new ApiError("x", 404))).toBe(true);
  expect(api.isSeamMissing(new ApiError("x", 409))).toBe(false);
  expect(api.isSeamMissing(new Error("x"))).toBe(false);
});

test("writes carry the revision and the decision", async () => {
  serve({
    "/api/incident-access/acme/profiles/verifier": {
      status: 200,
      body: { revision: 3 },
    },
    "/api/incidents/inc-1/decisions": { status: 200, body: { id: "inc-1" } },
    "/api/incident-projects/acme": {
      status: 200,
      body: {
        settings: { project: "acme" },
        runners: [],
        models: { error: "x" },
      },
    },
    "/api/incident-access/acme/overrides/investigator/sig-a?expectedRevision=4":
      { status: 200, body: { revision: 5 } },
  });
  await api.putAccessProfile("acme", "verifier", { mode: "ask" }, 2);
  expect(calls[0]).toMatchObject({
    method: "PUT",
    body: JSON.stringify({ fields: { mode: "ask" }, expectedRevision: 2 }),
  });
  await api.decideIncidentApi(
    "inc-1",
    "send-back",
    "Not proxies: send the app's own user agent",
  );
  expect(calls[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({
      decision: "send-back",
      note: "Not proxies: send the app's own user agent",
    }),
  });
  await api.deleteAccessOverride("acme", "investigator", "sig-a", 4);
  expect(calls[2]!.method).toBe("DELETE");
  expect((await api.fetchProjectSettings("acme"))?.settings.project).toBe(
    "acme",
  );
});

test("writes throw on a missing route", async () => {
  serve({});
  await expect(api.decideIncidentApi("inc-1", "stop")).rejects.toBeInstanceOf(
    ApiError,
  );
});
