/**
 * Supervisor routes: get-or-create the user's standing supervisor session
 * (src/server/supervisor.ts), the one the Blob app talks to. Resolves the
 * user exactly like `/api/desk/ensure` (routes/todos.ts).
 */

import type { RouteContext } from "./context";
import { requestUser } from "./context";
import { findSessionAsync } from "../session-cache";
import { ensureSupervisorSession } from "../supervisor";

export async function handleSupervisorRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/supervisor/ensure" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    const user = requestUser(ctx, body?.user);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    const { sessionId } = await ensureSupervisorSession(user);
    return Response.json({
      sessionId,
      session: (await findSessionAsync(sessionId)) ?? null,
    });
  }

  return undefined;
}
