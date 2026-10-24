// The project document a project's legacy settings compose to: per-project
// incident settings (`incident-projects`), incident access (`incident-access`),
// the repo's sandbox default, and the connectors its automations and the
// pull request review automation mount. `composeFromLegacy` is pure; the
// report names everything the new document can't hold. This file is the
// only reader of the two legacy namespaces once the readers switch over.
import { readFile } from "node:fs/promises";
import {
  type AccessProfileFields,
  type CompleteAccessProfile,
  egressRouteKey,
  type EgressRoute,
  hostGrantKey,
  INCIDENT_AGENT_ROLES,
  type IncidentAccessSettings,
  type IncidentAgentRole,
} from "../../shared/incident-access";
import type { IncidentProjectSettings } from "../../shared/incident-response";
import {
  defaultProjectDocument,
  type ProjectAccess,
  type ProjectMigrationReport,
  type ProjectSettingsDocument,
  type ProjectSignalException,
  type UnattendedRole,
} from "../../shared/project-settings";
import { catalogDocuments } from "../catalog-documents";
import { configuredPaths, configuredRepos } from "../config";
import {
  exceptionOutsideGrants,
  isFieldError,
  parseStoredSettings,
} from "../incidents/access/fields";
import { accessSettingsFromDocument } from "../incidents/access/settings-store";
import { canonicalModelId, sameModel } from "../incidents/response/models";
import { sandboxConfig } from "../sandbox/config";
import { isRecord } from "./validate";

export const LEGACY_PROJECTS_NAMESPACE = "incident-projects";
export const LEGACY_ACCESS_NAMESPACE = "incident-access";

const PR_EVENT_KEY = "github:pull_request";

/** Everything one project's composition reads. */
export interface LegacySources {
  /** The raw `incident-projects` document, or null. */
  incidentProject: unknown;
  /** The raw `incident-access` document, or null. */
  access: unknown;
  /** `sandboxConfig().perRepo[project].sessionDefault`. */
  sessionDefault: string | null;
  /** The `mcpServers` of each automation on this project (not the review
   *  automation); `undefined` mounts every server. */
  automationServers: Array<string[] | undefined>;
  /** The connectors pull request reviews mount today. */
  reviewServers: string[];
  /** The review automation's model, when it pins one. */
  reviewModel: string | null;
  /** Every configured MCP server. */
  mcpServers: string[];
  /** The global web search choice (Settings, Models). */
  webSearch: string;
}

// ── Composing (pure) ────────────────────────────────────────────────────────

