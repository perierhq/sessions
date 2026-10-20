// Webhook and heartbeat intake on the public webhook gateway:
// `/incident-hooks/<signalId>/<secret>` (POST; GET too for heartbeats) and
// `/incident-hooks/<signalId>/<secret>/fail` for a heartbeat reporting a
// failure. The secret in the path is the only auth, so every wrong door
// (unknown id, wrong secret, a signal that is not a hook, the wrong method
// or suffix) gets the same 404. No per-call audit: the observations are
// their own record.
import { timingSafeEqual } from "node:crypto";
import type { Observation, Signal } from "../../shared/incidents";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../shared/bounded-body";
import { isShuttingDown } from "../shutdown-state";
import type { PublicWebhookHandler } from "../webhook-server";
import { ingestObservations } from "./signal-runtime";
import { getSignal } from "./signal-store";
import { webhookObservations } from "./sources/webhook";

export const WEBHOOK_BODY_CAP = 262_144;
export const HEARTBEAT_BODY_CAP = 10_000;

const MAX_DETAIL_CHARS = 200;
const HOOK_PATH = /^\/incident-hooks\/([^/]+)\/([^/]+)(\/fail)?$/;

interface HookPath {
  signalId: string;
  secret: string;
  fail: boolean;
}

function parseHookPath(pathname: string): HookPath | null {
  const match = HOOK_PATH.exec(pathname);
  if (!match) return null;
  return { signalId: match[1]!, secret: match[2]!, fail: !!match[3] };
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

function restarting(): Response {
  return Response.json({ error: "Server restarting" }, { status: 503 });
}

function secretMatches(stored: string | undefined, given: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, MAX_DETAIL_CHARS) : "";
}

function heartbeatObservation(
  fail: boolean,
  body: string,
  at: string,
): Observation {
  const detail =
    firstLine(body) || (fail ? "Reported a failure" : "Checked in");
  return { at, result: fail ? "fail" : "ok", detail };
}

/** The signal this door opens, or null for any wrong door. */
async function hookSignal(
  method: "GET" | "POST",
  hook: HookPath,
): Promise<Signal | null> {
  const signal = await getSignal(hook.signalId);
  if (!signal || !secretMatches(signal.hookSecret, hook.secret)) return null;
  // An http or expiry signal may still hold a secret from an earlier kind.
  switch (signal.source.kind) {
    case "webhook":
      return method === "POST" && !hook.fail ? signal : null;
    case "heartbeat":
      return signal;
    default:
      return null;
  }
}

function handler(method: "GET" | "POST"): PublicWebhookHandler {
  return async (req, url) => {
    if (isShuttingDown()) return restarting();
    const hook = parseHookPath(url.pathname);
    if (!hook) return Response.json({ error: "Bad path" }, { status: 400 });
    const signal = await hookSignal(method, hook);
    if (!signal) return notFound();
    if (!signal.enabled)
      return Response.json({ ok: false, skipped: "disabled" });

    const cap =
      signal.source.kind === "webhook" ? WEBHOOK_BODY_CAP : HEARTBEAT_BODY_CAP;
    let body = "";
    try {
      body = await readRequestTextWithinLimit(req, cap);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError)
        return webhookBodyTooLargeResponse(cap);
      throw error;
    }
    if (isShuttingDown()) return restarting();

    const now = Date.now();
    const at = new Date(now).toISOString();
    const observations =
      signal.source.kind === "webhook"
        ? webhookObservations(signal.source, body, at).observations
        : [heartbeatObservation(hook.fail, body, at)];
    await ingestObservations(signal.id, observations, now);
    return Response.json({ ok: true });
  };
}

export function incidentHookRoutes(): Map<string, PublicWebhookHandler> {
  return new Map([
    ["POST /incident-hooks/*", handler("POST")],
    ["GET /incident-hooks/*", handler("GET")],
  ]);
}
