import { expect, test } from "bun:test";
import {
  type IncidentAccessSettings,
  defaultIncidentAccessSettings,
} from "../../../shared/incident-access";
import type { Incident, Signal } from "../../../shared/incidents";
import { catalogDocuments } from "../../catalog-documents";
import { __setIdentitiesForTest } from "../../shared/user-mappings";
import { createIncident } from "../incident-store";
import { createSignal } from "../signal-store";
import { useAccessTestEnv } from "../testing/access-fixture";
import { useIncidentTestKernel } from "../testing/kernel-fixture";
import {
  accessSpawnSnapshot,
  registerAccessGate,
  resolveAgentAccess,
  resolveAgentAccessForBinding,
  VERIFIER_WEB_SEARCH_MESSAGE,
  WEB_SEARCH_OFF_MESSAGE,
} from "./resolve";
import { setProjectAccessForTest } from "../testing/project-access";
import { runToolPolicy } from "../../run-policy";

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
        grantedByLogin: "ada",
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
  // The verifier judges the evidence it is given: no web search. The
  // investigator keeps it.
  expect(v.deniedTools.web_search).toBe(VERIFIER_WEB_SEARCH_MESSAGE);
  expect(v.deniedTools.web_fetch).toBe(VERIFIER_WEB_SEARCH_MESSAGE);
  expect(a.deniedTools.web_search).toBeUndefined();
  expect(a.deniedTools.web_fetch).toBeUndefined();
  const verifierDisables = runToolPolicy({
    deniedTools: v.deniedTools,
  }).disables;
  expect(verifierDisables).toHaveProperty("web_search", false);
  expect(verifierDisables).toHaveProperty("web_fetch", false);
  const investigatorDisables = runToolPolicy({
    deniedTools: a.deniedTools,
  }).disables;
  expect(investigatorDisables).not.toHaveProperty("web_search");
  expect(investigatorDisables).not.toHaveProperty("web_fetch");
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
// The signal's own host is a default, not a grant: it passes the rules a
// saved egress host does (no IP literals, localhost or private suffixes).
test.each([
  ["http://127.0.0.1:8080/health", "127.0.0.1"],
  ["http://10.0.0.5/health", "10.0.0.5"],
  // The URL parser reads 0x7f.1 as 127.0.0.1.
  ["http://0x7f.1/health", "127.0.0.1"],
  ["http://[::1]:9000/health", "[::1]"],
  ["http://localhost:9000/health", "localhost"],
  ["https://metrics.internal/health", "metrics.internal"],
  ["https://printer.local/status", "printer.local"],
  ["https://intranet/health", "intranet"],
])("a signal host %s is not a default egress host", async (url, host) => {
  const s = settings();
  const v = await resolveAgentAccess(
    "verifier",
    incident(),
    { ...signal, source: { kind: "http", url } } as Signal,
    { settings: s },
  );
  expect(v.egress).toBeNull();
  expect(v.narrowed).toContainEqual({
    field: "egress",
    item: host,
    reason: "Signal host is not a public host name",
  });
  expect(v.narrowed).toContainEqual({
    field: "egress",
    item: "server",
    reason: "No hosts to reach",
  });
});
test("an expiry signal's private host is dropped too", async () => {
  const v = await resolveAgentAccess(
    "verifier",
    incident(),
    { ...signal, source: { kind: "expiry", host: "db.internal" } } as Signal,
    { settings: settings() },
  );
  expect(v.egress).toBeNull();
  expect(v.narrowed).toContainEqual({
    field: "egress",
    item: "db.internal",
    reason: "Signal host is not a public host name",
  });
});
// Agents run only in states listed for them; any other state, including one
// added later, refuses.
test.each([
  "investigating",
  "fix-ready",
  "veto",
  "deploying",
  "watching",
  "needs-you",
  "rolled-back",
])("agents may run while the incident is %s", async (state) => {
  expect(
    (
      await resolveAgentAccess(
        "investigator",
        incident({ state: state as Incident["state"] }),
        signal,
        { settings: settings() },
      )
    ).incidentId,
  ).toBe("inc-1");
});
test.each(["heads-up", "waiting-on-provider", "archived", ""])(
  "agents get nothing while the incident is %j",
  async (state) => {
    await expect(
      resolveAgentAccess(
        "investigator",
        incident({ state: state as Incident["state"] }),
        signal,
        { settings: settings() },
      ),
    ).rejects.toMatchObject({
      code: "incident",
      message: `Incident inc-1 is ${state}; its agents have no access`,
    });
  },
);
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
  ]);
  await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(
    kit.audits.filter((e) => e.kind === "incident_access_narrowed"),
  ).toHaveLength(4);
});
test.each([
  [{ platform: "win32" as const }, "Runner does not run on Linux or macOS"],
  [{ maintenance: true }, "Runner is in maintenance"],
  [{ allowedRepos: ["acme-api"] }, "Runner does not serve acme"],
])(
  "a host and egress Runner that turned %j is dropped",
  async (over, reason) => {
    Object.assign(
      t.spec.runners.find((r) => r.id === "rn-prod")!,
      over,
    );
    const a = await resolveAgentAccess("investigator", incident(), signal, {
      settings: settings(),
    });
    expect(a).toMatchObject({ hosts: [], egress: null });
    expect(a.narrowed).toEqual(
      expect.arrayContaining([
        { field: "hosts", item: "rn-prod", reason },
        { field: "egress", item: "runner:rn-prod", reason },
      ]),
    );
  },
);
test("a personal credential granted by someone else is dropped", async () => {
  const s = settings();
  s.grants.credentials[0].grantedBy = "Bo";
  s.grants.credentials[0].grantedByLogin = "bo";
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
test.each([
  ["without the granting login", { grantedByLogin: undefined }],
  [
    "by a teammate who shares the owner's first name",
    { grantedByLogin: "ada-byron" },
  ],
])("a personal credential granted %s is dropped", async (_label, over) => {
  __setIdentitiesForTest([
    { name: "Ada Lovelace", github: "ada" },
    { name: "Ada Byron", github: "ada-byron" },
  ]);
  t.spec.credentials[0].owner = "Ada Lovelace";
  const s = settings();
  Object.assign(s.grants.credentials[0], over);
  const access = await resolveAgentAccess("investigator", incident(), signal, {
    settings: s,
  });
  expect(access.credentials).toEqual([]);
  expect(access.narrowed).toContainEqual({
    field: "credentials",
    item: "kc-proxy",
    reason: "Credential is personal and was not granted by its owner",
  });
});
test("a personal credential whose owner name two teammates share is dropped", async () => {
  __setIdentitiesForTest([
    { name: "Ada Lovelace", github: "ada" },
    { name: "Ada Byron", github: "ada-byron" },
  ]);
  const access = await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(access.credentials).toEqual([]);
});
test("the owner's own grant survives", async () => {
  const access = await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(access.credentials.map((c) => c.credential)).toEqual(["kc-proxy"]);
});
test("settings breaking a role lock fail closed", async () => {
  const s = settings();
  s.profiles.verifier.mode = "code";
  await expect(
    resolveAgentAccess("verifier", incident(), signal, { settings: s }),
  ).rejects.toMatchObject({
    code: "settings",
    message: expect.stringContaining("break a role rule"),
  });
});
test("stored settings are read when none are passed; unreadable legacy ones read as the defaults", async () => {
  expect(
    (await resolveAgentAccess("verifier", incident(), signal)).defaults,
  ).toBe(true);
  await catalogDocuments("incident-access").set("acme", { nope: 1 });
  const a = await resolveAgentAccess("verifier", incident(), signal);
  expect(a).toMatchObject({ defaults: true, connections: [], mode: "ask" });
});
test("binding resolution reads the incident and signal; a missing incident refuses", async () => {
  await expect(
    resolveAgentAccessForBinding({
      incidentId: "inc-missing",
      role: "verifier",
      signalId: null,
      accessRevision: "x",
      spawn: { hosts: [], credentials: [], egress: null },
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
    spawn: { hosts: [], credentials: [], egress: null },
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
      spawn: { hosts: [], credentials: [], egress: null },
    }),
  ).rejects.toThrow("Signal sig-gone no longer exists");
});
test("a binding to a signal that is not the incident's refuses", async () => {
  const mine = await createSignal(
    {
      name: "Search",
      project: "acme",
      source: { kind: "http", url: "https://search.example.test/q" },
    },
    "Ada",
  );
  const other = await createSignal(
    {
      name: "Checkout",
      project: "acme",
      source: { kind: "http", url: "https://checkout.example.test/q" },
    },
    "Ada",
  );
  if ("error" in mine) throw new Error(mine.error);
  if ("error" in other) throw new Error(other.error);
  const inc = await createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule", ref: mine.id },
    signalIds: [mine.id],
    primarySignalId: mine.id,
    at: "2026-10-20T10:00:00.000Z",
    detail: "3 failures in a row",
  });
  // The other signal's override could be wider than this incident's.
  await expect(
    resolveAgentAccessForBinding({
      incidentId: inc.id,
      role: "investigator",
      signalId: other.id,
      accessRevision: "x",
      spawn: { hosts: [], credentials: [], egress: null },
    }),
  ).rejects.toMatchObject({
    code: "incident",
    message: `Signal ${other.id} is not part of incident ${inc.id}`,
  });
});