function legacyIncidentSettings(
  raw: unknown,
): Partial<IncidentProjectSettings> {
  return isRecord(raw) ? (raw as Partial<IncidentProjectSettings>) : {};
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function addRole<R extends string>(roles: R[], role: R): R[] {
  return roles.includes(role) ? roles : [...roles, role];
}

/** Compose one project's document from its legacy sources. Nothing is read
 *  or written; `now` stamps a document nobody wrote yet. */
export function composeFromLegacy(
  project: string,
  sources: LegacySources,
  now = new Date().toISOString(),
): { document: ProjectSettingsDocument; report: ProjectMigrationReport } {
  const doc = defaultProjectDocument(project, now);
  const dropped: ProjectMigrationReport["dropped"] = [];
  const drop = (field: string, item: string, why: string) => {
    if (!dropped.some((d) => d.field === field && d.item === item))
      dropped.push({ field, item, why });
  };

  // Incident policy and production.
  const legacy = legacyIncidentSettings(sources.incidentProject);
  const inc = doc.incidents;
  if (typeof legacy.agentsPaused === "boolean")
    inc.agentsPaused = legacy.agentsPaused;
  if (typeof legacy.autonomy === "string") inc.autonomy = legacy.autonomy;
  if (typeof legacy.vetoMs === "number") inc.vetoMs = legacy.vetoMs;
  if (typeof legacy.watchMs === "number") inc.watchMs = legacy.watchMs;
  if (typeof legacy.maxRounds === "number") inc.maxRounds = legacy.maxRounds;
  if (isRecord(legacy.night)) inc.night = legacy.night;
  if (Array.isArray(legacy.neverWithoutYou))
    inc.neverWithoutYou = [...legacy.neverWithoutYou];
  if (isRecord(legacy.budget)) inc.budget = { ...inc.budget, ...legacy.budget };
  doc.production = {
    runners: [...arr<string>(legacy.productionRunners)],
    actions: [
      ...arr<ProjectSettingsDocument["production"]["actions"][number]>(
        legacy.actions,
      ),
    ],
    releases: [
      ...arr<ProjectSettingsDocument["production"]["releases"][number]>(
        legacy.releases,
      ),
    ],
  };
  if (typeof legacy.automationId === "string")
    doc.automationId = legacy.automationId;
  if (typeof legacy.releaseHookSecret === "string")
    doc.releaseHookSecret = legacy.releaseHookSecret;
  const agents = isRecord(legacy.agents) ? legacy.agents : {};
  const projectModel: Record<IncidentAgentRole, string | undefined> = {
    investigator:
      typeof agents.investigatorModel === "string"
        ? agents.investigatorModel
        : undefined,
    verifier:
      typeof agents.verifierModel === "string"
        ? agents.verifierModel
        : undefined,
  };

  // Incident access.
  let accessState: ProjectMigrationReport["access"] = "default";
  let settings: IncidentAccessSettings | null = null;
  if (sources.access !== null && sources.access !== undefined) {
    const parsed = parseStoredSettings(sources.access);
    if (isFieldError(parsed) || parsed.project !== project)
      accessState = "reset-unreadable";
    else {
      settings = parsed;
      accessState = "migrated";
    }
  }
  const access = doc.access;
  if (settings) migrateAccess(project, settings, access, drop);

  // Models: the access profile's model won at runtime
  // (`access.model ?? models[role]`).
  for (const role of INCIDENT_AGENT_ROLES) {
    const profileModel = settings?.profiles[role].model ?? undefined;
    const fromProject = projectModel[role];
    const chosen = profileModel ?? fromProject;
    if (chosen) doc.models[role] = canonicalModelId(chosen);
    if (profileModel && fromProject && !sameModel(profileModel, fromProject))
      drop(
        `models.${role}`,
        fromProject,
        "The access profile's model won at runtime",
      );
  }
  if (
    doc.models.investigator &&
    doc.models.verifier &&
    sameModel(doc.models.investigator, doc.models.verifier)
  ) {
    drop(
      "models.verifier",
      doc.models.verifier,
      "The verifier needs a different model from the investigator",
    );
    delete doc.models.verifier;
  }

  // Automations: their connectors, code access and web search.
  const known = new Set(sources.mcpServers);
  const grant = (server: string, role: UnattendedRole) => {
    const row = access.connections.find((r) => r.server === server);
    if (row) row.roles = addRole(row.roles, role);
    else access.connections.push({ server, roles: [role] });
  };
  access.modes.automations = "code";
  const automationServers = sources.automationServers.some(
    (s) => s === undefined,
  )
    ? sources.mcpServers
    : [...new Set(sources.automationServers.flatMap((s) => s ?? []))];
  for (const server of automationServers)
    if (known.has(server)) grant(server, "automations");
    else drop("access.connections", server, "Not in Connections");
  if (sources.webSearch === "off")
    access.webSearch = access.webSearch.filter((r) => r !== "automations");

  // Reviews.
  for (const server of sources.reviewServers)
    if (known.has(server)) grant(server, "reviews");
  if (sources.reviewModel)
    doc.models.reviews = canonicalModelId(sources.reviewModel);

  // Sandbox: the repo's own default. "none" ran the repo on this machine.
  if (sources.sessionDefault === "none") doc.sandbox = "local";
  else if (sources.sessionDefault) doc.sandbox = sources.sessionDefault;

  return {
    document: doc,
    report: { project, dropped, access: accessState },
  };
}

function migrateAccess(
  project: string,
  settings: IncidentAccessSettings,
  access: ProjectAccess,
  drop: (field: string, item: string, why: string) => void,
): void {
  const { grants, profiles } = settings;
  const roles = INCIDENT_AGENT_ROLES;
  const usedBy = <T>(
    pick: (p: CompleteAccessProfile) => T[],
    keyOf: (t: T) => string,
  ) => {
    const out = new Map<string, { item: T; roles: IncidentAgentRole[] }>();
    for (const role of roles)
      for (const item of pick(profiles[role])) {
        const key = keyOf(item);
        const entry = out.get(key) ?? { item, roles: [] };
        entry.roles = addRole(entry.roles, role);
        out.set(key, entry);
      }
    return out;
  };

  for (const role of roles) {
    access.modes[role] = profiles[role].mode;
    access.deniedTools[role] = [...profiles[role].deniedTools];
  }

  const connections = usedBy(
    (p) => p.connections,
    (s) => s,
  );
  for (const [server, { roles: r }] of connections)
    access.connections.push({ server, roles: [...r] });
  for (const server of grants.connections)
    if (!connections.has(server))
      drop("access.connections", server, "No agent used it");

  const credentials = usedBy(
    (p) => p.credentials,
    (c) => c.credential,
  );
  for (const [credential] of credentials) {
    const grant = grants.credentials.find((g) => g.credential === credential);
    const rowRoles: ProjectAccess["credentials"][number]["roles"] = {};
    for (const role of roles) {
      const lent = profiles[role].credentials.find(
        (c) => c.credential === credential,
      );
      if (lent) rowRoles[role] = lent.mode;
    }
    access.credentials.push({
      credential,
      roles: rowRoles,
      grantedBy: grant?.grantedBy ?? settings.updatedBy,
      ...(grant?.grantedByLogin !== undefined
        ? { grantedByLogin: grant.grantedByLogin }
        : {}),
      grantedAt: grant?.grantedAt ?? settings.updatedAt,
    });
  }
  for (const g of grants.credentials)
    if (!credentials.has(g.credential))
      drop("access.credentials", g.credential, "No agent used it");

  const hosts = usedBy((p) => p.hosts, hostGrantKey);
  for (const [, { item, roles: r }] of hosts)
    access.hosts.push({
      runner: item.runner,
      ...(item.ssh ? { ssh: item.ssh } : {}),
      access: "read-only",
      roles: [...r],
    });
  for (const h of grants.hosts)
    if (!hosts.has(hostGrantKey(h)))
      drop("access.hosts", hostGrantKey(h), "No agent used it");

  // Egress: the route per role, and the hosts it reached as websites (the
  // profile's own hosts, else those of the matching project route).
  for (const role of roles) {
    const egress = profiles[role].egress;
    if (!egress) continue;
    const { hosts: own, ...route } = egress;
    access.routes[role] = route as EgressRoute;
    const grantRoute = grants.egress.find(
      (g) => egressRouteKey(g) === egressRouteKey(route as EgressRoute),
    );
    const reach = own?.length ? own : (grantRoute?.hosts ?? []);
    for (const host of reach) {
      const row = access.websites.find((w) => w.host === host);
      if (row) row.roles = addRole(row.roles, role);
      else access.websites.push({ host, roles: [role] });
    }
  }

  // Runners never had an effect.
  for (const runner of [
    ...grants.runners,
    ...roles.flatMap((r) => profiles[r].runners),
  ])
    drop("access.runners", runner, "Runners had no effect");
  for (const repo of [
    ...grants.repos,
    ...roles.flatMap((r) => profiles[r].repos),
  ])
    if (repo !== project)
      drop("access.repos", repo, "Agents work on this project's repository");

  // Per-signal overrides keep everything but the model and Runners, and
  // only what the table now allows: the table is their ceiling.
  const table = accessSettingsFromDocument({
    ...defaultProjectDocument(project, settings.updatedAt),
    access,
  }).grants;
  for (const o of settings.overrides) {
    const { model, runners, ...fields } = o.fields as AccessProfileFields;
    if (model) {
      drop(
        `access.signalExceptions.${o.signalId}.${o.role}.model`,
        model,
        "Per-signal models are not allowed",
      );
    }
    for (const runner of runners ?? [])
      drop("access.runners", runner, "Runners had no effect");
    for (const { field, item } of exceptionOutsideGrants(fields, table)) {
      drop(
        `access.signalExceptions.${o.signalId}.${o.role}.${field}`,
        item,
        "Outside the project's access table",
      );
      withoutItem(fields, field, item);
    }
    if (!Object.values(fields).some((v) => v !== undefined)) continue;
    const exception: ProjectSignalException = {
      signalId: o.signalId,
      role: o.role,
      fields,
      updatedBy: o.updatedBy,
      updatedAt: o.updatedAt,
    };
    access.signalExceptions.push(exception);
  }
}

/** Remove one item `exceptionOutsideGrants` reported from `fields`. */
function withoutItem(
  fields: AccessProfileFields,
  field: keyof AccessProfileFields,
  item: string,
): void {
  switch (field) {
    case "connections":
    case "repos":
      fields[field] = fields[field]?.filter((v) => v !== item);
      return;
    case "hosts":
      fields.hosts = fields.hosts?.filter((h) => hostGrantKey(h) !== item);
      return;
    case "credentials":
      fields.credentials = fields.credentials?.filter(
        (c) => c.credential !== item,
      );
      return;
    case "egress": {
      const egress = fields.egress;
      if (!egress) return;
      const hosts = (egress.hosts ?? []).filter((h) => h !== item);
      // Without hosts of its own the route would reach the signal's hosts:
      // fall back to the role's row in the table instead.
      if (egressRouteKey(egress) === item || !hosts.length)
        delete fields.egress;
      else fields.egress = { ...egress, hosts };
      return;
    }
    default:
      delete fields[field];
  }
}

// ── Loading the sources ─────────────────────────────────────────────────────

/** The live inputs outside the two legacy namespaces. */
export interface LegacyEnvironment {
  /** Every configured project, in config order. */
  projects(): string[];
  sandbox(): {
    sessionDefault?: string;
    perRepo: Record<string, { sessionDefault?: string }>;
  };
  automations(): Promise<
    Array<{
      repo?: string;
      eventKey?: string;
      mcpServers?: string[];
      model?: string;
    }>
  >;
  mcpServers(): Promise<string[]>;
  webSearch(): Promise<string>;
  /** The review flow's connectors when its automation pins none. */
  defaultReviewServers(): Promise<string[]>;
}

let environmentOverride: Partial<LegacyEnvironment> | undefined;

/** Replace parts of the live inputs (undefined restores them). */
export function __setLegacyEnvironmentForTest(
  env?: Partial<LegacyEnvironment>,
): void {
  environmentOverride = env;
}

async function readMcpServerNames(): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      await readFile(configuredPaths().mcpConfig, "utf8"),
    ) as { mcpServers?: unknown };
    return isRecord(parsed?.mcpServers) ? Object.keys(parsed.mcpServers) : [];
  } catch {
    return [];
  }
}

