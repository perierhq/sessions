/**
 * Incident access, read side: the per-project view projected from the
 * project settings document, the preview (saved settings resolved against
 * a synthetic incident, gates off, no audit) and the per-incident view (the
 * real incident, gates on). Neither writes anything.
 *
 * Writing moved to the project settings API: every PUT, PATCH and DELETE
 * under /api/incident-access/:project, and a preview with a draft, answer
 * 410 with where to go instead.
 *
 * Returns a Response for a matched route or undefined to fall through.
 */

import {
  type IncidentAgentsAccessView,
  isIncidentAgentRole,
} from "../../shared/incident-access";
import type { Incident } from "../../shared/incidents";
import { loadAccessEnvironment } from "../incidents/access/environment";
import { previewAccess } from "../incidents/access/preview";
import {
  AccessSettingsError,
  getIncidentAccessSettings,
} from "../incidents/access/settings-store";
import { getIncident } from "../incidents/incident-store";
import { getSignal } from "../incidents/signal-store";
import type { RouteContext } from "./context";

const PREFIX = "/api/incident-access/";
const PREVIEW_PATH = "/api/incident-access/preview";
const INCIDENT_ACCESS_PATH = /^\/api\/incidents\/([^/]+)\/access$/;

const error = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });
const badRequest = (message: string) => error(message, 400);
const roleError = (role: string) => badRequest(`Unknown agent role "${role}"`);

/** The JSON object body, or the 400 to answer with. */
export async function readAccessBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return badRequest("Body must be a JSON object");
  return body as Record<string, unknown>;
}

/** Where writes to a project's incident access go now. */
export function movedToProjectSettings(project: string): Response {
  return error(`Moved to /api/projects/${project}/settings`, 410);
}

/** Path segments after the prefix, decoded; null for a malformed one. */
function segmentsOf(path: string): string[] | null {
  const rest = path.slice(PREFIX.length);
  if (!rest) return [];
  const raw = rest.split("/");
  if (raw.some((s) => s === "")) return [];
  try {
    return raw.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/** The stand-in incident a preview resolves against. */
function previewIncident(project: string, signalId: string | null): Incident {
  const now = new Date().toISOString();
  return {
    id: "preview",
    project,
    title: "Preview",
    state: "investigating",
    severity: "major",
    owner: "",
    openedBy: { kind: "owner" },
    signalIds: signalId ? [signalId] : [],
    primarySignalId: signalId ?? "",
    openedAt: now,
    updatedAt: now,
    lastProblemAt: now,
    findings: [],
    events: [],
    droppedEvents: 0,
  };
}

async function preview(ctx: RouteContext): Promise<Response> {
  const body = await readAccessBody(ctx.req);
  if (body instanceof Response) return body;
  const { project, role, signalId, draft } = body;
  if (!isIncidentAgentRole(role)) return roleError(String(role));
  if (typeof project !== "string" || !project)
    return badRequest("project is required");
  const env = await loadAccessEnvironment();
  if (!env.projectExists(project))
    return error(`Unknown project "${project}"`, 404);
  let signal = null;
  if (signalId !== undefined && signalId !== null) {
    signal = typeof signalId === "string" ? await getSignal(signalId) : null;
    if (!signal) return badRequest(`Unknown signal "${String(signalId)}"`);
    if (signal.project !== project)
      return badRequest(`Signal ${signal.id} belongs to another project`);
  }
  if (draft !== undefined && draft !== null)
    return movedToProjectSettings(project);
  try {
    await getIncidentAccessSettings(project);
  } catch (e) {
    if (e instanceof AccessSettingsError) return error(e.message, e.status);
    throw e;
  }
  return Response.json(
    await previewAccess(
      role,
      previewIncident(project, signal?.id ?? null),
      signal,
      { gates: false },
    ),
  );
}

async function incidentAgentsAccess(id: string): Promise<Response> {
  const incident = await getIncident(id);
  if (!incident) return error("Not found", 404);
  const signal = incident.primarySignalId
    ? await getSignal(incident.primarySignalId)
    : null;
  const view: IncidentAgentsAccessView = {
    incidentId: incident.id,
    investigator: await previewAccess("investigator", incident, signal, {
      gates: true,
    }),
    verifier: await previewAccess("verifier", incident, signal, {
      gates: true,
    }),
  };
  return Response.json(view);
}

export async function handleIncidentAccessRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (req.method === "GET") {
    const match = INCIDENT_ACCESS_PATH.exec(path);
    if (match) {
      let id: string;
      try {
        id = decodeURIComponent(match[1]!);
      } catch {
        return badRequest("Invalid path");
      }
      return incidentAgentsAccess(id);
    }
  }
  if (path === PREVIEW_PATH && req.method === "POST") return preview(ctx);
  if (!path.startsWith(PREFIX)) return undefined;
  const segments = segmentsOf(path);
  if (segments === null) return badRequest("Invalid path");
  const [project, kind] = segments;
  if (!project) return undefined;

  // GET /api/incident-access/:project
  if (kind === undefined && req.method === "GET") {
    try {
      return Response.json(await getIncidentAccessSettings(project));
    } catch (e) {
      if (e instanceof AccessSettingsError) return error(e.message, e.status);
      throw e;
    }
  }

  // Every write under /api/incident-access/:project moved.
  if (req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE")
    return movedToProjectSettings(project);

  return undefined;
}
