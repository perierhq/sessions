// The live inputs and writers behind the project settings and defaults
// routes. Plain functions over the stores; nothing runs at import. The
// routes install the view inputs on first use, and tests replace any of
// them through the routes' and the view's test seams.

import { readFile } from "node:fs/promises";
import type { CredentialInfo } from "../../shared/incident-access";
import {
  PROJECT_ROLES,
  type EffectiveRoleModel,
  type ProjectRole,
  type ProjectSettingsDocument,
} from "../../shared/project-settings";
import { configuredPaths, configuredRepos } from "../config";
import { readMcpConfig, replaceMcpServerEntries } from "../connections";
import { incidentAudit } from "../incidents/audit-sink";
import { connectionStatusFrom } from "../incidents/access/environment";
import { projectMonthSpend } from "../incidents/response/coordinator";
import { resolveRoleModels, sameModel } from "../incidents/response/models";
import {
  bindProductionRunner,
  listProductionRunnerCandidates,
} from "../incidents/response/runners";
import { listSignals } from "../incidents/signal-store";
import { ensureKeychainLoaded, listCredentials } from "../keychain";
import { modelLabel, resolveModel } from "../models";
import {
  defaultRoleModel,
  effectiveRoleModel,
  effectiveSandboxes,
  sandboxLabel,
} from "../projects/effective";
import {
  globalPreviewsDefault,
  globalRoleDefault,
  globalWebsites,
  setGlobalRoleDefault,
} from "../projects/global-defaults";
import { legacyDrift, migrateProjectSettings } from "../projects/migrate";
import {
  getProjectDocument,
  patchProjectDocumentAsServer,
  projectExists,
  updateProjectDocument,
} from "../projects/store";
import { setProjectViewDeps, type ProjectViewDeps } from "../projects/view";
import type { ConnectorState } from "../projects/readiness";
import { listRunners } from "../runners";
import {
  repoPortalSandbox,
  setAutomationEgressAllowlist,
  setPortalSandboxDefault,
} from "../sandbox/config";
import {
  previewsDefaultProblem,
  saveRepoPortalSandbox,
  saveWorkspaceSandboxDefault,
  workspaceSandboxDefault,
  workspaceSandboxProblem,
} from "../sandbox/defaults";
import type { ProjectDefaultsDeps } from "./project-defaults";
import type { ProjectRouteDeps } from "./projects";

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

/** Every role's model in `project`: its own, else what the runtime falls
 *  back to (the role's global default, else today's built-in choice). */
async function liveEffectiveModels(
  project: string,
  doc: ProjectSettingsDocument,
): Promise<Record<ProjectRole, EffectiveRoleModel>> {
  const entries = await Promise.all(
    PROJECT_ROLES.map(async (role) => {
      const model = await effectiveRoleModel(project, role, doc);
      return [
        role,
        {
          model,
          label: modelLabel(model),
          source: doc.models[role] ? "project" : "default",
        } satisfies EffectiveRoleModel,
      ] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<ProjectRole, EffectiveRoleModel>;
}

/** Why a set of default model changes can't be saved, before any write:
 *  an unknown model, or a verifier equal to the investigator. */
function defaultModelsProblem(
  changes: Array<[ProjectRole, string | null]>,
): string | null {
  for (const [, id] of changes)
    if (id !== null && !resolveModel(id)) return `Unknown model: ${id}`;
  const next = (role: ProjectRole) => {
    const change = changes.find(([r]) => r === role);
    return change ? (change[1] ?? undefined) : globalRoleDefault(role);
  };
  const investigator = next("investigator");
  const verifier = next("verifier");
  if (investigator && verifier && sameModel(investigator, verifier))
    return "Pick a different model for the verifier";
  return null;
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
    effectiveSandboxes: (project, doc) => effectiveSandboxes(project, doc),
    effectiveModels: liveEffectiveModels,
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
    sandboxLabel: (provider) => sandboxLabel(provider),
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
    models: async () =>
      Object.fromEntries(
        await Promise.all(
          PROJECT_ROLES.map(
            async (role) => [role, await defaultRoleModel(role)] as const,
          ),
        ),
      ) as Record<ProjectRole, string>,
    modelsProblem: defaultModelsProblem,
    setModel: (role, id) => {
      setGlobalRoleDefault(role, id);
    },
    sandbox: () => workspaceSandboxDefault(),
    sandboxProblem: workspaceSandboxProblem,
    setSandbox: (value) => {
      saveWorkspaceSandboxDefault(value);
    },
    previews: () => globalPreviewsDefault(),
    previewsProblem: previewsDefaultProblem,
    setPreviews: (value) => {
      setPortalSandboxDefault(value);
    },
    websites: () => globalWebsites(),
    setWebsites: (hosts) => {
      setAutomationEgressAllowlist(hosts);
    },
  };
}
