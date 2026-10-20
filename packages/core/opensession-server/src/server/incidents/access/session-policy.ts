// Incident agents are automation descendants whose policy carries an
// `incident` binding. incidentDescendantPolicy builds that policy from a
// resolved AgentAccess; enforceIncidentSpawn re-resolves the binding when the
// session is created, before it exists, and narrows the policy to the fresh
// access. The binding is set only by server-side callers.
import type {
  AgentAccess,
  IncidentAgentBinding,
} from "../../../shared/incident-access";
import { resolveModel } from "../../models";
import type { AutomationDescendantPolicy } from "../../types";
import { incidentAudit } from "../audit-sink";
import { AgentAccessError, resolveAgentAccessForBinding } from "./resolve";

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
    },
  };
}

function canonicalModel(id: string): string {
  return resolveModel(id)?.id ?? id;
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
  if (request.runner !== undefined && !access.runners.includes(request.runner))
    refuse(`Runner ${request.runner} is not in this agent's access`);
  if (
    access.model &&
    (request.model === undefined ||
      canonicalModel(request.model) !== canonicalModel(access.model))
  )
    refuse(`This agent must use ${access.model}`);
  incidentAudit({
    kind: "incident_access_spawn",
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
    incident: { ...binding, accessRevision: access.revision },
  };
}
