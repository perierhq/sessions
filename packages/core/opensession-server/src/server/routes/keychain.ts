/**
 * Keychain routes: credential registration, the owner's answers to asks, and
 * inspection for humans (Settings → Account). All of them sit behind the
 * web sign-in gate, except the retired broker URL's explanation. There is no
 * HTTP broker: agents call a borrowed credential through the call_credential
 * tool (keychain-broker.ts), which binds the call to the calling run's
 * session, or through a scripted run's own proxy (keychain-runs.ts).
 */

import type { RouteContext } from "./context";
import { verifiedPerson } from "./context";
import {
  addCredentialAsync,
  answerKeychainAsk,
  deleteCredentialAsync,
  ensureKeychainLoaded,
  keychainAsksInSession,
  keychainViewFor,
  patchCredentialAsync,
  resumeGrantAsync,
  revokeGrant,
  setCredentialScopeAsync,
  STALE_CREDENTIAL_ERROR,
} from "../keychain";
import { testCredential } from "../keychain-broker";
import { listProjectDocuments } from "../projects/store";
import type { CredentialGrantMode } from "../../shared/incident-access";
import type {
  IncidentRole,
  ProjectCredentialRow,
} from "../../shared/project-settings";
import { readRequestTextWithinLimit } from "../shared/bounded-body";
import {
  CredentialRegistrationError,
  declineCredentialRegistration,
  pendingCredentialRegistration,
  submitCredentialRegistration,
} from "../credential-registrations";

export { verifiedPerson } from "./context";

/** The loopback broker URL grants used to be served at:
 *  /api/keychain/broker/<grant>/<path>. */
export function isRetiredKeychainBrokerPath(path: string): boolean {
  return (
    path === "/api/keychain/broker" || path.startsWith("/api/keychain/broker/")
  );
}

/** What a caller of the retired broker URL is told. Open to every caller, so
 *  a script that still uses one learns why instead of seeing a sign-in
 *  error. It never touches a grant. */
