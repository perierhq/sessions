import { expect, test } from "bun:test";
import {
  type IncidentAccessSettings,
  defaultIncidentAccessSettings,
} from "../../../shared/incident-access";
import type { Incident, Signal } from "../../../shared/incidents";
import { catalogDocuments } from "../../catalog-documents";
import { createIncident } from "../incident-store";
import { createSignal } from "../signal-store";
import { useAccessTestEnv } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  registerAccessGate,
  resolveAgentAccess,
  resolveAgentAccessForBinding,
} from "./resolve";

const kit = useIncidentTestKernel();
const t = useAccessTestEnv();
const incident = (over: Partial<Incident> = {}): Incident => ({
  id: "inc-1",
  project: "acme",
  title: "Search",
  state: "investigating",
  severity: "major",
  owner: "Ada",
  openedBy: { kind: "rule" },
  signalIds: ["sig-search"],
  primarySignalId: "sig-search",
  openedAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T10:00:00Z",
  lastProblemAt: "2026-10-20T10:00:00Z",
  findings: [],
  events: [],
  droppedEvents: 0,
  ...over,
});
const signal = {
  id: "sig-search",
  name: "Search",
  project: "acme",
  enabled: true,
  severity: "major",
  createdBy: "Ada",
  createdAt: "x",
  updatedAt: "x",
  source: { kind: "http", url: "https://search.example.test/q" },
  rule: { kind: "consecutive", failures: 3 },
} as Signal;
const settings = (): IncidentAccessSettings => {
  const s = defaultIncidentAccessSettings("acme", "2026-10-20T10:00:00Z");
  s.grants = {
    ...s.grants,
    connections: ["sentry", "logs"],
    runners: ["rn-prod"],
    hosts: [{ runner: "rn-prod", access: "read-only" }],
    credentials: [
      {
        credential: "kc-proxy",
        mode: "standing",
        grantedBy: "Ada",
        grantedAt: "x",
      },
    ],
    egress: [{ route: "server" }, { route: "runner", runner: "rn-prod" }],
  };
  s.profiles.investigator = {
    ...s.profiles.investigator,
    connections: ["sentry", "logs"],
    runners: ["rn-prod"],
    egress: { route: "runner", runner: "rn-prod" },
  };
  s.overrides = [
    {
      signalId: "sig-search",
      role: "investigator",
      updatedBy: "Ada",
      updatedAt: "x",
      fields: {
        hosts: [{ runner: "rn-prod", access: "read-only" }],
        credentials: [{ credential: "kc-proxy", mode: "standing" }],
      },
    },
  ];
  return s;
};

