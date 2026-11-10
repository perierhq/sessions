/**
 * Blob metrics and review routes (src/server/blob-metrics.ts,
 * src/server/blob-review.ts). Like every /api route they sit behind the
 * gateway's sign-in gate.
 *
 *   POST /api/blob/metrics          { user?, turns: BlobTurnMetric[] } → { stored, rejected }
 *   GET  /api/blob/review?days=14   aggregated stats, no message text
 *
 * The review is owner-only: with sign-in on, only the verified instance
 * owner (support/actor.ts) reads it, and always their own records. With
 * sign-in off every /api route is open to whoever reaches the port, as the
 * /api/admin routes are (routes/system.ts adminDiagnosticsDenied), and the
 * review reads the claimed `user`.
 */
import type { RouteContext } from "./context";
import { requestUser, verifiedPerson } from "./context";
import {
  MAX_BODY_BYTES,
  appendBlobMetrics,
  blobMetricsRateLimited,
  parseMetricsBatch,
} from "../blob-metrics";
import {
  DEFAULT_REVIEW_DAYS,
  MAX_REVIEW_DAYS,
  buildBlobReview,
} from "../blob-review";
import { actorFor, isOwnerActor } from "../support/actor";
import { webAuthRequired } from "../web-auth";

interface RouteDeps {
  signInRequired(): boolean;
  isOwner(ctx: RouteContext, person: string): boolean;
  now(): number;
}

const defaultDeps: RouteDeps = {
  signInRequired: webAuthRequired,
  isOwner: (ctx, person) =>
    isOwnerActor(actorFor(person, true, ctx.authUser?.login)),
  now: Date.now,
};

let deps: RouteDeps = defaultDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setBlobMetricsRouteDepsForTest(
  overrides: Partial<RouteDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

const NO_STORE = { "Cache-Control": "no-store" };

async function readBody(req: Request): Promise<unknown | Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return Response.json({ error: "batch too large" }, { status: 413 });
  const text = await req.text().catch(() => null);
  if (text === null)
    return Response.json({ error: "unreadable body" }, { status: 400 });
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    return Response.json({ error: "batch too large" }, { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
}

function reviewDays(raw: string | null): number {
  const days = Math.floor(Number(raw));
  if (!raw || !Number.isFinite(days) || days < 1) return DEFAULT_REVIEW_DAYS;
  return Math.min(MAX_REVIEW_DAYS, days);
}

export async function handleBlobMetricsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;

  if (path === "/api/blob/metrics" && req.method === "POST") {
    const body = await readBody(req);
    if (body instanceof Response) return body;
    const claimed =
      body && typeof body === "object" ? Reflect.get(body, "user") : undefined;
    const user = requestUser(ctx, claimed);
    if (!user) return Response.json({ error: "missing user" }, { status: 400 });
    const now = deps.now();
    if (blobMetricsRateLimited(user, now))
      return Response.json(
        { error: "Too many metrics batches, try again in a minute" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    const batch = parseMetricsBatch(body, now);
    if (!batch.ok)
      return Response.json({ error: batch.error }, { status: 400 });
    const stored = await appendBlobMetrics(user, batch.turns, now);
    return Response.json(
      { stored, rejected: batch.rejected },
      { headers: NO_STORE },
    );
  }

  if (path === "/api/blob/review" && req.method === "GET") {
    let user: string;
    if (deps.signInRequired()) {
      const person = verifiedPerson(ctx);
      if (!person)
        return Response.json({ error: "Sign in required" }, { status: 401 });
      if (!deps.isOwner(ctx, person))
        return Response.json(
          { error: "Only the instance owner can read the Blob review" },
          { status: 403 },
        );
      user = person;
    } else {
      user = requestUser(ctx, url.searchParams.get("user"));
      if (!user)
        return Response.json({ error: "missing user" }, { status: 400 });
    }
    const review = await buildBlobReview(
      user,
      reviewDays(url.searchParams.get("days")),
      { now: deps.now },
    );
    return Response.json(review, { headers: NO_STORE });
  }

  return undefined;
}
