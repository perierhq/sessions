// The live inputs and writers behind the project settings and defaults
// routes. Plain functions over the stores; nothing runs at import. The
// routes install the view inputs on first use, and tests replace any of
// them through the routes' and the view's test seams.

import { readFile } from "node:fs/promises";
import type { CredentialInfo } from "../../shared/incident-access";
import {
  PROJECT_ROLES,
  type EffectiveSandbox,
  type ProjectRole,
  type ProjectSettingsDocument,
  type RunPlace,
} from "../../shared/project-settings";
import { automationModel } from "../automations";
import { configuredPaths, configuredRepos } from "../config";
import { readMcpConfig, replaceMcpServerEntries } from "../connections";
import { incidentAudit } from "../incidents/audit-sink";
import { connectionStatusFrom } from "../incidents/access/environment";
import { projectMonthSpend } from "../incidents/response/coordinator";
import { resolveRoleModels } from "../incidents/response/models";
import {
  bindProductionRunner,
  listProductionRunnerCandidates,
} from "../incidents/response/runners";
import { listSignals } from "../incidents/signal-store";
import { ensureKeychainLoaded, listCredentials } from "../keychain";
import {
  interactiveDefaultModel,
  modelLabel,
  setInteractiveDefaultModel,
} from "../models";
import { globalPreviewsDefault } from "../projects/global-defaults";
import { legacyDrift, migrateProjectSettings } from "../projects/migrate";
import {
  getProjectDocument,
  patchProjectDocumentAsServer,
  projectExists,
  updateProjectDocument,
} from "../projects/store";
import {
  effectiveModelsFrom,
  setProjectViewDeps,
  type ProjectViewDeps,
} from "../projects/view";
import type { ConnectorState } from "../projects/readiness";
import { listRunners } from "../runners";
import {
  repoPortalSandbox,
  sandboxAutomationAvailability,
  sandboxAutomationConfig,
  sandboxConfig,
  setAutomationEgressAllowlist,
  setPortalSandboxDefault,
} from "../sandbox/config";
import {
  saveRepoPortalSandbox,
  saveWorkspaceSandboxDefault,
  workspaceSandboxDefault,
} from "../sandbox/defaults";
import type { ProjectDefaultsDeps } from "./project-defaults";
import type { ProjectRouteDeps } from "./projects";

const THIS_MACHINE = "This machine";
const CONTAINER = "This machine · container";

/** Connector names as people know them. */
const CONNECTOR_LABELS: Record<string, string> = {
  github: "GitHub",
  posthog: "PostHog",
};

function connectorLabel(server: string): string {
  return (
    CONNECTOR_LABELS[server] ?? server.charAt(0).toUpperCase() + server.slice(1)
  );
}

