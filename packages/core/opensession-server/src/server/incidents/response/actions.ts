// The project's typed actions, run by Sessions alone on a production Runner
// reserved for incidents, and the release hook a deploy pipeline outside
// Sessions calls so rollback-first knows its releases. Every placeholder
// value is validated and shell-quoted. The rendered command goes to the
// Runner on stdin (`bash -s`), so it is never in argv, the process list, the
// audit log or the returned run. A Runner problem leaves the run `unknown`,
// never `failed`: it may or may not have run. A run is returned finished and
// never retried here, and an interrupted or unknown run is never run again
// on its own: the caller records the intent first, so a restart or a lost
// Runner mid-run is visible and goes to a person.
import { randomUUIDv7 } from "bun";
import { timingSafeEqual } from "node:crypto";
import {
  ACTION_PLACEHOLDERS,
  type ActionRun,
  type IncidentAction,
  type IncidentProjectSettings,
} from "../../../shared/incident-response";
import { type RunnerExecResult, execOnIncidentRunner } from "../../runner-ws";
import {
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../shared/bounded-body";
import { isShuttingDown } from "../../shutdown-state";
import type { PublicWebhookHandler } from "../../webhook-server";
import { incidentAudit } from "../audit-sink";
import { shellQuote } from "../sources/runner-fetch";
import {
  getProjectSettings,
  incidentProjectExists,
  recordRelease,
} from "./project-settings";

export interface ActionVars {
  incident: string;
  project: string;
  ref?: string;
  previousRef?: string;
}

const SHA = /^[0-9a-f]{7,40}$/;
const VALUE_RULES: Record<keyof ActionVars, RegExp> = {
  ref: SHA,
  previousRef: SHA,
  incident: /^inc-[A-Za-z0-9-]{1,80}$/,
  project: /^[A-Za-z0-9._-]{1,100}$/,
};
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const STDERR_DETAIL_MAX = 300;

function isPlaceholder(name: string): name is keyof ActionVars {
  return (ACTION_PLACEHOLDERS as readonly string[]).includes(name);
}

/** Each `{{name}}` becomes its shell-quoted, validated value. */
export function renderActionCommand(
  command: string,
  vars: ActionVars,
): string | { error: string } {
  for (const match of command.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!isPlaceholder(name))
      return { error: `Unknown placeholder {{${name}}}` };
    const value = vars[name];
    if (value === undefined) return { error: `{{${name}}} has no value` };
    if (typeof value !== "string" || !VALUE_RULES[name].test(value))
      return { error: `Invalid value for {{${name}}}` };
  }
  return command.replace(PLACEHOLDER, (_, name: keyof ActionVars) =>
    shellQuote(vars[name]!),
  );
}

export function newActionRunId(): string {
  return `act-${randomUUIDv7()}`;
}

export interface ActionDeps {
  exec: (
    runnerId: string,
    command: string,
    opts: {
      timeoutMs: number;
      repo: string;
      stdin: string;
      auditCommand: string;
      sessionId?: string;
      cwd?: string;
    },
  ) => Promise<RunnerExecResult>;
  now: () => number;
}

/** The Runner runs the script it reads on stdin. */
const ACTION_COMMAND = "exec bash -s";

/** The script as one group whose own stdin is empty: bash reads the whole
 *  group before running it, so a step that reads stdin (`cat`, `read`, an
 *  ssh) gets nothing instead of consuming the rest of the script. */
function actionScript(rendered: string): string {
  return `{\n${rendered}\n} </dev/null\n`;
}
const CHECK_PRODUCTION = "Check production before going on";

function lastStderrLine(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1)?.slice(0, STDERR_DETAIL_MAX);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, STDERR_DETAIL_MAX) || "The action failed";
}

/** A Runner problem: refused before dispatch (the action did not start),
 *  or anything else that went wrong getting it there (it may have). */
function runnerProblemDetail(error: unknown): string {
  return (error as { code?: unknown }).code === "RUNNER_UNAVAILABLE"
    ? `${errorMessage(error)}. The action did not start`
    : `The Runner failed while the action started: ${errorMessage(error)}. ${CHECK_PRODUCTION}`;
}

