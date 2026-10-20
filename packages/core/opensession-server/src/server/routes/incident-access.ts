/**
 * Incident access settings API: per project, the grants (the ceiling), a
 * profile per agent role and per-signal overrides, stored only in the
 * catalog and written only here. Lending a credential needs a verified
 * sign-in (the store checks the actor); every write carries an optional
 * expectedRevision and a stale one is a 409. An unreadable document is a
 * 500 on read and on every write except the reset (DELETE), which repairs it.
 *
 * Returns a Response for a matched route or undefined to fall through.
 */

import { isIncidentAgentRole } from "../../shared/incident-access";
import type { AccessActor } from "../incidents/access/grants";
import {
  type AccessChange,
  AccessSettingsError,
  getIncidentAccessSettings,
  updateIncidentAccess,
} from "../incidents/access/settings-store";
import { type RouteContext, requestUser } from "./context";
import { verifiedPerson } from "./keychain";

const PREFIX = "/api/incident-access/";

/** Who is changing the settings: lending needs `verified`. */
export function accessActor(
  ctx: RouteContext,
  body?: Record<string, unknown>,
): AccessActor {
  return {
    name: requestUser(ctx, body?.user) || "Anonymous",
    verified: verifiedPerson(ctx) !== "",
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

export async function handleIncidentAccessRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;
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
