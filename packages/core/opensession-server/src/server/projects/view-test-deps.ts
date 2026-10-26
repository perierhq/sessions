// Test inputs for the project view and routes: acme-web as in the 4 of 6
// design, acme-api and docs-site on every default, all in memory.

import {
  defaultProjectDocument,
  type EffectiveSandbox,
  type ProjectSettingsDocument,
} from "../../shared/project-settings";
import { READY_4_OF_6 } from "../../shared/project-settings-fixtures";
import type { RoleModels } from "../incidents/response/models";
import type { ConnectorState } from "./readiness";
import {
  effectiveModelsFrom,
  type ProjectRunnerInfo,
  type ProjectViewDeps,
} from "./view";

export const TEST_PROJECTS = ["acme-web", "acme-api", "docs-site"];

const NOW = "2026-10-01T09:00:00.000Z";

export function acmeWebDocument(): ProjectSettingsDocument {
  const { releaseHookPath: _path, ...doc } = READY_4_OF_6.document;
  return structuredClone({ ...doc, releaseHookSecret: "fixture" });
}

const MODELS: RoleModels = {
  investigator: {
    model: "pi/anthropic/claude-opus-5-5",
    provider: "anthropic",
    label: "Opus 5.5",
  },
  verifier: {
    model: "pi/openai/gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    independence: "other-provider",
  },
};

const CONNECTORS: ConnectorState[] = [
  {
    server: "linear",
    label: "Linear",
    status: "ok",
    allowedUsers: 0,
    allowUnattended: false,
  },
  {
    server: "sentry",
    label: "Sentry",
    status: "ok",
    allowedUsers: 0,
    allowUnattended: false,
  },
  {
    server: "grafana",
    label: "Grafana",
    status: "ok",
    allowedUsers: 2,
    allowUnattended: false,
  },
];

const DAYTONA: EffectiveSandbox = {
  you: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "default",
  },
  reviews: {
    state: "ok",
    provider: null,
    label: "This machine",
    source: "fallback",
  },
  automations: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "default",
  },
  incidentAgents: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "default",
  },
  support: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "default",
  },
  note: null,
};

const GLOBAL_MODELS = {
  you: "pi/anthropic/claude-opus-5-5",
  automations: "pi/anthropic/claude-sonnet-5",
  investigator: "pi/anthropic/claude-opus-5-5",
  verifier: "pi/openai/gpt-5.5",
  reviews: "pi/anthropic/claude-opus-5-5",
  support: "pi/anthropic/claude-sonnet-5",
} as const;

const LABELS: Record<string, string> = {
  "pi/anthropic/claude-opus-5-5": "Opus 5.5",
  "pi/anthropic/claude-sonnet-5": "Sonnet 5",
  "pi/openai/gpt-5.5": "GPT-5.5",
};

export interface TestProjectStore {
  docs: Map<string, ProjectSettingsDocument>;
  deps: ProjectViewDeps;
}

/** In-memory view inputs; `docs` is the live store the deps read. */
export function testProjectViewDeps(): TestProjectStore {
  const docs = new Map<string, ProjectSettingsDocument>([
    ["acme-web", acmeWebDocument()],
  ]);
  const runners: ProjectRunnerInfo[] = [
    {
      id: "rn-prod-eu-1",
      name: "prod-eu-1",
      online: true,
      platform: "linux",
      reserved: true,
      bound: true,
      problem: null,
    },
  ];
  const deps: ProjectViewDeps = {
    projectIds: () => [...TEST_PROJECTS],
    projectExists: (id) => TEST_PROJECTS.includes(id),
    getDocument: async (id) =>
      structuredClone(docs.get(id) ?? defaultProjectDocument(id, NOW)),
    previews: () => "same",
    effectiveSandboxes: async (id) =>
      id === "acme-web" ? READY_4_OF_6.effective.sandbox : DAYTONA,
    effectiveModels: async (_id, doc) =>
      effectiveModelsFrom(
        doc,
        (role) => GLOBAL_MODELS[role],
        (m) => LABELS[m] ?? m,
      ),
    roleModels: async () => MODELS,
    runners: async (_id, bound) =>
      runners.map((r) => ({ ...r, bound: bound.includes(r.id) })),
    signalCounts: async () => ({ "acme-web": 2 }),
    connectors: async () => CONNECTORS,
    credentials: async () => ({
      "cred-cloudflare": {
        label: "Cloudflare token",
        service: "Cloudflare",
        host: "api.cloudflare.com",
        owner: "alex-doe",
        scope: "personal",
        kind: "api",
      },
      "cred-db-readonly": {
        label: "Production database, read only",
        service: "Postgres",
        host: "db.example.test",
        owner: "alex-doe",
        scope: "workspace",
        kind: "api",
      },
    }),
    monthSpendUsd: async () => 6.5,
    drift: async () => [],
    sandboxLabel: (p) => (p === "daytona" ? "Daytona eu" : p),
  };
  return { docs, deps };
}