export function retiredKeychainBrokerResponse(): Response {
  return Response.json(
    {
      error:
        "The keychain broker URL was retired: a grant is no longer usable over HTTP. " +
        "For a single API call, use the call_credential tool. For bulk work by a script, " +
        "ask the owner for a scripted run (request_credential with `run`: the command and " +
        "its call cap), then start it with run_with_credential; the script gets " +
        "KEYCHAIN_PROXY_URL, which works only while it runs.",
      retired: true,
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

/** What lending reads of a project's settings. */
type ProjectLending = {
  project: string;
  access: {
    credentials: Array<Pick<ProjectCredentialRow, "credential" | "roles">>;
  };
};

export interface CredentialLending {
  project: string;
  roles: Partial<Record<IncidentRole, CredentialGrantMode>>;
}

/** Each credential's projects that lend it to an incident role (a row
 *  with no role ticked lends nothing). */
export function lendingByCredential(
  docs: ProjectLending[],
): Map<string, CredentialLending[]> {
  const out = new Map<string, CredentialLending[]>();
  for (const doc of docs)
    for (const row of doc.access.credentials) {
      if (!Object.values(row.roles).some(Boolean)) continue;
      const list = out.get(row.credential) ?? [];
      list.push({ project: doc.project, roles: { ...row.roles } });
      out.set(row.credential, list);
    }
  return out;
}

let projectsForLending: () => Promise<ProjectLending[]> = listProjectDocuments;

/** Replace where lending is read from (undefined restores the catalog). */
export function __setKeychainProjectsForTest(
  read?: () => Promise<ProjectLending[]>,
): void {
  projectsForLending = read ?? listProjectDocuments;
}

/** Lending per credential, or an empty map when the project catalog can't
 *  answer: the Keychain still loads, without the links. */
async function currentLending(): Promise<Map<string, CredentialLending[]>> {
  try {
    return lendingByCredential(await projectsForLending());
  } catch (error) {
    console.error("[keychain] couldn't read project lending:", error);
    return new Map();
  }
}

export async function handleKeychainRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (isRetiredKeychainBrokerPath(path)) return retiredKeychainBrokerResponse();

  if (
    path === "/api/keychain/registrations" ||
    path.startsWith("/api/keychain/registrations/")
  ) {
    return handleRegistrationRoutes(ctx);
  }

  // ── Management ────────────────────────────────────────────────────────────
  if (path === "/api/keychain" && req.method === "GET") {
    await ensureKeychainLoaded();
    const view = keychainViewFor(verifiedPerson(ctx));
    // Which projects lend each credential to incident agents, so a row
    // links to that project's access settings.
    const lending = await currentLending();
    return Response.json(
      {
        ...view,
        credentials: view.credentials.map((c) => {
          const lentIn = lending.get(c.id);
          return lentIn ? { ...c, lentIn } : c;
        }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // The card in the requesting session. Only the credential's owner, by
  // verified sign-in, gets anything back; every other viewer an empty list.
  if (path === "/api/keychain/asks" && req.method === "GET") {
    await ensureKeychainLoaded();
    return Response.json(
      {
        asks: keychainAsksInSession(
          ctx.url.searchParams.get("sessionId") || "",
          verifiedPerson(ctx),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // The owner answers a teammate's request from Settings or the session card. A verified sign-in
  // is required: a claimed name (the no-auth picker) or an automation token
  // must never approve access to someone's credential.
  const askMatch = path.match(/^\/api\/keychain\/asks\/([^/]+)\/answer$/);
  if (askMatch && req.method === "POST") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to answer a keychain request" },
        { status: 401 },
      );
    const body = await req.json().catch(() => null);
    const decision = body?.decision;
    if (
      decision !== "once" &&
      decision !== "standing" &&
      decision !== "run" &&
      decision !== "release" &&
      decision !== "decline"
    )
      return Response.json(
        {
          error:
            'expected { decision: "once" | "standing" | "run" | "release" | "decline" }',
        },
        { status: 400 },
      );
    await ensureKeychainLoaded();
    const result = answerKeychainAsk(
      decodeURIComponent(askMatch[1]!),
      decision,
      by,
    );
    return "error" in result
      ? Response.json(result, { status: 403 })
      : Response.json(result);
  }

  if (path === "/api/keychain/credentials" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (
      !body ||
      typeof body.service !== "string" ||
      typeof body.secret !== "string"
    ) {
      return Response.json(
        {
          error:
            'expected { service, host, secret, ... } or { service, kind: "login", loginUrl, username, secret }',
        },
        { status: 400 },
      );
    }
    // A verified sign-in, like scope and answers: a claimed name (the
    // no-auth picker) or an automation token must never own a credential.
    const owner = verifiedPerson(ctx);
    if (!owner)
      return Response.json(
        { error: "Sign in with GitHub to add a credential" },
        { status: 401 },
      );
    try {
      return Response.json({
        credential: await addCredentialAsync({
          owner,
          service: body.service,
          host: String(body.host || ""),
          secret: body.secret,
          // Anything but "api" or "login" is refused by the spec check.
          ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
          ...(typeof body.loginUrl === "string"
            ? { loginUrl: body.loginUrl }
            : {}),
          ...(typeof body.username === "string"
            ? { username: body.username }
            : {}),
          description:
            typeof body.description === "string" ? body.description : undefined,
          injection: body.injection,
          allowedMethods: Array.isArray(body.allowedMethods)
            ? body.allowedMethods
            : undefined,
          allowedPathPrefixes: Array.isArray(body.allowedPathPrefixes)
            ? body.allowedPathPrefixes
            : undefined,
          statusOnly: body.statusOnly === true,
          ...(typeof body.expiresOn === "string"
            ? { expiresOn: body.expiresOn }
            : {}),
          ...(typeof body.testPath === "string"
            ? { testPath: body.testPath }
            : {}),
          // Anything but "personal" or "workspace" is refused by the spec
          // check, and so is a workspace login.
          ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
        }),
      });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 400 });
    }
  }

  // The owner shares a credential with every session in the workspace, or
  // makes it personal again. Verified sign-in only: a claimed name or an
  // automation token must never open someone's credential to everyone.
  const scopeMatch = path.match(
    /^\/api\/keychain\/credentials\/([^/]+)\/scope$/,
  );
  if (scopeMatch && req.method === "POST") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to change who can use a credential" },
        { status: 401 },
      );
    const body = await req.json().catch(() => null);
    if (body?.scope !== "personal" && body?.scope !== "workspace")
      return Response.json(
        { error: 'expected { scope: "personal" | "workspace" }' },
        { status: 400 },
      );
    try {
      return Response.json(
        await setCredentialScopeAsync(
          decodeURIComponent(scopeMatch[1]!),
          by,
          body.scope,
        ),
      );
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 403 });
    }
  }

  // The owner's status-only test of a credential being added or edited:
  // one GET, only the status back. The body may carry a secret, so nothing
  // here logs or echoes it.
  if (path === "/api/keychain/test" && req.method === "POST") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to test a credential" },
        { status: 401 },
      );
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return Response.json(
        { error: "expected { credentialId?, spec?, secret?, path? }" },
        { status: 400 },
      );
    const result = await testCredential({
      by,
      ...(typeof body.credentialId === "string"
        ? { credentialId: body.credentialId }
        : {}),
      ...(body.spec && typeof body.spec === "object"
        ? { spec: body.spec }
        : {}),
      ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
      ...(typeof body.path === "string" ? { path: body.path } : {}),
    });
    return Response.json(result, {
      status: "error" in result ? 400 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const credMatch = path.match(/^\/api\/keychain\/credentials\/([^/]+)$/);
  // The owner edits a credential from Settings: the fields the body names
  // change, a non-empty secret rotates it. Verified sign-in only, like
  // scope changes.
  if (credMatch && req.method === "PATCH") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to edit a credential" },
        { status: 401 },
      );
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      return Response.json(
        { error: "expected the fields to change" },
        { status: 400 },
      );
    try {
      return Response.json(
        await patchCredentialAsync(decodeURIComponent(credMatch[1]!), by, body),
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e: any) {
      const message = e?.message || String(e);
      const status = /no longer exists/.test(message)
        ? 404
        : /owner can/.test(message)
          ? 403
          : message === STALE_CREDENTIAL_ERROR
            ? 409
            : 400;
      return Response.json({ error: message }, { status });
    }
  }

  if (credMatch && req.method === "DELETE") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to delete a credential" },
        { status: 401 },
      );
    try {
      const ok = await deleteCredentialAsync(
        decodeURIComponent(credMatch[1]!),
        by,
      );
      return ok
        ? Response.json({ ok: true })
        : Response.json({ error: "no such credential" }, { status: 404 });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 403 });
    }
  }

  // The owner allows a grant paused by a widening edit again.
  const resumeMatch = path.match(/^\/api\/keychain\/grants\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to allow a grant again" },
        { status: 401 },
      );
    try {
      const grant = await resumeGrantAsync(
        decodeURIComponent(resumeMatch[1]!),
        by,
      );
      return Response.json({ ok: true, status: grant.status });
    } catch (e: any) {
      const message = e?.message || String(e);
      return Response.json(
        { error: message },
        { status: /owner can/.test(message) ? 403 : 409 },
      );
    }
  }

  const grantMatch = path.match(/^\/api\/keychain\/grants\/([^/]+)$/);
  if (grantMatch && req.method === "DELETE") {
    const by = verifiedPerson(ctx);
    if (!by)
      return Response.json(
        { error: "Sign in with GitHub to revoke a grant" },
        { status: 401 },
      );
    const result = revokeGrant(decodeURIComponent(grantMatch[1]!), by);
    return "error" in result
      ? Response.json(result, { status: 403 })
      : Response.json({ ok: true });
  }

  return undefined;
}

