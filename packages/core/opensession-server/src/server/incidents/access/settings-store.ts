// Incident access settings, projected from the project settings document
// (projects/store.ts): the incident agents' rows of the access table become
// the grants (their union), a complete profile per role, and the per-signal
// exceptions as overrides. Runners and a per-role model are gone from
// access; they read empty. Writes go through the project settings API.
import {
  type CompleteAccessProfile,
  type CredentialGrantMode,
  type CredentialInfo,
  type EgressGrant,
  egressRouteKey,
  type IncidentAccessSettings,
  type IncidentAccessSettingsView,
  type IncidentAgentRole,
  INCIDENT_AGENT_ROLES,
} from "../../../shared/incident-access";
import {
  defaultProjectDocument,
  type ProjectSettingsDocument,
} from "../../../shared/project-settings";
import {
  getProjectDocument,
  onProjectDocumentChange,
} from "../../projects/store";
import { type AccessEnvironment, loadAccessEnvironment } from "./environment";

export class AccessSettingsError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 500,
  ) {
    super(message);
    this.name = "AccessSettingsError";
  }
}

export type AccessWriteError = {
  error: string;
  status: 400 | 404 | 409 | 410 | 500;
};

/** Access changes moved to the project settings API. */
export const ACCESS_MOVED_ERROR = "Moved to /api/projects/:id/settings";

/** Subscribe to access changes: every committed write to a project's
 *  settings document; returns the unsubscribe function. */
export function onIncidentAccessChange(
  listener: (project: string) => void,
): () => void {
  return onProjectDocumentChange(listener);
}

const wider = (a: CredentialGrantMode, b: CredentialGrantMode) =>
  a === "standing" || b === "standing" ? "standing" : "once";

/** The incident agents' part of the access table, in the shape incident
 *  access resolution reads. */
export function accessSettingsFromDocument(
  doc: ProjectSettingsDocument,
): IncidentAccessSettings {
  const { access, project } = doc;
  const has = (roles: readonly string[], role: IncidentAgentRole) =>
    roles.includes(role);
  const anyAgent = (roles: readonly string[]) =>
    INCIDENT_AGENT_ROLES.some((r) => roles.includes(r));

  const profile = (role: IncidentAgentRole): CompleteAccessProfile => {
    const websites = access.websites
      .filter((w) => has(w.roles, role))
      .map((w) => w.host);
    return {
      connections: access.connections
        .filter((c) => has(c.roles, role))
        .map((c) => c.server),
      deniedTools: [...(access.deniedTools[role] ?? [])],
      mode: access.modes[role],
      repos: [project],
      runners: [],
      hosts: access.hosts
        .filter((h) => has(h.roles, role))
        .map((h) => ({
          runner: h.runner,
          ...(h.ssh ? { ssh: h.ssh } : {}),
          access: "read-only" as const,
        })),
      credentials: access.credentials.flatMap((c) => {
        const mode = c.roles[role];
        return mode ? [{ credential: c.credential, mode }] : [];
      }),
      model: null,
      egress: {
        ...access.routes[role],
        ...(websites.length ? { hosts: websites } : {}),
      } as EgressGrant,
    };
  };
  const profiles = {
    investigator: profile("investigator"),
    verifier: profile("verifier"),
  };

  // One grant per route, reaching the websites of the roles that use it.
  const egress: EgressGrant[] = [];
  for (const role of INCIDENT_AGENT_ROLES) {
    const route = access.routes[role];
    const hosts = profiles[role].egress?.hosts ?? [];
    const grant = egress.find(
      (g) => egressRouteKey(g) === egressRouteKey(route),
    );
    if (!grant) egress.push({ ...route, ...(hosts.length ? { hosts } : {}) });
    else if (hosts.length)
      grant.hosts = [...new Set([...(grant.hosts ?? []), ...hosts])];
  }
  return {
    project,
    revision: doc.revision,
    grants: {
      connections: access.connections
        .filter((c) => anyAgent(c.roles))
        .map((c) => c.server),
      repos: [project],
      runners: [],
      hosts: access.hosts
        .filter((h) => anyAgent(h.roles))
        .map((h) => ({
          runner: h.runner,
          ...(h.ssh ? { ssh: h.ssh } : {}),
          access: "read-only" as const,
        })),
      credentials: access.credentials.flatMap((c) => {
        const modes = INCIDENT_AGENT_ROLES.flatMap((r) =>
          c.roles[r] ? [c.roles[r]!] : [],
        );
        if (!modes.length) return [];
        return [
          {
            credential: c.credential,
            mode: modes.reduce(wider),
            grantedBy: c.grantedBy,
            ...(c.grantedByLogin !== undefined
              ? { grantedByLogin: c.grantedByLogin }
              : {}),
            grantedAt: c.grantedAt,
          },
        ];
      }),
      egress,
      maxMode: INCIDENT_AGENT_ROLES.some((r) => access.modes[r] === "code")
        ? "code"
        : "ask",
    },
    profiles,
    overrides: access.signalExceptions.map((e) => ({
      signalId: e.signalId,
      role: e.role,
      fields: { ...e.fields },
      updatedBy: e.updatedBy,
      updatedAt: e.updatedAt,
    })),
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt,
  };
}