export function legacyEnvironment(): LegacyEnvironment {
  const o = environmentOverride ?? {};
  return {
    projects: o.projects ?? (() => Object.keys(configuredRepos())),
    sandbox:
      o.sandbox ??
      (() => {
        const config = sandboxConfig();
        return {
          sessionDefault: config.sessionDefault,
          perRepo: config.perRepo ?? {},
        };
      }),
    automations:
      o.automations ??
      (async () => (await import("../automations")).listAutomations()),
    mcpServers: o.mcpServers ?? readMcpServerNames,
    webSearch:
      o.webSearch ??
      (async () =>
        (await import("../web-search-setting")).readWebSearchSetting()),
    defaultReviewServers:
      o.defaultReviewServers ??
      (async () => [
        ...(await import("../../agents/github/run"))
          .DEFAULT_GITHUB_FLOW_MCP_SERVERS,
      ]),
  };
}

// Bound on first use, never at import: the catalog client is a live effect.
let projectsLegacy: ReturnType<typeof catalogDocuments> | undefined;
let accessLegacy: ReturnType<typeof catalogDocuments> | undefined;
export function legacyProjectDocuments(): ReturnType<typeof catalogDocuments> {
  return (projectsLegacy ??= catalogDocuments(LEGACY_PROJECTS_NAMESPACE));
}
export function legacyAccessDocuments(): ReturnType<typeof catalogDocuments> {
  return (accessLegacy ??= catalogDocuments(LEGACY_ACCESS_NAMESPACE));
}

