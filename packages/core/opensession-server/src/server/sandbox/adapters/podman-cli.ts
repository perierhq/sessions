/**
 * podman-cli — the only module that spawns `podman` for the "This machine
 * (container)" Sandbox provider (docs/self-hosting-sandboxes.md).
 *
 * Everything here is an argv array: nothing is ever handed to a shell. The
 * builders are pure and pin the isolation flags the provider depends on (one
 * pasta network namespace per pod with no host mappings, a workload with no
 * capabilities, a read-only rootfs and one volume). `runPodman` spawns with a
 * minimal environment: the gateway's own env (model keys, OPENSESSION_*)
 * never reaches podman, conmon or a container, and neither does any name a
 * caller chose. The host podman process env is always exactly PATH, HOME,
 * XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS: podman hands its env to
 * conmon, crun and pasta, so a caller's LD_PRELOAD or CONTAINERS_CONF there
 * would run as the gateway user. An exec's variables (secrets, and the
 * caller's in-container PATH/HOME) go through `--env-file`, a 0600 file under
 * `$XDG_RUNTIME_DIR/opensession/` that is deleted when the exec returns, so a
 * value never appears in `/proc/<pid>/cmdline` or `/proc/<pid>/environ`.
 *
 * Every other podman module takes a `PodmanRunner` so tests inject a fake.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../provider";

export interface PodmanRunOpts {
  /** Written to the child's stdin, then closed. */
  stdin?: string;
  /** Kill the child after this long (default 120 s); the result is exit 124. */
  timeoutMs?: number;
}

export interface PodmanResult extends ExecResult {
  /** Set when stdout or stderr went over PODMAN_MAX_OUTPUT_BYTES and was cut. */
  truncated?: boolean;
}

/** Runs `podman <argv>`. Never throws: a non-zero exit, a timeout (124) and a
 *  missing binary (127) are all results. */
export type PodmanRunner = (
  argv: string[],
  opts?: PodmanRunOpts,
) => Promise<PodmanResult>;

export const PODMAN_DEFAULT_TIMEOUT_MS = 120_000;
/** Each of stdout and stderr keeps at most this much; the rest is drained
 *  and dropped so the child never blocks on a full pipe. */
export const PODMAN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** After a timeout kill, how long to wait for the pipes to close. */
const KILL_GRACE_MS = 1_000;
/** Image builds and first pulls. */
export const PODMAN_LONG_TIMEOUT_MS = 600_000;

/** Prefix of every resource this provider creates. Cleanup only ever touches
 *  names with this prefix AND the sandbox label. */
export const PODMAN_NAME_PREFIX = "opensession-sbx-";
export const PODMAN_SANDBOX_LABEL = "opensession.sandbox=1";
export const PODMAN_SESSION_LABEL_KEY = "opensession.sandbox.session";
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
/** A spawned podman's complete environment. */
export type PodmanEnv = Record<string, string>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** podman reads `--env-file` with a bufio.Scanner: one line per variable,
 *  at most 64 KiB, a trailing `\r` silently dropped. */
const MAX_ENV_LINE = 60_000;
const MAX_KEY = 48;

/**
 * The whole environment of a spawned podman: a fixed system PATH, the
 * gateway user's HOME, and the user session's runtime dir and D-Bus socket
 * (without them podman falls back to cgroupfs and its containers land in
 * the gateway service's cgroup, so a service restart would kill them).
 */
export function podmanEnv(uid: number): PodmanEnv {
  if (!Number.isInteger(uid) || uid < 0) throw new Error(`invalid uid ${uid}`);
  return {
    PATH: SYSTEM_PATH,
    HOME: homedir(),
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

/**
 * The text of an exec's `--env-file`: one literal `NAME=value` line per
 * variable (podman does no quoting or expansion). Throws on a name outside
 * `[A-Za-z_][A-Za-z0-9_]*`, and on a value with a line break or NUL, or too
 * long for podman's line reader, rather than letting it be cut or split.
 */
export function execEnvFileText(env: Record<string, string>): string {
  let text = "";
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name))
      throw new Error(
        `invalid environment variable name: ${JSON.stringify(name)}`,
      );
    if (/[\r\n]/.test(value))
      throw new Error(
        `environment variable ${name} contains a line break, which the podman sandbox cannot pass`,
      );
    if (value.includes("\0"))
      throw new Error(`environment variable ${name} contains a NUL byte`);
    const line = `${name}=${value}`;
    if (Buffer.byteLength(line, "utf8") > MAX_ENV_LINE)
      throw new Error(`environment variable ${name} is too long`);
    text += `${line}\n`;
  }
  return text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Capture {
  /** Settles when the stream ends or errors. */
  done: Promise<void>;
  text(): string;
  truncated(): boolean;
  cancel(): void;
}

/** Reads a child's pipe to the end, keeping the first `cap` bytes. */
function capture(stream: ReadableStream<Uint8Array>, cap: number): Capture {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let cut = false;
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        const room = cap - bytes;
        if (value.byteLength <= room) {
          chunks.push(value);
          bytes += value.byteLength;
        } else {
          if (room > 0) chunks.push(value.subarray(0, room));
          bytes = cap;
          cut = true;
        }
      }
    } catch {
      // Cancelled or broken pipe: keep what was read.
    }
  })();
  return {
    done,
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => cut,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
  };
}

