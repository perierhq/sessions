// Fixtures for the project settings contract, mirroring the designs:
// acme-web 4 of 6 ready (rollback missing, Grafana limited to named people,
// Daytona eu as the global default, prod-eu-1 as the production Runner),
// acme-web blocked with no sandbox, acme-web with every step ready, the
// global Defaults page and the project list. Used by the contract test and
// by frontend lanes before the API exists. Plain data only.

import type { IncidentAction } from "./incident-response";
import {
  ANY_WEBSITE_HOST,
  MODE_NOT_SET_HERE,
  MODE_SET_ELSEWHERE_LABEL,
  PROJECT_ROLES,
  defaultProjectDocument,
  type AccessCellView,
  type AccessRowKey,
  type AccessRowView,
  type AccessTableView,
  type EffectiveSandbox,
  type ProjectDefaultsView,
  type ProjectListItem,
  type ProjectReadiness,
  type ProjectRole,
  type ProjectSettingsDocument,
  type ProjectSettingsView,
  type ReadinessStep,
} from "./project-settings";

const NOW = "2026-10-01T09:00:00.000Z";
const MIGRATED_AT = "2026-09-30T18:00:00.000Z";

const OPUS = "pi/anthropic/claude-opus-5-5";
const SONNET = "pi/anthropic/claude-sonnet-5";
const GPT = "pi/openai/gpt-5.5";
const MODEL_LABELS: Record<string, string> = {
  [OPUS]: "Opus 5.5",
  [SONNET]: "Sonnet 5",
  [GPT]: "GPT-5.5",
};

const RUNNER_ID = "rn-prod-eu-1";
const RUNNER_NAME = "prod-eu-1";

const ANY_WEBSITE_ROW: AccessRowKey = {
  kind: "website",
  host: ANY_WEBSITE_HOST,
};

// ── Documents ────────────────────────────────────────────────────────────

function action(
  kind: "deploy" | "rollback",
  command: string,
  reversible: boolean,
): IncidentAction {
  return {
    id: `act-${kind}`,
    kind,
    label: kind === "deploy" ? "Deploy" : "Rollback",
    runner: RUNNER_ID,
    command,
    timeoutMs: 180_000,
    reversible,
    cost: { kind: "none" },
    needsSecret: false,
    scope: { services: [], paths: [], migrationPaths: [] },
  };
}

const DEPLOY = action(
  "deploy",
  "docker compose pull && docker compose up -d",
  true,
);
const ROLLBACK = action(
  "rollback",
  "IMAGE_TAG={{previousRef}} docker compose up -d",
  true,
);

function acmeWebDocument(
  over: Partial<ProjectSettingsDocument> = {},
): ProjectSettingsView["document"] {
  const base = defaultProjectDocument("acme-web", NOW);
  const { releaseHookSecret: _secret, ...doc }: ProjectSettingsDocument = {
    ...base,
    revision: 4,
    sandbox: "podman",
    models: { reviews: OPUS },
    incidents: {
      ...base.incidents,
      night: { start: "23:00", end: "07:00", timeZone: "UTC" },
      neverWithoutYou: ["costs-money", "needs-secret", "migration"],
      budget: { perIncidentUsd: 20, perMonthUsd: 100 },
    },
    production: { runners: [RUNNER_ID], actions: [DEPLOY], releases: [] },
    access: {
      ...base.access,
      connections: [
        { server: "linear", roles: ["automations", "investigator", "reviews"] },
        {
          server: "sentry",
          roles: ["automations", "investigator", "verifier", "reviews"],
        },
        {
          server: "grafana",
          roles: ["automations", "investigator", "verifier", "reviews"],
        },
      ],
      credentials: [
        {
          credential: "cred-cloudflare",
          roles: { investigator: "once" },
          grantedBy: "Alex Doe",
          grantedByLogin: "alex-doe",
          grantedAt: MIGRATED_AT,
        },
        {
          credential: "cred-db-readonly",
          roles: { investigator: "once", verifier: "once" },
          grantedBy: "Alex Doe",
          grantedByLogin: "alex-doe",
          grantedAt: MIGRATED_AT,
        },
      ],
      hosts: [
        {
          runner: RUNNER_ID,
          access: "read-only",
          roles: ["investigator", "verifier"],
        },
      ],
      websites: [
        {
          host: "api.example.test",
          roles: ["automations", "investigator", "verifier", "reviews"],
        },
        { host: "status.example.test", roles: ["investigator", "verifier"] },
      ],
    },
    automationId: "auto-incidents-acme-web",
    releaseHookSecret: "fixture-secret",
    migratedAt: MIGRATED_AT,
    updatedBy: "Alex Doe",
    ...over,
  };
  return { ...doc, releaseHookPath: "/incident-releases/acme-web/fixture" };
}

// ── Access table ─────────────────────────────────────────────────────────

