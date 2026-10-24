// Where an automation descendant may work. Every descendant needs a sandbox
// or an isolation-approved Runner, except an incident agent without a
// sandbox: it works in a host worktree with its bash run as the incident
// agent user (incidents/response/host-agents.ts). Of the descendants, only
// incident agents may use This machine (container): both roles, the
// investigator and the verifier, so the fix loop can still verify a
// candidate when the host path is off. The verifier stays read-only there
// by its tool policy: its access profile is locked to ask mode, which gives
// it no edit or write tools and a read-only bash. Checked when the session
// is created, before its opening turn and before every later turn.
import { isIncidentAgentRole } from "../shared/incident-access";
import type { AutomationDescendantPolicy } from "./types";

export const HOST_WORKTREE_MISUSE =
  "Host worktrees are only for incident agents without a sandbox";

/** This machine (container) shares this server's kernel, so the only
 *  automation-spawned sessions it takes are incident agents; every other
 *  descendant must use a remote sandbox or a Runner. */
export const PODMAN_DESCENDANT_REFUSED =
  "Automation descendants cannot run in This machine (container); choose another sandbox or a Runner";

/**
 * Whether the policy is an incident agent's (investigator or verifier): it
 * carries an incident binding with an incident id and an agent role. Only server-side callers set the
 * binding (incidents/access/session-policy.ts; the workflow controller's
 * server-only spawn option), never an HTTP body, MCP tool or WebSocket
 * message, and session creation and every turn re-resolve it against the
 * incident's stored access, so a forged binding fails there too.
 */
export function isIncidentAgentPolicy(
  policy: AutomationDescendantPolicy,
): boolean {
  const binding = policy.incident;
  return (
    !!binding &&
    typeof binding.incidentId === "string" &&
    binding.incidentId.length > 0 &&
    isIncidentAgentRole(binding.role)
  );
}

/**
 * The user a descendant's bash runs as in a host worktree, or undefined when
 * it is not a descendant or works in a sandbox or on a Runner. Throws
 * `isolationMessage` for a descendant with none of those, and
 * HOST_WORKTREE_MISUSE for a host user on anything but an incident agent
 * without a sandbox or Runner, and PODMAN_DESCENDANT_REFUSED for a
 * descendant other than an incident agent in This machine (container). The
 * caller still checks that the
 * user is ready (host-agents.ts assertHostAgentReady).
 */
export function descendantBashRunAs(
  policy: AutomationDescendantPolicy | undefined,
  where: { runner?: string | null; sandbox?: string | null },
  isolationMessage: string,
): string | undefined {
  if (!policy) return undefined;
  if (where.sandbox === "podman" && !isIncidentAgentPolicy(policy))
    throw new Error(PODMAN_DESCENDANT_REFUSED);
  if (policy.hostAgentUser !== undefined) {
    if (!policy.incident || where.runner || where.sandbox)
      throw new Error(HOST_WORKTREE_MISUSE);
    return policy.hostAgentUser;
  }
  if (!where.runner && !where.sandbox) throw new Error(isolationMessage);
  return undefined;
}
