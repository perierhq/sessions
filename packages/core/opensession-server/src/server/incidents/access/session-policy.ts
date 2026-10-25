// Incident agents are automation descendants whose policy carries an
// `incident` binding. incidentDescendantPolicy builds that policy from a
// resolved AgentAccess; enforceIncidentSpawn re-resolves the binding when the
// session is created, before it exists, and narrows the policy to the fresh
// access. incidentTurnScope re-resolves it before every turn and never lets a
// turn reach wider than the spawn snapshot. An agent whose run a fresh
// session took over (supersededRefusal) is refused every turn. The binding
// is set only by server-side callers.
import type {
  AgentAccess,
  IncidentAgentBinding,
} from "../../../shared/incident-access";
import type { AutomationDescendantPolicy } from "../../types";
import { incidentAudit } from "../audit-sink";
import { getIncident } from "../incident-store";
import {
  AgentAccessError,
  type IncidentRunBound,
  accessSpawnSnapshot,
  resolveAgentAccessForBinding,
  spawnSnapshotOf,
} from "./resolve";

export interface IncidentDescendantBase {
  automationId: string;
  automationName: string;
  repo: string;
  publicationRepo: string;
  baseBranch: string;
}

export function incidentDescendantPolicy(
  access: AgentAccess,
  base: IncidentDescendantBase,
): AutomationDescendantPolicy {
  if (!access.repos.includes(base.repo))
    throw new AgentAccessError(
      `Repo ${base.repo} is not in this agent's access`,
      "spawn",
    );
  return {
    automationId: base.automationId,
    automationName: base.automationName,
    repo: base.repo,
    publicationRepo: base.publicationRepo,
    baseBranch: base.baseBranch,
    mcpServers: [...access.connections],
    allowedRunners: [...access.runners],
    publication: "branch-pr-only",
    incident: {
      incidentId: access.incidentId,
      role: access.role,
      signalId: access.signalId,
      accessRevision: access.revision,
      spawn: accessSpawnSnapshot(access),
    },
  };
}

function refused(binding: IncidentAgentBinding, reason: string): void {
  incidentAudit({
    kind: "incident_access_refused",
    incident_id: binding.incidentId,
    incident_role: binding.role,
    phase: "spawn",
    reason,
  });
}

/**
 * Re-resolve an incident agent's access before its session exists. Returns
 * the policy unchanged when it carries no binding; otherwise the policy
 * narrowed to the fresh access, or throws AgentAccessError("spawn").
 */
export async function enforceIncidentSpawn(
  policy: AutomationDescendantPolicy,
  request: {
    repo: string;
    runner?: string;
    mode: "ask" | "code" | "scratch";
    model?: string;
  },
): Promise<AutomationDescendantPolicy> {
  const binding = policy.incident;
  if (!binding) return policy;
  let access: AgentAccess;
  try {
    access = await resolveAgentAccessForBinding(binding);
  } catch (error) {
    refused(
      binding,
      error instanceof Error ? error.message : "Access could not be resolved",
    );
    throw error;
  }
  const refuse = (reason: string): never => {
    refused(binding, reason);
    throw new AgentAccessError(reason, "spawn");
  };
  if (access.incidentId !== binding.incidentId || access.role !== binding.role)
    refuse("The agent's access does not match its binding");
  if (policy.repo !== request.repo)
    refuse("The agent's repo does not match its policy");
  if (!access.repos.includes(request.repo))
    refuse(`Repo ${request.repo} is not in this agent's access`);
  if (request.mode === "scratch")
    refuse("Incident agents work in a repository");
  if (request.mode === "code" && access.mode === "ask")
    refuse("This agent may only read (mode ask)");
  // Runners and models are no longer part of access: the policy's
  // allowedRunners (narrowed below) and the project's role models decide.
  // The session does not exist yet: this records the decision, and
  // auditIncidentSpawned records the session once it is created.
  incidentAudit({
    kind: "incident_access_spawn_allowed",
    incident_id: binding.incidentId,
    incident_role: binding.role,
    revision: access.revision,
    repo: request.repo,
    ...(request.runner !== undefined ? { runner: request.runner } : {}),
    mode: request.mode,
    ...(request.model !== undefined ? { model: request.model } : {}),
  });
  return {
    ...policy,
    mcpServers: policy.mcpServers.filter((name) =>
      access.connections.includes(name),
    ),
    allowedRunners: policy.allowedRunners.filter((id) =>
      access.runners.includes(id),
    ),
    // The snapshot every later resolution is held to: the access the
    // session is created under.
    incident: {
      ...binding,
      accessRevision: access.revision,
      spawn: accessSpawnSnapshot(access),
    },
  };
}

/** Record an incident agent's session once it exists; a policy without a
 *  binding records nothing. */
export function auditIncidentSpawned(
  policy: AutomationDescendantPolicy | undefined,
  sessionId: string,
  request: {
    repo: string;
    runner?: string;
    mode: "ask" | "code" | "scratch";
    model?: string;
  },
): void {
  const binding = policy?.incident;
  if (!binding) return;
  incidentAudit({
    kind: "incident_access_spawn",
    incident_id: binding.incidentId,
    incident_role: binding.role,
    session_id: sessionId,
    revision: binding.accessRevision,
    repo: request.repo,
    ...(request.runner !== undefined ? { runner: request.runner } : {}),
    mode: request.mode,
    ...(request.model !== undefined ? { model: request.model } : {}),
  });
}

