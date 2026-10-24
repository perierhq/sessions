import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIncident, updateIncident } from "../incident-store";
import { createSignal } from "../signal-store";
import { transitionIncident } from "../lifecycle";
import { useAccessTestEnv } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { setProjectAccessForTest } from "../testing/project-access";

/** Lend `credential` to the investigator at `mode` (null: not at all). */
function lend(credential: string, mode: "once" | "standing" | null) {
  return setProjectAccessForTest("acme", (access) => {
    access.credentials = [
      {
        credential,
        roles: mode ? { investigator: mode } : {},
        grantedBy: "Ada",
        grantedByLogin: "ada",
        grantedAt: "2026-10-20T10:00:00Z",
      },
    ];
  });
}

const STORE = join(mkdtempSync(join(tmpdir(), "kc-incident-life-")), "kc.json");
process.env.OPENSESSION_KEYCHAIN_STORE = STORE;
const kc = await import("../../keychain");
const { reconcileIncidentGrants } = await import("./credentials");
const { startIncidentAccess, __incidentAccessIdleForTest } =
  await import("./lifecycle");

useIncidentTestKernel();
const t = useAccessTestEnv();

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
});
afterEach(async () => {
  await __incidentAccessIdleForTest();
  reset();
});

async function seedIncidentWithGrantedCredential(mode: "once" | "standing") {
  const cred = await kc.addCredentialAsync({
    owner: "Ada",
    service: "proxy-api",
    host: "api.proxy.example.test",
    secret: "sk-life-1234",
  });
  t.spec.credentials.push({
    id: cred.id,
    service: "proxy-api",
    host: "api.proxy.example.test",
    owner: "Ada",
    kind: "api",
    scope: "personal",
    injectionHeader: "Authorization",
  });
  await lend(cred.id, mode);
  const incident = await createIncident({
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
  const grant = await kc.incidentGrantFor({
    credentialId: cred.id,
    sessionId: "os-1",
    mode,
    incident: {
      incidentId: incident.id,
      role: "investigator",
      project: "acme",
      signalId: null,
    },
    purpose: "Check the pool",
  });
  if ("error" in grant) throw new Error(grant.error);
  return { incident, credentialId: cred.id };
}

// Direct reconciliation first: once started, the settings listener
// reconciles on its own and would race these counts.
test("standing narrowed to once is revoked; an unchanged grant survives", async () => {
  const { incident, credentialId } =
    await seedIncidentWithGrantedCredential("standing");
  expect(await reconcileIncidentGrants("acme")).toBe(0);
  await lend(credentialId, "once");
  expect(await reconcileIncidentGrants("acme")).toBe(1);
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("a deleted credential's live grant is revoked", async () => {
  const { incident, credentialId } =
    await seedIncidentWithGrantedCredential("standing");
  t.spec.credentials = t.spec.credentials.filter((c) => c.id !== credentialId);
  expect(await reconcileIncidentGrants("acme")).toBe(1);
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("a grant bound to a signal that is not the incident's is revoked", async () => {
  const { incident, credentialId } =
    await seedIncidentWithGrantedCredential("standing");
  const sig = await createSignal(
    {
      name: "Checkout",
      project: "acme",
      source: { kind: "http", url: "https://checkout.example.test/q" },
    },
    "Ada",
  );
  if ("error" in sig) throw new Error(sig.error);
  const stray = await kc.incidentGrantFor({
    credentialId,
    sessionId: "os-2",
    mode: "standing",
    incident: {
      incidentId: incident.id,
      role: "investigator",
      project: "acme",
      signalId: sig.id,
    },
    purpose: "Check the pool",
  });
  if ("error" in stray) throw new Error(stray.error);
  expect(await reconcileIncidentGrants("acme")).toBe(1);
  expect(
    kc.listIncidentGrants({ incidentId: incident.id }).map((g) => g.sessionId),
  ).toEqual(["os-1"]);
});
test("closing the incident revokes its agents' grants", async () => {
  startIncidentAccess();
  await __incidentAccessIdleForTest();
  const { incident } = await seedIncidentWithGrantedCredential("standing");
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toHaveLength(1);
  await updateIncident(incident.id, (c) =>
    transitionIncident(c, "resolved", {
      by: "Ada",
      detail: "Fixed by hand",
      at: new Date().toISOString(),
    }),
  );
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("pausing the incident revokes its agents' grants", async () => {
  startIncidentAccess();
  const { incident } = await seedIncidentWithGrantedCredential("standing");
  await updateIncident(incident.id, (c) =>
    transitionIncident(c, "paused", {
      by: "Ada",
      detail: "Pause",
      at: new Date().toISOString(),
    }),
  );
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("waiting on a provider revokes its agents' grants", async () => {
  startIncidentAccess();
  const { incident } = await seedIncidentWithGrantedCredential("standing");
  await updateIncident(incident.id, (c) =>
    transitionIncident(c, "waiting-on-provider", {
      by: "Ada",
      detail: "Upstream outage",
      at: new Date().toISOString(),
    }),
  );
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("narrowing the settings revokes what the agent no longer has", async () => {
  startIncidentAccess();
  const { incident } = await seedIncidentWithGrantedCredential("standing");
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toHaveLength(1);
  await setProjectAccessForTest("acme", (access) => {
    access.credentials = [];
  });
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("changing a standing grant to once in the settings revokes the live standing grant", async () => {
  startIncidentAccess();
  const { incident, credentialId } =
    await seedIncidentWithGrantedCredential("standing");
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toHaveLength(1);
  await lend(credentialId, "once");
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
  // A later settings write that still lends it once revokes a standing
  // grant taken meanwhile.
  const again = await kc.incidentGrantFor({
    credentialId,
    sessionId: "os-3",
    mode: "standing",
    incident: {
      incidentId: incident.id,
      role: "investigator",
      project: "acme",
      signalId: null,
    },
    purpose: "Check the pool",
  });
  if ("error" in again) throw new Error(again.error);
  await lend(credentialId, "once");
  await __incidentAccessIdleForTest();
  expect(kc.listIncidentGrants({ incidentId: incident.id })).toEqual([]);
});
test("start is idempotent", () => {
  startIncidentAccess();
  startIncidentAccess();
});
