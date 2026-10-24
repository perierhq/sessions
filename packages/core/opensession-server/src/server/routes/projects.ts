/**
 * Project settings API: one revisioned document per project, read as the
 * project page's view (effective sandbox and models, access table,
 * readiness) and written as a patch carrying `expectedRevision`. A stale
 * revision is a 409; changes the store reserves for a signed-in person are
 * a 403. Previews live in sandbox config, outside the revision.
 *
 *   GET   /api/projects                          ProjectListItem[]
 *   GET   /api/projects/:id/settings             ProjectSettingsView
 *   PATCH /api/projects/:id/settings             ProjectSettingsPatch → view
 *   POST  /api/projects/:id/production/runners   {runnerId, shared?} → view
 *   POST  /api/projects/migrate                  {dryRun?} → MigrationResult
 *   POST  /api/projects/:id/migrate              {force?} → ProjectRemigrateResult
 *   POST  /api/connections/:server/allow-unattended {on} → {ok:true}
 *
 * Identity is the verified sign-in only; a claimed `user` is never taken.
 * Binding a Runner, allowing agents on a connector and migrating need a
 * signed-in person (`verifiedPerson`).
 *
 * Returns a Response for a matched route or undefined to fall through.
 */

import type {
  MigrationResult,
  PreviewsChoice,
  ProjectRemigrateResult,
  ProjectSettingsDocument,
  ProjectSettingsPatch,
} from "../../shared/project-settings";
import {
  buildProjectList,
  buildProjectSettingsView,
  projectViewDeps,
} from "../projects/view";
import type { ProjectActor, ProjectWriteError } from "../projects/store";
import { installLiveProjectDeps, liveProjectRouteDeps } from "./project-deps";
import { type RouteContext, requestUser, verifiedPerson } from "./context";

export interface ProjectRouteDeps {
  update(
    project: string,
    patch: ProjectSettingsPatch,
    actor: ProjectActor,
  ): Promise<ProjectSettingsDocument | ProjectWriteError>;
  patchAsServer(
    project: string,
    mutate: (doc: ProjectSettingsDocument) => ProjectSettingsDocument,
  ): Promise<ProjectSettingsDocument>;
  /** Why the previews value can't be used, checked before any write. */
  previewsProblem(value: PreviewsChoice): string | null;
  /** Rejects with the reason when the value can't be saved. */
  savePreviews(project: string, value: PreviewsChoice): Promise<void>;
  /** Throws with the reason the Runner can't be bound. */
  bindRunner(
    project: string,
    runnerId: string,
    by: string,
    opts: { confirmShared: boolean },
  ): Promise<void>;
  allowUnattended(
    server: string,
    on: boolean,
  ): { ok: true } | { error: string };
  migrate(opts: { dryRun: boolean; by: string }): Promise<MigrationResult>;
  /** Compose one project from its legacy settings again; overwrites the
   *  document (after a backup) only with `force`. */
  remigrate(
    project: string,
    opts: { force: boolean; by: string },
  ): Promise<ProjectRemigrateResult>;
  audit(event: Record<string, unknown>): void;
}

let override: Partial<ProjectRouteDeps> | undefined;

/** Replace some writers (undefined restores them). */
export function __setProjectRoutesForTest(
  over: Partial<ProjectRouteDeps> | undefined,
): void {
  override = over;
}

function deps(): ProjectRouteDeps {
  installLiveProjectDeps();
  const live = liveProjectRouteDeps();
  return override ? { ...live, ...override } : live;
}

const LIST_PATH = "/api/projects";
const MIGRATE_PATH = "/api/projects/migrate";
const SETTINGS_PATH = /^\/api\/projects\/([^/]+)\/settings$/;
const REMIGRATE_PATH = /^\/api\/projects\/([^/]+)\/migrate$/;
const RUNNERS_PATH = /^\/api\/projects\/([^/]+)\/production\/runners$/;
const ALLOW_UNATTENDED_PATH = /^\/api\/connections\/([^/]+)\/allow-unattended$/;

const error = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });
const notFound = () => error("Not found", 404);

