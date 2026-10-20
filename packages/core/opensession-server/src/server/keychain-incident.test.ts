/**
 * Keychain grants for incident agents: minted only through incidentGrantFor,
 * invisible to the interactive path and to other incidents, never a
 * workspace auto-grant, never a login, revocable by incident or project.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddCredentialInput } from "./keychain";

const STORE = join(mkdtempSync(join(tmpdir(), "kc-incident-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;

const kc = await import("./keychain");
const { brokerCall } = await import("./keychain-broker");

const SECRET = "sk-incident-secret-1234";

function reset(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}

let seen: string[] = [];
const fetchImpl = (async (url: URL) => {
  seen.push(String(url));
  return Response.json(
    { ok: true },
    { headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  reset();
  seen = [];
});
afterEach(reset);

const marker = {
  incidentId: "inc-1",
  role: "investigator",
  project: "acme",
  signalId: "sig-search",
};
const seed = async (over: Partial<AddCredentialInput> = {}) =>
  kc.addCredentialAsync({
    owner: "Ada",
    service: "proxy-api",
    host: "api.proxy.example.test",
    secret: SECRET,
    ...over,
  });

test("mint once, reuse while live, refuse after it is spent", async () => {
  const cred = await seed();
  const g = await kc.incidentGrantFor({
    credentialId: cred.id,
    sessionId: "s-1",
    mode: "once",
    incident: marker,
    purpose: "check the proxy pool",
  });
  if ("error" in g) throw new Error(g.error);
  expect(g).toMatchObject({
    mode: "once",
    incident: marker,
    requestedBy: "incident inc-1 investigator",
    owner: "Ada",
  });
  expect(
    await kc.incidentGrantFor({
      credentialId: cred.id,
      sessionId: "s-1",
      mode: "once",
      incident: marker,
      purpose: "x",
    }),
  ).toMatchObject({ id: g.id });
  const out = await brokerCall({
    sessionId: "s-1",
    credential: cred.id,
    method: "GET",
    path: "/v1/pool",
    purpose: "check",
    incident: { incidentId: "inc-1", role: "investigator" },
    fetchImpl,
  });
  expect(out).toMatchObject({ status: 200 });
  expect(
    await kc.incidentGrantFor({
      credentialId: cred.id,
      sessionId: "s-1",
      mode: "once",
      incident: marker,
      purpose: "x",
    }),
  ).toEqual({ error: "This agent already used its one call to proxy-api" });
});
test("an incident call never mints a workspace grant", async () => {
  const cred = await seed({ scope: "workspace" });
  expect(
    await brokerCall({
      sessionId: "s-1",
      credential: cred.id,
      method: "GET",
      path: "/",
      purpose: "x",
      incident: { incidentId: "inc-1", role: "investigator" },
      fetchImpl,
    }),
  ).toEqual({ error: "This agent holds no grant for proxy-api" });
  expect(seen).toEqual([]);
  expect(kc.listGrants({ sessionId: "s-1" })).toEqual([]);
});
test("incident grants are invisible to the interactive path and to other incidents", async () => {
  const cred = await seed();
  const g = await kc.incidentGrantFor({
    credentialId: cred.id,
    sessionId: "s-1",
    mode: "standing",
    incident: marker,
    purpose: "x",
  });
  if ("error" in g) throw new Error(g.error);
  expect(kc.activeGrantFor("s-1", cred.id)).toBeUndefined();
  expect(
    await brokerCall({
      sessionId: "s-1",
      credential: cred.id,
      method: "GET",
      path: "/",
      fetchImpl,
    }),
  ).toMatchObject({ error: expect.stringContaining("no live grant") });
  expect(
    await brokerCall({
      sessionId: "s-1",
      credential: cred.id,
      method: "GET",
      path: "/",
      purpose: "x",
      incident: { incidentId: "inc-2", role: "investigator" },
      fetchImpl,
    }),
  ).toEqual({ error: "This agent holds no grant for proxy-api" });
  expect(kc.consumeGrantForBroker(g.id, "s-1", "GET", "/")).toEqual({
    error: "this grant belongs to an incident agent",
    status: 403,
  });
  expect(kc.consumeGrantForBroker(g.id, "s-1", "GET", "/", "inc-2")).toEqual({
    error: "this grant belongs to an incident agent",
    status: 403,
  });
});
test("an interactive grant is not usable on the incident path", async () => {
  const cred = await seed();
  const g = kc.__mintGrantForTest({
    credentialId: cred.id,
    sessionId: "s-1",
    requestedBy: "Ada",
    mode: "standing",
  });
  expect(kc.consumeGrantForBroker(g.id, "s-1", "GET", "/", "inc-1")).toEqual({
    error: "unknown grant",
    status: 404,
  });
});
test("logins are never lent", async () => {
  const login = await kc.addCredentialAsync({
    owner: "Ada",
    service: "admin-login",
    kind: "login",
    loginUrl: "https://admin.example.test/login",
    username: "ops",
    secret: "pw",
  });
  expect(
    await kc.incidentGrantFor({
      credentialId: login.id,
      sessionId: "s-1",
      mode: "once",
      incident: marker,
      purpose: "x",
    }),
  ).toEqual({
    error: "admin-login is a login; logins are never lent to incident agents",
  });
});
test("revoke by incident or project, and the filter is required", async () => {
  const cred = await seed();
  await kc.incidentGrantFor({
    credentialId: cred.id,
    sessionId: "s-1",
    mode: "standing",
    incident: marker,
    purpose: "x",
  });
  await kc.incidentGrantFor({
    credentialId: cred.id,
    sessionId: "s-2",
    mode: "standing",
    incident: { ...marker, incidentId: "inc-2" },
    purpose: "x",
  });
  expect(
    await kc.revokeIncidentGrants({ incidentId: "inc-1" }, "Incident closed"),
  ).toBe(1);
  expect(
    kc.listIncidentGrants({ project: "acme" }).map((g) => g.sessionId),
  ).toEqual(["s-2"]);
  expect(
    await kc.revokeIncidentGrants(
      { project: "acme" },
      "Access settings changed",
    ),
  ).toBe(1);
  await expect(kc.revokeIncidentGrants({}, "x")).rejects.toThrow(
    "needs a filter",
  );
});
test("proxy headers come only from a live incident grant for that host", async () => {
  const fwd = await kc.addCredentialAsync({
    owner: "Ada",
    service: "fwd-proxy",
    host: "proxy.example.test",
    secret: "dXNlcjpwYXNz",
    injection: { header: "Proxy-Authorization", scheme: "Basic" },
  });
  expect(
    kc.incidentGrantHeaders({
      sessionId: "s-1",
      incidentId: "inc-1",
      credentialId: fwd.id,
      host: "proxy.example.test",
    }),
  ).toEqual({ error: "This agent holds no grant for fwd-proxy" });
  await kc.incidentGrantFor({
    credentialId: fwd.id,
    sessionId: "s-1",
    mode: "standing",
    incident: marker,
    purpose: "x",
  });
  expect(
    kc.incidentGrantHeaders({
      sessionId: "s-1",
      incidentId: "inc-1",
      credentialId: fwd.id,
      host: "evil.example.test",
    }),
  ).toEqual({ error: "fwd-proxy is not for evil.example.test" });
  expect(
    kc.incidentGrantHeaders({
      sessionId: "s-1",
      incidentId: "inc-1",
      credentialId: fwd.id,
      host: "proxy.example.test",
    }),
  ).toEqual({ "Proxy-Authorization": "Basic dXNlcjpwYXNz" });
});
test("scrub", async () => {
  const cred = await seed();
  expect(
    kc.scrubCredentialSecrets(`token=${SECRET}`, [cred.id, "kc-missing"]),
  ).not.toContain(SECRET);
});