/** Keys sorted at every level, so equal settings encode equally. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

function isDefaultAccess(settings: IncidentAccessSettings): boolean {
  const base = accessSettingsFromDocument(
    defaultProjectDocument(settings.project, settings.updatedAt),
  );
  const strip = (s: IncidentAccessSettings) => ({
    grants: s.grants,
    profiles: s.profiles,
    overrides: s.overrides,
  });
  return canonical(strip(settings)) === canonical(strip(base));
}

function view(
  settings: IncidentAccessSettings,
  env: AccessEnvironment,
): IncidentAccessSettingsView {
  const credentialInfo: Record<string, CredentialInfo> = {};
  for (const grant of settings.grants.credentials) {
    const info = env.credential(grant.credential);
    if (!info || info.id !== grant.credential) continue;
    credentialInfo[grant.credential] = {
      service: info.service,
      host: info.host,
      owner: info.owner,
      scope: info.scope,
      kind: info.kind,
    };
  }
  return { ...settings, isDefault: isDefaultAccess(settings), credentialInfo };
}

/** The incident agents' access for a project, with which roles may search
 *  the web (the verifier never does). */
export async function getIncidentAccess(project: string): Promise<{
  view: IncidentAccessSettingsView;
  webSearch: Record<IncidentAgentRole, boolean>;
}> {
  const env = await loadAccessEnvironment();
  if (!env.projectExists(project))
    throw new AccessSettingsError(`Unknown project "${project}"`, 404);
  let doc: ProjectSettingsDocument;
  try {
    doc = await getProjectDocument(project);
  } catch (error) {
    throw new AccessSettingsError(
      `Settings for ${project} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }
  const search = doc.access.webSearch as string[];
  return {
    view: view(accessSettingsFromDocument(doc), env),
    webSearch: {
      investigator: search.includes("investigator"),
      verifier: false,
    },
  };
}

/** The projected settings, or the defaults when nothing is set. */
export async function getIncidentAccessSettings(
  project: string,
): Promise<IncidentAccessSettingsView> {
  return (await getIncidentAccess(project)).view;
}

/** @deprecated Access is edited through the project settings API; this
 *  answers 410 until its routes are removed. */
export async function updateIncidentAccess(
  ..._args: unknown[]
): Promise<IncidentAccessSettingsView | AccessWriteError> {
  return { error: ACCESS_MOVED_ERROR, status: 410 };
}

/** @deprecated See updateIncidentAccess. */
export async function draftIncidentAccess(
  ..._args: unknown[]
): Promise<IncidentAccessSettings | AccessWriteError> {
  return { error: ACCESS_MOVED_ERROR, status: 410 };
}

/** @deprecated The change shapes of the retired access write API. */
export type AccessChange =
  | { kind: "grants"; grants: unknown }
  | { kind: "profile"; role: IncidentAgentRole; fields: unknown }
  | {
      kind: "override";
      role: IncidentAgentRole;
      signalId: string;
      fields: unknown;
    }
  | { kind: "delete-override"; role: IncidentAgentRole; signalId: string }
  | { kind: "reset" };
