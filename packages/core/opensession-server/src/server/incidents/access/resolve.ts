// The effective access of an incident agent: the role profile merged with
// the signal's override, re-checked against the project's grants, then
// narrowed against live state (Runners, connections, credentials, models).
// Resolution either returns a whole AgentAccess or throws AgentAccessError;
// it never returns a partial grant. Narrowing is recorded and audited once;
// widening never happens here.
import { createHash } from "node:crypto";
import {
  type AccessNarrowing,
  type AgentAccess,
  egressRouteKey,
  hostGrantKey,
  type IncidentAccessSettings,
  type IncidentAgentBinding,
  type IncidentAgentRole,
  isIncidentAgentRole,
  type ResolvedCredential,
  type ResolvedEgress,
  type ResolvedHost,
} from "../../../shared/incident-access";
import {
  type Incident,
  isTerminalIncidentState,
  type Signal,
} from "../../../shared/incidents";
import { AUTOMATION_DENIED_TOOLS } from "../../automation-denied-tools";
import { incidentAudit } from "../audit-sink";
import { getIncident } from "../incident-store";
import { getSignal } from "../signal-store";
import { loadAccessEnvironment } from "./environment";
import { checkWithinGrants, mergeProfile, roleLockProblem } from "./fields";
import {
  AccessSettingsError,
  getIncidentAccessSettings,
} from "./settings-store";

export class AgentAccessError extends Error {
  constructor(
    message: string,
    readonly code: "role" | "incident" | "gate" | "settings" | "spawn" | "turn",
  ) {
    super(message);
    this.name = "AgentAccessError";
  }
}

/** A reason refuses spawn, every turn and every incident tool call. */
export type AccessGate = (
  incident: Incident,
  role: IncidentAgentRole,
) => string | null;

const gates = new Set<AccessGate>();

export function registerAccessGate(gate: AccessGate): () => void {
  gates.add(gate);
  return () => {
    gates.delete(gate);
  };
}

export const INCIDENT_DENIED_MESSAGE =
  "This tool is turned off for incident agents in this project's access settings.";

export interface ResolveOptions {
  /** Settings to resolve against (a draft or a test); default: stored. */
  settings?: IncidentAccessSettings;
  /** Run the registered gates (default on). */
  gates?: boolean;
  /** Audit narrowings (default on). */
  audit?: boolean;
}

const ROLE_LABEL: Record<IncidentAgentRole, string> = {
  investigator: "Investigator",
  verifier: "Verifier",
};

/** Hosts a signal itself reaches: the defaults for egress. */
export function signalHosts(signal: Signal | null): string[] {
  if (!signal) return [];
  const source = signal.source;
  if (source.kind === "http") {
    try {
      return [new URL(source.url).hostname.toLowerCase()];
    } catch {
      return [];
    }
  }
  if (source.kind === "expiry") return [source.host.toLowerCase()];
  return [];
}

export function describeAccess(
  access: Omit<AgentAccess, "summary" | "revision">,
): string {
  const parts = [
    ROLE_LABEL[access.role],
    access.connections.length
      ? access.connections.join(", ")
      : "no connections",
    `${access.mode === "code" ? "can edit" : "read-only on"} ${
      access.repos.length ? access.repos.join(", ") : "no repos"
    }`,
  ];
  if (access.hosts.length)
    parts.push(
      `reads ${access.hosts
        .map((h) => (h.ssh ? `${h.ssh} via ${h.runnerName}` : h.runnerName))
        .join(", ")}`,
    );
  if (access.credentials.length)
    parts.push(
      access.credentials.map((c) => `${c.service} (${c.mode})`).join(", "),
    );
  if (access.egress) {
    const via =
      access.egress.route === "runner"
        ? access.egress.runnerName
        : access.egress.route === "proxy"
          ? hostOf(access.egress.proxyUrl)
          : "Sessions";
    parts.push(`egress via ${via}`);
  }
  return parts.join(" · ");
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : "a proxy";
  } catch {
    return "a proxy";
  }
}

const sorted = (list: string[]): string[] => [...list].sort();

export function accessRevision(
  access: Omit<AgentAccess, "summary" | "revision" | "narrowed">,
): string {
  const material = {
    connections: sorted(access.connections),
    deniedTools: sorted(Object.keys(access.deniedTools)),
    mode: access.mode,
    repos: sorted(access.repos),
    runners: sorted(access.runners),
    hosts: sorted(access.hosts.map((h) => hostGrantKey(h))),
    credentials: sorted(
      access.credentials.map((c) => `${c.credential}:${c.mode}`),
    ),
    model: access.model,
    egress: access.egress
      ? {
          route: access.egress.route,
          runner: access.egress.runner ?? null,
          proxyUrl: access.egress.proxyUrl ?? null,
          proxyCredential: access.egress.proxyCredential ?? null,
          hosts: sorted(access.egress.hosts),
        }
      : null,
  };
  return createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex")
    .slice(0, 16);
}