// A bound agent's access is held to what it was spawned with: widening the
// settings mid-incident reaches only agents spawned afterwards, while
// narrowing applies on the next call.
async function storedIncident(): Promise<Incident> {
  return createIncident({
    project: "acme",
    title: "Search",
    state: "investigating",
    severity: "major",
    owner: "Ada",
    openedBy: { kind: "rule" },
    signalIds: ["sig-search"],
    primarySignalId: "sig-search",
    at: "2026-10-20T10:00:00.000Z",
    detail: "3 failures in a row",
  });
}
const wideGrants = (s: IncidentAccessSettings) => {
  s.grants.hosts = [
    { runner: "rn-prod", access: "read-only" },
    { runner: "rn-prod", ssh: "db-1", access: "read-only" },
  ];
  s.grants.credentials = [
    {
      credential: "kc-proxy",
      mode: "standing",
      grantedBy: "Ada",
      grantedByLogin: "ada",
      grantedAt: "x",
    },
    {
      credential: "kc-shared",
      mode: "standing",
      grantedBy: "Bo",
      grantedByLogin: "bo",
      grantedAt: "x",
    },
  ];
  s.grants.egress = [
    { route: "server" },
    {
      route: "runner",
      runner: "rn-prod",
      hosts: ["search.example.test", "status.example.test"],
    },
  ];
  return s;
};
const store = (s: IncidentAccessSettings) =>
  catalogDocuments("incident-access").set("acme", s);
