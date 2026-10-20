// The `opensession-incident-access` in-process server: the only
// opensession-* server an incident agent gets. Each tool is mounted only when
// the agent's access grants what it reaches, and every call re-resolves that
// access from the binding first: a refusal returns "Access refused: ..." and
// does nothing else, and a narrowing applies at once. Everything is audited
// with the incident and role by the modules the tools call.
import { z } from "zod";
import {
  type AgentAccess,
  INCIDENT_ACCESS_SERVER,
  type IncidentAgentBinding,
} from "../../../shared/incident-access";
import {
  type InProcessMcpServer,
  type InProcessToolDefinition,
  createSdkMcpServer,
  tool,
} from "../../inprocess-mcp";
import { BROKER_METHODS } from "../../keychain-broker";
import type { AutomationDescendantPolicy } from "../../types";
import { incidentCredentialCall } from "./credentials";
import { egressFetch } from "./egress";
import { runHostCommand } from "./host-exec";
import { MAX_HOST_ARGS } from "./read-only-commands";
import { resolveAgentAccessForBinding } from "./resolve";
import type { IncidentToolContext } from "./tool-context";

type Ctx = {
  sessionId: string;
  binding: IncidentAgentBinding;
  access: AgentAccess;
};

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

/** The access for this call, re-resolved; a string is the refusal. */
async function freshContext(
  ctx: Pick<Ctx, "sessionId" | "binding">,
): Promise<IncidentToolContext | string> {
  try {
    const access = await resolveAgentAccessForBinding(ctx.binding);
    if (
      access.incidentId !== ctx.binding.incidentId ||
      access.role !== ctx.binding.role
    )
      return "Access refused: the agent's access does not match its binding";
    return { sessionId: ctx.sessionId, binding: ctx.binding, access };
  } catch (error) {
    return `Access refused: ${error instanceof Error ? error.message : "access could not be resolved"}`;
  }
}

function describe(access: AgentAccess) {
  return {
    summary: access.summary,
    connections: access.connections,
    mode: access.mode,
    repos: access.repos,
    hosts: access.hosts.map((h) => ({
      runner: h.runnerName,
      ...(h.ssh ? { ssh: h.ssh } : {}),
      access: h.access,
    })),
    credentials: access.credentials.map((c) => ({
      service: c.service,
      mode: c.mode,
    })),
    egress: access.egress
      ? { route: access.egress.route, hosts: access.egress.hosts }
      : null,
    narrowed: access.narrowed,
  };
}

const AUDITED = "Every call is audited with your incident and role.";

// Each tool's own zod shape types its handler; the list holds them all.
type AnyTool = InProcessToolDefinition<any>;

export function incidentAccessToolDefinitions(ctx: Ctx): AnyTool[] {
  const guarded =
    <A>(run: (fresh: IncidentToolContext, args: A) => Promise<unknown>) =>
    async (args: A) => {
      const fresh = await freshContext(ctx);
      if (typeof fresh === "string") return text(fresh);
      return json(await run(fresh, args));
    };
  const tools: AnyTool[] = [
    tool(
      "describe_access",
      `What this incident agent may reach right now: connections, mode, repos, read-only hosts, borrowed credentials (by service, never a secret) and the egress route. Call it first. ${AUDITED}`,
      {},
      guarded(async (fresh) => describe(fresh.access)),
    ),
  ];
  if (ctx.access.hosts.length)
    tools.push(
      tool(
        "host_command",
        `Run one read-only program (cat, head, tail, grep, ls, journalctl, systemctl status, docker ps/logs and a few more) on one of your granted hosts, through its paired Runner. The program and arguments are passed as data, never through a shell; anything that writes, follows output or reads secret-shaped files is refused. Hosts are read-only. ${AUDITED}`,
        {
          runner: z.string().describe("Runner name or id of a granted host"),
          ssh: z
            .string()
            .optional()
            .describe("SSH alias the Runner reaches, for a host behind it"),
          program: z.string().describe("Program name, without a path"),
          args: z.array(z.string()).max(MAX_HOST_ARGS).optional(),
          timeoutSeconds: z.number().optional(),
        },
        guarded((fresh, args) => runHostCommand(fresh, args)),
      ),
    );
  if (ctx.access.egress)
    tools.push(
      tool(
        "egress_fetch",
        `Send one HTTP request to a host on your egress list through your granted route (Sessions' own network, production's own egress through a Runner, or a proxy). Redirects are returned with their location, never followed; only a few harmless headers are forwarded. ${AUDITED}`,
        {
          url: z.string(),
          method: z.enum(["GET", "HEAD", "POST"]).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
          timeoutSeconds: z.number().optional(),
        },
        guarded((fresh, args) => egressFetch(fresh, args)),
      ),
    );
  if (ctx.access.credentials.length)
    tools.push(
      tool(
        "call_credential",
        `Call the API of a credential this project lent you, through the keychain broker: the secret is added to the request and never shown to you. Say why in purpose. A credential lent once allows one call. ${AUDITED}`,
        {
          credential: z.string().describe("Credential service or id"),
          method: z.enum(BROKER_METHODS),
          path: z.string().describe("Path and query on the credential's host"),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
          purpose: z.string(),
        },
        guarded((fresh, args) => incidentCredentialCall(fresh, args)),
      ),
    );
  return tools;
}

export function createIncidentAccessMcpServer(ctx: Ctx): InProcessMcpServer {
  return createSdkMcpServer({
    name: INCIDENT_ACCESS_SERVER,
    tools: incidentAccessToolDefinitions(ctx),
  });
}

/**
 * The incident access server for a bound incident agent, keyed by its name;
 * `{}` without a binding or when its access is refused (no tools at all).
 */
export async function incidentAccessMcpForSession(session: {
  id: string;
  automationDescendantPolicy?: AutomationDescendantPolicy;
}): Promise<Record<string, unknown>> {
  const binding = session.automationDescendantPolicy?.incident;
  if (!binding) return {};
  const fresh = await freshContext({ sessionId: session.id, binding });
  if (typeof fresh === "string") return {};
  return { [INCIDENT_ACCESS_SERVER]: createIncidentAccessMcpServer(fresh) };
}
