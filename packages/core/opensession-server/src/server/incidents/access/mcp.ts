// The `opensession-incident-access` in-process server: the only
// opensession-* server an incident agent gets. Each tool is mounted only when
// the agent's access grants what it reaches, and every call re-resolves that
// access from the binding first: a refusal returns "Access refused: ..." and
// does nothing else, and a narrowing applies at once; an agent a fresh
// session took over is refused everything. A widening never applies:
// the access is held to what the run is bound to (clampToRun), and
// describe_access names connections allowed after the agent started.
// Everything is audited with the incident and role by the modules the tools
// call.
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
import {
  type IncidentRunBound,
  clampToRun,
  resolveAgentAccessForBinding,
} from "./resolve";
import { incidentRunBound, supersededRefusal } from "./session-policy";
import type { IncidentToolContext } from "./tool-context";

type Ctx = {
  sessionId: string;
  binding: IncidentAgentBinding;
  access: AgentAccess;
  /** What the run is bound to; absent for a preview, which is unclamped. */
  run?: Pick<IncidentRunBound, "connections" | "mode">;
};

type Fresh = {
  ctx: IncidentToolContext;
  /** Connections allowed now that this run does not mount. */
  allowedLater: string[];
};

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});
const json = (value: unknown) => text(JSON.stringify(value, null, 2));

/** The access for this call, re-resolved and held to the run; a string is
 *  the refusal. */
async function freshContext(
  ctx: Pick<Ctx, "sessionId" | "binding" | "run">,
): Promise<Fresh | string> {
  try {
    const superseded = await supersededRefusal(
      ctx.binding.incidentId,
      ctx.sessionId,
    );
    if (superseded)
      return `Access refused: ${superseded.charAt(0).toLowerCase()}${superseded.slice(1)}`;
    const resolved = await resolveAgentAccessForBinding(ctx.binding);
    if (
      resolved.incidentId !== ctx.binding.incidentId ||
      resolved.role !== ctx.binding.role
    )
      return "Access refused: the agent's access does not match its binding";
    const run = ctx.run;
    const access = run ? clampToRun(resolved, run) : resolved;
    return {
      ctx: { sessionId: ctx.sessionId, binding: ctx.binding, access },
      allowedLater: run
        ? resolved.connections.filter((c) => !run.connections.includes(c))
        : [],
    };
  } catch (error) {
    return `Access refused: ${error instanceof Error ? error.message : "access could not be resolved"}`;
  }
}

function listed(names: string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? "");
}

/** The note for connections allowed after the agent started. */
export function allowedLaterNote(names: string[]): string | undefined {
  if (!names.length) return undefined;
  return `${listed(names)} ${names.length > 1 ? "were" : "was"} allowed after this agent started. ${names.length > 1 ? "They apply" : "It applies"} from the next round.`;
}

function describe(access: AgentAccess, allowedLater: string[] = []) {
  const note = allowedLaterNote(allowedLater);
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
    ...(note ? { note } : {}),
  };
}

const AUDITED = "Every call is audited with your incident and role.";

// Each tool's own zod shape types its handler; the list holds them all.
type AnyTool = InProcessToolDefinition<any>;

export function incidentAccessToolDefinitions(ctx: Ctx): AnyTool[] {
  const guarded =
    <A>(
      run: (
        fresh: IncidentToolContext,
        args: A,
        later: string[],
      ) => Promise<unknown>,
    ) =>
    async (args: A) => {
      const fresh = await freshContext(ctx);
      if (typeof fresh === "string") return text(fresh);
      return json(await run(fresh.ctx, args, fresh.allowedLater));
    };
  const tools: AnyTool[] = [
    tool(
      "describe_access",
      `What this incident agent may reach right now: connections, mode, repos, read-only hosts, borrowed credentials (by service, never a secret) and the egress route. Call it first. ${AUDITED}`,
      {},
      guarded(async (fresh, _args, later) => describe(fresh.access, later)),
    ),
  ];
  if (ctx.access.hosts.length)
    tools.push(
      tool(
        "host_command",
        `Run one read-only program (cat, head, tail, grep, ls, journalctl, systemctl status, docker ps/logs and a few more) on one of your granted hosts, through its paired Runner. Each argument is quoted and the Runner's POSIX shell runs the command, so shell characters in an argument are plain text; anything that writes, follows output or reads secret-shaped files is refused. Hosts are read-only. ${AUDITED}`,
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

/** The context of a bound incident agent's session, held to its run; a
 *  string is the refusal, null is no binding. */
async function sessionContext(session: {
  id: string;
  mode?: string;
  automationDescendantPolicy?: AutomationDescendantPolicy;
}): Promise<Ctx | string | null> {
  const binding = session.automationDescendantPolicy?.incident;
  const bound = incidentRunBound(session);
  if (!binding || !bound) return null;
  const run = { connections: bound.connections, mode: bound.mode };
  const fresh = await freshContext({ sessionId: session.id, binding, run });
  return typeof fresh === "string" ? fresh : { ...fresh.ctx, run };
}

/**
 * The incident access server for a bound incident agent, keyed by its name;
 * `{}` without a binding or when its access is refused (no tools at all).
 */
export async function incidentAccessMcpForSession(session: {
  id: string;
  mode?: string;
  automationDescendantPolicy?: AutomationDescendantPolicy;
}): Promise<Record<string, unknown>> {
  const ctx = await sessionContext(session);
  if (!ctx || typeof ctx === "string") return {};
  return { [INCIDENT_ACCESS_SERVER]: createIncidentAccessMcpServer(ctx) };
}

/** The tools incidentAccessMcpForSession mounts; `[]` when it mounts none. */
export async function incidentAccessToolsForSession(session: {
  id: string;
  mode?: string;
  automationDescendantPolicy?: AutomationDescendantPolicy;
}): Promise<AnyTool[]> {
  const ctx = await sessionContext(session);
  if (!ctx || typeof ctx === "string") return [];
  return incidentAccessToolDefinitions(ctx);
}