/** Everything `composeFromLegacy` needs for one project. */
export async function loadLegacySources(
  project: string,
): Promise<LegacySources> {
  const env = legacyEnvironment();
  const [incidentProject, access, automations, mcpServers, webSearch] =
    await Promise.all([
      legacyProjectDocuments().get(project),
      legacyAccessDocuments().get(project),
      env.automations(),
      env.mcpServers(),
      env.webSearch(),
    ]);
  const review = automations.find((a) => a.eventKey === PR_EVENT_KEY);
  const sessionDefault = env.sandbox().perRepo[project]?.sessionDefault;
  return {
    incidentProject,
    access,
    sessionDefault: sessionDefault ?? null,
    automationServers: automations
      .filter((a) => a.repo === project && a.eventKey !== PR_EVENT_KEY)
      .map((a) => (a.mcpServers ? [...a.mcpServers] : undefined)),
    reviewServers: review?.mcpServers
      ? [...review.mcpServers]
      : await env.defaultReviewServers(),
    reviewModel: review?.model ?? null,
    mcpServers,
    webSearch,
  };
}

/** What a project without a stored document reads as. */
export async function composeProjectFromLegacy(
  project: string,
  now: string,
): Promise<ProjectSettingsDocument> {
  return composeFromLegacy(project, await loadLegacySources(project), now)
    .document;
}
