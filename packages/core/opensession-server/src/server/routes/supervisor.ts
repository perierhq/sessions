/**
 * Supervisor routes: get-or-create the user's standing supervisor session
 * (src/server/supervisor.ts), the one the Blob app talks to, and its inbox
 * (src/server/supervisor-inbox.ts). Every route resolves the user exactly
 * like `/api/desk/ensure` (routes/todos.ts): the signed-in person, else the
 * claimed name.
 *
 *   POST /api/supervisor/ensure                 { user }
 *   GET  /api/supervisor/items?user=&state=&kind=&since=&limit=
 *   POST /api/supervisor/items/:id/answer       { user, answer }
 *   POST /api/supervisor/items/:id/dismiss      { user }
 *   GET  /api/supervisor/prefs?user=
 *   PUT  /api/supervisor/prefs                  { user, quietStart?, quietEnd?, digestAt?, timezone?, reportStyle? }
 *   GET  /api/supervisor/bark                    keys masked; signed in only
 *   PUT  /api/supervisor/bark                    { enabled?, serverUrl?, openIn?, deviceKey?, encryption? }
 *   POST /api/supervisor/bark/test
 */

import type { RouteContext } from "./context";
import { requestUser, verifiedPerson } from "./context";
import { findSessionAsync } from "../session-cache";
import { ensureSupervisorSession } from "../supervisor";
import {
  getBarkSettings,
  sendBarkTest,
  setBarkSettings,
  validateBarkPatch,
} from "../bark";
import {
  answerSupervisorItem,
  dismissSupervisorItem,
  getSupervisorPrefs,
  listSupervisorItems,
  setSupervisorPrefs,
  type CloseResult,
  type SupervisorItemKind,
  type SupervisorItemState,
} from "../supervisor-inbox";
import { validatePrefsPatch } from "../supervisor-quiet-hours";

const ITEM_ACTION = /^\/api\/supervisor\/items\/([^/]+)\/(answer|dismiss)$/;
const STATES: readonly SupervisorItemState[] = [
  "open",
  "answered",
  "dismissed",
  "expired",
];
const KINDS: readonly SupervisorItemKind[] = ["needs-you", "fyi"];

function missingUser(): Response {
  return Response.json({ error: "missing user" }, { status: 400 });
}

function closeResponse(result: CloseResult): Response {
  if (result.ok) return Response.json({ item: result.item });
  if (result.error === "not-found")
    return Response.json({ error: "not found" }, { status: 404 });
  if (result.error === "closed")
    return Response.json({ error: "already closed" }, { status: 409 });
  return Response.json({ error: "missing answer" }, { status: 400 });
}

export async function handleSupervisorRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;

  if (path === "/api/supervisor/ensure" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return missingUser();
    const { sessionId } = await ensureSupervisorSession(user);
    return Response.json({
      sessionId,
      session: (await findSessionAsync(sessionId)) ?? null,
    });
  }

  if (path === "/api/supervisor/items" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user"));
    if (!user) return missingUser();
    const state = STATES.find((s) => s === url.searchParams.get("state"));
    const kind = KINDS.find((k) => k === url.searchParams.get("kind"));
    const since = Number(url.searchParams.get("since"));
    const limit = Number(url.searchParams.get("limit"));
    const items = await listSupervisorItems(user, {
      state,
      kind,
      since: Number.isFinite(since) && since > 0 ? since : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return Response.json({ items });
  }

  const action = ITEM_ACTION.exec(path);
  if (action && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return missingUser();
    let id: string;
    try {
      id = decodeURIComponent(action[1]!);
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (action[2] === "answer") {
      const answer = typeof body?.answer === "string" ? body.answer : "";
      if (!answer.trim())
        return Response.json({ error: "missing answer" }, { status: 400 });
      return closeResponse(
        await answerSupervisorItem(user, id, answer, "owner"),
      );
    }
    return closeResponse(await dismissSupervisorItem(user, id));
  }

  if (path === "/api/supervisor/prefs" && req.method === "GET") {
    const user = requestUser(ctx, url.searchParams.get("user"));
    if (!user) return missingUser();
    return Response.json({ prefs: await getSupervisorPrefs(user) });
  }

  if (path === "/api/supervisor/prefs" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return missingUser();
    const { user: _user, ...fields } =
      body && typeof body === "object" ? body : ({} as Record<string, unknown>);
    const patch = validatePrefsPatch(fields);
    if ("error" in patch)
      return Response.json({ error: patch.error }, { status: 400 });
    return Response.json({ prefs: await setSupervisorPrefs(user, patch) });
  }

  // Bark holds the person's device and encryption keys: signed-in people
  // only, never a claimed name or an automation.
  if (path === "/api/supervisor/bark" || path === "/api/supervisor/bark/test") {
    const user = verifiedPerson(ctx);
    if (!user)
      return Response.json(
        { error: "Sign in to set up Bark" },
        { status: 401 },
      );

    if (path === "/api/supervisor/bark" && req.method === "GET")
      return Response.json({ bark: await getBarkSettings(user) });

    if (path === "/api/supervisor/bark" && req.method === "PUT") {
      const body = await req.json().catch(() => null);
      const { user: _user, ...fields } =
        body && typeof body === "object"
          ? body
          : ({} as Record<string, unknown>);
      const patch = validateBarkPatch(fields);
      if ("error" in patch)
        return Response.json({ error: patch.error }, { status: 400 });
      const result = await setBarkSettings(user, patch);
      if (!result.ok)
        return Response.json({ error: result.error }, { status: 400 });
      return Response.json({ bark: result.settings });
    }

    if (path === "/api/supervisor/bark/test" && req.method === "POST") {
      const result = await sendBarkTest(user);
      if (result.ok) return Response.json({ ok: true });
      return Response.json(
        { error: result.error },
        { status: result.setup ? 400 : 502 },
      );
    }
  }

  return undefined;
}
