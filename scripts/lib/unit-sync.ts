/**
 * Keep an install's systemd units in step with the release it runs.
 *
 * `opensession service install` renders the units once. A release that
 * changes a template (a new directive, a new slice budget, a dependency
 * between units) used to reach only boxes where someone ran `service install`
 * again: `opensession update` swapped the code and restarted it under the old
 * units. `syncUnits` re-renders every unit the install already has from the
 * running release's templates, keeps the values that belong to the install
 * (its user, paths, env file, credentials, binary and PATH, read back from the
 * installed unit), installs the ones that differ and reloads systemd.
 * `opensession update` runs it through the new release (`service sync`), and
 * `opensession doctor` reports the same plan as drift.
 *
 * Only units the install already has are touched: creating, enabling or
 * removing units is `service install`'s job. Drop-ins under `<unit>.d/` are
 * the operator's and are never read or written here.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EXECUTOR_SERVICE_PATH,
  INGRESS_SERVICE_PATH,
  SERVICE_PATH,
  SESSION_KERNEL_SERVICE_PATH,
  SOCKET_PATH,
  USER_INGRESS_UNIT_PATH,
  USER_SESSION_KERNEL_UNIT_PATH,
  USER_SOCKET_PATH,
  USER_UNIT_PATH,
} from "./paths";
import {
  renderExecutorUnit,
  renderIngressUnit,
  renderSessionKernelUnit,
  renderSocketUnit,
  renderUnit,
  serviceWorkdir,
  socketActivated,
  type SystemdScope,
  userEnv,
} from "./service";
import { dim, info, ok, runInherit, warn } from "./ui";

/** One unit file the install may have, and how this release renders it. */
export interface UnitTarget {
  name: string;
  /** Where the install keeps it. */
  path: string;
  render: () => Promise<string>;
  /** Carry the install's own values over (rendered services and sockets);
   *  static files such as slices are installed as shipped. */
  carry: boolean;
}

export interface PlannedUnit {
  name: string;
  path: string;
  status: "unchanged" | "changed" | "missing" | "error";
  desired?: string;
  /** Directive lines (comments and blanks left out) the sync adds/removes. */
  added: string[];
  removed: string[];
  error?: string;
}

const RESOURCE_SLICES = [
  "opensession-control.slice",
  "opensession-workloads.slice",
] as const;

/** The units `service install` puts in place for this scope. */
export function defaultUnitTargets(scope: SystemdScope): UnitTarget[] {
  const ingress = socketActivated();
  if (scope === "user") {
    return [
      {
        name: "opensession.service",
        path: USER_UNIT_PATH,
        render: () => renderUnit("user"),
        carry: true,
      },
      {
        name: "opensession-session-kernel.service",
        path: USER_SESSION_KERNEL_UNIT_PATH,
        render: () => renderSessionKernelUnit("user"),
        carry: true,
      },
      ...(ingress
        ? [
            {
              name: "opensession-ingress.service",
              path: USER_INGRESS_UNIT_PATH,
              render: () => renderIngressUnit("user"),
              carry: true,
            },
            {
              name: "opensession.socket",
              path: USER_SOCKET_PATH,
              render: () => renderSocketUnit("user"),
              carry: true,
            },
          ]
        : []),
    ];
  }
  return [
    {
      name: "opensession.service",
      path: SERVICE_PATH,
      render: () => renderUnit("system"),
      carry: true,
    },
    {
      name: "opensession-session-kernel.service",
      path: SESSION_KERNEL_SERVICE_PATH,
      render: () => renderSessionKernelUnit("system"),
      carry: true,
    },
    {
      name: "opensession-executor.service",
      path: EXECUTOR_SERVICE_PATH,
      render: () => renderExecutorUnit(),
      carry: true,
    },
    ...(ingress
      ? [
          {
            name: "opensession-ingress.service",
            path: INGRESS_SERVICE_PATH,
            render: () => renderIngressUnit("system"),
            carry: true,
          },
          {
            name: "opensession.socket",
            path: SOCKET_PATH,
            render: () => renderSocketUnit("system"),
            carry: true,
          },
        ]
      : []),
    // The resource slices are shipped as-is (deploy/install-resource-control.sh).
    ...RESOURCE_SLICES.map((name) => ({
      name,
      path: `/etc/systemd/system/${name}`,
      render: async () => {
        const source = join(serviceWorkdir(), "deploy", "systemd", name);
        if (!existsSync(source)) throw new Error(`missing ${source}`);
        return readFileSync(source, "utf8");
      },
      carry: false,
    })),
  ];
}

// ── Carrying the install's values over ─────────────────────────────────────

