/**
 * Blob's GitHub account (src/server/github-blob.ts), owner only.
 *
 *   GET    /api/blob/github         { as, login, expiresAt, repos, publicRepos, labels, enabled, tokenSet }
 *   PUT    /api/blob/github         { as?, token?, repos?, publicRepos?, labels?, enabled? } (token write-only)
 *   DELETE /api/blob/github/token   removes the token and turns posting off
 *   DELETE /api/blob/github         forgets Blob's account (clears
 *                                   integrations.github.blob); refused while
 *                                   a token is stored
 *
 * The owner is the verified instance owner (support/actor.ts: the signed-in
 * GitHub login matches the owner's roster entry), the same rule that lets
 * the owner give a project lead more room. A claimed name, an automation or
 * an instance without sign-in never qualifies, so the token can only be set
 * by someone GitHub vouched for. A token for the owner's own account
 * (`as: "owner"`) must also belong to the login they signed in with. No
 * response carries the token.
 */
import type { RouteContext } from "./context";
import { verifiedPerson } from "./context";
import { refreshIndexHtml } from "../frontend-build";
import {
  deleteBlobGithubToken,
  forgetBlobGithubAccount,
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
    const result = await setBlobGithubSettings(patch, person, {
      signedInLogin: ctx.authUser?.login,
    });
    if (!result.ok)
      return Response.json({ error: result.error }, { status: result.status });
    refreshIndexHtml("Blob's GitHub account");
    return Response.json({ blob: result.settings }, { headers: NO_STORE });
  }

  if (path === "/api/blob/github" && req.method === "DELETE") {
    const result = await forgetBlobGithubAccount(person);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: result.status });
    refreshIndexHtml("Blob's GitHub account forgotten");
    return Response.json({ blob: result.settings }, { headers: NO_STORE });
  }

  if (path === "/api/blob/github/token" && req.method === "DELETE") {
    const blob = await deleteBlobGithubToken(person);
    refreshIndexHtml("Blob's GitHub token removed");
    return Response.json({ blob }, { headers: NO_STORE });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
