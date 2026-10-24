import { expect, test } from "bun:test";
import {
  defaultIncidentAccessSettings,
  defaultRoleProfile,
  type IncidentAccessSettings,
} from "../../shared/incident-access";
import { canonicalModelId } from "../incidents/response/models";
import { composeFromLegacy, type LegacySources } from "./legacy";

const NOW = "2026-10-01T09:00:00.000Z";
const OPUS = "pi/anthropic/claude-opus-5-5";
const GPT = "pi/openai/gpt-5.5";

function sources(over: Partial<LegacySources> = {}): LegacySources {
  return {
    incidentProject: null,
    access: null,
    sessionDefault: null,
    automationServers: [],
    reviewServers: ["grafana", "linear"],
    reviewModel: null,
    mcpServers: ["grafana", "linear", "sentry"],
    webSearch: "auto",
    ...over,
  };
}

const deploy = {
  id: "deploy",
  kind: "deploy",
  label: "Deploy",
  runner: "rn-prod",
  command: "./deploy.sh {{ref}}",
  timeoutMs: 600_000,
  reversible: true,
  cost: { kind: "none" },
  needsSecret: false,
  scope: { services: [], paths: [], migrationPaths: [] },
};

function legacyAccess(
  edit: (s: IncidentAccessSettings) => void = () => {},
): IncidentAccessSettings {
  const s = defaultIncidentAccessSettings("acme-web", "2026-09-01T00:00:00Z");
  s.revision = 3;
  s.updatedBy = "Ada";
  s.grants = {
    connections: ["grafana", "linear", "sentry"],
    repos: ["acme-web"],
    runners: [],
    hosts: [
      { runner: "rn-prod", access: "read-only" },
      { runner: "rn-prod", ssh: "db", access: "read-only" },
    ],
    credentials: [
      {
        credential: "cred-grafana",
        mode: "standing",
        grantedBy: "Ada",
        grantedByLogin: "ada",
        grantedAt: "2026-09-01T00:00:00Z",
      },
    ],
    egress: [{ route: "server", hosts: ["status.example.test"] }],
    maxMode: "code",
  };
  s.profiles = {
    investigator: {
      ...defaultRoleProfile("investigator", "acme-web"),
      connections: ["grafana", "linear"],
      hosts: [{ runner: "rn-prod", access: "read-only" }],
      credentials: [{ credential: "cred-grafana", mode: "once" }],
      deniedTools: ["bash"],
      egress: { route: "server", hosts: ["api.example.test"] },
    },
    verifier: {
      ...defaultRoleProfile("verifier", "acme-web"),
      connections: ["grafana"],
      egress: { route: "server" },
    },
  };
  edit(s);
  return s;
}

test("a full legacy pair composes field by field", () => {
  const { document: d, report } = composeFromLegacy(
    "acme-web",
    sources({
      incidentProject: {
        project: "acme-web",
        agentsPaused: true,
        autonomy: "propose",
        vetoMs: 1_200_000,
        watchMs: 900_000,
        maxRounds: 3,
        night: { start: "23:00", end: "07:00", timeZone: "Europe/Warsaw" },
        neverWithoutYou: ["migration"],
        budget: { perIncidentUsd: 10, perMonthUsd: 100 },
        agents: { investigatorModel: OPUS, verifierModel: GPT },
        productionRunners: ["rn-prod"],
        actions: [deploy],
        releases: [{ at: NOW, source: "hook" }],
        automationId: "auto-1",
        releaseHookSecret: "a".repeat(48),
      },
      access: legacyAccess(),
      sessionDefault: "podman",
    }),
    NOW,
  );
  expect(d.incidents).toEqual({
    agentsPaused: true,
    autonomy: "propose",
    vetoMs: 1_200_000,
    watchMs: 900_000,
    maxRounds: 3,
    night: { start: "23:00", end: "07:00", timeZone: "Europe/Warsaw" },
    neverWithoutYou: ["migration"],
    budget: { perIncidentUsd: 10, perMonthUsd: 100 },
  });
  expect(d.production).toEqual({
    runners: ["rn-prod"],
    actions: [deploy as never],
    releases: [{ at: NOW, source: "hook" }],
  });
  expect(d.automationId).toBe("auto-1");
  expect(d.releaseHookSecret).toBe("a".repeat(48));
  expect(d.models).toEqual({
    investigator: OPUS,
    verifier: canonicalModelId(GPT),
  });
  expect(d.sandbox).toBe("podman");
  expect(d.revision).toBe(0);
  expect(d.access.modes).toEqual({
    automations: "code",
    investigator: "code",
    verifier: "ask",
    reviews: "code",
  });
  expect(d.access.connections).toEqual([
    { server: "grafana", roles: ["investigator", "verifier", "reviews"] },
    { server: "linear", roles: ["investigator", "reviews"] },
  ]);
  expect(d.access.credentials).toEqual([
    {
      credential: "cred-grafana",
      roles: { investigator: "once" },
      grantedBy: "Ada",
      grantedByLogin: "ada",
      grantedAt: "2026-09-01T00:00:00Z",
    },
  ]);
  expect(d.access.hosts).toEqual([
    { runner: "rn-prod", access: "read-only", roles: ["investigator"] },
  ]);
  // The verifier's route has no hosts of its own: the project route's apply.
  expect(d.access.websites).toEqual([
    { host: "api.example.test", roles: ["investigator"] },
    { host: "status.example.test", roles: ["verifier"] },
  ]);
  expect(d.access.routes).toEqual({
    investigator: { route: "server" },
    verifier: { route: "server" },
  });
  expect(d.access.deniedTools).toEqual({
    investigator: ["bash"],
    verifier: [],
  });
  expect(d.access.webSearch).toEqual([
    "automations",
    "investigator",
    "reviews",
  ]);
  expect(report).toEqual({
    project: "acme-web",
    access: "migrated",
    dropped: [
      { field: "access.connections", item: "sentry", why: "No agent used it" },
      { field: "access.hosts", item: "rn-prod>db", why: "No agent used it" },
    ],
  });
});

