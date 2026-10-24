import { expect, test } from "bun:test";
import { useAccessTestEnv } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import { setProjectAccessForTest } from "../testing/project-access";
import {
  ACCESS_MOVED_ERROR,
  draftIncidentAccess,
  getIncidentAccessSettings,
  onIncidentAccessChange,
  updateIncidentAccess,
} from "./settings-store";

useIncidentTestKernel();
useAccessTestEnv();

test("defaults until written; unknown project is 404", async () => {
  const view = await getIncidentAccessSettings("acme");
  expect(view).toMatchObject({
    isDefault: true,
    revision: 0,
    profiles: {
      investigator: { mode: "code", runners: [], model: null },
      verifier: { mode: "ask", runners: [], model: null },
    },
  });
  await expect(getIncidentAccessSettings("globex")).rejects.toMatchObject({
    status: 404,
  });
});

test("the incident agents' rows project into grants, profiles and overrides", async () => {
  await setProjectAccessForTest("acme", (access) => {
    access.connections = [
      { server: "sentry", roles: ["investigator", "verifier"] },
      { server: "logs", roles: ["automations"] },
    ];
    access.credentials = [
      {
        credential: "kc-proxy",
        roles: { investigator: "once", verifier: "standing" },
        grantedBy: "Ada",
        grantedByLogin: "ada",
        grantedAt: "2026-10-20T10:00:00Z",
      },
    ];
    access.hosts = [
      {
        runner: "rn-prod",
        ssh: "db-1",
        access: "read-only",
        roles: ["investigator"],
      },
    ];
    access.websites = [
      { host: "status.example.test", roles: ["investigator"] },
      { host: "docs.example.test", roles: ["automations"] },
    ];
    access.signalExceptions = [
      {
        signalId: "sig-1",
        role: "investigator",
        fields: { connections: [] },
        updatedBy: "Ada",
        updatedAt: "2026-10-20T10:00:00Z",
      },
    ];
  });
  const view = await getIncidentAccessSettings("acme");
  expect(view.isDefault).toBe(false);
  expect(view.revision).toBe(1);
  expect(view.grants).toEqual({
    connections: ["sentry"],
    repos: ["acme"],
    runners: [],
    hosts: [{ runner: "rn-prod", ssh: "db-1", access: "read-only" }],
    credentials: [
      {
        credential: "kc-proxy",
        mode: "standing",
        grantedBy: "Ada",
        grantedByLogin: "ada",
        grantedAt: "2026-10-20T10:00:00Z",
      },
    ],
    egress: [{ route: "server" }],
    maxMode: "code",
  });
  expect(view.profiles.investigator).toMatchObject({
    connections: ["sentry"],
    credentials: [{ credential: "kc-proxy", mode: "once" }],
    hosts: [{ runner: "rn-prod", ssh: "db-1", access: "read-only" }],
    egress: { route: "server", hosts: ["status.example.test"] },
  });
  expect(view.profiles.verifier).toMatchObject({
    connections: ["sentry"],
    credentials: [{ credential: "kc-proxy", mode: "standing" }],
    hosts: [],
    egress: { route: "server" },
  });
  expect(view.profiles.verifier.egress).not.toHaveProperty("hosts");
  expect(view.overrides).toEqual([
    {
      signalId: "sig-1",
      role: "investigator",
      fields: { connections: [] },
      updatedBy: "Ada",
      updatedAt: "2026-10-20T10:00:00Z",
    },
  ]);
  expect(view.credentialInfo["kc-proxy"]).toMatchObject({ scope: "personal" });
});

test("the old write API has moved", async () => {
  expect(await updateIncidentAccess("acme", { kind: "reset" })).toEqual({
    error: ACCESS_MOVED_ERROR,
    status: 410,
  });
  expect(await draftIncidentAccess("acme", {})).toEqual({
    error: ACCESS_MOVED_ERROR,
    status: 410,
  });
});

test("listeners hear committed project settings writes", async () => {
  const heard: string[] = [];
  const stop = onIncidentAccessChange((p) => heard.push(p));
  try {
    await setProjectAccessForTest("acme", (access) => {
      access.webSearch = [];
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(heard).toEqual(["acme"]);
  } finally {
    stop();
  }
});
