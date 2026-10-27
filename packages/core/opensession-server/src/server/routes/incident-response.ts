/**
 * Incident response API: per-project fix loop settings (redacted, read
 * only), pairing a new production Runner, owner decisions on an incident,
 * and "What the agents did" (the ledger plus each agent's access and tool
 * calls). Writing the settings and binding a paired Runner moved to the
 * project settings API (routes/projects.ts); the old paths answer 410.
 *
 * Identity is the verified sign-in only; a claimed `user` in a body is
 * never taken. Pairing a Runner and decisions that act on production
 * (deploy now, approve, roll back) need a signed-in person
 * (`verifiedPerson`), even with web sign-in off.
 * The release hook path carries its secret, so only a signed-in person
 * sees it.
 *
 * Returns a Response for a matched route or undefined to fall through.
 */

import {
  type AgentRun,
  type IncidentProjectSettings,
  type OwnerDecision,
  type RedactedProjectSettings,
  OWNER_DECISIONS,
  describeIndependence,
  describeWorkspace,
} from "../../shared/incident-response";
import { configuredRepos } from "../config";
import { getIncident } from "../incidents/incident-store";
import { AGENT_AUDIT_TAIL } from "../incidents/response/agent-audit";
import { agentToolCalls } from "../incidents/response/agents";
import {
  applyOwnerDecision,
  projectMonthSpend,
} from "../incidents/response/coordinator";
import { resolveRoleModels } from "../incidents/response/models";
import {
  defaultProjectSettings,
  getProjectSettings,
  incidentProjectExists,
  listProjectSettings,
  redactProjectSettings,
} from "../incidents/response/project-settings";
import {
  listProductionRunnerCandidates,
  startProductionPairing,
} from "../incidents/response/runners";
import { webAuthRequired } from "../web-auth";
import { type RouteContext, requestUser, verifiedPerson } from "./context";

const PROJECTS_PATH = "/api/incident-projects";
const PROJECT_PATH = /^\/api\/incident-projects\/([^/]+)$/;
const PAIRING_PATH = /^\/api\/incident-projects\/([^/]+)\/runner-pairing$/;
const BIND_PATH = /^\/api\/incident-projects\/([^/]+)\/runners\/([^/]+)\/bind$/;
const DECISIONS_PATH = /^\/api\/incidents\/([^/]+)\/decisions$/;
const AGENT_AUDIT_PATH = /^\/api\/incidents\/([^/]+)\/agent-audit$/;

/** Decisions that merge, deploy or roll back production. */
const PRODUCTION_DECISIONS: ReadonlySet<OwnerDecision> = new Set([
  "deploy-now",
  "approve",
  "roll-back",
]);

type ToolCalls = typeof agentToolCalls;
let toolCallsOverride: ToolCalls | undefined;

/** Replace the transcript reader (undefined restores it). */
export function __setIncidentResponseRoutesForTest(
  over: { toolCalls?: ToolCalls } | undefined,
): void {
  toolCallsOverride = over?.toolCalls;
}

const error = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });
const notFound = () => error("Not found", 404);