test("the profile model wins over the project's, which is reported", () => {
  const { document, report } = composeFromLegacy(
    "acme-web",
    sources({
      incidentProject: { agents: { investigatorModel: GPT } },
      access: legacyAccess((s) => {
        s.profiles.investigator.model = OPUS;
      }),
    }),
    NOW,
  );
  expect(document.models.investigator).toBe(OPUS);
  expect(report.dropped).toContainEqual({
    field: "models.investigator",
    item: GPT,
    why: "The access profile's model won at runtime",
  });
});

test("Runners are dropped once each: they had no effect", () => {
  const { report } = composeFromLegacy(
    "acme-web",
    sources({
      access: legacyAccess((s) => {
        s.grants.runners = ["r1"];
      }),
    }),
    NOW,
  );
  expect(report.dropped.filter((d) => d.item === "r1")).toEqual([
    { field: "access.runners", item: "r1", why: "Runners had no effect" },
  ]);
});

test("an automation mounting every server gives automations every server", () => {
  const { document } = composeFromLegacy(
    "acme-web",
    sources({
      automationServers: [["linear"], undefined],
      reviewServers: [],
    }),
    NOW,
  );
  expect(document.access.connections).toEqual([
    { server: "grafana", roles: ["automations"] },
    { server: "linear", roles: ["automations"] },
    { server: "sentry", roles: ["automations"] },
  ]);
});

test("named automation servers, the review model and web search off", () => {
  const { document } = composeFromLegacy(
    "acme-web",
    sources({
      automationServers: [["linear"], ["sentry"]],
      reviewServers: ["sentry"],
      reviewModel: "opus",
      webSearch: "off",
      sessionDefault: "none",
    }),
    NOW,
  );
  expect(document.access.connections).toEqual([
    { server: "linear", roles: ["automations"] },
    { server: "sentry", roles: ["automations", "reviews"] },
  ]);
  expect(document.models.reviews).toBe(OPUS);
  expect(document.access.webSearch).toEqual(["investigator", "reviews"]);
  expect(document.sandbox).toBe("local");
});

test("signal overrides keep everything but the model and Runners", () => {
  const { document, report } = composeFromLegacy(
    "acme-web",
    sources({
      access: legacyAccess((s) => {
        s.overrides = [
          {
            signalId: "sig-1",
            role: "investigator",
            fields: { model: "m", connections: ["linear"] },
            updatedBy: "Ada",
            updatedAt: NOW,
          },
        ];
      }),
    }),
    NOW,
  );
  expect(document.access.signalExceptions[0]?.fields).toEqual({
    connections: ["linear"],
  });
  expect(report.dropped).toContainEqual({
    field: "access.signalExceptions.sig-1.investigator.model",
    item: "m",
    why: "Per-signal models are not allowed",
  });
});

test("signal exceptions keep only what the access table allows", () => {
  const { document, report } = composeFromLegacy(
    "acme-web",
    sources({
      access: legacyAccess((s) => {
        s.overrides = [
          {
            signalId: "sig-1",
            role: "investigator",
            fields: {
              // sentry was granted but no agent used it, so the table
              // doesn't list it.
              connections: ["linear", "sentry"],
              hosts: [
                { runner: "rn-prod", access: "read-only" },
                { runner: "rn-prod", ssh: "db", access: "read-only" },
              ],
              egress: {
                route: "server",
                hosts: ["api.example.test", "elsewhere.example.test"],
              },
            },
            updatedBy: "Ada",
            updatedAt: NOW,
          },
          {
            signalId: "sig-2",
            role: "verifier",
            fields: { egress: { route: "runner", runner: "rn-prod" } },
            updatedBy: "Ada",
            updatedAt: NOW,
          },
        ];
      }),
    }),
    NOW,
  );
  expect(document.access.signalExceptions.map((e) => e.fields)).toEqual([
    {
      connections: ["linear"],
      hosts: [{ runner: "rn-prod", access: "read-only" }],
      egress: { route: "server", hosts: ["api.example.test"] },
    },
  ]);
  const why = "Outside the project's access table";
  for (const [field, item] of [
    ["access.signalExceptions.sig-1.investigator.connections", "sentry"],
    ["access.signalExceptions.sig-1.investigator.hosts", "rn-prod>db"],
    [
      "access.signalExceptions.sig-1.investigator.egress",
      "elsewhere.example.test",
    ],
    ["access.signalExceptions.sig-2.verifier.egress", "runner:rn-prod"],
  ])
    expect(report.dropped).toContainEqual({ field, item, why });
});

test("unreadable access composes the default access", () => {
  const { document, report } = composeFromLegacy(
    "acme-web",
    sources({ access: { garbage: true }, reviewServers: [] }),
    NOW,
  );
  expect(report.access).toBe("reset-unreadable");
  expect(document.access.connections).toEqual([]);
  expect(document.access.modes.verifier).toBe("ask");
});