/** Directives whose value is the install's, not the template's. */
const CARRIED_KEYS = new Set([
  "User",
  "Group",
  "WorkingDirectory",
  "EnvironmentFile",
  "ListenStream",
]);
/** Environment= variables that locate the install (binaries, state). */
const CARRIED_ENV = new Set([
  "PATH",
  "HOME",
  "OPENSESSION_HOME",
  "OPENSESSION_ENV_FILE",
  "OPENSESSION_STATE_DIR",
  "OPENSESSION_SESSIONS_DIR",
]);

function directive(line: string): { key: string; value: string } | null {
  if (/^\s*[#;]/.test(line)) return null;
  const match = line.match(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/);
  return match ? { key: match[1], value: match[2] } : null;
}

function envName(value: string): string {
  return value.replace(/^"/, "").split("=")[0] ?? "";
}

function credentialId(value: string): string {
  return value.split(":")[0] ?? "";
}

function program(value: string): string {
  return value.trim().split(/\s+/)[0] ?? "";
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The rendered unit with the installed unit's own values put back: its
 * User/Group, WorkingDirectory, EnvironmentFile, socket address, credential
 * paths (matched by id), the binary ExecStart runs (when it is the same
 * program) and the Environment= variables that locate binaries and state.
 * Everything else, comments included, is the template's.
 */
export function carryInstalledValues(
  rendered: string,
  installed: string,
): string {
  const old = installed.split("\n").map(directive);
  const oldValues = (key: string) =>
    old.filter((d): d is { key: string; value: string } => d?.key === key);
  const oldEnv = new Map(
    oldValues("Environment")
      .filter((d) => CARRIED_ENV.has(envName(d.value)))
      .map((d) => [envName(d.value), d.value]),
  );
  const oldCredentials = new Map(
    oldValues("LoadCredential").map((d) => [credentialId(d.value), d.value]),
  );
  const oldExec = oldValues("ExecStart").find((d) => d.value)?.value;

  const seen = new Map<string, number>();
  const usedEnv = new Set<string>();
  const lines = rendered.split("\n").map((line) => {
    const d = directive(line);
    if (!d) return line;
    if (CARRIED_KEYS.has(d.key)) {
      const index = seen.get(d.key) ?? 0;
      seen.set(d.key, index + 1);
      const value = oldValues(d.key)[index]?.value;
      return value === undefined ? line : `${d.key}=${value}`;
    }
    if (d.key === "LoadCredential") {
      const value = oldCredentials.get(credentialId(d.value));
      return value === undefined ? line : `${d.key}=${value}`;
    }
    if (d.key === "Environment") {
      const name = envName(d.value);
      const value = oldEnv.get(name);
      if (value === undefined) return line;
      usedEnv.add(name);
      return `${d.key}=${value}`;
    }
    if (d.key === "ExecStart" && oldExec && d.value) {
      const from = program(d.value);
      const to = program(oldExec);
      // Only the same program moves (a release binary installed elsewhere,
      // another bun); a source unit never inherits a release binary.
      if (from && to && basename(from) === basename(to))
        return `${d.key}=${to}${d.value.trim().slice(from.length)}`;
    }
    return line;
  });

  // A locating variable the install sets but this shell did not render
  // (the state dir comes from the env file the CLI may not be pointed at)
  // stays, after the last Environment= line of [Service].
  const missing = [...oldEnv.entries()].filter(([name]) => !usedEnv.has(name));
  if (missing.length) {
    const start = lines.findIndex((l) => l.trim() === "[Service]");
    if (start >= 0) {
      let end = lines.findIndex((l, i) => i > start && /^\[.*\]$/.test(l));
      if (end < 0) end = lines.length;
      let at = start + 1;
      for (let i = start + 1; i < end; i++)
        if (directive(lines[i])?.key === "Environment") at = i + 1;
      lines.splice(
        at,
        0,
        ...missing.map(([, value]) => `Environment=${value}`),
      );
    }
  }
  return lines.join("\n");
}

function directiveLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith(";"));
}

function multisetMinus(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of a) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else out.push(line);
  }
  return out;
}

