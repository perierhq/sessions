import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAccess,
  ResolvedCredential,
} from "../../../shared/incident-access";
import { agentAccessFixture } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { AgentAccessError, __setBindingResolverForTest } from "./resolve";
import type { IncidentToolContext } from "./tool-context";
import { fetchBackedNet } from "../../testing/pinned-fetch-double";

const STORE = join(
  mkdtempSync(join(tmpdir(), "kc-incident-calls-")),
  "kc.json",
);
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
const kc = await import("../../keychain");
const { incidentCredentialCall, freshGrantedCredential } =
  await import("./credentials");

const SECRET = "sk-incident-call-5678";
const kit = useIncidentTestKernel();
let fresh: AgentAccess | null = null;
let seen: string[] = [];
const fetchImpl = (async (url: URL) => {
  seen.push(String(url));
  return Response.json({ ok: true });
}) as unknown as typeof fetch;

function reset(): void {
  if (existsSync(STORE)) rmSync(STORE);
  const g = globalThis as any;
  g.__keychainCredentials?.clear();
  g.__keychainGrants?.clear();
  g.__keychainAsks?.clear();
}
beforeEach(() => {
  process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
  reset();
  seen = [];
  fresh = null;
  __setBindingResolverForTest(async () => {
    if (!fresh) throw new Error("no access in this test");
    return fresh;
  });
});
afterEach(() => {
  __setBindingResolverForTest(undefined);
  reset();
});

const ctx = (credentials: ResolvedCredential[]): IncidentToolContext => {
  fresh = agentAccessFixture({ signalId: "sig-search", credentials });
  return {
    sessionId: "os-1",
    binding: {
      incidentId: "inc-1",
      role: "investigator",
      signalId: "sig-search",
      accessRevision: "r",
      spawn: { hosts: [], credentials: [], egress: null },
    },
    access: fresh,
  };
};
const granted = (id: string, mode: "once" | "standing" = "once") =>
  ({
    credential: id,
    service: "proxy-api",
    host: "api.proxy.example.test",
    mode,
    scope: "personal",
  }) as const;

test("a granted credential is called through a minted incident grant and audited", async () => {
  const cred = await kc.addCredentialAsync({
    owner: "Ada",
    service: "proxy-api",
    host: "api.proxy.example.test",
    secret: SECRET,
  });
  const c = ctx([granted(cred.id)]);
  expect(
    await incidentCredentialCall(
      c,
      {
        credential: "proxy-api",
        method: "GET",
        path: "/v1/pool?key=zzz",
        purpose: "Check the pool",
      },
      { net: fetchBackedNet(fetchImpl) },
    ),
  ).toMatchObject({ status: 200 });
  expect(seen).toEqual(["https://api.proxy.example.test/v1/pool?key=zzz"]);
  expect(kc.listIncidentGrants({ incidentId: "inc-1" })).toEqual([]); // the once grant is spent
  expect(kit.audits).toContainEqual({
    kind: "incident_credential_call",
    incident_id: "inc-1",
    incident_role: "investigator",
    session_id: "os-1",
    credential_id: cred.id,
    service: "proxy-api",
    method: "GET",
    path: "/v1/pool",
    mode: "once",
    status: 200,
  });
  expect(JSON.stringify(kit.audits)).not.toContain("zzz");
  expect(
    await incidentCredentialCall(
      c,
      { credential: "proxy-api", method: "GET", path: "/", purpose: "again" },
      { net: fetchBackedNet(fetchImpl) },
    ),
  ).toEqual({ error: "This agent already used its one call to proxy-api" });
});
test("ungranted credentials and missing purposes are refused before the keychain", async () => {
  expect(
    await incidentCredentialCall(ctx([]), {
      credential: "proxy-api",
      method: "GET",
      path: "/",
      purpose: "x",
    }),
  ).toEqual({ error: "proxy-api is not granted to this agent" });
  const c = ctx([granted("kc-x")]);
  expect(
    await incidentCredentialCall(c, {
      credential: "proxy-api",
      method: "GET",
      path: "/",
      purpose: " ",
    }),
  ).toEqual({ error: "Say why you make this call (purpose)" });
});
test("the grant is minted at the mode the fresh access names, not the caller's", async () => {
  const cred = await kc.addCredentialAsync({
    owner: "Ada",
    service: "proxy-api",
    host: "api.proxy.example.test",
    secret: SECRET,
  });
  const c = ctx([granted(cred.id, "standing")]);
  fresh = agentAccessFixture({
    signalId: "sig-search",
    credentials: [granted(cred.id, "once")],
  });
  await incidentCredentialCall(
    c,
    { credential: cred.id, method: "GET", path: "/", purpose: "x" },
    { net: fetchBackedNet(fetchImpl) },
  );
  expect(
    kit.audits.find((e) => e.kind === "incident_credential_call"),
  ).toMatchObject({ mode: "once" });
  fresh = agentAccessFixture({ signalId: "sig-search", credentials: [] });
  expect(
    await incidentCredentialCall(
      c,
      { credential: cred.id, method: "GET", path: "/", purpose: "x" },
      { net: fetchBackedNet(fetchImpl) },
    ),
  ).toEqual({ error: `${cred.id} is not granted to this agent` });
  expect(kc.listIncidentGrants({ incidentId: "inc-1" })).toEqual([]);
});
test("a refused resolution mints nothing", async () => {
  const cred = await kc.addCredentialAsync({
    owner: "Ada",
    service: "proxy-api",
    host: "api.proxy.example.test",
    secret: SECRET,
  });
  const c = ctx([granted(cred.id, "standing")]);
  __setBindingResolverForTest(async () => {
    throw new AgentAccessError(
      "Incident inc-1 is resolved; its agents have no access",
      "incident",
    );
  });
  expect(await freshGrantedCredential(c, cred.id)).toEqual({
    error:
      "Access refused: Incident inc-1 is resolved; its agents have no access",
  });
  expect(
    await incidentCredentialCall(
      c,
      { credential: cred.id, method: "GET", path: "/", purpose: "x" },
      { net: fetchBackedNet(fetchImpl) },
    ),
  ).toEqual({
    error:
      "Access refused: Incident inc-1 is resolved; its agents have no access",
  });
  expect(kc.listIncidentGrants({ incidentId: "inc-1" })).toEqual([]);
  expect(seen).toEqual([]);
});
test("two lent credentials with the same service name are refused by name, not guessed", async () => {
  const c = ctx([granted("kc-a"), granted("kc-b", "standing")]);
  const ambiguous = {
    error:
      "Two credentials lent to this agent are named proxy-api; name one by its id",
  };
  expect(
    await incidentCredentialCall(
      c,
      { credential: "proxy-api", method: "GET", path: "/", purpose: "Check" },
      { net: fetchBackedNet(fetchImpl) },
    ),
  ).toEqual(ambiguous);
  expect(await freshGrantedCredential(c, "Proxy-API")).toEqual(ambiguous);
  expect(await freshGrantedCredential(c, "kc-b")).toMatchObject({
    credential: { credential: "kc-b", mode: "standing" },
  });
  expect(seen).toEqual([]);
});
