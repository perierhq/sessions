/**
 * podman-cli — the only module that spawns `podman` for the "This machine
 * (container)" Sandbox provider (docs/self-hosting-sandboxes.md).
 *
 * Everything here is an argv array: nothing is ever handed to a shell. The
 * builders are pure and pin the isolation flags the provider depends on (one
 * pasta network namespace per pod with no host mappings, a workload with no
 * capabilities, a read-only rootfs and one volume). `runPodman` spawns with a
 * minimal environment: the gateway's own env (model keys, OPENSESSION_*)
 * never reaches podman, conmon or a container. Secrets for one exec travel
 * as `--env NAME` in argv and `NAME=value` in the spawned podman's env, so a
 * value never appears in `/proc/<pid>/cmdline`.
 *
 * Every other podman module takes a `PodmanRunner` so tests inject a fake.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { ExecResult } from "../provider";

export interface PodmanRunOpts {
  /** Written to the child's stdin, then closed. */
  stdin?: string;
  /** Kill the child after this long (default 120 s); the result is exit 124. */
  timeoutMs?: number;
  /** Extra variables for the child (e.g. the values behind `--env NAME`). */
  env?: Record<string, string>;
}

/** Runs `podman <argv>`. Never throws: a non-zero exit, a timeout (124) and a
 *  missing binary (127) are all results. */
export type PodmanRunner = (
  argv: string[],
  opts?: PodmanRunOpts,
) => Promise<ExecResult>;

export const PODMAN_DEFAULT_TIMEOUT_MS = 120_000;
/** Image builds and first pulls. */
export const PODMAN_LONG_TIMEOUT_MS = 600_000;

/** Prefix of every resource this provider creates. Cleanup only ever touches
 *  names with this prefix AND the sandbox label. */
export const PODMAN_NAME_PREFIX = "opensession-sbx-";
export const PODMAN_SANDBOX_LABEL = "opensession.sandbox=1";
export const PODMAN_SESSION_LABEL_KEY = "opensession.session";
/** The workload's uid:gid (the image's `ubuntu` user). Container root maps to
 *  the gateway's own host user, so nothing ever runs as it. */
export const PODMAN_WORKLOAD_USER = "1000:1000";
export const PODMAN_WORKLOAD_HOME = "/home/ubuntu";

/**
 * The pod's network: a private pasta namespace with
 *  - `--no-map-gw`: the default gateway is not an alias for the host;
 *  - `-T/-U none`: no namespace-to-host loopback port forwards;
 *  - `-t/-u none`: nothing published inbound;
 *  - `-4`: no IPv6 in the namespace;
 *  - `--map-guest-addr none`: podman otherwise maps 169.254.1.2 to the host.
 * pasta's DNS forwarder (169.254.1.1) cannot be disabled; the egress ruleset
 * blocks it (podman-egress.ts).
 */
export const PODMAN_PASTA_NETWORK =
  "pasta:--no-map-gw,-T,none,-U,none,-t,none,-u,none,-4,--map-guest-addr,none";

const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Set by podmanEnv itself; an extra may not replace them. */
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
]);
/** A spawned podman's complete environment. */
export type PodmanEnv = Record<string, string>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY = 48;

function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name))
    throw new Error(`invalid environment variable name: ${name}`);
  if (RESERVED_ENV.has(name))
    throw new Error(`${name} is set by the podman runner and cannot be passed`);
}

/**
 * The whole environment of a spawned podman: a fixed system PATH, the
 * gateway user's HOME, and the user session's runtime dir and D-Bus socket
 * (without them podman falls back to cgroupfs and its containers land in
 * the gateway service's cgroup, so a service restart would kill them).
 */