function sleep(ms: number): { promise: Promise<"timeout">; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

/** SIGKILL the child's whole process group (it leads one: `detached`). */
function killGroup(proc: {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Already gone.
  }
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
      env = podmanEnv(uid);
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: errorText(err) };
    }
    let proc: Bun.Subprocess<Buffer | "ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([binary, ...argv], {
        env,
        // Its own process group, so a timeout kills conmon helpers and any
        // other descendants along with podman.
        detached: true,
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
    const out = capture(proc.stdout, PODMAN_MAX_OUTPUT_BYTES);
    const err = capture(proc.stderr, PODMAN_MAX_OUTPUT_BYTES);
    const finished = Promise.all([out.done, err.done, proc.exited]).then(
      () => "done" as const,
    );
    const deadline = sleep(opts.timeoutMs ?? PODMAN_DEFAULT_TIMEOUT_MS);
    const first = await Promise.race([finished, deadline.promise]);
    deadline.clear();
    let exitCode: number;
    if (first === "timeout") {
      killGroup(proc);
      // Keep what the group wrote before it died, but do not wait on a
      // descendant that left the group and still holds a pipe.
      const grace = sleep(KILL_GRACE_MS);
      await Promise.race([finished, grace.promise]);
      grace.clear();
      out.cancel();
      err.cancel();
      exitCode = 124;
    } else {
      exitCode = await proc.exited;
    }
    let stderr = err.text();
    if (first === "timeout")
      stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}podman ${argv[0] ?? ""} timed out`;
    const result: PodmanResult = { exitCode, stdout: out.text(), stderr };
    if (out.truncated() || err.truncated()) result.truncated = true;
    return result;
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
 * session volume (nosuid, nodev) as the only writable disk. No restart policy: a restart
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
    `${o.names.volume}:${PODMAN_WORKLOAD_HOME}:Z,nosuid,nodev`,
    o.image,
    "sleep",
    "infinity",
  ];
}

/**
 * `podman exec` into the workload as uid 1000, running `cmd` with bash under
 * `timeout` (`timeoutSec: 0` only for detached commands, which are meant to
 * outlive the call). `envFile` is an absolute `--env-file` path; values never
 * go in argv. Use `podmanExec`, which writes and removes that file.
 */
export function execArgs(o: {
  workload: string;
  cwd?: string;
  envFile?: string;
  timeoutSec: number;
  detached?: boolean;
  stdin?: boolean;
  cmd: string;
}): string[] {
  assertOwnName(o.workload);
  if (
    o.envFile !== undefined &&
    (!o.envFile.startsWith("/") || /[\0\r\n]/.test(o.envFile))
  )
    throw new Error(`exec env file must be an absolute path: ${o.envFile}`);
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
    ...(o.envFile ? ["--env-file", o.envFile] : []),
    o.workload,
    ...timeout,
    "/bin/bash",
    "-c",
    o.cmd,
  ];
}

/** `$XDG_RUNTIME_DIR/opensession`, created 0700 and owned by us (a symlink
 *  or someone else's dir is refused). */
async function privateRuntimeDir(runtimeDir: string): Promise<string> {
  if (!runtimeDir.startsWith("/"))
    throw new Error(`runtime dir must be absolute: ${runtimeDir}`);
  const dir = join(runtimeDir, "opensession");
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new Error(`${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid)
    throw new Error(`${dir} is not owned by uid ${uid}`);
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
  return dir;
}

function defaultRuntimeDir(): string {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv?.startsWith("/")) return fromEnv;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("podman needs a POSIX host");
  return `/run/user/${uid}`;
}

/**
 * Runs `podman exec` (see `execArgs`) with `env` delivered in-container via a
 * 0600 `--env-file` under `$XDG_RUNTIME_DIR/opensession/` (0700). The file is
 * removed when the exec returns or throws. Throws before spawning on an env
 * the file cannot carry.
 */
export async function podmanExec(
  run: PodmanRunner,
  o: {
    workload: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutSec: number;
    detached?: boolean;
    /** Written to the exec's stdin (adds `-i`). */
    stdin?: string;
    cmd: string;
    timeoutMs?: number;
    /** Defaults to `$XDG_RUNTIME_DIR` (or `/run/user/<uid>`). */
    runtimeDir?: string;
  },
): Promise<ExecResult> {
  const base = {
    workload: o.workload,
    cwd: o.cwd,
    timeoutSec: o.timeoutSec,
    detached: o.detached,
    stdin: o.stdin !== undefined,
    cmd: o.cmd,
  };
  const runOpts: PodmanRunOpts = { stdin: o.stdin, timeoutMs: o.timeoutMs };
  const env = o.env ?? {};
  if (Object.keys(env).length === 0) return run(execArgs(base), runOpts);
  const text = execEnvFileText(env);
  const dir = await privateRuntimeDir(o.runtimeDir ?? defaultRuntimeDir());
  const file = join(dir, `exec-env-${randomBytes(12).toString("hex")}`);
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    return await run(execArgs({ ...base, envFile: file }), runOpts);
  } finally {
    await rm(file, { force: true });
  }
}
