// Where an automation descendant may work. Every descendant needs a sandbox
// or an isolation-approved Runner, except an incident agent without a
// sandbox: it works in a host worktree with its bash run as the incident
// agent user (incidents/response/host-agents.ts). Checked when the session
// is created, before its opening turn and before every later turn.
import type { AutomationDescendantPolicy } from "./types";

export const HOST_WORKTREE_MISUSE =
  "Host worktrees are only for incident agents without a sandbox";

/**
 * The user a descendant's bash runs as in a host worktree, or undefined when
 * it is not a descendant or works in a sandbox or on a Runner. Throws
 * `isolationMessage` for a descendant with none of those, and
 * HOST_WORKTREE_MISUSE for a host user on anything but an incident agent
 * without a sandbox or Runner. The caller still checks that the user is
 * ready (host-agents.ts assertHostAgentReady).
 */
export function descendantBashRunAs(
  policy: AutomationDescendantPolicy | undefined,
  where: { runner?: string | null; sandbox?: string | null },
  isolationMessage: string,
): string | undefined {
  if (!policy) return undefined;
  if (policy.hostAgentUser !== undefined) {
    if (!policy.incident || where.runner || where.sandbox)
      throw new Error(HOST_WORKTREE_MISUSE);
    return policy.hostAgentUser;
  }
  if (!where.runner && !where.sandbox) throw new Error(isolationMessage);
  return undefined;
}
