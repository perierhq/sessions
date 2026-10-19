/**
 * Ownership labels for what a session starts outside its own process tree:
 * containers and systemd user units. session-resources.ts tears them down
 * with the session; this module names them and finds them again.
 *
 * Nothing here keeps its own record. The label on the container or unit is
 * the durable record, so a gateway restart, a crash or a second gateway
 * process loses nothing, and something without the label is never touched.
 *
 * - Every local run, script, Portal and session-tagged setup gets
 *   `OPENSESSION_SESSION_ID` (sessionOwnershipEnv).
 * - Containers: the same environments put a small `podman`/`docker` shim
 *   first on PATH. On `run`/`create` (also `container run|create`) with
 *   `OPENSESSION_SESSION_ID` set, it adds `--label opensession.session=<id>`
 *   and `--label opensession.instance=<instance>` and execs the real CLI;
 *   every other invocation, and every shell outside a session, reaches the
 *   real CLI unchanged. Anything started another way (compose, an absolute
 *   path) can carry the same label by hand; the run instructions say so.
 * - Units: agent command scopes carry the same two labels in their unit
 *   Description, and so can a unit an agent starts itself with
 *   `systemd-run --user --description="$OPENSESSION_UNIT_LABEL"`.
 *
 * The instance label names this installation's state root, so a second
 * instance sharing the host user (a dev gateway) never reaps another
 * instance's containers as ownerless.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { statePath } from "./paths";
import {
  SYSTEMD_USER_RUNTIME,
  systemdUserEnv,
  systemdUserScopesAvailable,
} from "./systemd-scopes";

export const SESSION_LABEL = "opensession.session";
export const INSTANCE_LABEL = "opensession.instance";
export const CONTAINER_CLIS = ["podman", "docker"] as const;
export type ContainerCli = (typeof CONTAINER_CLIS)[number];

/** Session ids this module will put in a label or a unit description. */
const LABEL_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function labelSafeSessionId(id: string | undefined): id is string {
  return !!id && LABEL_SAFE_ID.test(id);
}

/** This installation's id: a hash of where its session-resource registry
 * lives, so it follows OPENSESSION_STATE_DIR. Resolved per call. */
export function resourceInstanceId(): string {
  return createHash("sha256")
    .update(statePath(".opensession-session-resources.json"))
    .digest("hex")
    .slice(0, 12);
}

/** The labels a session-owned unit carries in its Description. */
export function sessionUnitLabel(sessionId: string): string {
  return `${SESSION_LABEL}=${sessionId} ${INSTANCE_LABEL}=${resourceInstanceId()}`;
}

/** A unit Description that carries the session labels, or undefined when
 * the id cannot be labelled. */
export function sessionUnitDescription(
  sessionId: string | undefined,
  what: string,
): string | undefined {
  if (!labelSafeSessionId(sessionId)) return undefined;
  return `${sessionUnitLabel(sessionId)} ${what}`;
}

/** The session and instance a unit Description names, if it carries them. */
export function parseUnitLabels(
  description: string,
): { sessionId: string; instance?: string } | null {
  const session = description.match(
    /(?:^|\s)opensession\.session=([A-Za-z0-9][A-Za-z0-9_.:-]*)(?=\s|$)/,
  );
  if (!session) return null;
  const instance = description.match(
    /(?:^|\s)opensession\.instance=([a-f0-9]+)(?=\s|$)/,
  );
  return {
    sessionId: session[1]!,
    ...(instance ? { instance: instance[1]! } : {}),
  };
}

// ── Labelled resources ───────────────────────────────────────────────────────

export type LabelledResource = {
  kind: "container" | "unit";
  /** Container id, or the full unit name (with its suffix). */
  handle: string;
  /** The CLI that lists and stops a container. */
  runtime?: ContainerCli;
  sessionId: string;
  instance?: string;
  /** When the container was created or the unit became active. */
  startedAtMs?: number;
  memoryBytes?: number;
  /** Container name and image, or the unit's description. */
  label: string;
};

type CommandResult = { exitCode: number | null; stdout: string };

/** The host calls this module makes, replaceable in tests. */
export type OwnershipRuntime = {
  /** Container CLIs installed on this host. */
  containerClis: () => ContainerCli[];
  /** Whether a systemd user manager is reachable. */
  systemdUser: () => boolean;
  run: (
    argv: string[],
    options: { timeoutMs: number },
  ) => Promise<CommandResult>;
  /** Time since boot, for unit start times. */
  uptimeMs: () => Promise<number | undefined>;
};

function containerCliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  // Rootless podman needs the user's runtime dir; a system service may not
  // have one in its environment.
  if (!env.XDG_RUNTIME_DIR && existsSync(SYSTEMD_USER_RUNTIME))
    env.XDG_RUNTIME_DIR = SYSTEMD_USER_RUNTIME;
  return env;
}

async function runCommand(
  argv: string[],
  options: { timeoutMs: number },
): Promise<CommandResult> {
  try {
    const systemctl = argv[0] === "systemctl";
    const proc = Bun.spawn(argv, {
      env: systemctl
        ? { ...containerCliEnv(), ...systemdUserEnv() }
        : containerCliEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    // A hung daemon (docker without its socket, a wedged podman) must not
    // hold archive or the reaper.
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, options.timeoutMs);
    try {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { exitCode: proc.signalCode ? null : exitCode, stdout };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { exitCode: null, stdout: "" };
  }
}

const defaultRuntime: OwnershipRuntime = {
  containerClis: () =>
    // Tests never reach the host's container runtimes or user manager.
    process.env.NODE_ENV === "test"
      ? []
      : CONTAINER_CLIS.filter((cli) => !!Bun.which(cli)),
  systemdUser: () =>
    process.env.NODE_ENV !== "test" && systemdUserScopesAvailable(),
  run: runCommand,
  uptimeMs: async () => {
    try {
      const seconds = Number(
        (await readFile("/proc/uptime", "utf8")).split(/\s+/)[0],
      );
      return Number.isFinite(seconds) ? seconds * 1000 : undefined;
    } catch {
      return undefined;
    }
  },
};

let runtime: OwnershipRuntime = defaultRuntime;

/** Test seam: replace the container CLI and systemctl calls, or `null`. */
export function __setOwnershipRuntimeForTest(
  next: Partial<OwnershipRuntime> | null,
): void {
  runtime = next ? { ...defaultRuntime, ...next } : defaultRuntime;
  inventory = null;
}

const LIST_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 30_000;
/** Seconds a container gets between SIGTERM and SIGKILL. */
const CONTAINER_STOP_SECONDS = 10;

/** `ps --format` columns, the same for podman and docker. */
export const CONTAINER_PS_FORMAT = [
  "{{.ID}}",
  `{{.Label "${SESSION_LABEL}"}}`,
  `{{.Label "${INSTANCE_LABEL}"}}`,
  "{{.CreatedAt}}",
  "{{.Names}}",
  "{{.Image}}",
].join("\t");

/** `2024-05-01 12:00:00[.fraction] +0200 CEST`, docker's and podman's
 * CreatedAt, as epoch ms. */
export function parseContainerCreatedAt(value: string): number | undefined {
  const match = value
    .trim()
    .match(
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-])(\d{2})(\d{2})/,
    );
  if (!match) return undefined;
  const [, date, time, sign, hours, minutes] = match;
  const ms = Date.parse(`${date}T${time}${sign}${hours}:${minutes}`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Rows of `<cli> ps --format CONTAINER_PS_FORMAT`; rows without a usable
 * session label are dropped. */
export function parseContainerRows(
  out: string,
  cli: ContainerCli,
): LabelledResource[] {
  const rows: LabelledResource[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [id, sessionId, instance, createdAt, names, image] = line.split("\t");
    if (!id || !/^[a-f0-9]{12,64}$/.test(id.trim())) continue;
    if (!labelSafeSessionId(sessionId?.trim())) continue;
    const startedAtMs = parseContainerCreatedAt(createdAt ?? "");
    rows.push({
      kind: "container",
      handle: id.trim(),
      runtime: cli,
      sessionId: sessionId!.trim(),
      ...(instance?.trim() ? { instance: instance.trim() } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      label: [names?.trim(), image?.trim()].filter(Boolean).join(" · "),
    });
  }
  return rows;
}

/** Active units whose description carries a session label, from
 * `systemctl --user list-units --plain --no-legend` (UNIT LOAD ACTIVE SUB
 * DESCRIPTION). */
export function parseUnitRows(out: string): LabelledResource[] {
  const rows: LabelledResource[] = [];
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+\S+\s+\S+\s+\S+\s+(.*)$/);
    if (!match) continue;
    const [, unit, description] = match;
    if (!/\.(scope|service)$/.test(unit!)) continue;
    const labels = parseUnitLabels(description!);
    if (!labels) continue;
    rows.push({
      kind: "unit",
      handle: unit!,
      sessionId: labels.sessionId,
      ...(labels.instance ? { instance: labels.instance } : {}),
      label: description!.trim(),
    });
  }
  return rows;
}

/** `systemctl show -p Id -p ActiveEnterTimestampMonotonic -p MemoryCurrent`
 * blocks, keyed by unit. */
export function parseUnitShow(
  out: string,
  uptimeMs: number | undefined,
  nowMs: number,
): Map<string, { startedAtMs?: number; memoryBytes?: number }> {
  const result = new Map<
    string,
    { startedAtMs?: number; memoryBytes?: number }
  >();
  for (const block of out.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1));
    }
    const id = fields.get("Id");
    if (!id) continue;
    const entry: { startedAtMs?: number; memoryBytes?: number } = {};
    const monotonicUs = Number(fields.get("ActiveEnterTimestampMonotonic"));
    if (
      uptimeMs !== undefined &&
      Number.isFinite(monotonicUs) &&
      monotonicUs > 0
    )
      entry.startedAtMs = nowMs - (uptimeMs - monotonicUs / 1000);
    const memory = Number(fields.get("MemoryCurrent"));
    // systemd prints UINT64_MAX (or "[not set]") when it does not account it.
    if (Number.isFinite(memory) && memory >= 0 && memory < 2 ** 63)
      entry.memoryBytes = memory;
    result.set(id, entry);
  }
  return result;
}