/** Runs one action and returns the finished run. Never throws. */
export async function runIncidentAction(
  input: {
    runId: string;
    incidentId: string;
    round: number;
    project: string;
    action: IncidentAction;
    vars: ActionVars;
    owner: string;
    purpose: ActionRun["purpose"];
    sessionId?: string;
  },
  deps: Partial<ActionDeps> = {},
): Promise<ActionRun> {
  const exec = deps.exec ?? execOnIncidentRunner;
  const now = deps.now ?? Date.now;
  const { action } = input;
  const ref =
    action.kind === "deploy"
      ? input.vars.ref
      : action.kind === "rollback"
        ? input.vars.previousRef
        : undefined;
  const startedAt = new Date(now()).toISOString();
  let status: ActionRun["status"] = "failed";
  let exitCode: number | undefined;
  let detail: string;
  const rendered = renderActionCommand(action.command, input.vars);
  if (typeof rendered !== "string") {
    detail = rendered.error;
  } else {
    try {
      // As the incident service on a reserved Runner, never as the owner:
      // the owner counts the budget, the Runner trusts only Sessions.
      const result = await exec(action.runner, ACTION_COMMAND, {
        timeoutMs: action.timeoutMs,
        repo: input.project,
        stdin: actionScript(rendered),
        auditCommand: `incident action ${action.id}`,
        sessionId: input.sessionId,
        cwd: action.cwd,
      });
      if (result.timedOut) {
        detail = `Timed out after ${Math.max(1, Math.round(action.timeoutMs / 60_000))} min`;
      } else if (result.code === -1) {
        // The channel dropped: the script may have run, in part or whole.
        status = "unknown";
        detail = `The Runner disconnected while the action ran. ${CHECK_PRODUCTION}`;
      } else {
        exitCode = result.code;
        if (result.code === 0) {
          status = "ok";
          detail = "Exit 0";
        } else {
          const line = lastStderrLine(result.stderr ?? "");
          detail = line
            ? `Exit ${result.code}: ${line}`
            : `Exit ${result.code}`;
        }
      }
    } catch (error) {
      status = "unknown";
      detail = runnerProblemDetail(error);
    }
  }
  incidentAudit({
    kind: "incident_action",
    incidentId: input.incidentId,
    actionId: action.id,
    actionKind: action.kind,
    runner: action.runner,
    status,
    exitCode,
    purpose: input.purpose,
    secretTouched: action.needsSecret,
  });
  return {
    id: input.runId,
    round: input.round,
    actionId: action.id,
    kind: action.kind,
    label: action.label,
    runner: action.runner,
    status,
    purpose: input.purpose,
    startedAt,
    endedAt: new Date(now()).toISOString(),
    ...(exitCode !== undefined ? { exitCode } : {}),
    detail,
    ...(ref !== undefined ? { ref } : {}),
    secretTouched: action.needsSecret,
  };
}

/** The release before the newest one: what a rollback goes back to. */
export function previousReleaseRef(
  settings: IncidentProjectSettings,
): string | undefined {
  return settings.releases[1]?.ref;
}

// ---------------------------------------------------------------------------
// Release hook: `POST /incident-releases/<project>/<secret>`, body empty or
// `{ ref?, note? }`. The secret in the path is the only auth, so every wrong
// door gets the same 404.

export const RELEASE_BODY_CAP = 10_000;
const RELEASE_PATH = /^\/incident-releases\/([^/]+)\/([^/]+)$/;
export const RELEASE_HOOK_LIMIT = 30;
const RELEASE_HOOK_WINDOW_MS = 60_000;
/** Accepted calls per project in the last minute; held in memory only. */
const releaseCalls = new Map<string, number[]>();

/** Whether `project` may take one more release now (and counts it). */
function releaseAllowed(project: string, now: number): boolean {
  const recent = (releaseCalls.get(project) ?? []).filter(
    (at) => now - at < RELEASE_HOOK_WINDOW_MS,
  );
  if (recent.length >= RELEASE_HOOK_LIMIT) {
    releaseCalls.set(project, recent);
    return false;
  }
  recent.push(now);
  releaseCalls.set(project, recent);
  return true;
}

export function __resetReleaseHookLimitForTest(): void {
  releaseCalls.clear();
}
const PROJECT_ID = VALUE_RULES.project;
const NOTE_MAX = 200;

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
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

function parseReleaseBody(
  text: string,
): { ref?: string; note?: string } | { error: string } {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "Body must be JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { error: "Body must be a JSON object" };
  const { ref, note } = value as Record<string, unknown>;
  if (ref !== undefined && (typeof ref !== "string" || !SHA.test(ref)))
    return { error: "Invalid ref" };
  if (note !== undefined && typeof note !== "string")
    return { error: "Invalid note" };
  const trimmed = note?.trim().slice(0, NOTE_MAX);
  return {
    ...(ref !== undefined ? { ref } : {}),
    ...(trimmed ? { note: trimmed } : {}),
  };
}

const releaseHook: PublicWebhookHandler = async (req, url) => {
  if (isShuttingDown()) return restarting();
  const match = RELEASE_PATH.exec(url.pathname);
  if (!match) return badRequest("Bad path");
  const [, project, secret] = match as unknown as [string, string, string];
  // Unknown names never reach the settings store (or its cache).
  if (!PROJECT_ID.test(project) || !incidentProjectExists(project))
    return notFound();
  const settings = await getProjectSettings(project);
  if (!secretMatches(settings.releaseHookSecret, secret)) return notFound();
  if (!releaseAllowed(project, Date.now()))
    return Response.json({ error: "Too many releases" }, { status: 429 });
  let text: string;
  try {
    text = await readRequestTextWithinLimit(req, RELEASE_BODY_CAP);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return webhookBodyTooLargeResponse(RELEASE_BODY_CAP);
    throw error;
  }
  const body = parseReleaseBody(text);
  if ("error" in body) return badRequest(body.error);
  if (isShuttingDown()) return restarting();
  const refused = await recordRelease(project, {
    at: new Date().toISOString(),
    source: "hook",
    ...body,
  });
  if (refused) return badRequest(refused.error);
  return Response.json({ ok: true });
};

export function incidentReleaseHookRoutes(): Map<string, PublicWebhookHandler> {
  return new Map([["POST /incident-releases/*", releaseHook]]);
}