// ── Planning and applying ──────────────────────────────────────────────────

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** What syncing would change, unit by unit. Never writes. */
export async function planUnitSync(opts: {
  targets: UnitTarget[];
  read?: (path: string) => string | undefined;
}): Promise<PlannedUnit[]> {
  const read = opts.read ?? readIfPresent;
  const out: PlannedUnit[] = [];
  for (const target of opts.targets) {
    const current = read(target.path);
    const base = {
      name: target.name,
      path: target.path,
      added: [],
      removed: [],
    };
    if (current === undefined) {
      out.push({ ...base, status: "missing" });
      continue;
    }
    let rendered: string;
    try {
      rendered = await target.render();
    } catch (e) {
      out.push({
        ...base,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const desired = target.carry
      ? carryInstalledValues(rendered, current)
      : rendered;
    out.push({
      ...base,
      status: desired === current ? "unchanged" : "changed",
      desired,
      added: multisetMinus(directiveLines(desired), directiveLines(current)),
      removed: multisetMinus(directiveLines(current), directiveLines(desired)),
    });
  }
  return out;
}

/** One line per changed unit, then its directive changes. */
export function describeUnitChange(unit: PlannedUnit, limit = 8): string[] {
  const lines = [
    ...unit.removed.map((l) => `- ${l}`),
    ...unit.added.map((l) => `+ ${l}`),
  ];
  if (!lines.length) return ["  (comments only)"];
  const shown = lines.slice(0, limit).map((l) => `  ${l}`);
  if (lines.length > limit) shown.push(`  … ${lines.length - limit} more`);
  return shown;
}

/** What `opensession doctor` reports for a plan, or null when in step. */
export function unitDrift(
  plan: PlannedUnit[],
): { summary: string; fix: string; details: string[] } | null {
  const changed = plan.filter((u) => u.status === "changed");
  if (!changed.length) return null;
  return {
    summary: `${changed.length} systemd unit(s) differ from this release`,
    fix: "`opensession service sync` updates them (`opensession update` does it too)",
    details: changed.flatMap((u) => [u.path, ...describeUnitChange(u)]),
  };
}

export interface SyncResult {
  code: number;
  changed: string[];
  missing: string[];
  hint?: string;
}

const SYNC_HINT =
  "run `opensession service sync` from a shell that can use sudo, then restart";

async function stageInTemp(content: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "opensession-units-"));
  const path = join(dir, "unit");
  writeFileSync(path, content, { mode: 0o644 });
  return path;
}

/**
 * Re-render the install's units from this release and install the ones that
 * differ. System scope copies through `sudo` (`sudo -n` by default, so an
 * unattended update fails instead of hanging on a prompt) and reloads the
 * system manager; user scope writes the files and reloads the user manager.
 * The new definitions take effect when each unit next restarts.
 */
export async function syncUnits(opts: {
  scope: SystemdScope;
  check?: boolean;
  targets?: UnitTarget[];
  read?: (path: string) => string | undefined;
  write?: (path: string, content: string) => Promise<void>;
  stage?: (content: string) => Promise<string>;
  sudo?: string[];
  runCommand?: (
    cmd: string[],
    cwd?: string,
    env?: Record<string, string>,
  ) => Promise<number>;
}): Promise<SyncResult> {
  const runCommand = opts.runCommand ?? runInherit;
  const sudo = opts.sudo ?? ["sudo", "-n"];
  const plan = await planUnitSync({
    targets: opts.targets ?? defaultUnitTargets(opts.scope),
    read: opts.read,
  });
  const changed = plan.filter((u) => u.status === "changed");
  const missing = plan.filter((u) => u.status === "missing").map((u) => u.name);
  for (const unit of plan.filter((u) => u.status === "error"))
    warn(`cannot render ${unit.name}`, unit.error);
  const result: SyncResult = {
    code: plan.some((u) => u.status === "error") ? 1 : 0,
    changed: changed.map((u) => u.name),
    missing,
  };
  if (!changed.length) {
    if (!result.code) ok("systemd units match this release");
    return result;
  }
  for (const unit of changed) {
    info(`${opts.check ? "out of date" : "updating"} ${unit.path}`);
    for (const line of describeUnitChange(unit)) info(dim(line));
  }
  if (opts.check) return result;

  if (opts.scope === "system") {
    const staged: string[] = [];
    try {
      for (const unit of changed) {
        const source = await (opts.stage ?? stageInTemp)(unit.desired!);
        staged.push(source);
        const code = await runCommand([
          ...sudo,
          "install",
          "-o",
          "root",
          "-g",
          "root",
          "-m",
          "0644",
          source,
          unit.path,
        ]);
        if (code !== 0) {
          warn(`could not install ${unit.path}`, SYNC_HINT);
          return { ...result, code: 1, hint: SYNC_HINT };
        }
      }
    } finally {
      if (!opts.stage)
        for (const path of staged)
          rmSync(join(path, ".."), { recursive: true, force: true });
    }
    if ((await runCommand([...sudo, "systemctl", "daemon-reload"])) !== 0) {
      warn("systemctl daemon-reload failed", SYNC_HINT);
      return { ...result, code: 1, hint: SYNC_HINT };
    }
  } else {
    const write =
      opts.write ??
      (async (path: string, content: string) => {
        await Bun.write(path, content);
      });
    for (const unit of changed) await write(unit.path, unit.desired!);
    if (
      (await runCommand(
        ["systemctl", "--user", "daemon-reload"],
        undefined,
        userEnv(),
      )) !== 0
    ) {
      warn("systemctl --user daemon-reload failed", SYNC_HINT);
      return { ...result, code: 1, hint: SYNC_HINT };
    }
  }
  ok(
    `updated ${changed.length} systemd unit(s)`,
    "they take effect when each unit next restarts",
  );
  return result;
}
