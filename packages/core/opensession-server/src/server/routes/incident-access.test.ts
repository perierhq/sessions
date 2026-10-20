import { expect, test } from "bun:test";
import { defaultProjectGrants } from "../../shared/incident-access";
import { catalogDocuments } from "../catalog-documents";
import { createSignal } from "../incidents/signal-store";
import { useAccessTestEnv } from "../incidents/testing/access-fixture";
import { useIncidentTestKernel } from "../incidents/testing/kernel-fixture";
import type { RouteContext } from "./context";
import { handleIncidentAccessRoutes } from "./incident-access";

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
const grants = (over = {}) => ({ ...defaultProjectGrants("acme"), ...over });

test("read defaults, write grants and a profile with revisions", async () => {
  expect((await call("GET", "/api/incident-access/acme"))?.json).toMatchObject({
    isDefault: true,
    revision: 0,
  });
  const g = await call("PUT", "/api/incident-access/acme/grants", {
    grants: grants({
      connections: ["sentry"],
      credentials: [{ credential: "kc-proxy", mode: "once" }],
    }),
    expectedRevision: 0,
  });
  expect(g?.json).toMatchObject({
    revision: 1,
    grants: { credentials: [{ credential: "kc-proxy", grantedBy: "Ada" }] },
    credentialInfo: { "kc-proxy": { service: "proxy-api" } },
  });
  expect(JSON.stringify(g?.json)).not.toContain("secret");
  const p = await call(
    "PUT",
    "/api/incident-access/acme/profiles/investigator",
    {
      fields: { connections: ["sentry"] },
      expectedRevision: 1,
    },
  );
  expect(p?.json.profiles.investigator.connections).toEqual(["sentry"]);
  expect(
    (
      await call("PUT", "/api/incident-access/acme/profiles/investigator", {
        fields: {},
        expectedRevision: 1,
      })
    )?.status,
  ).toBe(409);
  expect(kit.audits).toContainEqual(
    expect.objectContaining({ kind: "incident_access_updated", by: "Ada" }),
  );
});
test("a claimed identity cannot lend a credential", async () => {
  const out = await call(
    "PUT",
    "/api/incident-access/acme/grants",
    {
      grants: grants({
        credentials: [{ credential: "kc-proxy", mode: "once" }],
      }),
      user: "Ada",
    },
    null,
  );
  expect(out).toEqual({
    status: 400,
    json: { error: "Sign in to grant credentials to incident agents" },
  });
});
test("overrides, unknown roles and fields, bad input", async () => {
  const sig = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://search.example.test/q" },
    },
    "Ada",
  );
  if ("error" in sig) throw new Error(sig.error);
  expect(
    (
      await call(
        "PUT",
        `/api/incident-access/acme/overrides/investigator/${sig.id}`,
        { fields: { connections: [] } },
      )
    )?.json.overrides,
  ).toHaveLength(1);
  expect(
    (
      await call(
        "DELETE",
        `/api/incident-access/acme/overrides/investigator/${sig.id}?expectedRevision=1`,
      )
    )?.json.overrides,
  ).toEqual([]);
  expect(
    (
      await call(
        "DELETE",
        `/api/incident-access/acme/overrides/investigator/${sig.id}?expectedRevision=x`,
      )
    )?.json,
  ).toEqual({ error: "expectedRevision must be an integer" });
  expect(
    (
      await call("PUT", "/api/incident-access/acme/profiles/responder", {
        fields: {},
      })
    )?.json,
  ).toEqual({ error: 'Unknown agent role "responder"' });
  expect(
    (
      await call("PUT", "/api/incident-access/acme/overrides/auditor/sig-1", {
        fields: {},
      })
    )?.json,
  ).toEqual({ error: 'Unknown agent role "auditor"' });
  expect(
    (
      await call("PUT", "/api/incident-access/acme/profiles/verifier", {
        fields: { mode: "code" },
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await call("PUT", "/api/incident-access/acme/profiles/verifier", {
        fields: { sudo: true },
      })
    )?.json,
  ).toEqual({ error: 'The verifier profile: Unknown field "sudo"' });
  expect(
    (await call("PUT", "/api/incident-access/acme/grants", "{nope"))?.json,
  ).toEqual({ error: "Invalid JSON" });
  expect(
    (
      await call("PUT", "/api/incident-access/acme/grants", {
        grants: grants(),
        expectedRevision: "1",
      })
    )?.status,
  ).toBe(400);
  expect((await call("GET", "/api/incident-access/globex"))?.status).toBe(404);
  expect((await call("GET", "/api/incident-access/%E0%A4%A"))?.json).toEqual({
    error: "Invalid path",
  });
});
test("an unreadable document reports and resets", async () => {
  await catalogDocuments("incident-access").set("acme", { future: 1 });
  expect((await call("GET", "/api/incident-access/acme"))?.status).toBe(500);
  expect(
    (
      await call("PUT", "/api/incident-access/acme/profiles/verifier", {
        fields: {},
      })
    )?.status,
  ).toBe(500);
  expect(
    (await call("DELETE", "/api/incident-access/acme"))?.json,
  ).toMatchObject({
    isDefault: true,
  });
});
test("other paths fall through", async () => {
  expect(await call("GET", "/api/incident-signals")).toBeUndefined();
  expect(await call("PATCH", "/api/incident-access/acme")).toBeUndefined();
});
