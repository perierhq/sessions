import { expect, test } from "bun:test";
import { createIncident, updateIncident } from "../incidents/incident-store";
import { transitionIncident } from "../incidents/lifecycle";
import { useAccessTestEnv } from "../incidents/testing/access-fixture";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import type { RouteContext } from "./context";
import { handleIncidentAccessRoutes } from "./incident-access";
import { handleIncidentsRoutes } from "./incidents";
import { routeHandlers } from "./index";

const kit = useIncidentTestKernel();
useAccessTestEnv();

const call = async (
  method: string,
  path: string,
  body?: unknown,
  auth: RouteContext["authUser"] = { login: "ada", name: "Ada Lovelace" },
) => {
  const url = new URL(`http://localhost${path}`);
  const res = await handleIncidentAccessRoutes({
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
    authUser: auth,
  });
  return res ? { status: res.status, json: await res.json() } : undefined;
};
test("reads the project's access, and every write has moved", async () => {
  expect((await call("GET", "/api/incident-access/acme"))?.json).toMatchObject({
    project: "acme",
  });
  const moved = {
    status: 410,
    json: { error: "Moved to /api/projects/acme/settings" },
  };
  expect(
    await call("PUT", "/api/incident-access/acme/grants", { grants: {} }),
  ).toEqual(moved);
  expect(
    await call("PUT", "/api/incident-access/acme/profiles/investigator", {
      fields: {},
    }),
  ).toEqual(moved);
  expect(
    await call(
      "PUT",
      "/api/incident-access/acme/overrides/investigator/sig-1",
      {
        fields: {},
      },
    ),
  ).toEqual(moved);
  expect(
    await call(
      "DELETE",
      "/api/incident-access/acme/overrides/investigator/sig-1",
    ),
  ).toEqual(moved);
  expect(await call("DELETE", "/api/incident-access/acme")).toEqual(moved);
  expect(await call("PATCH", "/api/incident-access/acme")).toEqual(moved);
  expect((await call("GET", "/api/incident-access/%E0%A4%A"))?.json).toEqual({
    error: "Invalid path",
  });
});
test("other paths fall through", async () => {
  expect(await call("GET", "/api/incident-signals")).toBeUndefined();
  expect(await call("POST", "/api/incident-access/acme")).toBeUndefined();
});

test("preview the saved settings; a draft has moved", async () => {
  expect(
    await call("POST", "/api/incident-access/preview", {
      project: "acme",
      role: "investigator",
      draft: { profiles: { investigator: { connections: ["sentry"] } } },
    }),
  ).toEqual({
    status: 410,
    json: { error: "Moved to /api/projects/acme/settings" },
  });
  expect(
    (
      await call("POST", "/api/incident-access/preview", {
        project: "acme",
        role: "auditor",
      })
    )?.json,
  ).toEqual({ error: 'Unknown agent role "auditor"' });
  expect(
    (
      await call("POST", "/api/incident-access/preview", {
        project: "globex",
        role: "verifier",
      })
    )?.status,
  ).toBe(404);
  expect(
    (
      await call("POST", "/api/incident-access/preview", {
        project: "acme",
        role: "verifier",
        signalId: "sig-missing",
      })
    )?.status,
  ).toBe(400);
  const stored = await call("POST", "/api/incident-access/preview", {
    project: "acme",
    role: "verifier",
  });
  expect(stored?.json).toMatchObject({
    access: { role: "verifier", mode: "ask", defaults: true },
  });
  expect(
    kit.audits.filter((e) => e.kind === "incident_access_narrowed"),
  ).toEqual([]);
});
test("per-incident access shows each role, and refusals for a paused incident", async () => {
  const inc = await createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "owner" },
    signalIds: [],
    primarySignalId: "",
    at: new Date().toISOString(),
    detail: "Opened by hand",
  } as never);
  const live = await call("GET", `/api/incidents/${inc.id}/access`);
  expect(live?.json).toMatchObject({
    incidentId: inc.id,
    investigator: { access: { role: "investigator" } },
    verifier: { access: { mode: "ask" } },
  });
  await updateIncident(inc.id, (c) =>
    transitionIncident(c, "paused", {
      by: "Ada",
      detail: "Pause",
      at: new Date().toISOString(),
    }),
  );
  expect(
    (await call("GET", `/api/incidents/${inc.id}/access`))?.json.verifier,
  ).toEqual({
    access: null,
    error: `Incident ${inc.id} is paused; its agents have no access`,
    tools: [],
    warnings: [],
  });
  expect((await call("GET", "/api/incidents/inc-missing/access"))?.status).toBe(
    404,
  );
});

test("registered before the incidents routes", () => {
  const at = routeHandlers.indexOf(handleIncidentAccessRoutes);
  expect(at).toBeGreaterThan(-1);
  expect(at).toBeLessThan(routeHandlers.indexOf(handleIncidentsRoutes));
});
