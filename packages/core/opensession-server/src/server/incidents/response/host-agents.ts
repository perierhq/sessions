// Where an incident agent works: the project's sandbox, else This machine
// (container) when it is Ready. The host path is experimental and off by
// default: only with OPENSESSION_INCIDENT_HOST_AGENTS=1, and only when the
// container sandbox is not Ready, may an agent work in an ordinary worktree
// on this server, its shell commands run as a separate low-privilege system
// user (the incident agent user) that can write the worktrees but cannot
// read the Sessions state directory, and only when that user is set up
// (docs/incident-host-agents.md). Otherwise the agent does not start.
//
// The readiness probe runs only when called, never at import, and every
// command it runs is awaited (no synchronous subprocess on the gateway).
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentWorkspace } from "../../../shared/incident-response";
import { legacyCatalogDirectory } from "../../catalog-documents";
import { configuredPaths } from "../../config";
import { resolveRequestedSandbox } from "../../sandbox/config";
import type { SandboxProviderId } from "../../sandbox/provider";
import { sandboxConnectionReady } from "../../sandbox/connections";
import {
  SYSTEMD_USER_RUNTIME,
  processRunsInControlPlane,
} from "../../systemd-scopes";

export const INCIDENT_AGENT_USER_DEFAULT = "opensession-incident";
export const INCIDENT_HOST_AGENTS_ENV = "OPENSESSION_INCIDENT_HOST_AGENTS";
const NO_SANDBOX = "Agents can't start: this project has no sandbox";

/** Whether the operator turned on the experimental host path
 *  (`OPENSESSION_INCIDENT_HOST_AGENTS=1`). Off by default. */
export function incidentHostAgentsEnabled(): boolean {
  return process.env[INCIDENT_HOST_AGENTS_ENV]?.trim() === "1";
}
const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const CACHE_MS = 60_000;

/** The incident agent user: `OPENSESSION_INCIDENT_AGENT_USER` when it is a
 *  plain system user name, else the default. */
export function incidentAgentUser(): string {
  const configured = process.env.OPENSESSION_INCIDENT_AGENT_USER?.trim();
  return configured && USER_NAME.test(configured)
    ? configured
    : INCIDENT_AGENT_USER_DEFAULT;
}

/** The argv that runs one shell command as `user`. The command stays one
 *  argument; `-E` keeps the minimal environment the caller built. */
export function hostBashArgv(user: string, command: string): string[] {
  return ["sudo", "-n", "-E", "-u", user, "--", "/bin/bash", "-c", command];
}