/** How a sandbox provider id reads ("Daytona eu"). */
export function sandboxProviderLabel(provider: string): string {
  if (provider === "podman") return CONTAINER;
  if (provider === "daytona") {
    const target = sandboxConfig().daytona?.target?.trim();
    return target ? `Daytona ${target}` : "Daytona";
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function place(
  provider: string | null,
  source: Extract<RunPlace, { state: "ok" }>["source"],
): RunPlace {
  return {
    state: "ok",
    provider,
    label: provider === null ? THIS_MACHINE : sandboxProviderLabel(provider),
    source,
  };
}

/**
 * Where each role runs, until projects/effective.ts (Task 3) replaces it:
 * the project's sandbox, else the global default. Automations need a
 * provider that runs unattended, else the global one, else this machine
 * (D3). Reviews run on this machine (D4).
 */
function interimEffectiveSandboxes(
  doc: ProjectSettingsDocument,
): EffectiveSandbox {
  const global = workspaceSandboxDefault();
  const globalProvider = global === "none" ? null : global;
  const own =
    doc.sandbox === "default"
      ? undefined
      : doc.sandbox === "local"
        ? null
        : doc.sandbox;
  const unattended = (p: string | null | undefined) =>
    p === sandboxAutomationConfig().provider &&
    sandboxAutomationAvailability().available;
  const agents = own !== undefined ? own : globalProvider;
  return {
    you:
      own !== undefined
        ? place(own, "project")
        : place(globalProvider, "default"),
    reviews: place(null, "fallback"),
    automations: unattended(own)
      ? place(own!, "project")
      : unattended(globalProvider)
        ? place(globalProvider, "default")
        : place(null, "fallback"),
    incidentAgents: agents
      ? place(agents, own !== undefined ? "project" : "default")
      : {
          state: "cant-start",
          reason: "Agents can't start: this project has no sandbox",
        },
    note: null,
  };
}

/** The global default model per role, until projects/global-defaults.ts
 *  (Task 3) stores one per role. */
function interimGlobalModel(role: ProjectRole): string {
  const automations = automationModel() ?? interactiveDefaultModel();
  if (role === "automations") return automations;
  if (role === "investigator" || role === "verifier") {
    const models = resolveRoleModels({});
    return "error" in models ? automations : models[role].model;
  }
  return interactiveDefaultModel();
}

async function readMcpServers(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(
      await readFile(configuredPaths().mcpConfig, "utf8"),
    ) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function liveConnectors(): Promise<ConnectorState[]> {
  const servers = await readMcpServers();
  return Object.entries(servers)
    .filter(([name]) => connectionStatusFrom(name, servers) !== "internal")
    .map(([name, raw]) => {
      const entry = (raw ?? {}) as {
        allowedUsers?: unknown;
        allowUnattended?: unknown;
      };
      const allowed = Array.isArray(entry.allowedUsers)
        ? entry.allowedUsers.filter(
            (u) => typeof u === "string" && u.trim() !== "",
          ).length
        : 0;
      return {
        server: name,
        label: connectorLabel(name),
        status: "ok" as const,
        allowedUsers: allowed,
        allowUnattended: entry.allowUnattended === true,
      };
    });
}

async function liveCredentials(): Promise<Record<string, CredentialInfo>> {
  await ensureKeychainLoaded();
  return Object.fromEntries(
    listCredentials().map((c) => [
      c.id,
      {
        service: c.service,
        host: c.host,
        owner: c.owner,
        scope: c.scope === "workspace" ? "workspace" : "personal",
        kind: c.kind === "login" ? "login" : "api",
      } satisfies CredentialInfo,
    ]),
  );
}

function liveViewDeps(): ProjectViewDeps {
  return {
    projectIds: () => Object.keys(configuredRepos()),
    projectExists,
    getDocument: getProjectDocument,
    previews: (project) => repoPortalSandbox(project) ?? "default",
    effectiveSandboxes: async (_project, doc) => interimEffectiveSandboxes(doc),
    effectiveModels: async (_project, doc) =>
      effectiveModelsFrom(doc, interimGlobalModel, (m) => modelLabel(m)),
    roleModels: async (_project, doc) =>
      resolveRoleModels({
        ...(doc.models.investigator
          ? { investigatorModel: doc.models.investigator }
          : {}),
        ...(doc.models.verifier ? { verifierModel: doc.models.verifier } : {}),
      }),
    runners: async (project, bound) => {
      const reserved = new Set(
        listRunners()
          .filter((r) => r.incidentReserved === true)
          .map((r) => r.id),
      );
      const candidates = await listProductionRunnerCandidates(project, bound);
      return candidates.map((r) => ({
        id: r.id,
        name: r.name,
        online: r.online,
        platform: r.platform,
        reserved: reserved.has(r.id),
        bound: r.bound,
        problem: r.problem,
      }));
    },
    signalCounts: async () => {
      const counts: Record<string, number> = {};
      for (const s of await listSignals())
        if (s.enabled) counts[s.project] = (counts[s.project] ?? 0) + 1;
      return counts;
    },
    connectors: liveConnectors,
    credentials: liveCredentials,
    monthSpendUsd: async (project) =>
      (await projectMonthSpend(project, Date.now())).monthUsd,
    drift: legacyDrift,
    sandboxLabel: sandboxProviderLabel,
  };
}

let installed = false;

/** Install the live view inputs once; cheap after the first call. */
export function installLiveProjectDeps(): void {
  if (installed) return;
  installed = true;
  setProjectViewDeps(liveViewDeps);
}

export function liveProjectRouteDeps(): ProjectRouteDeps {
  return {
    update: updateProjectDocument,
    patchAsServer: patchProjectDocumentAsServer,
    savePreviews: (project, value) => {
      // "same" and "default" both clear the project's own choice until
      // sandbox config can record "beside the session" per project.
      saveRepoPortalSandbox(
        project,
        value === "same" || value === "default" ? "none" : value,
      );
    },
    bindRunner: (project, runnerId, by, opts) =>
      bindProductionRunner(
        project,
        runnerId,
        by,
        { signedInPerson: true },
        { confirmShared: opts.confirmShared },
      ),
    allowUnattended: (server, on) => {
      const entry = readMcpConfig().mcpServers[server] as
        | Record<string, unknown>
        | undefined;
      if (!entry) return { error: `Server "${server}" not found` };
      const next = { ...entry };
      if (on) next.allowUnattended = true;
      else delete next.allowUnattended;
      return replaceMcpServerEntries({ [server]: next });
    },
    migrate: migrateProjectSettings,
    audit: incidentAudit,
  };
}

export function liveProjectDefaultsDeps(): ProjectDefaultsDeps {
  return {
    models: () =>
      Object.fromEntries(
        PROJECT_ROLES.map((role) => [role, interimGlobalModel(role)]),
      ) as Record<ProjectRole, string>,
    setModel: (role, id) => {
      // Task 3's setGlobalRoleDefault() stores the other roles.
      if (role !== "you")
        throw new Error("Only the default for You can be changed for now");
      setInteractiveDefaultModel(id);
    },
    sandbox: () => workspaceSandboxDefault(),
    setSandbox: (value) => {
      saveWorkspaceSandboxDefault(value);
    },
    previews: () => globalPreviewsDefault(),
    setPreviews: (value) => {
      setPortalSandboxDefault(value);
    },
    websites: () => [...(sandboxAutomationConfig().egressAllowlist ?? [])],
    setWebsites: (hosts) => {
      setAutomationEgressAllowlist(hosts);
    },
  };
}