test("role default plus signal override, with summary and revision", async () => {
  const a = await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(a).toMatchObject({
    overrideApplied: true,
    mode: "code",
    repos: ["acme"],
    connections: ["sentry", "logs"],
    hosts: [{ runner: "rn-prod", runnerName: "prod-1", access: "read-only" }],
    credentials: [
      {
        credential: "kc-proxy",
        service: "proxy-api",
        mode: "standing",
        scope: "personal",
      },
    ],
    egress: {
      route: "runner",
      runner: "rn-prod",
      runnerName: "prod-1",
      hosts: ["search.example.test"],
    },
    narrowed: [],
  });
  expect(a.summary).toBe(
    "Investigator · sentry, logs · can edit acme · reads prod-1 · proxy-api (standing) · egress via prod-1",
  );
  expect(a.revision).toMatch(/^[0-9a-f]{16}$/);
  expect(a.deniedTools).toMatchObject({
    mcp__plain__reply_to_thread: expect.any(String),
  });
  const v = await resolveAgentAccess("verifier", incident(), signal, {
    settings: settings(),
  });
  expect(v).toMatchObject({
    overrideApplied: false,
    mode: "ask",
    connections: [],
    hosts: [],
    egress: { route: "server", hosts: ["search.example.test"] },
  });
});
test("another signal gets the role default; an override from another project is ignored", async () => {
  const other = {
    ...signal,
    id: "sig-errors",
    source: { kind: "webhook" },
  } as Signal;
  const a = await resolveAgentAccess("investigator", incident(), other, {
    settings: settings(),
  });
  expect(a.hosts).toEqual([]);
  expect(a.egress).toBeNull();
  expect(a.narrowed).toContainEqual({
    field: "egress",
    item: "runner:rn-prod",
    reason: "No hosts to reach",
  });
  const foreign = { ...signal, project: "acme-api" } as Signal;
  expect(
    (
      await resolveAgentAccess("investigator", incident(), foreign, {
        settings: settings(),
      })
    ).overrideApplied,
  ).toBe(false);
});
test("closed, paused and gated incidents get nothing", async () => {
  await expect(
    resolveAgentAccess(
      "investigator",
      incident({ state: "resolved" }),
      signal,
      {
        settings: settings(),
      },
    ),
  ).rejects.toThrow("Incident inc-1 is resolved; its agents have no access");
  await expect(
    resolveAgentAccess("investigator", incident({ state: "paused" }), signal, {
      settings: settings(),
    }),
  ).rejects.toMatchObject({ code: "incident" });
  const off = registerAccessGate(() => "Agents are paused for acme");
  await expect(
    resolveAgentAccess("verifier", incident(), signal, {
      settings: settings(),
    }),
  ).rejects.toThrow("Agents are paused for acme");
  expect(
    await resolveAgentAccess("verifier", incident(), signal, {
      settings: settings(),
      gates: false,
    }),
  ).toBeDefined();
  off();
  await expect(
    resolveAgentAccess("responder" as never, incident(), signal, {
      settings: settings(),
    }),
  ).rejects.toMatchObject({ code: "role" });
});
test("a gate that throws refuses", async () => {
  const off = registerAccessGate(() => {
    throw new Error("budget store down");
  });
  await expect(
    resolveAgentAccess("verifier", incident(), signal, {
      settings: settings(),
    }),
  ).rejects.toMatchObject({ code: "gate" });
  off();
});
test("live state narrows instead of failing, and each narrowing is audited once", async () => {
  t.spec.runners = t.spec.runners.filter((r) => r.id !== "rn-prod");
  t.spec.credentials = t.spec.credentials.filter((c) => c.id !== "kc-proxy");
  t.spec.connections.logs = "missing";
  const a = await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(a).toMatchObject({
    connections: ["sentry"],
    hosts: [],
    credentials: [],
    egress: null,
  });
  expect(a.narrowed.map((n) => `${n.field}:${n.reason}`).sort()).toEqual([
    "connections:Connection is no longer available to incident agents",
    "credentials:Credential was deleted",
    "egress:Egress Runner was removed",
    "hosts:Runner was removed",
    "runners:Runner was removed",
  ]);
  await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(
    kit.audits.filter((e) => e.kind === "incident_access_narrowed"),
  ).toHaveLength(5);
});
test("a personal credential granted by someone else is dropped", async () => {
  const s = settings();
  s.grants.credentials[0].grantedBy = "Bo";
  expect(
    (
      await resolveAgentAccess("investigator", incident(), signal, {
        settings: s,
      })
    ).narrowed,
  ).toContainEqual({
    field: "credentials",
    item: "kc-proxy",
    reason: "Credential is personal and was not granted by its owner",
  });
});
test("settings beyond their grants fail closed", async () => {
  const s = settings();
  s.profiles.investigator.connections = ["sentry", "people-only"];
  await expect(
    resolveAgentAccess("investigator", incident(), signal, { settings: s }),
  ).rejects.toMatchObject({
    code: "settings",
    message: expect.stringContaining("exceed their grants"),
  });
});
test("stored settings are read when none are passed; unreadable ones refuse", async () => {
  expect(
    (await resolveAgentAccess("verifier", incident(), signal)).defaults,
  ).toBe(true);
  await catalogDocuments("incident-access").set("acme", { nope: 1 });
  await expect(
    resolveAgentAccess("verifier", incident(), signal),
  ).rejects.toMatchObject({
    code: "settings",
    message: expect.stringContaining("unreadable"),
  });
});
test("binding resolution reads the incident and signal; a missing incident refuses", async () => {
  await expect(
    resolveAgentAccessForBinding({
      incidentId: "inc-missing",
      role: "verifier",
      signalId: null,
      accessRevision: "x",
    }),
  ).rejects.toThrow("Incident inc-missing no longer exists");
});
test("binding resolution applies the bound signal's override; a deleted signal refuses", async () => {
  const sig = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://search.example.test/q" },
    },
    "Ada",
  );
  if ("error" in sig) throw new Error(sig.error);
  const inc = await createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule", ref: sig.id },
    signalIds: [sig.id],
    primarySignalId: sig.id,
    at: "2026-10-20T10:00:00.000Z",
    detail: "3 failures in a row",
  });
  const a = await resolveAgentAccessForBinding({
    incidentId: inc.id,
    role: "verifier",
    signalId: sig.id,
    accessRevision: "x",
  });
  expect(a).toMatchObject({
    incidentId: inc.id,
    role: "verifier",
    signalId: sig.id,
    mode: "ask",
  });
  await expect(
    resolveAgentAccessForBinding({
      incidentId: inc.id,
      role: "verifier",
      signalId: "sig-gone",
      accessRevision: "x",
    }),
  ).rejects.toThrow("Signal sig-gone no longer exists");
});
