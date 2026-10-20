import { expect, test } from "bun:test";
import {
  type ProjectAccessGrants,
  defaultProjectGrants,
} from "../../../shared/incident-access";
import { catalogDocuments } from "../../catalog-documents";
import { createSignal } from "../signal-store";
import { useAccessTestEnv } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  draftIncidentAccess,
  getIncidentAccessSettings,
  onIncidentAccessChange,
  updateIncidentAccess,
} from "./settings-store";

const kit = useIncidentTestKernel();
useAccessTestEnv();
const ada = { name: "Ada", login: "ada", verified: true };
const grantsWith = (over: Partial<ProjectAccessGrants>) => ({
  ...defaultProjectGrants("acme"),
  ...over,
});

test("defaults until written; unknown project is 404", async () => {
  const view = await getIncidentAccessSettings("acme");
  expect(view).toMatchObject({
    isDefault: true,
    revision: 0,
    profiles: { verifier: { mode: "ask" } },
  });
  await expect(getIncidentAccessSettings("globex")).rejects.toMatchObject({
    status: 404,
  });
});
test("grants then profile: revisions, audit with field names only", async () => {
  const g = await updateIncidentAccess(
    "acme",
    {
      kind: "grants",
      grants: grantsWith({
        connections: ["sentry", "logs"],
        credentials: [{ credential: "kc-proxy", mode: "standing" }],
      } as never),
    },
    ada,
  );
  expect(g).toMatchObject({
    revision: 1,
    isDefault: false,
    credentialInfo: { "kc-proxy": { service: "proxy-api", owner: "Ada" } },
  });
  const p = await updateIncidentAccess(
    "acme",
    {
      kind: "profile",
      role: "investigator",
      fields: {
        connections: ["sentry"],
        credentials: [{ credential: "kc-proxy", mode: "once" }],
      },
    },
    { name: "Bo", login: "bo", verified: true },
    { expectedRevision: 1 },
  );
  expect(p).toMatchObject({
    revision: 2,
    profiles: { investigator: { connections: ["sentry"], mode: "code" } },
  });
  expect(kit.audits).toEqual([
    {
      kind: "incident_access_updated",
      project: "acme",
      by: "Ada",
      change: "grants",
      fields: ["connections", "credentials"],
    },
    {
      kind: "incident_access_credential_granted",
      project: "acme",
      credentialId: "kc-proxy",
      mode: "standing",
      by: "Ada",
    },
    {
      kind: "incident_access_updated",
      project: "acme",
      by: "Bo",
      change: "profile",
      role: "investigator",
      fields: ["connections", "credentials"],
    },
  ]);
});
test("a profile wider than the grants is refused; so is narrowing grants under a profile", async () => {
  expect(
    await updateIncidentAccess(
      "acme",
      {
        kind: "profile",
        role: "investigator",
        fields: { connections: ["sentry"] },
      },
      ada,
    ),
  ).toEqual({
    error:
      'The investigator profile: Connection "sentry" is not in the project\'s grants',
    status: 400,
  });
  await updateIncidentAccess(
    "acme",
    { kind: "grants", grants: grantsWith({ connections: ["sentry"] }) },
    ada,
  );
  await updateIncidentAccess(
    "acme",
    {
      kind: "profile",
      role: "investigator",
      fields: { connections: ["sentry"] },
    },
    ada,
  );
  expect(
    await updateIncidentAccess(
      "acme",
      { kind: "grants", grants: grantsWith({}) },
      ada,
    ),
  ).toEqual({
    error:
      'The investigator profile: Connection "sentry" is not in the project\'s grants',
    status: 400,
  });
});
test("overrides: signal checks, upsert, delete, role lock", async () => {
  const sig = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://search.example.test/q" },
    },
    "Ada",
  );
  const other = await createSignal(
    {
      name: "Api",
      project: "acme-api",
      source: { kind: "http", url: "https://api.example.test" },
    },
    "Ada",
  );
  if ("error" in sig || "error" in other) throw new Error("seed");
  await updateIncidentAccess(
    "acme",
    {
      kind: "grants",
      grants: grantsWith({
        runners: ["rn-prod"],
        hosts: [{ runner: "rn-prod", access: "read-only" }],
      }),
    },
    ada,
  );
  const o = await updateIncidentAccess(
    "acme",
    {
      kind: "override",
      role: "investigator",
      signalId: sig.id,
      fields: { hosts: [{ runner: "rn-prod", access: "read-only" }] },
    },
    ada,
  );
  expect(o).toMatchObject({
    overrides: [
      {
        signalId: sig.id,
        role: "investigator",
        fields: { hosts: [{ runner: "rn-prod" }] },
        updatedBy: "Ada",
      },
    ],
  });
  expect(
    await updateIncidentAccess(
      "acme",
      {
        kind: "override",
        role: "verifier",
        signalId: sig.id,
        fields: { mode: "code" },
      },
      ada,
    ),
  ).toMatchObject({ status: 400 });
  expect(
    await updateIncidentAccess(
      "acme",
      {
        kind: "override",
        role: "investigator",
        signalId: other.id,
        fields: {},
      },
      ada,
    ),
  ).toEqual({
    error: `Signal ${other.id} belongs to another project`,
    status: 400,
  });
  expect(
    await updateIncidentAccess(
      "acme",
      { kind: "delete-override", role: "investigator", signalId: sig.id },
      ada,
    ),
  ).toMatchObject({ overrides: [] });
  expect(
    await updateIncidentAccess(
      "acme",
      { kind: "delete-override", role: "investigator", signalId: sig.id },
      ada,
    ),
  ).toEqual({ error: "Not found", status: 404 });
});
test("stale revision, no-op writes, unreadable documents and reset", async () => {
  await updateIncidentAccess(
    "acme",
    { kind: "grants", grants: grantsWith({ connections: ["sentry"] }) },
    ada,
  );
  expect(
    await updateIncidentAccess(
      "acme",
      { kind: "grants", grants: grantsWith({}) },
      ada,
      { expectedRevision: 0 },
    ),
  ).toEqual({
    error: "Access settings changed since you loaded them",
    status: 409,
  });
  kit.audits.length = 0;
  expect(
    await updateIncidentAccess(
      "acme",
      { kind: "grants", grants: grantsWith({ connections: ["sentry"] }) },
      ada,
    ),
  ).toMatchObject({ revision: 1 });
  expect(kit.audits).toEqual([]);
  await catalogDocuments("incident-access").set("acme", {
    project: "acme",
    future: true,
  });
  await expect(getIncidentAccessSettings("acme")).rejects.toMatchObject({
    status: 500,
  });
  expect(
    await updateIncidentAccess(
      "acme",
      { kind: "grants", grants: grantsWith({}) },
      ada,
    ),
  ).toMatchObject({
    status: 500,
    error: expect.stringContaining("Reset them"),
  });
  expect(
    await updateIncidentAccess("acme", { kind: "reset" }, ada),
  ).toMatchObject({ isDefault: true });
});
test("draft validates without writing; listeners hear commits", async () => {
  const seen: string[] = [];
  const off = onIncidentAccessChange((p) => seen.push(p));
  expect(
    await draftIncidentAccess(
      "acme",
      {
        grants: grantsWith({ connections: ["sentry"] }),
        profiles: { investigator: { connections: ["sentry"] } },
      },
      ada,
    ),
  ).toMatchObject({
    profiles: { investigator: { connections: ["sentry"] } },
  });
  expect((await getIncidentAccessSettings("acme")).isDefault).toBe(true);
  expect(seen).toEqual([]);
  await updateIncidentAccess(
    "acme",
    { kind: "grants", grants: grantsWith({ connections: ["sentry"] }) },
    ada,
  );
  expect(seen).toEqual(["acme"]);
  off();
});