// Each narrowing is audited once per process. The reason is part of the key:
// a different reason for the same item is a new fact.
const auditedNarrowings = new Set<string>();
const MAX_AUDITED_NARROWINGS = 10_000;

function auditNarrowing(
  incident: Incident,
  role: IncidentAgentRole,
  n: AccessNarrowing,
): void {
  const key = [incident.id, role, n.field, n.item, n.reason].join("\u0000");
  if (auditedNarrowings.has(key)) return;
  if (auditedNarrowings.size >= MAX_AUDITED_NARROWINGS)
    auditedNarrowings.clear();
  auditedNarrowings.add(key);
  incidentAudit({
    kind: "incident_access_narrowed",
    incident_id: incident.id,
    incident_role: role,
    field: n.field,
    item: n.item,
    reason: n.reason,
  });
}

async function settingsFor(
  incident: Incident,
): Promise<{ settings: IncidentAccessSettings; defaults: boolean }> {
  try {
    const view = await getIncidentAccessSettings(incident.project);
    return { settings: view, defaults: view.isDefault };
  } catch (error) {
    if (error instanceof AccessSettingsError)
      throw new AgentAccessError(error.message, "settings");
    throw new AgentAccessError(
      `Access settings for ${incident.project} could not be read`,
      "settings",
    );
  }
}

