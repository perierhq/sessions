// Credential calls for incident agents, through incident grants only, and
// the reconciliation that revokes live grants the access settings no longer
// back. A grant is minted only after the agent's access is resolved afresh,
// at the mode that access names; the call goes through the keychain broker,
// which uses only this incident's grant. The audit names the credential,
// method and path, never the query, headers, body or secret.
import type {
  AgentAccess,
  ResolvedCredential,
} from "../../../shared/incident-access";
import { isTerminalIncidentState } from "../../../shared/incidents";
import {
  incidentGrantFor,
  listIncidentGrants,
  revokeIncidentGrants,
} from "../../keychain";
import {
  type BrokerCallResult,
  type BrokerMethod,
  brokerCall,
} from "../../keychain-broker";
import { getIncident } from "../incident-store";
import { getSignal } from "../signal-store";
import {
  AgentAccessError,
  resolveAgentAccess,
  resolveAgentAccessForBinding,
} from "./resolve";
import { type IncidentToolContext, toolAudit } from "./tool-context";

export interface CredentialCallInput {
  credential: string;
  method: BrokerMethod;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  purpose: string;
}

const MAX_PURPOSE_CHARS = 500;

function findGranted(
  access: AgentAccess,
  ref: string,
): ResolvedCredential | undefined {
  const key = ref.trim().toLowerCase();
  return (
    access.credentials.find((c) => c.credential === ref) ??
    access.credentials.find((c) => c.service.toLowerCase() === key)
  );
}

function pathOnly(path: string): string {
  const cut = path.search(/[?#]/);
  return cut < 0 ? path : path.slice(0, cut);
}

/**
 * The credential as the agent's access names it right now: re-resolved from
 * the binding, never from what the caller holds. Every incident grant is
 * minted from this, at its mode.
 */
export async function freshGrantedCredential(
  ctx: IncidentToolContext,
  ref: string,
): Promise<
  { access: AgentAccess; credential: ResolvedCredential } | { error: string }
> {
  let access: AgentAccess;
  try {
    access = await resolveAgentAccessForBinding(ctx.binding);
  } catch (error) {
    return {
      error: `Access refused: ${error instanceof Error ? error.message : "access could not be resolved"}`,
    };
  }
  if (
    access.incidentId !== ctx.binding.incidentId ||
    access.role !== ctx.binding.role
  )
    return {
      error: "Access refused: the agent's access does not match its binding",
    };
  const credential = findGranted(access, ref);
  if (!credential) return { error: `${ref} is not granted to this agent` };
  return { access, credential };
}

export async function incidentCredentialCall(
  ctx: IncidentToolContext,
  input: CredentialCallInput,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<BrokerCallResult> {
  if (!findGranted(ctx.access, input.credential))
    return { error: `${input.credential} is not granted to this agent` };
  const purpose = (input.purpose ?? "").trim();
  if (!purpose || purpose.length > MAX_PURPOSE_CHARS)
    return { error: "Say why you make this call (purpose)" };
  const fresh = await freshGrantedCredential(ctx, input.credential);
  if ("error" in fresh) return { error: fresh.error };
  const { access, credential } = fresh;
  const fields = {
    credential_id: credential.credential,
    service: credential.service,
    method: input.method,
    path: pathOnly(input.path),
    mode: credential.mode,
  };
  const grant = await incidentGrantFor({
    credentialId: credential.credential,
    sessionId: ctx.sessionId,
    mode: credential.mode,
    incident: {
      incidentId: ctx.binding.incidentId,
      role: ctx.binding.role,
      project: access.project,
      signalId: access.signalId,
    },
    purpose,
  });
  if ("error" in grant) {
    toolAudit(ctx, "incident_credential_call", {
      ...fields,
      error: grant.error,
    });
    return { error: grant.error };
  }
  const result = await brokerCall({
    sessionId: ctx.sessionId,
    credential: credential.credential,
    method: input.method,
    path: input.path,
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    purpose,
    requestedBy: `incident ${ctx.binding.incidentId} ${ctx.binding.role}`,
    incident: {
      incidentId: ctx.binding.incidentId,
      role: ctx.binding.role,
    },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  toolAudit(ctx, "incident_credential_call", {
    ...fields,
    ...("error" in result
      ? { error: result.error.slice(0, 300) }
      : { status: result.status }),
  });
  return result;
}

const SETTINGS_CHANGED = "Access settings changed";

/**
 * Revoke every live incident grant of the project that its access no longer
 * backs: the incident or its bound signal is gone, resolution refuses, the
 * credential left the access, or the grant is standing where the access now
 * lends it once. Returns how many grants were revoked.
 */
export async function reconcileIncidentGrants(
  project: string,
): Promise<number> {
  let revoked = 0;
  const revoke = async (
    filter: { incidentId: string; sessionId: string; credentialId: string },
    reason: string,
  ) => {
    revoked += await revokeIncidentGrants(filter, reason);
  };
  for (const grant of listIncidentGrants({ project })) {
    const marker = grant.incident;
    if (!marker) continue;
    const filter = {
      incidentId: marker.incidentId,
      sessionId: grant.sessionId,
      credentialId: grant.credentialId,
    };
    const incident = await getIncident(marker.incidentId);
    if (!incident) {
      await revoke(filter, "Incident no longer exists");
      continue;
    }
    if (isTerminalIncidentState(incident.state)) {
      await revoke(filter, "Incident closed");
      continue;
    }
    let access: AgentAccess;
    try {
      let signal = null;
      if (marker.signalId !== null) {
        signal = await getSignal(marker.signalId);
        // As for a bound agent: a vanished signal refuses rather than
        // falling back to the role default.
        if (!signal)
          throw new AgentAccessError(
            `Signal ${marker.signalId} no longer exists`,
            "settings",
          );
        if (!incident.signalIds.includes(signal.id))
          throw new AgentAccessError(
            `Signal ${signal.id} is not part of incident ${incident.id}`,
            "incident",
          );
      }
      if (marker.role !== "investigator" && marker.role !== "verifier")
        throw new AgentAccessError(
          `Unknown agent role "${marker.role}"`,
          "role",
        );
      access = await resolveAgentAccess(marker.role, incident, signal, {
        audit: false,
      });
    } catch {
      await revoke(filter, SETTINGS_CHANGED);
      continue;
    }
    const still = access.credentials.find(
      (c) => c.credential === grant.credentialId,
    );
    if (!still || (grant.mode === "standing" && still.mode === "once"))
      await revoke(filter, SETTINGS_CHANGED);
  }
  return revoked;
}
