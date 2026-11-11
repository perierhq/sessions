/**
 * Blob's GitHub machine user (src/server/github-blob.ts), owner only.
 *
 *   GET    /api/blob/github         { login, expiresAt, repos, publicRepos, labels, enabled, tokenSet }
 *   PUT    /api/blob/github         { token?, repos?, publicRepos?, labels?, enabled? } (token write-only)
 *   DELETE /api/blob/github/token   removes the token and turns posting off
 *
 * The owner is the verified instance owner (support/actor.ts: the signed-in
 * GitHub login matches the owner's roster entry), the same rule that lets
 * the owner give a project lead more room. A claimed name, an automation or
 * an instance without sign-in never qualifies, so the token can only be set
 * by someone GitHub vouched for. No response carries the token.
 */
import type { RouteContext } from "./context";
import { verifiedPerson } from "./context";
import {
  deleteBlobGithubToken,
  getBlobGithubSettings,
  setBlobGithubSettings,
  validateBlobGithubPatch,
} from "../github-blob";
import { actorFor, isOwnerActor } from "../support/actor";

interface RouteDeps {
  isOwner(ctx: RouteContext, person: string): boolean;
}

const defaultDeps: RouteDeps = {
  isOwner: (ctx, person) =>
    isOwnerActor(actorFor(person, true, ctx.authUser?.login)),
};

let deps: RouteDeps = defaultDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setBlobGithubRouteDepsForTest(
  overrides: Partial<RouteDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function handleBlobGithubRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== "/api/blob/github" && path !== "/api/blob/github/token")
    return undefined;

  const person = verifiedPerson(ctx);
  if (!person)
    return Response.json({ error: "Sign in required" }, { status: 401 });
  if (!deps.isOwner(ctx, person))
    return Response.json(
      { error: "Only the instance owner can set up Blob's GitHub account" },
      { status: 403 },
    );

  if (path === "/api/blob/github" && req.method === "GET")
    return Response.json(
      { blob: await getBlobGithubSettings() },
      { headers: NO_STORE },
    );

  if (path === "/api/blob/github" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const patch = validateBlobGithubPatch(body);
    if ("error" in patch)
      return Response.json({ error: patch.error }, { status: 400 });
    const result = await setBlobGithubSettings(patch, person);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ blob: result.settings }, { headers: NO_STORE });
  }

  if (path === "/api/blob/github/token" && req.method === "DELETE")
    return Response.json(
      { blob: await deleteBlobGithubToken(person) },
      { headers: NO_STORE },
    );

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