export function podmanEnv(uid: number, extra: PodmanEnv = {}): PodmanEnv {
  if (!Number.isInteger(uid) || uid < 0) throw new Error(`invalid uid ${uid}`);
  for (const name of Object.keys(extra)) assertEnvName(name);
  return {
    PATH: SYSTEM_PATH,
    HOME: homedir(),
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
    ...extra,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A runner for `binary` (tests point it at a stand-in). */
export function createPodmanRunner(
  o: { binary?: string; uid?: number } = {},
): PodmanRunner {
  const binary = o.binary ?? "podman";
  return async (argv, opts = {}) => {
    const uid = o.uid ?? process.getuid?.();
    if (uid === undefined)
      return { exitCode: 1, stdout: "", stderr: "podman needs a POSIX host" };
    let env: PodmanEnv;
    try {
      env = podmanEnv(uid, opts.env);
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: errorText(err) };
    }
    let proc: Bun.Subprocess<Buffer | "ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([binary, ...argv], {
        env,
        stdin:
          opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: `${binary}: ${errorText(err)}`,
      };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? PODMAN_DEFAULT_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut)
        return {
          exitCode: 124,
          stdout,
          stderr: `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}podman ${argv[0] ?? ""} timed out`,
        };
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `podman` with the gateway user's session env. */
export const runPodman: PodmanRunner = createPodmanRunner();

// ── Names ────────────────────────────────────────────────────────────────────

export interface PodmanNames {
  /** Session id folded to `[a-z0-9_.-]`, at most 48 chars, no `..`. */
  key: string;
  pod: string;
  /** The pod's infra container, which owns the network namespace. */
  infra: string;
  volume: string;
  workload: string;
}

/**
 * Resource names for a session. An id that had to be changed to fit (case,
 * other characters, length) gets a hash of the original appended, so two
 * sessions can never share a pod.
 */
export function podmanNames(sessionId: string): PodmanNames {
  if (!sessionId) throw new Error("podman sandbox needs a session id");
  const folded = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/\.{2,}/g, "-");
  let key = folded;
  if (folded !== sessionId || folded.length > MAX_KEY) {
    const hash = createHash("sha256").update(sessionId).digest("hex");
    key = `${folded.slice(0, MAX_KEY - 9)}-${hash.slice(0, 8)}`;
  }
  const pod = `${PODMAN_NAME_PREFIX}${key}`;
  return {
    key,
    pod,
    infra: `${pod}-infra`,
    volume: `${pod}-home`,
    workload: `${pod}-ws`,
  };
}

function assertOwnName(name: string): void {
  if (!name.startsWith(PODMAN_NAME_PREFIX) || !/^[a-z0-9_.-]+$/.test(name))
    throw new Error(`not an Open Session podman resource: ${name}`);
}

// ── Builders ─────────────────────────────────────────────────────────────────

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

function sessionLabel(sessionId: string): string {
  if (!sessionId || /[\0\r\n]/.test(sessionId))
    throw new Error("invalid session id for a podman label");
  return `${PODMAN_SESSION_LABEL_KEY}=${sessionId}`;
}

/** `podman pod create`: the network namespace and nothing else shared but
 *  uts and ipc (the pid namespace stays private to each container). */
export function podCreateArgs(o: {
  names: PodmanNames;
  sessionId: string;
  dns: string[];
}): string[] {
  assertOwnName(o.names.pod);
  assertOwnName(o.names.infra);
  if (!o.dns.length) throw new Error("podman sandbox needs a DNS resolver");
  for (const ip of o.dns)
    if (!isIpv4(ip)) throw new Error(`DNS resolver must be IPv4: ${ip}`);
  return [
    "pod",
    "create",
    "--name",
    o.names.pod,
    "--infra-name",
    o.names.infra,
    "--network",
    PODMAN_PASTA_NETWORK,
    ...o.dns.flatMap((ip) => ["--dns", ip]),
    "--dns-search",
    ".",
    "--no-hosts",
    "--hostname",
    "sandbox",
    "--share",
    "net,uts,ipc",
    "--label",
    PODMAN_SANDBOX_LABEL,
    "--label",
    sessionLabel(o.sessionId),
  ];
}