/**
 * The driver's side of a register_credential, update_credential or
 * delete_credential request (credential-registrations.ts):
 *
 *   GET  /api/keychain/registrations?sessionId=     -> { request | null, canAnswer }
 *   POST /api/keychain/registrations/:id            { sessionId, secret? }
 *   POST /api/keychain/registrations/:id/decline    { sessionId }
 *
 * Answering needs a verified GitHub sign-in that matches the person who drove
 * the session when the agent asked; machine auth and the name picker cannot.
 * The request body carries the secret, so nothing here logs or echoes it.
 */
async function handleRegistrationRoutes(ctx: RouteContext): Promise<Response> {
  const { req, path } = ctx;
  const reply = (data: object, status = 200) =>
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  const identity = ctx.authUser as
    | { login?: string; automation?: boolean }
    | null
    | undefined;
  const login =
    identity?.login && identity.automation !== true ? identity.login : "";

  if (path === "/api/keychain/registrations" && req.method === "GET") {
    const open = pendingCredentialRegistration(
      ctx.url.searchParams.get("sessionId") || "",
    );
    return reply({
      request: open?.request ?? null,
      canAnswer: !!open && !!login && login.toLowerCase() === open.login,
    });
  }

  const match = path.match(
    /^\/api\/keychain\/registrations\/([a-f0-9-]{36})(\/decline)?$/,
  );
  if (!match || req.method !== "POST")
    return reply({ error: "Not found" }, 404);
  if (!login)
    return reply(
      { error: "Sign in with GitHub to add a credential to the keychain" },
      401,
    );
  // Cross-site POSTs are refused before routing (opensession.ts,
  // web-auth.ts crossSiteViolation), against the public Host header. Do not
  // compare Origin with ctx.url here: behind the proxy that is the internal
  // backend address, so every real same-site answer would be refused.
  let body: { sessionId?: unknown; secret?: unknown };
  try {
    body = JSON.parse(await readRequestTextWithinLimit(req, 16 * 1024));
  } catch {
    return reply({ error: "Invalid request" }, 400);
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  try {
    if (match[2]) {
      declineCredentialRegistration(sessionId, match[1]!, login);
      return reply({ ok: true });
    }
    const credential = await submitCredentialRegistration(
      sessionId,
      match[1]!,
      login,
      body.secret,
    );
    return reply({ ok: true, credential });
  } catch (error) {
    if (error instanceof CredentialRegistrationError)
      return reply({ error: error.message }, error.status);
    // Never log the error object: the request that raised it carried a secret.
    return reply({ error: "Couldn't save the credential" }, 500);
  }
}