export async function readJsonObject(
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

function actorOf(ctx: RouteContext): ProjectActor {
  const verified = verifiedPerson(ctx) !== "";
  return {
    name: requestUser(ctx) || "Anonymous",
    verified,
    ...(verified && ctx.authUser?.login ? { login: ctx.authUser.login } : {}),
  };
}

async function settingsView(
  project: string,
  person: boolean,
): Promise<Response> {
  installLiveProjectDeps();
  const view = await buildProjectSettingsView(
    project,
    { person },
    projectViewDeps(),
  );
  return view ? Response.json(view) : notFound();
}

const PATCH_KEYS = new Set([
  "expectedRevision",
  "sandbox",
  "previews",
  "models",
  "incidents",
  "production",
  "access",
]);

async function patchSettings(
  ctx: RouteContext,
  project: string,
): Promise<Response> {
  installLiveProjectDeps();
  if (!projectViewDeps().projectExists(project)) return notFound();
  const body = await readJsonObject(ctx.req);
  if (body instanceof Response) return body;
  const { user: _claimed, ...patch } = body;
  const unknown = Object.keys(patch).filter((k) => !PATCH_KEYS.has(k));
  if (unknown.length) return error(`Unknown field ${unknown[0]}`, 400);
  if (!Number.isInteger(patch.expectedRevision))
    return error("expectedRevision must be an integer", 400);
  if (patch.previews !== undefined && typeof patch.previews !== "string")
    return error("previews must be a string", 400);
  const d = deps();
  const actor = actorOf(ctx);
  const { previews, ...documentPatch } =
    patch as unknown as ProjectSettingsPatch;
  // Previews live outside the document: check them first, so a bad value
  // leaves the document untouched.
  const previewsProblem =
    previews === undefined ? null : d.previewsProblem(previews);
  if (previewsProblem) return error(previewsProblem, 400);
  const out = await d.update(project, documentPatch, actor);
  if ("error" in out) return error(out.error, out.status);
  if (previews !== undefined) {
    try {
      await d.savePreviews(project, previews);
    } catch (cause) {
      return error(
        cause instanceof Error ? cause.message : "Couldn't save previews",
        400,
      );
    }
  }
  return settingsView(project, actor.verified);
}

async function bindRunner(
  ctx: RouteContext,
  project: string,
): Promise<Response> {
  installLiveProjectDeps();
  if (!projectViewDeps().projectExists(project)) return notFound();
  const body = await readJsonObject(ctx.req);
  if (body instanceof Response) return body;
  const person = verifiedPerson(ctx);
  if (!person)
    return error("Only a signed-in person can add a production Runner", 403);
  const runnerId = body.runnerId;
  if (typeof runnerId !== "string" || !runnerId.trim())
    return error("runnerId is required", 400);
  const d = deps();
  try {
    await d.bindRunner(project, runnerId, person, {
      confirmShared: body.shared === true,
    });
  } catch (cause) {
    return error(
      cause instanceof Error ? cause.message : "Couldn't add the Runner",
      400,
    );
  }
  await d.patchAsServer(project, (doc) =>
    doc.production.runners.includes(runnerId)
      ? doc
      : {
          ...doc,
          production: {
            ...doc.production,
            runners: [...doc.production.runners, runnerId],
          },
        },
  );
  return settingsView(project, true);
}

async function allowUnattended(
  ctx: RouteContext,
  server: string,
): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (body instanceof Response) return body;
  const person = verifiedPerson(ctx);
  if (!person)
    return error(
      "Only a signed-in person can allow agents on a connector",
      403,
    );
  if (typeof body.on !== "boolean")
    return error("on must be true or false", 400);
  const d = deps();
  const out = d.allowUnattended(server, body.on);
  if ("error" in out) return error(out.error, 400);
  d.audit({
    kind: "connection_allow_unattended",
    server,
    on: body.on,
    by: person,
  });
  return Response.json({ ok: true });
}

async function migrate(ctx: RouteContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (body instanceof Response) return body;
  const person = verifiedPerson(ctx);
  if (!person)
    return error("Only a signed-in person can migrate project settings", 403);
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    return error("dryRun must be true or false", 400);
  try {
    return Response.json(
      await deps().migrate({ dryRun: body.dryRun === true, by: person }),
    );
  } catch (cause) {
    return error(
      cause instanceof Error ? cause.message : "Couldn't migrate",
      500,
    );
  }
}

async function remigrate(
  ctx: RouteContext,
  project: string,
): Promise<Response> {
  installLiveProjectDeps();
  if (!projectViewDeps().projectExists(project)) return notFound();
  const body = await readJsonObject(ctx.req);
  if (body instanceof Response) return body;
  const person = verifiedPerson(ctx);
  if (!person)
    return error("Only a signed-in person can migrate project settings", 403);
  if (body.force !== undefined && typeof body.force !== "boolean")
    return error("force must be true or false", 400);
  try {
    return Response.json(
      await deps().remigrate(project, {
        force: body.force === true,
        by: person,
      }),
    );
  } catch (cause) {
    return error(
      cause instanceof Error ? cause.message : "Couldn't migrate",
      500,
    );
  }
}

export async function handleProjectsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === LIST_PATH) {
    if (req.method !== "GET") return undefined;
    installLiveProjectDeps();
    return Response.json(await buildProjectList(projectViewDeps()));
  }

  if (path === MIGRATE_PATH)
    return req.method === "POST" ? migrate(ctx) : undefined;

  const settings = SETTINGS_PATH.exec(path);
  if (settings) {
    const project = decodeSegment(settings[1]!);
    if (project === null) return notFound();
    if (req.method === "GET")
      return settingsView(project, verifiedPerson(ctx) !== "");
    if (req.method === "PATCH") return patchSettings(ctx, project);
    return undefined;
  }

  const again = REMIGRATE_PATH.exec(path);
  if (again && req.method === "POST") {
    const project = decodeSegment(again[1]!);
    return project === null ? notFound() : remigrate(ctx, project);
  }

  const runners = RUNNERS_PATH.exec(path);
  if (runners && req.method === "POST") {
    const project = decodeSegment(runners[1]!);
    return project === null ? notFound() : bindRunner(ctx, project);
  }

  const allow = ALLOW_UNATTENDED_PATH.exec(path);
  if (allow && req.method === "POST") {
    const server = decodeSegment(allow[1]!);
    return server === null ? notFound() : allowUnattended(ctx, server);
  }

  return undefined;
}
