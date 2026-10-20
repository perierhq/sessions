/**
 * Resource-controlled transient scopes used by Open Session on Linux.
 *
 * Limits are deliberately applied at the scope boundary rather than to the
 * model process alone: agent shell commands, MCP proxies, compilers, and dev
 * servers are descendants of the engine and must count against the same
 * budget. The parent opensession.slice supplies the host-wide aggregate fuse;
 * per-scope limits keep one user/server or preview from consuming that fuse.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const UID = typeof process.getuid === "function" ? process.getuid() : 1000;
export const SYSTEMD_USER_RUNTIME = `/run/user/${UID}`;

export const ENGINE_SLICE = "opensession-agents.slice";
export const PREVIEW_SLICE = "opensession-previews.slice";

type LimitEnv = Record<string, string | undefined>;

function value(env: LimitEnv, name: string, fallback: string): string {
  const configured = env[name]?.trim();
  // systemd byte/task/CPU properties accept integers with an optional binary
  // suffix or percentage. Fail closed to the known-good default on typos.
  return configured &&
    /^(?:infinity|\d+(?:\.\d+)?[KMGTPE]?%?)$/i.test(configured)
    ? configured
    : fallback;
}

function property(name: string, configured: string): string {
  return `--property=${name}=${configured}`;
}

export function engineScopeSystemdArgs(env: LimitEnv = process.env): string[] {
  return [
    `--slice=${ENGINE_SLICE}`,
    property("MemoryHigh", value(env, "OPENSESSION_ENGINE_MEMORY_HIGH", "6G")),
    property("MemoryMax", value(env, "OPENSESSION_ENGINE_MEMORY_MAX", "12G")),
    property("MemorySwapMax", value(env, "OPENSESSION_ENGINE_SWAP_MAX", "1G")),
    property("TasksMax", value(env, "OPENSESSION_ENGINE_TASKS_MAX", "1024")),
    property("OOMPolicy", "stop"),
  ];
}

export function previewScopeSystemdArgs(env: LimitEnv = process.env): string[] {
  return [
    `--slice=${PREVIEW_SLICE}`,
    property("MemoryHigh", value(env, "OPENSESSION_PREVIEW_MEMORY_HIGH", "8G")),
    property("MemoryMax", value(env, "OPENSESSION_PREVIEW_MEMORY_MAX", "12G")),
    property("MemorySwapMax", value(env, "OPENSESSION_PREVIEW_SWAP_MAX", "1G")),
    property("TasksMax", value(env, "OPENSESSION_PREVIEW_TASKS_MAX", "768")),
    property("CPUQuota", value(env, "OPENSESSION_PREVIEW_CPU_QUOTA", "600%")),
    property("OOMPolicy", "stop"),
  ];
}

export function systemdUserEnv(
  env: LimitEnv = process.env,
): Record<string, string> {
  return {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || SYSTEMD_USER_RUNTIME,
  };
}

/**
 * Arguments that make `systemd-run --scope` run its command verbatim.
 *
 * systemd-run expands `$VAR`, `${VAR}` and `$$` in the command it starts.
 * Scopes were exempt until systemd 258 turned that expansion on for them too,
 * so on newer hosts a Portal command such as `echo $$` reached its shell as
 * `echo $`, and a `$VAR` meant for that shell was replaced or dropped first.
 * `--expand-environment=no` (systemd 254+) restores the old behaviour; older
 * systemd-run rejects the switch but never expands scope commands anyway.
 */
export function scopeVerbatimArgs(
  version: number | null = systemdRunVersion(),
): string[] {
  return version !== null && version >= 254 ? ["--expand-environment=no"] : [];
}

