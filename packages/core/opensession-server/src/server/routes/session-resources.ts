/**
 * What a session still has running on this host, and stopping it.
 *
 *   GET  /api/sessions/:id/resources       -> SessionResourceList
 *   POST /api/sessions/:id/resources/stop  -> { stopped }; 409 while it runs
 *   GET  /api/host/session-resources       -> HostSessionResources
 *
 * See session-resource-inventory.ts.
 */
import type { RouteContext } from "./context";
import type {
  HostSessionResources,
  SessionResourceList,
  StopSessionResourcesResult,
} from "../../shared/session-resources";
import type { InventoryOwner } from "../session-resource-inventory";
import type { SessionResourceOwner } from "../session-resources";

const reply = (data: object, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** The seams the routes use, replaceable in tests. */
export type SessionResourceRouteDeps = {
  findSession: (id: string) => Promise<InventoryOwner | undefined>;
  listSessions: () => Promise<readonly SessionResourceOwner[]>;
  isIdle: (id: string) => boolean;
  list: (
    session: InventoryOwner,
    sessions: readonly SessionResourceOwner[],
  ) => Promise<SessionResourceList>;
  stop: (
    session: InventoryOwner,
    sessions: readonly SessionResourceOwner[],
  ) => Promise<number>;
  host: (
    sessions: readonly SessionResourceOwner[],
  ) => Promise<HostSessionResources>;
};

async function defaultDeps(): Promise<SessionResourceRouteDeps> {
  const [cache, inventory] = await Promise.all([
    import("../session-cache"),
    import("../session-resource-inventory"),
  ]);
  return {
    findSession: cache.findSessionAsync,
    listSessions: () => cache.getSessionListSnapshotAsync(),
    isIdle: cache.isRunSettled,
    list: inventory.sessionResourceList,
    stop: inventory.stopSessionWorkloads,
    host: inventory.hostSessionResources,
  };
}

let depsOverride: SessionResourceRouteDeps | null = null;

/** Test seam. */
export function __setSessionResourceRouteDepsForTest(
  deps: SessionResourceRouteDeps | null,
): void {
  depsOverride = deps;
}

export async function handleSessionResourceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path === "/api/host/session-resources") {
    if (req.method !== "GET") return undefined;
    const deps = depsOverride ?? (await defaultDeps());
    return reply(await deps.host(await deps.listSessions()));
  }
  const match = path.match(/^\/api\/sessions\/([^/]+)\/resources(\/stop)?$/);
  if (!match) return undefined;
  const stop = !!match[2];
  if (req.method !== (stop ? "POST" : "GET")) return undefined;
  const deps = depsOverride ?? (await defaultDeps());
  const session = await deps.findSession(decodeURIComponent(match[1]!));
  if (!session) return reply({ error: "Session not found" }, 404);
  const sessions = await deps.listSessions();
  if (!stop) return reply(await deps.list(session, sessions));
  // Stopping a running session's dev server or database under it would
  // break the turn; stop the run first.
  if (!deps.isIdle(session.id))
    return reply({ error: "The session is running. Stop the run first." }, 409);
  const result: StopSessionResourcesResult = {
    stopped: await deps.stop(session, sessions),
  };
  return reply(result);
}