test("widening mid-incident reaches only new agents; narrowing applies at once", async () => {
  const inc = await storedIncident();
  const spawned = wideGrants(settings());
  spawned.overrides = [];
  spawned.profiles.investigator = {
    ...spawned.profiles.investigator,
    hosts: [{ runner: "rn-prod", access: "read-only" }],
    credentials: [{ credential: "kc-proxy", mode: "once" }],
    egress: {
      route: "runner",
      runner: "rn-prod",
      hosts: ["search.example.test"],
    },
  };
  await store(spawned);
  const first = await resolveAgentAccess("investigator", inc, null);
  const binding = {
    incidentId: inc.id,
    role: "investigator" as const,
    signalId: null,
    accessRevision: first.revision,
    spawn: accessSpawnSnapshot(first),
  };
  expect(binding.spawn).toEqual({
    hosts: ["rn-prod"],
    credentials: [{ credential: "kc-proxy", mode: "once" }],
    egress: {
      route: "runner",
      runner: "rn-prod",
      hosts: ["search.example.test"],
    },
  });

  const widened = structuredClone(spawned);
  widened.profiles.investigator = {
    ...widened.profiles.investigator,
    hosts: [
      { runner: "rn-prod", access: "read-only" },
      { runner: "rn-prod", ssh: "db-1", access: "read-only" },
    ],
    credentials: [
      { credential: "kc-proxy", mode: "standing" },
      { credential: "kc-shared", mode: "standing" },
    ],
    egress: {
      route: "runner",
      runner: "rn-prod",
      hosts: ["search.example.test", "status.example.test"],
    },
  };
  await store(widened);
  const bound = await resolveAgentAccessForBinding(binding);
  expect(bound).toMatchObject({
    hosts: [{ runner: "rn-prod", runnerName: "prod-1" }],
    credentials: [{ credential: "kc-proxy", mode: "once" }],
    egress: { route: "runner", hosts: ["search.example.test"] },
  });
  expect(bound.hosts).toHaveLength(1);
  expect(bound.credentials).toHaveLength(1);
  // Nothing the agent can reach changed, so neither did its revision.
  expect(bound.revision).toBe(first.revision);
  expect(bound.summary).toBe(first.summary);
  // A new agent gets the widened access.
  const fresh = await resolveAgentAccess("investigator", inc, null);
  expect(fresh.hosts).toHaveLength(2);
  expect(fresh.credentials).toMatchObject([
    { credential: "kc-proxy", mode: "standing" },
    { credential: "kc-shared", mode: "standing" },
  ]);

  const narrowed = structuredClone(spawned);
  narrowed.profiles.investigator = {
    ...narrowed.profiles.investigator,
    hosts: [],
    credentials: [],
    egress: {
      route: "runner",
      runner: "rn-prod",
      hosts: ["status.example.test"],
    },
  };
  await store(narrowed);
  expect(await resolveAgentAccessForBinding(binding)).toMatchObject({
    hosts: [],
    credentials: [],
    egress: null,
  });

  // Another route is not the one the agent was spawned with.
  const rerouted = structuredClone(spawned);
  rerouted.profiles.investigator = {
    ...rerouted.profiles.investigator,
    egress: { route: "server", hosts: ["search.example.test"] },
  };
  await store(rerouted);
  expect((await resolveAgentAccessForBinding(binding)).egress).toBeNull();
});
test("a credential lent once at spawn stays once when the settings make it standing", async () => {
  const inc = await storedIncident();
  const s = wideGrants(settings());
  s.overrides = [];
  s.profiles.investigator = {
    ...s.profiles.investigator,
    credentials: [{ credential: "kc-proxy", mode: "standing" }],
  };
  await store(s);
  const first = await resolveAgentAccess("investigator", inc, null);
  const binding = {
    incidentId: inc.id,
    role: "investigator" as const,
    signalId: null,
    accessRevision: first.revision,
    spawn: accessSpawnSnapshot(first),
  };
  // Narrowed to once: applies at once.
  s.profiles.investigator.credentials = [
    { credential: "kc-proxy", mode: "once" },
  ];
  await store(s);
  expect(
    (await resolveAgentAccessForBinding(binding)).credentials,
  ).toMatchObject([{ credential: "kc-proxy", mode: "once" }]);
  // A binding spawned at once never becomes standing.
  const onceBinding = {
    ...binding,
    spawn: {
      ...binding.spawn,
      credentials: [{ credential: "kc-proxy", mode: "once" as const }],
    },
  };
  s.profiles.investigator.credentials = [
    { credential: "kc-proxy", mode: "standing" },
  ];
  await store(s);
  expect(
    (await resolveAgentAccessForBinding(onceBinding)).credentials,
  ).toMatchObject([{ credential: "kc-proxy", mode: "once" }]);
  // A mode the snapshot does not know reads as once.
  const oddBinding = {
    ...binding,
    spawn: {
      ...binding.spawn,
      credentials: [
        { credential: "kc-proxy", mode: "forever" as unknown as "once" },
      ],
    },
  };
  expect(
    (await resolveAgentAccessForBinding(oddBinding)).credentials,
  ).toMatchObject([{ credential: "kc-proxy", mode: "once" }]);
});
test("a binding without a spawn snapshot reaches no host, credential or egress", async () => {
  const inc = await storedIncident();
  const s = wideGrants(settings());
  s.overrides = [];
  s.profiles.investigator = {
    ...s.profiles.investigator,
    hosts: [{ runner: "rn-prod", access: "read-only" }],
    credentials: [{ credential: "kc-proxy", mode: "once" }],
    egress: {
      route: "runner",
      runner: "rn-prod",
      hosts: ["search.example.test"],
    },
  };
  await store(s);
  const a = await resolveAgentAccessForBinding({
    incidentId: inc.id,
    role: "investigator",
    signalId: null,
    accessRevision: "x",
    spawn: { hosts: [], credentials: [], egress: null },
  } as unknown as Parameters<typeof resolveAgentAccessForBinding>[0]);
  expect(a).toMatchObject({ hosts: [], credentials: [], egress: null });
  expect(a.connections).toEqual(["sentry", "logs"]);
});
test("binding resolution without audit records no narrowing", async () => {
  const inc = await storedIncident();
  const s = wideGrants(settings());
  s.overrides = [];
  s.profiles.investigator = {
    ...s.profiles.investigator,
    hosts: [{ runner: "rn-prod", access: "read-only" }],
  };
  await store(s);
  t.spec.runners = t.spec.runners.filter((r) => r.id !== "rn-prod");
  const binding = {
    incidentId: inc.id,
    role: "investigator" as const,
    signalId: null,
    accessRevision: "x",
    spawn: { hosts: ["rn-prod"], credentials: [], egress: null },
  };
  const a = await resolveAgentAccessForBinding(binding, { audit: false });
  expect(a.narrowed.map((n) => n.field)).toContain("hosts");
  expect(
    kit.audits.filter((e) => e.kind === "incident_access_narrowed"),
  ).toEqual([]);
  await resolveAgentAccessForBinding(binding);
  expect(
    kit.audits.filter((e) => e.kind === "incident_access_narrowed").length,
  ).toBeGreaterThan(0);
});