// systemd-run is not upgraded under a running process; read its version once.
let cachedSystemdRunVersion: number | null | undefined;
function systemdRunVersion(): number | null {
  if (cachedSystemdRunVersion !== undefined) return cachedSystemdRunVersion;
  cachedSystemdRunVersion = null;
  try {
    const result = Bun.spawnSync(["systemd-run", "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const match = /^systemd (\d+)/m.exec(result.stdout.toString());
    if (result.exitCode === 0 && match)
      cachedSystemdRunVersion = Number(match[1]);
  } catch {}
  return cachedSystemdRunVersion;
}

export function systemdUserScopesAvailable(): boolean {
  return (
    existsSync(`${SYSTEMD_USER_RUNTIME}/systemd/private`) &&
    !!Bun.which("systemd-run")
  );
}

// A process never changes cgroup on its own, so read it once.
let ownCgroup: string | undefined;
function selfCgroup(): string {
  if (ownCgroup !== undefined) return ownCgroup;
  try {
    ownCgroup = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    ownCgroup = "";
  }
  return ownCgroup;
}

export function processRunsInControlPlane(cgroup = selfCgroup()): boolean {
  return cgroup.includes("/opensession-control.slice/");
}

/**
 * Move a gateway-owned engine command into the low-priority user workload
 * slice. Detached run hosts already live in opensession-workloads.slice and
 * must stay there so stopping their unit still kills every descendant.
 */
export function controlPlaneWorkloadCommand(
  command: string[],
  unit: string,
  options: {
    env?: LimitEnv;
    cgroup?: string;
    scopesAvailable?: boolean;
    /** Unit Description; session-owned scopes carry their labels here
     * (session-ownership.ts). */
    description?: string;
    /** systemd-run's version; read from the host when omitted. */
    systemdVersion?: number | null;
  } = {},
): { command: string[]; env: Record<string, string>; unit?: string } {
  const env = options.env ?? process.env;
  const shouldScope =
    processRunsInControlPlane(options.cgroup) &&
    (options.scopesAvailable ?? systemdUserScopesAvailable());
  if (!shouldScope) return { command, env: env as Record<string, string> };
  return {
    command: [
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${unit}`,
      ...(options.description ? [`--description=${options.description}`] : []),
      ...engineScopeSystemdArgs(env),
      "--property=TimeoutStopSec=2",
      ...scopeVerbatimArgs(options.systemdVersion),
      "--",
      ...command,
    ],
    env: { ...(env as Record<string, string>), ...systemdUserEnv(env) },
    unit,
  };
}

/** Stable, path-private unit name used to stop a preview after a server restart. */
export function previewScopeUnit(
  worktreeDir: string,
  portalName?: string,
): string {
  const hash = createHash("sha256")
    .update(portalName ? `${worktreeDir}\0${portalName}` : worktreeDir)
    .digest("hex")
    .slice(0, 16);
  return `opensession-preview-${hash}`;
}

/** Put one host Portal in its own bounded, low-priority user scope. */
export function previewScopeCommand(
  command: string[],
  worktreeDir: string,
  portalName: string,
  options: {
    env?: LimitEnv;
    scopesAvailable?: boolean;
    /** systemd-run's version; read from the host when omitted. */
    systemdVersion?: number | null;
  } = {},
): { command: string[]; env: Record<string, string>; unit?: string } {
  const env = options.env ?? process.env;
  if (!(options.scopesAvailable ?? systemdUserScopesAvailable()))
    return { command, env: env as Record<string, string> };
  const unit = previewScopeUnit(worktreeDir, portalName);
  return {
    command: [
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${unit}`,
      ...previewScopeSystemdArgs(env),
      "--property=TimeoutStopSec=5",
      ...scopeVerbatimArgs(options.systemdVersion),
      "--",
      ...command,
    ],
    env: { ...(env as Record<string, string>), ...systemdUserEnv(env) },
    unit,
  };
}

/** Whether a detached user scope still owns a live process tree. */
export async function userScopeActive(unit: string): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["systemctl", "--user", "is-active", "--quiet", `${unit}.scope`],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Stop a detached user scope and wait until systemd has reaped its tree. */
export async function stopUserScopeAndWait(unit: string): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd: ["systemctl", "--user", "stop", `${unit}.scope`],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {}
}

export function stopUserScope(unit: string): void {
  try {
    Bun.spawn({
      cmd: ["systemctl", "--user", "stop", "--no-block", `${unit}.scope`],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {}
}

/**
 * Kill every process in a user scope, whoever owns it, then stop the scope.
 * The user manager cannot signal another user's processes (an incident
 * agent's commands run as the incident agent user), but writing
 * `cgroup.kill` in a cgroup this user owns kills its whole tree. Needs
 * cgroup v2 on Linux 5.14 or newer; never rejects.
 */
export async function killUserScope(unit: string): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd: [
        "systemctl",
        "--user",
        "show",
        "--property=ControlGroup",
        "--value",
        `${unit}.scope`,
      ],
      env: systemdUserEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [path] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const cgroup = path.trim();
    if (cgroup.startsWith("/") && !cgroup.includes(".."))
      await writeFile(`/sys/fs/cgroup${cgroup}/cgroup.kill`, "1").catch(
        () => {},
      );
  } catch {}
  stopUserScope(unit);
}
