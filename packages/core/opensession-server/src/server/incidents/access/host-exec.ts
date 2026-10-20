// Read-only commands on an incident agent's granted hosts, through the Runner
// command channel. The command is an argv from the read-only table, quoted
// word by word (and once more for an SSH hop) into one string that the
// Runner's POSIX shell (`bash -lc`) runs, so shell metacharacters are data.
// Only Linux and macOS Runners qualify (fields.ts runsPosixShell). It runs with no user, no repo and never the Runner's AWS role; the
// output is capped and scrubbed of the agent's own granted credentials.
import type { ResolvedHost } from "../../../shared/incident-access";
import { scrubCredentialSecrets } from "../../keychain";
import { execOnRunner, isRunnerConnected } from "../../runner-ws";
import { shellQuote } from "../../sandbox/adapters/bootstrap";
import { checkReadOnlyCommand } from "./read-only-commands";
import { type IncidentToolContext, toolAudit } from "./tool-context";

export const HOST_OUTPUT_CAP_BYTES = 65_536;
export const HOST_DEFAULT_TIMEOUT_MS = 60_000;
export const HOST_MAX_TIMEOUT_MS = 300_000;
const HOST_MIN_TIMEOUT_MS = 1_000;
const AUDIT_ARGS_CHARS = 500;
// The same alias rule the settings validator applies; checked again here so
// a value that reached the access some other way cannot become an ssh flag.
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface HostCommandInput {
  runner: string;
  ssh?: string;
  program: string;
  args?: string[];
  timeoutSeconds?: number;
}

export type HostCommandResult =
  | {
      ok: true;
      exitCode: number;
      timedOut: boolean;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }
  | { ok: false; error: string };

export interface HostExecDeps {
  exec?: typeof execOnRunner;
  connected?: (runnerId: string) => boolean;
  scrub?: (text: string, credentialIds: string[]) => string;
}

function capBytes(text: string, cap: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= cap) return { text, cut: false };
  // A character split at the cut is dropped, never half-decoded.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, cap))
    .replace(/\uFFFD+$/, "");
  return { text: head, cut: true };
}

function clampTimeout(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds))
    return HOST_DEFAULT_TIMEOUT_MS;
  return Math.min(
    HOST_MAX_TIMEOUT_MS,
    Math.max(HOST_MIN_TIMEOUT_MS, Math.round(seconds * 1000)),
  );
}

function findHost(
  hosts: ResolvedHost[],
  input: HostCommandInput,
): ResolvedHost | null {
  return (
    hosts.find(
      (h) =>
        (h.runner === input.runner || h.runnerName === input.runner) &&
        (h.ssh ?? undefined) === (input.ssh || undefined),
    ) ?? null
  );
}

export async function runHostCommand(
  ctx: IncidentToolContext,
  input: HostCommandInput,
  deps: HostExecDeps = {},
): Promise<HostCommandResult> {
  const exec = deps.exec ?? execOnRunner;
  const connected = deps.connected ?? isRunnerConnected;
  const scrub = deps.scrub ?? scrubCredentialSecrets;
  const args = input.args ?? [];
  const label = input.ssh ? `${input.ssh} via ${input.runner}` : input.runner;
  const host = findHost(ctx.access.hosts, input);
  if (!host || (host.ssh !== undefined && !SSH_ALIAS.test(host.ssh))) {
    const error = `${label} is not one of this agent's hosts`;
    toolAudit(ctx, "incident_host_denied", {
      runner_id: input.runner,
      ...(input.ssh ? { ssh: input.ssh } : {}),
      program: input.program,
      reason: error,
    });
    return { ok: false, error };
  }
  const where = {
    runner_id: host.runner,
    ...(host.ssh ? { ssh: host.ssh } : {}),
  };
  const check = checkReadOnlyCommand(input.program, args);
  if (!check.ok) {
    toolAudit(ctx, "incident_host_denied", {
      ...where,
      program: input.program,
      reason: check.reason,
    });
    return { ok: false, error: check.reason };
  }
  if (!connected(host.runner))
    return { ok: false, error: `${host.runnerName} is offline` };

  const inner = shellQuote(check.argv);
  const command = host.ssh
    ? shellQuote([
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        host.ssh,
        inner,
      ])
    : inner;
  const timeoutMs = clampTimeout(input.timeoutSeconds);
  const started = Date.now();
  let result: Awaited<ReturnType<typeof execOnRunner>>;
  try {
    result = await exec(host.runner, command, {
      timeoutMs,
      sessionId: ctx.sessionId,
      aws: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toolAudit(ctx, "incident_host_command", {
      ...where,
      program: input.program,
      args: args.join(" ").slice(0, AUDIT_ARGS_CHARS),
      error: message.slice(0, 300),
      duration_ms: Date.now() - started,
    });
    return {
      ok: false,
      error: `Could not run on ${host.runnerName}: ${message}`,
    };
  }
  const ids = ctx.access.credentials.map((c) => c.credential);
  // Scrub before the cut, so a secret split by the cut is still caught.
  const stdout = capBytes(
    scrub(result.stdout ?? "", ids),
    HOST_OUTPUT_CAP_BYTES,
  );
  const stderr = capBytes(
    scrub(result.stderr ?? "", ids),
    HOST_OUTPUT_CAP_BYTES,
  );
  const timedOut = result.timedOut === true;
  toolAudit(ctx, "incident_host_command", {
    ...where,
    program: input.program,
    args: args.join(" ").slice(0, AUDIT_ARGS_CHARS),
    exit_code: result.code,
    timed_out: timedOut,
    duration_ms: Date.now() - started,
  });
  return {
    ok: true,
    exitCode: result.code,
    timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.cut || stderr.cut,
  };
}