/** `podman volume create` for the session's `/home/ubuntu`. */
export function volumeCreateArgs(o: {
  names: PodmanNames;
  sessionId: string;
}): string[] {
  assertOwnName(o.names.volume);
  return [
    "volume",
    "create",
    "--label",
    PODMAN_SANDBOX_LABEL,
    "--label",
    sessionLabel(o.sessionId),
    o.names.volume,
  ];
}

function positiveInt(value: number, what: string): string {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${what} must be a positive integer`);
  return String(value);
}

/**
 * `podman create` for the workload (never `run`: the firewall goes in before
 * it starts). No host mounts, no capabilities, no new privileges, the
 * default seccomp profile and SELinux type, a read-only rootfs and the
 * session volume as the only writable disk. No restart policy: a restart
 * outside the firewall sequence would start it unfiltered.
 */
export function workloadCreateArgs(o: {
  names: PodmanNames;
  image: string;
  memoryMb: number;
  pidsLimit: number;
  cpu?: number;
}): string[] {
  assertOwnName(o.names.pod);
  assertOwnName(o.names.workload);
  assertOwnName(o.names.volume);
  if (!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(o.image))
    throw new Error(`invalid image reference: ${o.image}`);
  const memory = `${positiveInt(o.memoryMb, "memoryMb")}m`;
  const cpu: string[] = [];
  if (o.cpu !== undefined) {
    if (!Number.isFinite(o.cpu) || o.cpu <= 0)
      throw new Error("cpu must be a positive number");
    cpu.push("--cpus", String(o.cpu));
  }
  return [
    "create",
    "--pod",
    o.names.pod,
    "--name",
    o.names.workload,
    "--label",
    PODMAN_SANDBOX_LABEL,
    "--user",
    PODMAN_WORKLOAD_USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--security-opt",
    "label=type:container_t",
    "--read-only",
    "--read-only-tmpfs=true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
    "--init",
    "--pids-limit",
    positiveInt(o.pidsLimit, "pidsLimit"),
    "--memory",
    memory,
    "--memory-swap",
    memory,
    ...cpu,
    "--ulimit",
    "nofile=65536:65536",
    "-v",
    `${o.names.volume}:${PODMAN_WORKLOAD_HOME}:Z`,
    o.image,
    "sleep",
    "infinity",
  ];
}

/**
 * `podman exec` into the workload as uid 1000, running `cmd` with bash under
 * `timeout` (`timeoutSec: 0` only for detached commands, which are meant to
 * outlive the call). `envNames` become `--env NAME`: the values must be in
 * the runner's `env`, never in argv.
 */
export function execArgs(o: {
  workload: string;
  cwd?: string;
  envNames: string[];
  timeoutSec: number;
  detached?: boolean;
  stdin?: boolean;
  cmd: string;
}): string[] {
  assertOwnName(o.workload);
  for (const name of o.envNames) assertEnvName(name);
  if (o.cwd !== undefined && (!o.cwd.startsWith("/") || o.cwd.includes("\0")))
    throw new Error(`exec cwd must be an absolute path: ${o.cwd}`);
  const timeout: string[] = [];
  if (o.timeoutSec !== 0 || !o.detached)
    timeout.push(
      "/usr/bin/timeout",
      "-k",
      "5",
      positiveInt(o.timeoutSec, "timeoutSec"),
    );
  return [
    "exec",
    ...(o.stdin ? ["-i"] : []),
    ...(o.detached ? ["-d"] : []),
    "--user",
    PODMAN_WORKLOAD_USER,
    ...(o.cwd ? ["--workdir", o.cwd] : []),
    ...o.envNames.flatMap((name) => ["--env", name]),
    o.workload,
    ...timeout,
    "/bin/bash",
    "-c",
    o.cmd,
  ];
}