async function readObject(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return error("Body must be a JSON object", 400);
  return body as Record<string, unknown>;
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Redacted, and without the release hook path for anyone but a person. */
function view(
  s: IncidentProjectSettings,
  person: boolean,
): RedactedProjectSettings {
  const out = redactProjectSettings(s);
  if (person) return out;
  const { releaseHookPath: _hidden, ...rest } = out;
  return rest;
}

async function projectList(person: boolean): Promise<Response> {
  const stored = new Map(
    (await listProjectSettings()).map((s) => [s.project, s] as const),
  );
  const ids = new Set([...Object.keys(configuredRepos()), ...stored.keys()]);
  const projects = [...ids]
    .filter((id) => incidentProjectExists(id))
    .sort()
    .map((id) => view(stored.get(id) ?? defaultProjectSettings(id), person));
  return Response.json({ projects });
}

async function projectDetail(
  project: string,
  person: boolean,
): Promise<Response> {
  if (!incidentProjectExists(project)) return notFound();
  const settings = await getProjectSettings(project);
  const [runners, spend] = await Promise.all([
    listProductionRunnerCandidates(project, settings.productionRunners),
    projectMonthSpend(project, Date.now()),
  ]);
  return Response.json({
    settings: view(settings, person),
    runners,
    models: resolveRoleModels(settings.agents),
    spend,
  });
}

async function agentAudit(id: string): Promise<Response> {
  const incident = await getIncident(id);
  if (!incident) return notFound();
  const r = incident.response;
  if (!r) return Response.json({ ledger: [], droppedLedger: 0, agents: [] });
  const read = toolCallsOverride ?? agentToolCalls;
  const agents = await Promise.all(
    r.agents.map(async (run: AgentRun) => ({
      role: run.role,
      round: run.round,
      attempt: run.attempt,
      sessionId: run.sessionId,
      model: run.model,
      provider: run.provider,
      ...(run.independence
        ? {
            independence: run.independence,
            independenceLabel: describeIndependence(run.independence),
          }
        : {}),
      access: run.accessSummary,
      workspace: run.workspace,
      workspaceLabel: describeWorkspace(run.workspace),
      status: run.status,
      costUsd: run.costUsd,
      toolCalls: await read(run.sessionId, AGENT_AUDIT_TAIL).catch(() => []),
    })),
  );
  return Response.json({
    ledger: r.ledger,
    droppedLedger: r.droppedLedger,
    agents,
  });
}

async function decide(
  ctx: RouteContext,
  id: string,
  signInRequired: () => boolean,
): Promise<Response> {
  const body = await readObject(ctx.req);
  if (body instanceof Response) return body;
  if (signInRequired() && !ctx.authUser) return error("Sign in required", 401);
  const decision = body.decision;
  if (!(OWNER_DECISIONS as readonly unknown[]).includes(decision))
    return error("Unknown decision", 400);
  const person = verifiedPerson(ctx);
  if (PRODUCTION_DECISIONS.has(decision as OwnerDecision) && !person)
    return error(
      "Only a signed-in person can deploy, approve or roll back",
      403,
    );
  const out = await applyOwnerDecision(
    id,
    decision as OwnerDecision,
    person || requestUser(ctx) || "Anonymous",
    typeof body.note === "string" ? body.note : undefined,
  );
  if ("error" in out) return error(out.error, out.status);
  return Response.json(out);
}

export async function handleIncidentResponseRoutes(
  ctx: RouteContext,
  signInRequired: () => boolean = webAuthRequired,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  const person = verifiedPerson(ctx) !== "";

  if (path === PROJECTS_PATH)
    return req.method === "GET" ? projectList(person) : undefined;

  const projectMatch = PROJECT_PATH.exec(path);
  if (projectMatch) {
    const project = decodeSegment(projectMatch[1]!);
    if (project === null) return notFound();
    if (req.method === "GET") return projectDetail(project, person);
    // Settings are written through /api/projects/:id/settings now.
    if (req.method === "PUT" || req.method === "PATCH")
      return error(`Moved to /api/projects/${project}/settings`, 410);
    return undefined;
  }

  const pairingMatch = PAIRING_PATH.exec(path);
  if (pairingMatch && req.method === "POST") {
    const project = decodeSegment(pairingMatch[1]!);
    if (project === null || !incidentProjectExists(project)) return notFound();
    const pairing = startProductionPairing(
      project,
      requestUser(ctx) || "Anonymous",
      { signedInPerson: person },
    );
    if ("error" in pairing) return error(pairing.error, person ? 400 : 403);
    return Response.json(pairing);
  }

  const bindMatch = BIND_PATH.exec(path);
  if (bindMatch && req.method === "POST") {
    const project = decodeSegment(bindMatch[1]!);
    const runnerId = decodeSegment(bindMatch[2]!);
    if (project === null || runnerId === null) return notFound();
    // Binding moved to /api/projects/:id/production/runners.
    return error(`Moved to /api/projects/${project}/production/runners`, 410);
  }

  const decisionMatch = DECISIONS_PATH.exec(path);
  if (decisionMatch && req.method === "POST") {
    const id = decodeSegment(decisionMatch[1]!);
    if (id === null) return notFound();
    return decide(ctx, id, signInRequired);
  }

  const auditMatch = AGENT_AUDIT_PATH.exec(path);
  if (auditMatch && req.method === "GET") {
    const id = decodeSegment(auditMatch[1]!);
    return id === null ? notFound() : agentAudit(id);
  }

  return undefined;
}