async function listContainers(): Promise<LabelledResource[]> {
  const found: LabelledResource[] = [];
  const seen = new Set<string>();
  for (const cli of runtime.containerClis()) {
    const { exitCode, stdout } = await runtime.run(
      [
        cli,
        "ps",
        "--no-trunc",
        "--filter",
        `label=${SESSION_LABEL}`,
        "--format",
        CONTAINER_PS_FORMAT,
      ],
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    // Not running, no socket, or no podman machine: nothing to find there.
    if (exitCode !== 0) continue;
    for (const row of parseContainerRows(stdout, cli)) {
      // `docker` may be podman under another name: one container, one row.
      if (seen.has(row.handle)) continue;
      seen.add(row.handle);
      found.push(row);
    }
  }
  return found;
}

async function listUnits(): Promise<LabelledResource[]> {
  if (!runtime.systemdUser()) return [];
  const listed = await runtime.run(
    [
      "systemctl",
      "--user",
      "list-units",
      "--type=service,scope",
      "--state=active",
      "--plain",
      "--no-legend",
      "--no-pager",
    ],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (listed.exitCode !== 0) return [];
  const units = parseUnitRows(listed.stdout).slice(0, 200);
  if (!units.length) return units;
  const shown = await runtime.run(
    [
      "systemctl",
      "--user",
      "show",
      "--property=Id,ActiveEnterTimestampMonotonic,MemoryCurrent",
      ...units.map((unit) => unit.handle),
    ],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (shown.exitCode !== 0) return units;
  const details = parseUnitShow(
    shown.stdout,
    await runtime.uptimeMs(),
    Date.now(),
  );
  return units.map((unit) => ({ ...unit, ...details.get(unit.handle) }));
}

/** A listing shared by back-to-back callers (a batch of archives). */
let inventory: { at: number; rows: Promise<LabelledResource[]> } | null = null;
const INVENTORY_TTL_MS = 3_000;

/**
 * Running containers and active user units that carry a session label.
 * Hosts without podman, docker or a user manager (macOS dev hosts, tests)
 * have none. Never rejects.
 */
export function listLabelledResources(): Promise<LabelledResource[]> {
  const now = Date.now();
  if (inventory && now - inventory.at < INVENTORY_TTL_MS) return inventory.rows;
  const rows = (async () => {
    try {
      const [containers, units] = await Promise.all([
        listContainers(),
        listUnits(),
      ]);
      return [...containers, ...units];
    } catch (error) {
      console.warn(
        "[session-resources] could not list labelled resources:",
        error,
      );
      return [];
    }
  })();
  inventory = { at: now, rows };
  return rows;
}

function forgetListed(resource: LabelledResource): void {
  if (!inventory) return;
  const previous = inventory.rows;
  inventory = {
    at: inventory.at,
    rows: previous.then((rows) =>
      rows.filter((row) => row.handle !== resource.handle),
    ),
  };
}

/** Stop one labelled container or unit. Resolves whether the stop
 * succeeded; never rejects. */
export async function stopLabelledResource(
  resource: LabelledResource,
): Promise<boolean> {
  const argv =
    resource.kind === "container"
      ? [
          resource.runtime ?? "podman",
          "stop",
          "--time",
          String(CONTAINER_STOP_SECONDS),
          resource.handle,
        ]
      : ["systemctl", "--user", "stop", resource.handle];
  const { exitCode } = await runtime.run(argv, { timeoutMs: STOP_TIMEOUT_MS });
  if (exitCode === 0) forgetListed(resource);
  return exitCode === 0;
}

// ── Environment ──────────────────────────────────────────────────────────────

export function containerShimDir(): string {
  return statePath("container-shims");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `podman`/`docker` shim (see the module comment). POSIX sh. */
export function containerShimScript(
  cli: ContainerCli,
  shimDir: string,
  instance: string,
): string {
  const label = `--label "${SESSION_LABEL}=$OPENSESSION_SESSION_ID" --label "${INSTANCE_LABEL}=$instance"`;
  return `#!/bin/sh
# Generated by Open Session; rewritten when it changes. Do not edit.
# Labels containers that an Open Session session starts with \`run\` or
# \`create\`, so archiving the session stops them. Every other invocation,
# and any shell without OPENSESSION_SESSION_ID, reaches the real ${cli} as is.
shim_dir=${shellQuote(shimDir)}
tool=${cli}
instance=${shellQuote(instance)}
real=
saved_ifs=$IFS
IFS=:
for dir in $PATH; do
  dir=\${dir%/}
  [ -n "$dir" ] || continue
  [ "$dir" = "$shim_dir" ] && continue
  if [ -f "$dir/$tool" ] && [ -x "$dir/$tool" ] && ! [ "$dir/$tool" -ef "$0" ]; then
    real=$dir/$tool
    break
  fi
done
IFS=$saved_ifs
if [ -z "$real" ]; then
  echo "$tool: command not found" >&2
  exit 127
fi
if [ -n "\${OPENSESSION_SESSION_ID:-}" ]; then
  case "$1" in
    run|create)
      sub=$1
      shift
      exec "$real" "$sub" ${label} "$@"
      ;;
    container)
      case "\${2:-}" in
        run|create)
          sub=$2
          shift 2
          exec "$real" container "$sub" ${label} "$@"
          ;;
      esac
      ;;
  esac
fi
exec "$real" "$@"
`;
}

function pathWithout(path: string, dir: string): string {
  return path
    .split(delimiter)
    .filter((entry) => entry && entry.replace(/\/+$/, "") !== dir)
    .join(delimiter);
}

/** Write the shims for the CLIs found on `path`; the shim dir, or null when
 * there is nothing to wrap or it could not be written. */
export function ensureContainerShims(path: string): string | null {
  if (process.platform === "win32") return null;
  const dir = containerShimDir();
  const clis = CONTAINER_CLIS.filter(
    (cli) => !!Bun.which(cli, { PATH: pathWithout(path, dir) }),
  );
  if (!clis.length) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const instance = resourceInstanceId();
    for (const cli of clis) {
      const file = join(dir, cli);
      const script = containerShimScript(cli, dir, instance);
      let current: string | undefined;
      try {
        current = readFileSync(file, "utf8");
      } catch {}
      if (current === script) continue;
      // Write beside it and rename, so a shell never runs half a script.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, script, { mode: 0o755 });
      chmodSync(temp, 0o755);
      renameSync(temp, file);
    }
    return dir;
  } catch (error) {
    console.warn("[session-resources] could not write container shims:", error);
    return null;
  }
}

/**
 * What a local run, script, Portal or setup environment adds so the session
 * owns what it starts: `OPENSESSION_SESSION_ID`, `OPENSESSION_UNIT_LABEL`
 * for `systemd-run --description`, and PATH with the container shims first
 * (only when podman or docker is installed). Empty for an id that cannot be
 * labelled. `path` is the PATH the environment would otherwise get.
 * Shared shims, one id per environment: a shell outside a session never
 * has the variable, so the shim passes its commands through unchanged.
 */
export function sessionOwnershipEnv(
  sessionId: string | undefined,
  path: string | undefined,
  options: { shims?: boolean } = {},
): Record<string, string> {
  if (!labelSafeSessionId(sessionId)) return {};
  const env: Record<string, string> = {
    OPENSESSION_SESSION_ID: sessionId,
    OPENSESSION_UNIT_LABEL: sessionUnitLabel(sessionId),
  };
  // A command that runs on another machine (a Sandbox) gets the id only:
  // this host's shim path means nothing there.
  if (options.shims === false) return env;
  const basePath = path || "/usr/local/bin:/usr/bin:/bin";
  const shims = ensureContainerShims(basePath);
  if (shims)
    env.PATH = [shims, pathWithout(basePath, shims)]
      .filter(Boolean)
      .join(delimiter);
  return env;
}