export interface HostAgentProbe {
  platform: NodeJS.Platform;
  run: (
    argv: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** The gateway's own uid: the agent user must be someone else. */
  uid: number;
  /** The Sessions state directory the user must not read. */
  stateDir: () => Promise<string>;
  /** Where session worktrees live; the user must write here. */
  worktreesDir: () => string;
  /** This process's `/proc/self/cgroup`, "" when unreadable. */
  cgroup: () => Promise<string>;
  /** Each agent command can run in its own systemd user scope that Sessions
   *  can kill whole (`cgroup.kill`), whoever owns its processes. */
  scopes: () => Promise<boolean>;
}

async function run(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ownCgroup(): Promise<string> {
  try {
    return await readFile("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

/** The cgroup v2 path of this process, from `/proc/self/cgroup`. */
export function cgroupPath(cgroup: string): string | null {
  const line = cgroup
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("0::"));
  return line ? line.slice(3) || null : null;
}

async function scopesAvailable(): Promise<boolean> {
  const cgroup = await ownCgroup();
  const path = cgroupPath(cgroup);
  return (
    !!path &&
    processRunsInControlPlane(cgroup) &&
    !!Bun.which("systemd-run") &&
    (await exists(`${SYSTEMD_USER_RUNTIME}/systemd/private`)) &&
    (await exists(`/sys/fs/cgroup${path}/cgroup.kill`))
  );
}

function defaultProbe(): HostAgentProbe {
  return {
    platform: process.platform,
    run,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    stateDir: async () => dirname(await legacyCatalogDirectory("incidents")),
    worktreesDir: () => configuredPaths().worktreesDir,
    cgroup: ownCgroup,
    scopes: scopesAvailable,
  };
}

let probeOverride: Partial<HostAgentProbe> | undefined;
let cached: { at: number; user: string; problem: string | null } | null = null;

export function __resetHostAgentCacheForTest(): void {
  cached = null;
}

/** Replace the default probe (undefined restores it). */
export function __setHostAgentProbeForTest(
  probe: Partial<HostAgentProbe> | undefined,
): void {
  probeOverride = probe;
  cached = null;
}

async function probeUser(
  p: HostAgentProbe,
  user: string,
): Promise<string | null> {
  if (p.platform !== "linux")
    return "run Sessions on Linux to use the incident agent user";
  const id = await p.run(["id", "-u", user]);
  const uid = Number(id.stdout.trim());
  if (
    id.code !== 0 ||
    !/^\d+$/.test(id.stdout.trim()) ||
    uid === 0 ||
    uid === p.uid
  )
    return `create the system user ${user}`;
  const as = (script: string, ...args: string[]) =>
    p.run([...hostBashArgv(user, script), ...args]);
  if ((await as("true")).code !== 0)
    return `allow this server to run commands as ${user} without a password`;
  // Neither list nor enter: a directory the user can traverse leaks every
  // file whose name it can guess.
  if (
    (await as('test ! -r "$0" && test ! -x "$0"', await p.stateDir())).code !==
    0
  )
    return `make the Sessions state directory unreadable to ${user}`;
  if ((await as('test -w "$0" && test -x "$0"', p.worktreesDir())).code !== 0)
    return `let ${user} write the worktrees directory`;
  // Processes the user starts cannot be signalled by this service's user, so
  // teardown kills the command's whole scope through cgroup.kill instead.
  if (!(await p.scopes()))
    return "run Sessions as its systemd service on Linux 5.14 or newer, so each agent command runs in a scope Sessions can stop";
  // sudo with a PAM login session (pam_systemd) moves the command into a
  // session scope of its own, out of reach of that teardown.
  const there = await as("cat /proc/self/cgroup");
  if (
    there.code !== 0 ||
    there.stdout.trim() !== (await p.cgroup()).trim() ||
    !there.stdout.trim()
  )
    return `stop sudo from opening a login session for ${user} (Defaults>${user} !pam_session)`;
  return null;
}

/**
 * Why incident agents cannot work on this server as the incident agent
 * user, as an instruction for the operator, or null when they can. The
 * default probe's answer, a failure included, is cached for a minute, so a
 * broken host is not probed on every coordinator tick.
 */
export async function hostAgentUserProblem(
  probe?: Partial<HostAgentProbe>,
): Promise<string | null> {
  const user = incidentAgentUser();
  if (probe) return probeUser({ ...defaultProbe(), ...probe }, user);
  const now = Date.now();
  if (cached && cached.user === user && now - cached.at < CACHE_MS)
    return cached.problem;
  const problem = await probeUser(
    { ...defaultProbe(), ...probeOverride },
    user,
  );
  cached = { at: Date.now(), user, problem };
  return problem;
}

/** Whether This machine (container) is qualified and Ready, and a session
 *  for `project` on `model` could be created in it now. */
export function podmanReadyForIncident(
  project: string,
  model: string,
): boolean {
  return (
    sandboxConnectionReady("podman") &&
    resolveRequestedSandbox("podman", project, model).ok
  );
}

type SandboxResolution =
  | { ok: true; provider: SandboxProviderId | null }
  | { ok: false; error: string };
export type IncidentSandboxResolver = (
  project: string,
  model: string,
) => SandboxResolution | Promise<SandboxResolution>;

/** The project's sandbox, else the global default (projects/effective.ts);
 *  This machine (container) is allowed. */
async function incidentSandbox(
  project: string,
  model: string,
): Promise<SandboxResolution> {
  const { resolveSessionSandbox } = await import("../../projects/effective");
  return resolveSessionSandbox(undefined, project, model, "incident");
}

/**
 * The workspace for an incident agent: the project's sandbox when it has
 * one, whatever the host offers; otherwise This machine (container) when it
 * is Ready; otherwise, only with the experimental host path turned on, this
 * server as the incident agent user; otherwise an error the incident shows
 * as a setup problem.
 */
export async function incidentWorkspaceFor(
  project: string,
  model: string,
  deps: {
    sandbox?: IncidentSandboxResolver;
    podmanReady?: (project: string, model: string) => boolean;
    hostProblem?: () => Promise<string | null>;
    hostEnabled?: () => boolean;
  } = {},
): Promise<AgentWorkspace | { error: string }> {
  const sandbox = deps.sandbox ?? incidentSandbox;
  const resolved = await sandbox(project, model);
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.provider)
    return { kind: "sandbox", provider: resolved.provider };
  if ((deps.podmanReady ?? podmanReadyForIncident)(project, model))
    return { kind: "sandbox", provider: "podman" };
  if (!(deps.hostEnabled ?? incidentHostAgentsEnabled)())
    return { error: NO_SANDBOX };
  const problem = await (deps.hostProblem ?? (() => hostAgentUserProblem()))();
  if (problem === null) return { kind: "host", user: incidentAgentUser() };
  return {
    error: `Incident agents need a sandbox or the incident agent user. Set a default sandbox for ${project}, or ${problem} (see docs/incident-host-agents.md), then retry.`,
  };
}

/**
 * Throws `isolationMessage` unless `user` is the configured incident agent
 * user and the host is ready for it right now: the host path is turned on
 * and the cached probe passes.
 */
export async function assertHostAgentReady(
  user: string,
  isolationMessage: string,
  hostProblem: () => Promise<string | null> = async () =>
    incidentHostAgentsEnabled() ? hostAgentUserProblem() : NO_SANDBOX,
): Promise<void> {
  if (user !== incidentAgentUser() || (await hostProblem()) !== null)
    throw new Error(isolationMessage);
}
