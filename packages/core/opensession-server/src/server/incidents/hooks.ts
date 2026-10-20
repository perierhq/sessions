// Webhook and heartbeat intake on the public webhook gateway:
// `/incident-hooks/<signalId>/<secret>` (POST; GET too for heartbeats) and
// `/incident-hooks/<signalId>/<secret>/fail` (POST only) for a heartbeat
// reporting a failure. The secret in the path is the only auth, so every wrong door
// (unknown id, wrong secret, a signal that is not a hook, the wrong method
// or suffix) gets the same 404. A signal takes at most 60 calls a minute;
// the rest get a 429 and are not recorded. No per-call audit: the
// observations are their own record.
import { timingSafeEqual } from "node:crypto";
import type { Observation, Signal } from "../../shared/incidents";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../shared/bounded-body";
import { isShuttingDown } from "../shutdown-state";
import type { PublicWebhookHandler } from "../webhook-server";
import { recordObservations } from "./signal-runtime";
import { getSignal } from "./signal-store";
import { webhookObservations } from "./sources/webhook";

export const WEBHOOK_BODY_CAP = 262_144;
export const HEARTBEAT_BODY_CAP = 10_000;

export const HOOK_CALLS_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;

const MAX_DETAIL_CHARS = 200;

/** Accepted call instants per signal within the last minute, oldest first. */
let hookCalls = new Map<string, number[]>();

export function __resetHookRateForTest(): void {
  hookCalls = new Map();
}

/** Spend one call of the signal's budget, or say when the next one frees. */
export function takeHookCall(
  signalId: string,
  now: number,
): { ok: true } | { ok: false; retryAfterS: number } {
  const recent = (hookCalls.get(signalId) ?? []).filter(
    (at) => now - at < RATE_WINDOW_MS && at <= now,
  );
  if (recent.length >= HOOK_CALLS_PER_MINUTE) {
    hookCalls.set(signalId, recent);
    const frees = recent[0]! + RATE_WINDOW_MS;
    return {
      ok: false,
      retryAfterS: Math.max(1, Math.ceil((frees - now) / 1000)),
    };
  }
  recent.push(now);
  hookCalls.set(signalId, recent);
  // Past 1000 signals, those quiet for a minute are forgotten.
  if (hookCalls.size > 1_000)
    for (const [id, calls] of hookCalls)
      if (!calls.length || now - calls.at(-1)! >= RATE_WINDOW_MS)
        hookCalls.delete(id);
  return { ok: true };
}
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
      // A GET is a plain check-in; reporting a failure takes a POST.
      return method === "POST" || !hook.fail ? signal : null;
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
    const budget = takeHookCall(signal.id, Date.now());
    if (!budget.ok)
      return Response.json(
        { error: "Too many calls" },
        { status: 429, headers: { "retry-after": String(budget.retryAfterS) } },
      );

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
    // Answered once recorded; the engine catches up in the background.
    recordObservations(signal, observations, now);
    return Response.json({ ok: true });
  };
}

export function incidentHookRoutes(): Map<string, PublicWebhookHandler> {
  return new Map([
    ["POST /incident-hooks/*", handler("POST")],
    ["GET /incident-hooks/*", handler("GET")],
  ]);
}
