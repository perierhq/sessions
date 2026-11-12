/**
 * Mainspring settings (src/server/mainspring.ts), owner only.
 *
 *   GET    /api/settings/mainspring        { url, keySet, keyHint, routeClaude, fallbackDirect, models, modelsAt }
 *   PUT    /api/settings/mainspring        { url?, key?, routeClaude?, fallbackDirect? } (key write-only)
 *   DELETE /api/settings/mainspring/key    forgets the key and turns routing off
 *   POST   /api/settings/mainspring/test   GET /v1/models with the saved key
 *
 * The owner is the verified instance owner (support/actor.ts), the same rule
 * as Blob's GitHub account (routes/blob-github.ts): the key spends every
 * subscription behind Mainspring, so a claimed name, an automation or an
 * instance without sign-in never qualifies. No response carries the key.
 */
import type { RouteContext } from "./context";
import { verifiedPerson } from "./context";
import {
  getMainspringSettings,
  removeMainspringKey,
  saveMainspringSettings,
  testMainspring,
  validateMainspringPatch,
} from "../mainspring";
import { auditAsync } from "../audit";
import { refreshPickerModels } from "../models";
import { actorFor, isOwnerActor } from "../support/actor";

interface RouteDeps {
  isOwner(ctx: RouteContext, person: string): boolean;
  /** Rebuild the model picker after the model list or routing changed. */
  refreshPicker(): void;
  audit(event: Record<string, unknown>): void;
}

const defaultDeps: RouteDeps = {
  isOwner: (ctx, person) =>
    isOwnerActor(actorFor(person, true, ctx.authUser?.login)),
  refreshPicker: refreshPickerModels,
  audit: auditAsync,
};

let deps: RouteDeps = defaultDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setMainspringRouteDepsForTest(
  overrides: Partial<RouteDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

const NO_STORE = { "Cache-Control": "no-store" };
const BASE = "/api/settings/mainspring";

export async function handleMainspringRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return undefined;

  const person = verifiedPerson(ctx);
  if (!person)
    return Response.json({ error: "Sign in required" }, { status: 401 });
  if (!deps.isOwner(ctx, person))
    return Response.json(
      { error: "Only the instance owner can set up Mainspring" },
      { status: 403 },
    );

  if (path === BASE && req.method === "GET")
    return Response.json(
      { mainspring: await getMainspringSettings() },
      { headers: NO_STORE },
    );

  if (path === BASE && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const patch = validateMainspringPatch(body);
    if ("error" in patch)
      return Response.json({ error: patch.error }, { status: 400 });
    const result = await saveMainspringSettings(patch);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: result.status });
    deps.audit({
      msg: "mainspring_settings",
      user: person,
      fields: Object.keys(patch),
      route_claude: result.settings.routeClaude,
      fallback_direct: result.settings.fallbackDirect,
    });
    deps.refreshPicker();
    return Response.json(
      { mainspring: result.settings },
      { headers: NO_STORE },
    );
  }

  if (path === `${BASE}/key` && req.method === "DELETE") {
    const settings = await removeMainspringKey();
    deps.audit({ msg: "mainspring_key_removed", user: person });
    deps.refreshPicker();
    return Response.json({ mainspring: settings }, { headers: NO_STORE });
  }

  if (path === `${BASE}/test` && req.method === "POST") {
    const result = await testMainspring();
    if (!result.ok)
      return Response.json(
        {
          test: { ok: false, error: result.error },
          mainspring: await getMainspringSettings(),
        },
        { headers: NO_STORE },
      );
    deps.refreshPicker();
    return Response.json(
      {
        test: { ok: true, models: result.models },
        mainspring: result.settings,
      },
      { headers: NO_STORE },
    );
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
