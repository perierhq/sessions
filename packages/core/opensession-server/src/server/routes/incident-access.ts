/**
 * Incident access settings API: per project, the grants (the ceiling), a
 * profile per agent role and per-signal overrides, stored only in the
 * catalog and written only here. Lending a credential needs a verified
 * sign-in (the store checks the actor); every write carries an optional
 * expectedRevision and a stale one is a 409. An unreadable document is a
 * 500 on read and on every write except the reset (DELETE), which repairs it.
 *
 * The preview resolves saved or draft settings against a synthetic incident
 * with gates off and no audit; the per-incident view resolves the real
 * incident with gates on. Neither writes anything.
 *
 * Returns a Response for a matched route or undefined to fall through.
 */

import {
  type IncidentAccessSettings,
  type IncidentAgentsAccessView,
  isIncidentAgentRole,
} from "../../shared/incident-access";
import type { Incident } from "../../shared/incidents";
import { loadAccessEnvironment } from "../incidents/access/environment";
import type { AccessActor } from "../incidents/access/grants";
import { previewAccess } from "../incidents/access/preview";
import {
  type AccessChange,
  AccessSettingsError,
  draftIncidentAccess,
  getIncidentAccessSettings,
  updateIncidentAccess,
} from "../incidents/access/settings-store";
import { getIncident } from "../incidents/incident-store";
import { getSignal } from "../incidents/signal-store";
import { type RouteContext, requestUser } from "./context";
import { verifiedPerson } from "./keychain";

const PREFIX = "/api/incident-access/";
const PREVIEW_PATH = "/api/incident-access/preview";
const INCIDENT_ACCESS_PATH = /^\/api\/incidents\/([^/]+)\/access$/;

/** Who is changing the settings: lending needs `verified`. */
export function accessActor(
  ctx: RouteContext,
  body?: Record<string, unknown>,
): AccessActor {
  const verified = verifiedPerson(ctx) !== "";
  return {
    name: requestUser(ctx, body?.user) || "Anonymous",
    verified,
    ...(verified && ctx.authUser?.login ? { login: ctx.authUser.login } : {}),
  };
}

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

/** The expected revision, undefined when absent, or the 400. */
function revisionOf(value: unknown): number | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return badRequest("expectedRevision must be an integer");
}

function queryRevision(url: URL): number | undefined | Response {
  const raw = url.searchParams.get("expectedRevision");
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw))
    return badRequest("expectedRevision must be an integer");
  return Number(raw);
}

async function write(
  project: string,
  change: AccessChange,
  actor: AccessActor,
  expectedRevision: number | undefined,
): Promise<Response> {
  const out = await updateIncidentAccess(
    project,
    change,
    actor,
    expectedRevision === undefined ? {} : { expectedRevision },
  );
  if ("error" in out && "status" in out) return error(out.error, out.status);
  return Response.json(out);
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
  let settings: IncidentAccessSettings | undefined;
  if (draft !== undefined && draft !== null) {
    if (typeof draft !== "object" || Array.isArray(draft))
      return badRequest("draft must be an object");
    const out = await draftIncidentAccess(
      project,
      draft as Parameters<typeof draftIncidentAccess>[1],
      accessActor(ctx, body),
    );
    if ("error" in out && "status" in out) return error(out.error, out.status);
    settings = out as IncidentAccessSettings;
  } else {
    try {
      await getIncidentAccessSettings(project);
    } catch (e) {
      if (e instanceof AccessSettingsError) return error(e.message, e.status);
      throw e;
    }
  }
  return Response.json(
    await previewAccess(
      role,
      previewIncident(project, signal?.id ?? null),
      signal,
      {
        ...(settings ? { settings } : {}),
        gates: false,
      },
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
  const { req, path, url } = ctx;
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
  const [project, kind, role, signalId, ...extra] = segments;
  if (!project || extra.length) return undefined;

  // /api/incident-access/:project
  if (kind === undefined) {
    if (req.method === "GET") {
      try {
        return Response.json(await getIncidentAccessSettings(project));
      } catch (e) {
        if (e instanceof AccessSettingsError) return error(e.message, e.status);
        throw e;
      }
    }
    if (req.method === "DELETE") {
      const expected = queryRevision(url);
      if (expected instanceof Response) return expected;
      return write(project, { kind: "reset" }, accessActor(ctx), expected);
    }
    return undefined;
  }

  // PUT /api/incident-access/:project/grants
  if (kind === "grants" && role === undefined) {
    if (req.method !== "PUT") return undefined;
    const body = await readAccessBody(req);
    if (body instanceof Response) return body;
    const expected = revisionOf(body.expectedRevision);
    if (expected instanceof Response) return expected;
    return write(
      project,
      { kind: "grants", grants: body.grants },
      accessActor(ctx, body),
      expected,
    );
  }

  // PUT /api/incident-access/:project/profiles/:role
  if (kind === "profiles" && role !== undefined && signalId === undefined) {
    if (req.method !== "PUT") return undefined;
    if (!isIncidentAgentRole(role)) return roleError(role);
    const body = await readAccessBody(req);
    if (body instanceof Response) return body;
    const expected = revisionOf(body.expectedRevision);
    if (expected instanceof Response) return expected;
    return write(
      project,
      { kind: "profile", role, fields: body.fields },
      accessActor(ctx, body),
      expected,
    );
  }

  // PUT|DELETE /api/incident-access/:project/overrides/:role/:signalId
  if (kind === "overrides" && role !== undefined && signalId !== undefined) {
    if (req.method !== "PUT" && req.method !== "DELETE") return undefined;
    if (!isIncidentAgentRole(role)) return roleError(role);
    if (req.method === "DELETE") {
      const expected = queryRevision(url);
      if (expected instanceof Response) return expected;
      return write(
        project,
        { kind: "delete-override", role, signalId },
        accessActor(ctx),
        expected,
      );
    }
    const body = await readAccessBody(req);
    if (body instanceof Response) return body;
    const expected = revisionOf(body.expectedRevision);
    if (expected instanceof Response) return expected;
    return write(
      project,
      { kind: "override", role, signalId, fields: body.fields },
      accessActor(ctx, body),
      expected,
    );
  }

  return undefined;
}