/**
 * What a bound incident agent's run is held to: the connections its policy
 * mounts, its session's mode (read the way incidentTurnScope reads it: any
 * mode but ask is code) and its spawn snapshot. Null without a binding.
 */
export function incidentRunBound(session: {
  mode?: string;
  automationDescendantPolicy?: AutomationDescendantPolicy;
}): IncidentRunBound | null {
  const policy = session.automationDescendantPolicy;
  if (!policy?.incident) return null;
  return {
    connections: [...policy.mcpServers],
    mode: session.mode === "ask" ? "ask" : "code",
    spawn: spawnSnapshotOf(policy.incident),
  };
}

/**
 * Why an incident agent's session may no longer act: a fresh session took
 * its run over (the run's `supersededBy`). Undefined while it may act, or
 * when the incident or run is not found (resolution refuses those).
 */
export async function supersededRefusal(
  incidentId: string,
  sessionId: string,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const incident = await getIncident(incidentId);
  const by = incident?.response?.agents.find(
    (a) => a.sessionId === sessionId,
  )?.supersededBy;
  return by ? `This agent was superseded by ${by}` : undefined;
}

export interface IncidentTurnScope {
  mcpServers: string[];
  deniedTools: Record<string, string>;
  access: AgentAccess;
}

export interface IncidentTurnSession {
  id?: string;
  mode?: string;
  repo?: string;
  runner?: { id: string } | null;
  automationDescendantPolicy?: AutomationDescendantPolicy;
}

// (session, revision) pairs whose change was already audited in this process.
const auditedChanges = new Set<string>();
const MAX_AUDITED_CHANGES = 10_000;

/**
 * The scope of an incident agent's next turn, re-resolved from its binding:
 * the spawn snapshot of connections intersected with the fresh access, and
 * the fresh denials. Mode, repo and Runner are fixed at spawn; if the fresh
 * access no longer allows them the turn is refused. Returns null for a
 * session without a binding; throws AgentAccessError otherwise.
 */
export async function incidentTurnScope(
  session: IncidentTurnSession,
): Promise<IncidentTurnScope | null> {
  return turnScope(session, true);
}

/**
 * The same scope for a read-only view (the effective-config page): nothing
 * is audited, and a refusal, a paused incident's included, is returned as
 * `{ refused }` instead of thrown.
 */
export async function viewIncidentTurnScope(
  session: IncidentTurnSession,
): Promise<IncidentTurnScope | { refused: string } | null> {
  try {
    return await turnScope(session, false);
  } catch (error) {
    return {
      refused:
        error instanceof Error ? error.message : "Access could not be resolved",
    };
  }
}

async function turnScope(
  session: IncidentTurnSession,
  audit: boolean,
): Promise<IncidentTurnScope | null> {
  const policy = session.automationDescendantPolicy;
  const binding = policy?.incident;
  if (!policy || !binding) return null;
  const sessionId = session.id ?? "";
  const refusedTurn = (reason: string) =>
    audit &&
    incidentAudit({
      kind: "incident_access_refused",
      incident_id: binding.incidentId,
      incident_role: binding.role,
      session_id: sessionId,
      phase: "turn",
      reason,
    });
  const refuse = (reason: string): never => {
    refusedTurn(reason);
    throw new AgentAccessError(reason, "turn");
  };
  const superseded = await supersededRefusal(binding.incidentId, sessionId);
  if (superseded) refuse(superseded);
  let access: AgentAccess;
  try {
    access = await resolveAgentAccessForBinding(
      binding,
      audit ? {} : { audit: false },
    );
  } catch (error) {
    refusedTurn(
      error instanceof Error ? error.message : "Access could not be resolved",
    );
    throw error;
  }
  if (access.incidentId !== binding.incidentId || access.role !== binding.role)
    refuse("The agent's access does not match its binding");
  if (session.mode !== "ask" && access.mode === "ask")
    refuse("This agent may now only read; start a new agent");
  const repo = session.repo ?? policy.repo;
  if (!access.repos.includes(repo))
    refuse(
      `Repo ${repo} was removed from this agent's access; start a new agent`,
    );
  if (session.runner && !access.runners.includes(session.runner.id))
    refuse(
      `Runner ${session.runner.id} was removed from this agent's access; start a new agent`,
    );
  if (audit && access.revision !== binding.accessRevision) {
    const key = `${sessionId}\u0000${access.revision}`;
    if (!auditedChanges.has(key)) {
      if (auditedChanges.size >= MAX_AUDITED_CHANGES) auditedChanges.clear();
      auditedChanges.add(key);
      incidentAudit({
        kind: "incident_access_changed",
        incident_id: binding.incidentId,
        incident_role: binding.role,
        session_id: sessionId,
        from: binding.accessRevision,
        to: access.revision,
      });
    }
  }
  return {
    mcpServers: policy.mcpServers.filter((name) =>
      access.connections.includes(name),
    ),
    deniedTools: { ...access.deniedTools },
    access,
  };
}
