/**
 * Incidents API: signal CRUD (redacted on the way out), the test run, which
 * checks a draft source once without storing anything, incidents, and the
 * strips drawn from stored observations (a deleted signal keeps its lanes).
 *
 * Every handler returns a Response for a matched route or undefined to fall
 * through to the next handler (see routes/index.ts for the dispatch order).
 */

import type {
  Incident,
  Signal,
  SignalView,
  StripLane,
  StripMarker,
  StripResponse,
} from "../../shared/incidents";
import {
  getIncident,
  listIncidents,
  summarizeIncident,
} from "../incidents/incident-store";
import {
  MAIN_LANE,
  recentObservations,
  scanObservations,
} from "../incidents/observation-store";
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
import {
  createStripBucketer,
  defaultStripRange,
  markersFromEvents,
  stripBucketMs,
  stripIntervalMs,
} from "../incidents/strip";
import { type RouteContext, requestUser } from "./context";

const SIGNAL_PATH = /^\/api\/incident-signals\/([^/]+)$/;
const SIGNAL_STRIP_PATH = /^\/api\/incident-signals\/([^/]+)\/strip$/;
const INCIDENT_PATH = /^\/api\/incidents\/([^/]+)$/;
const INCIDENT_STRIP_PATH = /^\/api\/incidents\/([^/]+)\/strip$/;

const MINUTE_MS = 60_000;
const MAX_STRIP_SPAN_MS = 31 * 24 * 60 * MINUTE_MS;
/** Lead-in before an incident opened: 15 minutes or 10% of its length. */
const INCIDENT_LEAD_MIN_MS = 15 * MINUTE_MS;
/** Tail after an incident closed. */
const INCIDENT_TAIL_MS = 10 * MINUTE_MS;

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

class StripRangeError extends Error {}

/** One signal's lanes over `[from, to]`, streamed from stored observations. */
async function signalLanes(
  signalId: string,
  signal: Signal | null,
  from: number,
  to: number,
  bucketMs: number,
): Promise<StripLane[]> {
  let bucketer: ReturnType<typeof createStripBucketer>;
  try {
    bucketer = createStripBucketer({
      signalId,
      label: signal?.name ?? signalId,
      from,
      to,
      bucketMs,
      valueWorst: signal?.rule.kind === "deadline" ? "min" : "max",
    });
  } catch (error) {
    if (error instanceof RangeError) throw new StripRangeError(error.message);
    throw error;
  }
  await scanObservations(signalId, from, to, (o) => bucketer.add(o));
  return bucketer.lanes();
}

function byAt(a: StripMarker, b: StripMarker): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/** `from`/`to` from the query, else the signal's default range. */
function signalStripRange(
  url: URL,
  signal: Signal,
  now: number,
): { from: number; to: number } | Response {
  const rawFrom = url.searchParams.get("from");
  const rawTo = url.searchParams.get("to");
  const fallback = defaultStripRange(signal, now);
  const to = rawTo === null ? now : Date.parse(rawTo);
  const from =
    rawFrom === null ? to - (fallback.to - fallback.from) : Date.parse(rawFrom);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    return badRequest("Invalid range");
  if (to - from > MAX_STRIP_SPAN_MS) return badRequest("Range over 31 days");
  return { from, to };
}

async function signalStrip(url: URL, id: string): Promise<Response> {
  const signal = await getSignal(id);
  if (!signal) return notFound();
  const range = signalStripRange(url, signal, Date.now());
  if (range instanceof Response) return range;
  const { from, to } = range;
  const bucketMs = stripBucketMs(stripIntervalMs(signal), from, to);
  try {
    const lanes = await signalLanes(id, signal, from, to, bucketMs);
    const markers = (await listIncidents({ signalId: id }))
      .flatMap((incident) =>
        markersFromEvents(incident.id, incident.events, from, to),
      )
      .sort(byAt);
    const nextRunAt = signalNextRunAt(id);
    const body: StripResponse = {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      bucketMs,
      lanes,
      markers,
      ...(nextRunAt ? { nextRunAt } : {}),
    };
    return Response.json(body);
  } catch (error) {
    if (error instanceof StripRangeError) return badRequest(error.message);
    throw error;
  }
}

/**
 * An incident's range: a lead-in before it opened, up to now or a little
 * after it closed, at most the last 31 days (older observations are past
 * retention anyway).
 */
function incidentStripRange(
  incident: Incident,
  now: number,
): { from: number; to: number } {
  const opened = Date.parse(incident.openedAt);
  const closed = incident.closedAt ? Date.parse(incident.closedAt) : NaN;
  const end = Number.isFinite(closed) ? closed : now;
  const lead = Math.max(INCIDENT_LEAD_MIN_MS, 0.1 * Math.max(0, end - opened));
  const to = Number.isFinite(closed)
    ? Math.min(now, closed + INCIDENT_TAIL_MS)
    : now;
  let from = opened - lead;
  if (to - from > MAX_STRIP_SPAN_MS) from = to - MAX_STRIP_SPAN_MS;
  if (!(from < to)) from = to - INCIDENT_LEAD_MIN_MS;
  return { from, to };
}

async function incidentStrip(id: string): Promise<Response> {
  const incident = await getIncident(id);
  if (!incident) return notFound();
  const { from, to } = incidentStripRange(incident, Date.now());
  const signals = await Promise.all(
    incident.signalIds.map((signalId) => getSignal(signalId)),
  );
  const intervals = signals
    .filter((signal): signal is Signal => signal !== null)
    .map(stripIntervalMs);
  const intervalMs = intervals.length ? Math.min(...intervals) : MINUTE_MS;
  const bucketMs = stripBucketMs(intervalMs, from, to);
  try {
    const lanes: StripLane[] = [];
    for (const [index, signalId] of incident.signalIds.entries())
      lanes.push(
        ...(await signalLanes(
          signalId,
          signals[index] ?? null,
          from,
          to,
          bucketMs,
        )),
      );
    const body: StripResponse = {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      bucketMs,
      lanes,
      markers: markersFromEvents(incident.id, incident.events, from, to),
    };
    return Response.json(body);
  } catch (error) {
    if (error instanceof StripRangeError) return badRequest(error.message);
    throw error;
  }
}

async function incidentList(url: URL): Promise<Response> {
  const status = url.searchParams.get("status") ?? "all";
  if (status !== "open" && status !== "closed" && status !== "all")
    return badRequest("Status must be open, closed or all");
  const project = url.searchParams.get("project");
  const incidents = await listIncidents({
    ...(status === "all" ? {} : { open: status === "open" }),
    ...(project ? { project } : {}),
  });
  return Response.json({ incidents: incidents.map(summarizeIncident) });
}

export async function handleIncidentsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path, url } = ctx;

  if (req.method === "GET") {
    if (path === "/api/incidents") return incidentList(url);
    const incidentStripMatch = INCIDENT_STRIP_PATH.exec(path);
    if (incidentStripMatch) {
      const id = decodeSegment(incidentStripMatch[1]!);
      return id === null ? notFound() : incidentStrip(id);
    }
    const incidentMatch = INCIDENT_PATH.exec(path);
    if (incidentMatch) {
      const id = decodeSegment(incidentMatch[1]!);
      const incident = id === null ? null : await getIncident(id);
      return incident ? Response.json(incident) : notFound();
    }
    const signalStripMatch = SIGNAL_STRIP_PATH.exec(path);
    if (signalStripMatch) {
      const id = decodeSegment(signalStripMatch[1]!);
      return id === null ? notFound() : signalStrip(url, id);
    }
  }

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
