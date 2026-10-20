/**
 * Incident signals API: signal CRUD (redacted on the way out) and the test
 * run, which checks a draft source once without storing anything.
 *
 * Every handler returns a Response for a matched route or undefined to fall
 * through to the next handler (see routes/index.ts for the dispatch order).
 */

import type { Signal, SignalView } from "../../shared/incidents";
import { MAIN_LANE, recentObservations } from "../incidents/observation-store";
import { signalNextRunAt } from "../incidents/scheduler";
import { forgetSignal, getSignalEvaluation } from "../incidents/signal-runtime";
import {
  createSignal,
  deleteSignal,
  getSignal,
  listSignals,
  updateSignal,
} from "../incidents/signal-store";
import {
  defaultRuleFor,
  redactSignal,
  restoreRedactedSource,
  validateSource,
} from "../incidents/signal-validation";
import { runSignalSource } from "../incidents/sources";
import { webhookObservations } from "../incidents/sources/webhook";
import { type RouteContext, requestUser } from "./context";

const SIGNAL_PATH = /^\/api\/incident-signals\/([^/]+)$/;

/** A signal as the API returns it: redacted, with its live state. */
export function toSignalView(signal: Signal): SignalView {
  const view: SignalView = {
    ...redactSignal(signal),
    evaluation: getSignalEvaluation(signal.id),
  };
  const lastObservation = recentObservations(signal.id, MAIN_LANE).at(-1);
  if (lastObservation) view.lastObservation = lastObservation;
  const nextRunAt = signalNextRunAt(signal.id);
  if (nextRunAt) view.nextRunAt = nextRunAt;
  return view;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

/** The JSON object body, or the 400 to answer with. */
async function readObject(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return badRequest("Body must be a JSON object");
  return body as Record<string, unknown>;
}

/** A stand-in signal for running a draft source once. */
function draftSignal(
  source: Signal["source"],
  provider: boolean,
  stored: Signal | null,
): Signal {
  const now = new Date().toISOString();
  return {
    id: stored?.id ?? "sig-test",
    name: stored?.name ?? "Test",
    project: stored?.project ?? "",
    enabled: true,
    source,
    rule: defaultRuleFor(source.kind) ?? {
      kind: "consecutive",
      failures: 3,
    },
    severity: "major",
    ...(provider ? { provider: true } : {}),
    createdBy: "",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Check a draft source once. Values sent back as `[redacted]` are restored
 * from the stored signal named by `signalId` (same origin only); without one
 * they are an error. Nothing is stored.
 */
async function testRun(body: Record<string, unknown>): Promise<Response> {
  const validated = validateSource(body.source);
  if ("error" in validated) return badRequest(validated.error);
  if (validated.kind === "heartbeat")
    return badRequest("Nothing to test for a heartbeat");
  let stored: Signal | null = null;
  if (body.signalId !== undefined && body.signalId !== null) {
    if (typeof body.signalId !== "string")
      return badRequest("signalId must be a signal id");
    stored = await getSignal(body.signalId);
    if (!stored) return notFound();
  }
  const restored = restoreRedactedSource(stored?.source, validated);
  if ("error" in restored) return badRequest(restored.error);
  const source = restored.source;
  if (source.kind === "webhook") {
    const payload =
      typeof body.payload === "string"
        ? body.payload
        : body.payload === undefined || body.payload === null
          ? ""
          : JSON.stringify(body.payload);
    const { observations, matches } = webhookObservations(
      source,
      payload,
      new Date().toISOString(),
    );
    return Response.json({ observations, matches });
  }
  const provider =
    typeof body.provider === "boolean"
      ? body.provider
      : stored?.provider === true;
  const run = await runSignalSource(draftSignal(source, provider, stored));
  return Response.json({
    observations: run.observations,
    ...(run.preview ? { preview: run.preview } : {}),
  });
}

export async function handleIncidentsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/incident-signals") {
    if (req.method === "GET") {
      const signals = await listSignals();
      return Response.json({ signals: signals.map(toSignalView) });
    }
    if (req.method === "POST") {
      const body = await readObject(req);
      if (body instanceof Response) return body;
      const result = await createSignal(
        body,
        requestUser(ctx, body.user) || "Anonymous",
      );
      if ("error" in result) return badRequest(result.error);
      return Response.json(toSignalView(result));
    }
    return undefined;
  }

  if (path === "/api/incident-signals/test" && req.method === "POST") {
    const body = await readObject(req);
    if (body instanceof Response) return body;
    return testRun(body);
  }

  const signalMatch = SIGNAL_PATH.exec(path);
  if (signalMatch) {
    const id = decodeSegment(signalMatch[1]!);
    if (id === null) return notFound();
    if (req.method === "GET") {
      const signal = await getSignal(id);
      return signal ? Response.json(toSignalView(signal)) : notFound();
    }
    if (req.method === "PUT") {
      const body = await readObject(req);
      if (body instanceof Response) return body;
      const result = await updateSignal(
        id,
        body,
        requestUser(ctx, body.user) || "Anonymous",
      );
      if (result === null) return notFound();
      if ("error" in result) return badRequest(result.error);
      return Response.json(toSignalView(result));
    }
    if (req.method === "DELETE") {
      const user = requestUser(ctx, ctx.url.searchParams.get("user"));
      if (!(await deleteSignal(id, user || "Anonymous"))) return notFound();
      forgetSignal(id);
      return Response.json({ ok: true });
    }
    return undefined;
  }

  return undefined;
}