export async function resolveAgentAccess(
  role: IncidentAgentRole,
  incident: Incident,
  signal: Signal | null,
  opts: ResolveOptions = {},
): Promise<AgentAccess> {
  if (!isIncidentAgentRole(role))
    throw new AgentAccessError(`Unknown agent role "${String(role)}"`, "role");
  if (isTerminalIncidentState(incident.state) || incident.state === "paused")
    throw new AgentAccessError(
      `Incident ${incident.id} is ${incident.state}; its agents have no access`,
      "incident",
    );
  if (opts.gates !== false)
    for (const gate of [...gates]) {
      let reason: string | null;
      try {
        reason = gate(incident, role);
      } catch {
        reason = "An access check failed";
      }
      if (reason) throw new AgentAccessError(reason, "gate");
    }

  const { settings, defaults } = opts.settings
    ? { settings: opts.settings, defaults: false }
    : await settingsFor(incident);
  const override =
    signal && signal.project === incident.project
      ? settings.overrides.find(
          (o) => o.role === role && o.signalId === signal.id,
        )
      : undefined;
  const profile = mergeProfile(settings.profiles[role], override?.fields);
  const violation =
    checkWithinGrants(profile, settings.grants) ??
    roleLockProblem(role, profile);
  if (violation)
    throw new AgentAccessError(
      `Access settings for ${incident.project} exceed their grants: ${violation}`,
      "settings",
    );

  const env = await loadAccessEnvironment();
  const narrowed: AccessNarrowing[] = [];
  const narrow = (
    field: AccessNarrowing["field"],
    item: string,
    reason: string,
  ) => narrowed.push({ field, item, reason });

  const connections = profile.connections.filter((name) => {
    if (env.connection(name) === "ok") return true;
    narrow(
      "connections",
      name,
      "Connection is no longer available to incident agents",
    );
    return false;
  });

  const repos = profile.repos.filter((id) => {
    if (env.repoExists(id)) return true;
    narrow("repos", id, "Repo is no longer registered");
    return false;
  });

  const runners = profile.runners.filter((id) => {
    const info = env.runner(id);
    const reason = !info
      ? "Runner was removed"
      : !info.isolated
        ? "Runner is no longer isolated"
        : info.userRestricted
          ? "Runner now only accepts named people"
          : info.maintenance
            ? "Runner is in maintenance"
            : info.allowedRepos.length &&
                !info.allowedRepos.some((r) => repos.includes(r))
              ? "Runner does not serve these repos"
              : null;
    if (reason) narrow("runners", id, reason);
    return !reason;
  });

  const hosts: ResolvedHost[] = [];
  for (const host of profile.hosts) {
    const info = env.runner(host.runner);
    const reason = !info
      ? "Runner was removed"
      : !info.commands
        ? "Runner no longer accepts commands"
        : info.userRestricted
          ? "Runner now only accepts named people"
          : null;
    if (reason || !info) {
      narrow("hosts", hostGrantKey(host), reason ?? "Runner was removed");
      continue;
    }
    hosts.push({
      runner: info.id,
      runnerName: info.name,
      ...(host.ssh ? { ssh: host.ssh } : {}),
      access: "read-only",
    });
  }

  const credentials: ResolvedCredential[] = [];
  for (const cred of profile.credentials) {
    const info = env.credential(cred.credential);
    const grant = settings.grants.credentials.find(
      (g) => g.credential === cred.credential,
    );
    const reason =
      !info || info.id !== cred.credential
        ? "Credential was deleted"
        : info.kind === "login"
          ? "Credential is a login"
          : info.scope === "personal" &&
              !(grant && env.sameOwner(grant.grantedBy, info.owner))
            ? "Credential is personal and was not granted by its owner"
            : null;
    if (reason || !info) {
      narrow(
        "credentials",
        cred.credential,
        reason ?? "Credential was deleted",
      );
      continue;
    }
    credentials.push({
      credential: info.id,
      service: info.service,
      host: info.host,
      mode: cred.mode,
      scope: info.scope,
    });
  }

  let model: string | null = null;
  if (profile.model) {
    model = env.model(profile.model);
    if (!model) narrow("model", profile.model, "Model is no longer available");
  }

  let egress: ResolvedEgress | null = null;
  if (profile.egress) {
    const key = egressRouteKey(profile.egress);
    const grant = settings.grants.egress.find((g) => egressRouteKey(g) === key);
    let candidate: ResolvedEgress | null = {
      route: profile.egress.route,
      hosts: [],
    };
    if (profile.egress.route === "runner") {
      const info = env.runner(profile.egress.runner);
      if (!info || !info.commands || info.userRestricted) {
        narrow("egress", key, "Egress Runner was removed");
        candidate = null;
      } else {
        candidate.runner = info.id;
        candidate.runnerName = info.name;
      }
    } else if (profile.egress.route === "proxy") {
      candidate.proxyUrl = profile.egress.url;
      const proxyCredential =
        profile.egress.credential ??
        (grant?.route === "proxy" ? grant.credential : undefined);
      if (proxyCredential !== undefined) {
        if (!credentials.some((c) => c.credential === proxyCredential)) {
          narrow("egress", key, "Proxy credential is not available");
          candidate = null;
        } else candidate.proxyCredential = proxyCredential;
      }
    }
    if (candidate) {
      const reach = profile.egress.hosts?.length
        ? profile.egress.hosts
        : grant?.hosts?.length
          ? grant.hosts
          : signalHosts(signal);
      if (!reach.length) narrow("egress", key, "No hosts to reach");
      else egress = { ...candidate, hosts: [...reach] };
    }
  }

  const deniedTools: Record<string, string> = { ...AUTOMATION_DENIED_TOOLS };
  for (const name of profile.deniedTools)
    deniedTools[name] = INCIDENT_DENIED_MESSAGE;

  const base = {
    incidentId: incident.id,
    project: incident.project,
    role,
    signalId: signal?.id ?? null,
    overrideApplied: !!override,
    defaults,
    connections,
    deniedTools,
    mode: profile.mode,
    repos,
    runners,
    hosts,
    credentials,
    model,
    egress,
    narrowed,
  };
  if (opts.audit !== false)
    for (const n of narrowed) auditNarrowing(incident, role, n);
  return {
    ...base,
    revision: accessRevision(base),
    summary: describeAccess(base),
  };
}

let bindingResolver:
  | ((binding: IncidentAgentBinding) => Promise<AgentAccess>)
  | undefined;

/** Replace resolveAgentAccessForBinding (undefined restores it). */
export function __setBindingResolverForTest(
  fn: ((binding: IncidentAgentBinding) => Promise<AgentAccess>) | undefined,
): void {
  bindingResolver = fn;
}

/**
 * Resolve the access of a bound agent from the stored incident and signal.
 * A bound signal that no longer exists refuses rather than falling back to
 * the role default, which may be wider than the signal's override.
 */
export async function resolveAgentAccessForBinding(
  binding: IncidentAgentBinding,
): Promise<AgentAccess> {
  if (bindingResolver) return bindingResolver(binding);
  const incident = await getIncident(binding.incidentId);
  if (!incident)
    throw new AgentAccessError(
      `Incident ${binding.incidentId} no longer exists`,
      "incident",
    );
  let signal: Signal | null = null;
  if (binding.signalId !== null) {
    signal = await getSignal(binding.signalId);
    if (!signal)
      throw new AgentAccessError(
        `Signal ${binding.signalId} no longer exists`,
        "settings",
      );
  }
  return resolveAgentAccess(binding.role, incident, signal);
}