const YOU_COMPUTED = "Interactive sessions follow Organization → Connections";
const INCIDENT_ONLY = "Only incident agents have this enforced";

function cell(
  value: AccessCellView["value"],
  editable = true,
  reason?: string,
): AccessCellView {
  return reason ? { value, editable, reason } : { value, editable };
}

function cells(
  you: AccessCellView,
  rest: Record<Exclude<ProjectRole, "you">, AccessCellView>,
): Record<ProjectRole, AccessCellView> {
  return { you, ...rest };
}

function tick(on: boolean): AccessCellView {
  return cell(on ? "yes" : "no");
}

function connectionRow(
  server: string,
  title: string,
  roles: string[],
  blockedBy?: string,
): AccessRowView {
  const value = (role: Exclude<ProjectRole, "you">) => {
    const on = roles.includes(role);
    return on && blockedBy ? cell("blocked", true, blockedBy) : tick(on);
  };
  const row: AccessRowView = {
    key: { kind: "connection", server },
    title,
    cells: cells(cell("yes", false, YOU_COMPUTED), {
      automations: value("automations"),
      investigator: value("investigator"),
      verifier: value("verifier"),
      reviews: value("reviews"),
      support: value("support"),
    }),
  };
  if (blockedBy) {
    row.warning = {
      text: blockedBy,
      fix: { kind: "allow-agents", server },
    };
  }
  return row;
}

function keychainRow(
  credential: string,
  title: string,
  investigator: AccessCellView["value"],
  verifier: AccessCellView["value"],
): AccessRowView {
  return {
    key: { kind: "credential", credential },
    title,
    cells: cells(
      cell("ask-each", false, "Lent per request from your keychain"),
      {
        automations: cell("no", false, INCIDENT_ONLY),
        investigator: cell(investigator),
        verifier: cell(verifier),
        reviews: cell("no", false, INCIDENT_ONLY),
        support: cell("no", false, INCIDENT_ONLY),
      },
    ),
  };
}

function accessTable(opts: { grafanaBlocked: boolean }): AccessTableView {
  const grafanaWarning = opts.grafanaBlocked
    ? "Limited to 2 people, so agents can't open it"
    : undefined;
  return {
    groups: [
      {
        id: "code",
        label: null,
        rows: [
          {
            key: { kind: "mode" },
            title: "Changes code in acme-web",
            cells: cells(cell("yes", false, YOU_COMPUTED), {
              automations: {
                ...cell("elsewhere", false, MODE_NOT_SET_HERE.automations),
                label: MODE_SET_ELSEWHERE_LABEL.automations,
              },
              investigator: cell("branch"),
              verifier: cell("read"),
              reviews: {
                ...cell("elsewhere", false, MODE_NOT_SET_HERE.reviews),
                label: MODE_SET_ELSEWHERE_LABEL.reviews,
              },
              support: cell("read"),
            }),
          },
        ],
      },
      {
        id: "connectors",
        label: "Connectors",
        rows: [
          connectionRow("linear", "Linear", [
            "automations",
            "investigator",
            "reviews",
          ]),
          connectionRow("sentry", "Sentry", [
            "automations",
            "investigator",
            "verifier",
            "reviews",
          ]),
          connectionRow(
            "grafana",
            "Grafana",
            ["automations", "investigator", "verifier", "reviews"],
            grafanaWarning,
          ),
        ],
      },
      {
        id: "keychain",
        label: "Keychain",
        rows: [
          keychainRow("cred-cloudflare", "Cloudflare token", "ask-once", "no"),
          keychainRow(
            "cred-db-readonly",
            "Production database, read only",
            "ask-once",
            "ask-once",
          ),
        ],
      },
      {
        id: "production",
        label: "Production",
        rows: [
          {
            key: { kind: "host", runner: RUNNER_ID },
            title: `${RUNNER_NAME}, read-only commands`,
            detail: "Logs, disk, processes. Never writes",
            cells: cells(cell("no", false, "You reach production yourself"), {
              automations: cell("no", false, INCIDENT_ONLY),
              investigator: cell("yes"),
              verifier: cell("yes"),
              reviews: cell("no", false, INCIDENT_ONLY),
              support: cell("no", false, INCIDENT_ONLY),
            }),
          },
        ],
      },
      {
        id: "websites",
        label: "Websites agents may open",
        rows: [
          {
            key: ANY_WEBSITE_ROW,
            title: "Any website",
            detail: "Only you. Unattended runs need a list",
            cells: cells(cell("yes", false, YOU_COMPUTED), {
              automations: cell("locked", false, "Unattended runs need a list"),
              investigator: cell(
                "locked",
                false,
                "Unattended runs need a list",
              ),
              verifier: cell("locked", false, "Unattended runs need a list"),
              reviews: cell("locked", false, "Unattended runs need a list"),
              support: cell("locked", false, "Unattended runs need a list"),
            }),
          },
          {
            key: { kind: "website", host: "api.example.test" },
            title: "api.example.test",
            cells: cells(cell("yes", false, YOU_COMPUTED), {
              automations: tick(true),
              investigator: tick(true),
              verifier: tick(true),
              reviews: tick(true),
              support: tick(false),
            }),
          },
          {
            key: { kind: "website", host: "status.example.test" },
            title: "status.example.test",
            cells: cells(cell("yes", false, YOU_COMPUTED), {
              automations: tick(false),
              investigator: tick(true),
              verifier: tick(true),
              reviews: tick(false),
              support: tick(false),
            }),
          },
        ],
      },
      {
        id: "search",
        label: null,
        rows: [
          {
            key: { kind: "webSearch" },
            title: "Search the web",
            detail: "Never the verifier, by design",
            cells: cells(cell("yes", false, YOU_COMPUTED), {
              automations: tick(true),
              investigator: tick(true),
              verifier: cell("locked", false, "Never the verifier, by design"),
              reviews: tick(true),
              support: tick(false),
            }),
          },
        ],
      },
    ],
    signalExceptions: [],
  };
}

