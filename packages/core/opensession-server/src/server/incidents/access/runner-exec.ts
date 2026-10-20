// The one way an incident agent's tools reach a Runner: a read-only host
// command or a Runner egress request, sent as runner-ws's
// `incident-agent-readonly` caller. That caller is also the only path an
// agent has to a production Runner reserved for incidents. The input goes on
// stdin, the audit and Runner logs get a label, never the command, and no
// AWS credentials ride along. Just before dispatch the agent's access is
// resolved again from its binding, and the command goes out only if that
// access still grants this Runner for this use.
import type { AgentAccess } from "../../../shared/incident-access";
import { type RunnerExecResult, execOnRunner } from "../../runner-ws";
import { resolveAgentAccessForBinding } from "./resolve";
import type { IncidentToolContext } from "./tool-context";

export type IncidentRunnerTarget =
  | { use: "host"; runner: string; ssh?: string }
  | { use: "egress"; runner: string };

/** Why `access` does not grant the Runner for this use, or null. */
export function runnerGrantProblem(
  access: AgentAccess,
  target: IncidentRunnerTarget,
): string | null {
  if (target.use === "host") {
    const ssh = target.ssh || undefined;
    if (
      access.hosts.some(
        (h) => h.runner === target.runner && (h.ssh ?? undefined) === ssh,
      )
    )
      return null;
    const name =
      access.hosts.find((h) => h.runner === target.runner)?.runnerName ??
      target.runner;
    return `${ssh ? `${ssh} via ${name}` : name} is not one of this agent's hosts`;
  }
  return access.egress?.route === "runner" &&
    access.egress.runner === target.runner
    ? null
    : `${target.runner} is not this agent's egress route`;
}

export interface RunnerExecDeps {
  exec?: typeof execOnRunner;
}

export async function execForIncidentAgent(
  ctx: IncidentToolContext,
  target: IncidentRunnerTarget,
  command: string,
  opts: { stdin: string; label: string; timeoutMs: number },
  deps: RunnerExecDeps = {},
): Promise<RunnerExecResult> {
  const exec = deps.exec ?? execOnRunner;
  const { binding } = ctx;
  return exec(target.runner, command, {
    repo: ctx.access.project,
    sessionId: ctx.sessionId,
    stdin: opts.stdin,
    auditCommand: opts.label,
    timeoutMs: opts.timeoutMs,
    caller: {
      kind: "incident-agent-readonly",
      incidentId: binding.incidentId,
      role: binding.role,
      use: target.use,
      authorize: async () => {
        let fresh: AgentAccess;
        try {
          // The tool call already audited any narrowing.
          fresh = await resolveAgentAccessForBinding(binding, {
            audit: false,
          });
        } catch (error) {
          return error instanceof Error
            ? error.message
            : "Access could not be resolved";
        }
        if (
          fresh.incidentId !== binding.incidentId ||
          fresh.role !== binding.role ||
          fresh.project !== ctx.access.project
        )
          return "The agent's access does not match its binding";
        return runnerGrantProblem(fresh, target);
      },
    },
  });
}