test("a Runner reserved for this project's incidents serves hosts and egress only", async () => {
  Object.assign(
    t.spec.runners.find((r) => r.id === "rn-prod")!,
    {
      reserved: true,
      userRestricted: true,
      isolated: false,
      allowedRepos: ["acme"],
    },
  );
  const a = await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(a.hosts).toEqual([
    { runner: "rn-prod", runnerName: "prod-1", access: "read-only" },
  ]);
  expect(a.egress).toMatchObject({ route: "runner", runner: "rn-prod" });
  expect(a.runners).toEqual([]);
  // Reserved for another project's incidents: nothing.
  Object.assign(
    t.spec.runners.find((r) => r.id === "rn-prod")!,
    {
      allowedRepos: ["acme-api"],
    },
  );
  const b = await resolveAgentAccess("investigator", incident(), signal, {
    settings: settings(),
  });
  expect(b).toMatchObject({ hosts: [], egress: null, runners: [] });
});

test("the access table decides: a connector ticked only for automations, web search off", async () => {
  await setProjectAccessForTest("acme", (access) => {
    access.connections = [
      { server: "sentry", roles: ["automations"] },
      { server: "logs", roles: ["investigator", "reviews"] },
    ];
    access.webSearch = ["automations"];
  });
  const a = await resolveAgentAccess("investigator", incident(), signal);
  expect(a.connections).toEqual(["logs"]);
  expect(a.deniedTools.web_search).toBe(WEB_SEARCH_OFF_MESSAGE);
  expect(a.deniedTools.web_fetch).toBeUndefined();
  const v = await resolveAgentAccess("verifier", incident(), signal);
  expect(v.connections).toEqual([]);
  expect(v.deniedTools.web_search).toBe(VERIFIER_WEB_SEARCH_MESSAGE);
  await setProjectAccessForTest("acme", (access) => {
    access.webSearch = ["investigator"];
  });
  expect(
    (await resolveAgentAccess("investigator", incident(), signal)).deniedTools
      .web_search,
  ).toBeUndefined();
});