// ── Readiness ────────────────────────────────────────────────────────────

const STEP_MODELS: ReadinessStep = {
  id: "models",
  state: "ready",
  title: "Models",
  detail: "Opus 5.5 investigates, GPT-5.5 verifies",
};
const STEP_WHERE: ReadinessStep = {
  id: "where",
  state: "ready",
  title: "Where agents run",
  detail: "Incident agents run on this machine in a container",
};
const STEP_PRODUCTION: ReadinessStep = {
  id: "production",
  state: "ready",
  title: "Production",
  detail: `${RUNNER_NAME} is online`,
};
const STEP_SIGNALS: ReadinessStep = {
  id: "signals",
  state: "ready",
  title: "Signals",
  detail: "2 signals check acme-web",
};
const STEP_ROLLBACK: ReadinessStep = {
  id: "deploy",
  state: "todo",
  title: "Rollback",
  detail: "Deploy is set. Without a rollback, a bad fix stays live",
  fix: { kind: "add-action", action: "rollback" },
};
const STEP_LOGS: ReadinessStep = {
  id: "access",
  state: "todo",
  title: "Logs for agents",
  detail: "Grafana is limited to 2 people, so agents can't open it",
  fix: { kind: "allow-agents", server: "grafana" },
};
const STEP_WHERE_BLOCKED: ReadinessStep = {
  id: "where",
  state: "blocked",
  title: "Where agents run",
  detail:
    "acme-web uses this machine, which can't run incident agents, and no sandbox provider is connected for them to fall back to",
  fix: { kind: "connect-sandbox" },
};

const READINESS_4_OF_6: ProjectReadiness = {
  steps: [
    STEP_ROLLBACK,
    STEP_LOGS,
    STEP_MODELS,
    STEP_WHERE,
    STEP_PRODUCTION,
    STEP_SIGNALS,
  ],
  readyCount: 4,
  total: 6,
  blocking: null,
  status: { kind: "partial", label: "4 of 6 ready" },
};

const READINESS_BLOCKED: ProjectReadiness = {
  steps: [
    STEP_WHERE_BLOCKED,
    STEP_ROLLBACK,
    STEP_LOGS,
    STEP_MODELS,
    STEP_PRODUCTION,
    STEP_SIGNALS,
  ],
  readyCount: 3,
  total: 6,
  blocking: STEP_WHERE_BLOCKED,
  status: { kind: "blocked", label: "Can't start" },
};

const READINESS_ALL: ProjectReadiness = {
  steps: [
    STEP_MODELS,
    { ...STEP_WHERE, detail: "Incident agents run in Daytona eu" },
    STEP_PRODUCTION,
    STEP_SIGNALS,
    {
      id: "deploy",
      state: "ready",
      title: "Deploy and rollback",
      detail: "Both run on prod-eu-1",
    },
    {
      id: "access",
      state: "ready",
      title: "What agents may use",
      detail: "Every connector ticked for agents can be opened",
    },
  ],
  readyCount: 6,
  total: 6,
  blocking: null,
  status: { kind: "ready", label: "Ready" },
};

// ── Effective sandbox and models ─────────────────────────────────────────

const THIS_MACHINE = "This machine";
const CONTAINER = "This machine · container";

const SANDBOX_PODMAN: EffectiveSandbox = {
  you: { state: "ok", provider: "podman", label: CONTAINER, source: "project" },
  reviews: {
    state: "ok",
    provider: null,
    label: THIS_MACHINE,
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
    provider: "podman",
    label: CONTAINER,
    source: "project",
  },
  support: {
    state: "ok",
    provider: "podman",
    label: CONTAINER,
    source: "project",
  },
  note: "Sessions, reviews and incident agents run here. Automations use the global default",
};

