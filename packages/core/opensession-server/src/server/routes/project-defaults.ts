/**
 * Global defaults API: the fallbacks every project uses until it sets its
 * own. A façade over the model default store and sandbox config, which
 * stay where they are because their readers are synchronous.
 *
 *   GET   /api/project-defaults   ProjectDefaultsView
 *   PATCH /api/project-defaults   ProjectDefaultsPatch → view
 *
 * Changing a model, the sandbox or the websites needs a signed-in person
 * (`verifiedPerson`); previews stay open. Every website must be a domain
 * Daytona accepts, and the list may not exceed Daytona's ceiling.
 *
 * Returns a Response for a matched route or undefined to fall through.
 */

import {
  isProjectRole,
  type ProjectDefaultsView,
  type ProjectRole,
} from "../../shared/project-settings";
import {
  DAYTONA_DOMAIN_ALLOWLIST_MAX,
  parseAutomationEgressDomain,
} from "../sandbox/automation-egress";
import {
  buildProjectList,
  defaultSandboxUsedBy,
  projectViewDeps,
} from "../projects/view";
import {
  installLiveProjectDeps,
  liveProjectDefaultsDeps,
} from "./project-deps";
import { type RouteContext, verifiedPerson } from "./context";
import { readJsonObject } from "./projects";

export interface ProjectDefaultsDeps {
  /** Every role's model where a project sets none: the role's default,
   *  else what the runtime falls back to. */
  models(): Record<ProjectRole, string> | Promise<Record<ProjectRole, string>>;
  /** Why these model changes can't be saved together, or null. */
  modelsProblem(changes: Array<[ProjectRole, string | null]>): string | null;
  /** `null` clears the role back to the built-in default. Throws for an
   *  unknown model. */
  setModel(role: ProjectRole, id: string | null): void;
  /** Provider id or `"none"`. */
  sandbox(): string;
  /** Why the sandbox can't be the default (unknown or not available). */
  sandboxProblem(value: string): string | null;
  /** Throws for a provider that isn't available. */
  setSandbox(value: string): void;
  previews(): "same" | (string & {});
  previewsProblem(value: string): string | null;
  setPreviews(value: string): void;
  websites(): string[];
  setWebsites(hosts: string[]): void;
}

let override: Partial<ProjectDefaultsDeps> | undefined;

/** Replace some inputs (undefined restores them). */
export function __setProjectDefaultsRoutesForTest(
  over: Partial<ProjectDefaultsDeps> | undefined,
): void {
  override = over;
}

function deps(): ProjectDefaultsDeps {
  const live = liveProjectDefaultsDeps();
  return override ? { ...live, ...override } : live;
}

const PATH = "/api/project-defaults";

const error = (message: string, status: number): Response =>
  Response.json({ error: message }, { status });

async function view(): Promise<ProjectDefaultsView> {
  installLiveProjectDeps();
  const d = deps();
  const viewDeps = projectViewDeps();
  const [projects, sandboxUsedBy] = await Promise.all([
    buildProjectList(viewDeps),
    defaultSandboxUsedBy(viewDeps),
  ]);
  return {
    models: await d.models(),
    sandbox: d.sandbox(),
    sandboxUsedBy,
    previews: d.previews(),
    websites: d.websites(),
    projects,
  };
}

/** The normalized website list, or the reason it can't be saved. */
export function parseWebsites(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    return { error: "websites must be a list of domains" };
  const out: string[] = [];
  for (const raw of value as string[]) {
    let host: string;
    try {
      host = parseAutomationEgressDomain(raw);
    } catch (cause) {
      return {
        error:
          cause instanceof Error ? cause.message : `Invalid website ${raw}`,
      };
    }
    if (!out.includes(host)) out.push(host);
  }
  if (out.length > DAYTONA_DOMAIN_ALLOWLIST_MAX)
    return {
      error: `At most ${DAYTONA_DOMAIN_ALLOWLIST_MAX} websites. Daytona allows no more`,
    };
  return out;
}

async function patch(ctx: RouteContext): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  if (body instanceof Response) return body;
  const person = verifiedPerson(ctx) !== "";
  const { models, sandbox, previews, websites } = body;

  // Check everything first, so a bad field writes nothing.
  const modelChanges: Array<[ProjectRole, string | null]> = [];
  if (models !== undefined) {
    if (!models || typeof models !== "object" || Array.isArray(models))
      return error("models must be an object", 400);
    for (const [role, id] of Object.entries(models)) {
      if (!isProjectRole(role)) return error(`Unknown role "${role}"`, 400);
      if (id !== null && (typeof id !== "string" || !id.trim()))
        return error(`The ${role} model must be a model id or null`, 400);
      modelChanges.push([role, id as string | null]);
    }
  }
  if (sandbox !== undefined && (typeof sandbox !== "string" || !sandbox.trim()))
    return error("sandbox must be a provider id or none", 400);
  if (
    previews !== undefined &&
    (typeof previews !== "string" || !previews.trim())
  )
    return error("previews must be same or a provider id", 400);
  const hosts = websites === undefined ? undefined : parseWebsites(websites);
  if (hosts && "error" in hosts) return error(hosts.error, 400);
  if (
    !person &&
    (modelChanges.length > 0 || sandbox !== undefined || websites !== undefined)
  )
    return error(
      "Only a signed-in person can change default models, sandbox or websites",
      403,
    );

  // Validate every field against the live stores before the first write,
  // so a patch is all or nothing.
  const d = deps();
  const problem =
    (modelChanges.length ? d.modelsProblem(modelChanges) : null) ??
    (typeof sandbox === "string" ? d.sandboxProblem(sandbox) : null) ??
    (typeof previews === "string" ? d.previewsProblem(previews) : null);
  if (problem) return error(problem, 400);
  try {
    for (const [role, id] of modelChanges) d.setModel(role, id);
    if (typeof sandbox === "string") d.setSandbox(sandbox);
    if (typeof previews === "string") d.setPreviews(previews);
    if (hosts) d.setWebsites(hosts);
  } catch (cause) {
    return error(
      cause instanceof Error ? cause.message : "Couldn't save the defaults",
      400,
    );
  }
  return Response.json(await view());
}

export async function handleProjectDefaultsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (ctx.path !== PATH) return undefined;
  if (ctx.req.method === "GET") return Response.json(await view());
  if (ctx.req.method === "PATCH") return patch(ctx);
  return undefined;
}
