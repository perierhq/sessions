/**
 * Supervisor routes: get-or-create the user's standing supervisor session
 * (src/server/supervisor.ts), the one the Blob app talks to, and its inbox
 * (src/server/supervisor-inbox.ts). Every route resolves the user exactly
 * like `/api/desk/ensure` (routes/todos.ts): the signed-in person, else the
 * claimed name.
 *
 *   POST /api/supervisor/ensure                 { user } → { sessionId, previousSessionIds, session }
 *   GET  /api/supervisor/items?user=&state=&kind=&since=&limit=
 *                                               → { items: [{ ...item, revision, act? }] }
 *   POST /api/supervisor/items/:id/answer       { user, answer, revision? }
 *   POST /api/supervisor/items/:id/dismiss      { user }
 *   POST /api/supervisor/items/shown            { user, ids } → { marked }, Blob showed these open items
 *   GET  /api/supervisor/leads                  → { leads: LeadRosterEntry[] }, every project's lead
 *   GET  /api/supervisor/prefs?user=
 *   PUT  /api/supervisor/prefs                  { user, quietStart?, quietEnd?, digestAt?, timezone?, reportStyle?, watch?: { enabled?, everyMinutes?, activeStart?, activeEnd? }, memoryWriter? }
 *   GET  /api/supervisor/bark                    keys masked; signed in only
 *   PUT  /api/supervisor/bark                    { enabled?, serverUrl?, openIn?, speak?, deviceKey?, encryption? }
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
  markSupervisorItemsShown,
  setSupervisorPrefs,
  type CloseResult,
  type SupervisorItemKind,
  type SupervisorItemState,
} from "../supervisor-inbox";
import { validatePrefsPatch } from "../supervisor-quiet-hours";
import { withItemActs } from "../leads/item-acts";
import { listLeadRoster } from "../leads/roster";

const ITEM_ACTION = /^\/api\/supervisor\/items\/([^/]+)\/(answer|dismiss)$/;
const STATES: readonly SupervisorItemState[] = [
  "open",
  "answered",
  "dismissed",
  "expired",
];
const KINDS: readonly SupervisorItemKind[] = ["needs-you", "fyi"];
const MAX_SHOWN_IDS = 100;

function missingUser(): Response {
  return Response.json({ error: "missing user" }, { status: 400 });
}

function closeResponse(result: CloseResult): Response {
  if (result.ok) return Response.json({ item: result.item });
  if (result.error === "not-found")
    return Response.json({ error: "not found" }, { status: 404 });
  if (result.error === "closed")
    return Response.json({ error: "already closed" }, { status: 409 });
  // The item was rewritten after the client read it: it stays open, and
  // the client shows the new version.
  if (result.error === "changed")
    return Response.json({ error: "changed" }, { status: 409 });
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
    const { sessionId, previousSessionIds } =
      await ensureSupervisorSession(user);
    return Response.json({
      sessionId,
      // Earlier supervisor sessions, newest first: the history before each
      // rotation (supervisor.ts), for paging back.
      previousSessionIds,
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
    // fields=id is for counting: just the ids, without reading lead records.
    if (url.searchParams.get("fields") === "id") {
      return Response.json({ items: items.map(({ id }) => ({ id })) });
    }
    // Each item with the revision an answer names, and a lead's item with
    // the steps its approval runs, read from the record (leads/item-acts.ts).
    return Response.json({ items: await withItemActs(items) });
  }

  // Blob displayed these open items to the owner: the supervisor's
  // briefing lists them after unseen ones and folds repeats
  // (supervisor-inbox.ts briefPlace). Besides a reply that names an item,
  // this is the only way an item counts as shown.
  // TODO(ios): call this from the Blob app when it displays a decision
  // (OS1API.supervisorItems callers); no client calls it yet.
  if (path === "/api/supervisor/items/shown" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return missingUser();
    const ids: unknown = body?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_SHOWN_IDS ||
      !ids.every((id) => typeof id === "string" && id.length <= 80)
    )
      return Response.json({ error: "invalid ids" }, { status: 400 });
    return Response.json({
      marked: await markSupervisorItemsShown(user, ids as string[]),
    });
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
      // The item's updatedAt as the client showed it. Optional: older
      // clients send none, and their answers approve nothing. A revision
      // the item no longer has answers nothing (409 `changed`).
      const revision: unknown = body?.revision;
      if (
        revision !== undefined &&
        (typeof revision !== "number" ||
          !Number.isSafeInteger(revision) ||
          revision < 0)
      )
        return Response.json({ error: "invalid revision" }, { status: 400 });
      // Only a signed-in person's login: never a claimed name or an
      // automation's.
      const login = verifiedPerson(ctx) ? ctx.authUser?.login : undefined;
      return closeResponse(
        await answerSupervisorItem(user, id, answer, "owner", {
          ...(login ? { login } : {}),
          ...(revision !== undefined ? { revision } : {}),
        }),
      );
    }
    return closeResponse(await dismissSupervisorItem(user, id));
  }

  // Read only: each project's lead from its stored settings document
  // (leads/roster.ts), for Settings, Members.
  if (path === "/api/supervisor/leads" && req.method === "GET")
    return Response.json({ leads: await listLeadRoster() });

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
    const prefs = await setSupervisorPrefs(user, patch);
    // The watch follows the prefs: turned off it pauses, turned on it
    // starts (supervisor-watch.ts). Not awaited: the prefs are saved.
    if (patch.watch)
      void import("../supervisor-watch")
        .then(({ ensureWatchGoal }) => ensureWatchGoal(user))
        .catch((error: unknown) =>
          console.warn(
            "[watch] could not apply the prefs:",
            error instanceof Error ? error.message : error,
          ),
        );
    return Response.json({ prefs });
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