const SANDBOX_NONE: EffectiveSandbox = {
  you: { state: "ok", provider: null, label: THIS_MACHINE, source: "project" },
  reviews: {
    state: "ok",
    provider: null,
    label: THIS_MACHINE,
    source: "fallback",
  },
  automations: {
    state: "ok",
    provider: null,
    label: THIS_MACHINE,
    source: "fallback",
  },
  incidentAgents: {
    state: "cant-start",
    reason: "Agents can't start: this project has no sandbox",
  },
  support: {
    state: "cant-start",
    reason: "Agents can't start: this project has no sandbox",
  },
  note: "No sandbox provider is connected, so incident agents can't start. Connect one in the checklist above",
};

const SANDBOX_DAYTONA: EffectiveSandbox = {
  you: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "project",
  },
  reviews: {
    state: "ok",
    provider: null,
    label: THIS_MACHINE,
    source: "fallback",
  },
  automations: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "project",
  },
  incidentAgents: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "project",
  },
  support: {
    state: "ok",
    provider: "daytona",
    label: "Daytona eu",
    source: "project",
  },
  note: null,
};

const DEFAULT_MODELS: Record<ProjectRole, string> = {
  you: OPUS,
  automations: SONNET,
  investigator: OPUS,
  verifier: GPT,
  reviews: OPUS,
  support: SONNET,
};

function effectiveModels(
  set: Partial<Record<ProjectRole, string>>,
): ProjectSettingsView["effective"]["models"] {
  const out = {} as ProjectSettingsView["effective"]["models"];
  for (const role of PROJECT_ROLES) {
    const model = set[role] ?? DEFAULT_MODELS[role];
    out[role] = {
      model,
      label: MODEL_LABELS[model] ?? model,
      source: set[role] ? "project" : "default",
    };
  }
  return out;
}

const RUNNERS: ProjectSettingsView["runners"] = [
  {
    id: RUNNER_ID,
    name: RUNNER_NAME,
    online: true,
    platform: "linux",
    reserved: true,
  },
];

// ── Views ────────────────────────────────────────────────────────────────

const READY_DOC = acmeWebDocument();

export const READY_4_OF_6: ProjectSettingsView = {
  document: READY_DOC,
  previews: "same",
  effective: {
    sandbox: SANDBOX_PODMAN,
    models: effectiveModels(READY_DOC.models),
  },
  access: accessTable({ grafanaBlocked: true }),
  readiness: READINESS_4_OF_6,
  runners: RUNNERS,
  monthSpendUsd: 6.5,
  drift: false,
};

const BLOCKED_DOC = acmeWebDocument({ sandbox: "local", revision: 2 });

export const BLOCKED_NO_SANDBOX: ProjectSettingsView = {
  document: BLOCKED_DOC,
  previews: "same",
  effective: {
    sandbox: SANDBOX_NONE,
    models: effectiveModels(BLOCKED_DOC.models),
  },
  access: accessTable({ grafanaBlocked: true }),
  readiness: READINESS_BLOCKED,
  runners: RUNNERS,
  monthSpendUsd: 0,
  drift: false,
};

const ALL_READY_DOC = acmeWebDocument({
  sandbox: "daytona",
  revision: 7,
  production: {
    runners: [RUNNER_ID],
    actions: [DEPLOY, ROLLBACK],
    releases: [],
  },
});

export const ALL_READY: ProjectSettingsView = {
  document: ALL_READY_DOC,
  previews: "same",
  effective: {
    sandbox: SANDBOX_DAYTONA,
    models: effectiveModels(ALL_READY_DOC.models),
  },
  access: accessTable({ grafanaBlocked: false }),
  readiness: READINESS_ALL,
  runners: RUNNERS,
  monthSpendUsd: 6.5,
  drift: false,
};

export const PROJECT_LIST: ProjectListItem[] = [
  {
    id: "acme-web",
    label: "acme-web",
    status: READINESS_4_OF_6.status,
    sandboxForYou: "podman",
    modelForYou: OPUS,
  },
  {
    id: "acme-api",
    label: "acme-api",
    status: { kind: "off", label: "Incidents off" },
    sandboxForYou: "daytona",
    modelForYou: OPUS,
  },
  {
    id: "docs-site",
    label: "docs-site",
    status: { kind: "off", label: "Incidents off" },
    sandboxForYou: "daytona",
    modelForYou: OPUS,
  },
];

export const DEFAULTS_VIEW: ProjectDefaultsView = {
  models: { ...DEFAULT_MODELS },
  sandbox: "daytona",
  sandboxUsedBy: "Used by acme-api, docs-site, and acme-web's automations",
  previews: "same",
  websites: ["api.example.test"],
  projects: PROJECT_LIST,
};
