/**
 * "This machine (container)": each session's Sandbox is a rootless Podman pod
 * on this host (docs/self-hosting-sandboxes.md). A `RemoteDriver` adapter like
 * Daytona and Tart, so bootstrap, the workspace clone, checkpoints,
 * workspace-rpc and the Portal relay are the shared remote paths.
 *
 * Resources per session (podman-cli.ts names them): a pod whose infra
 * container owns a private pasta network namespace, a workload container
 * (uid 1000, no capabilities, read-only rootfs), and a volume holding
 * `/home/ubuntu` with the repository cloned inside it. Nothing from the host
 * is mounted.
 *
 * The network namespace is destroyed whenever the pod stops, and with it the
 * egress table. So every start, on create and on every wake, runs the same
 * sequence (`startFirewalledPod`):
 *   infra → install rules → verify → workload → re-verify in the namespace the
 *   workload process holds → network self-test.
 * `podman pod start` is never used (it starts the workload before the rules
 * land), and `podman start <workload>` is only issued right after the rules
 * were verified in the running infra's namespace (on a stopped pod podman
 * would silently start the infra with no rules). Any failure stops the pod and
 * rejects; nothing falls back to an open network or another provider.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { sessionsDir } from "../../paths";
import { getRepo, worktreePathFor } from "../../worktree";
import { remoteSandboxCallbackBaseUrl, sandboxConfig } from "../config";
import {
  getSandboxConnection,
  PODMAN_DEFAULT_MEMORY_MB,
  PODMAN_DEFAULT_PIDS_LIMIT,
  type PodmanConnectionFacts,
} from "../connections";
import type {
  Sandbox,
  SandboxProvider,
  SandboxSessionSpec,
  SandboxStatus,
} from "../provider";
import {
  assertDialbackReachable,
  bootstrapRemoteSandbox,
  findRemoteStateBySession,
  listRemoteStates,
  makeRemoteSandbox,
  readRemoteState,
  remoteCloneUrl,
  removeRemoteState,
  resolveTrustPolicy,
  runResumeHook,
  setupRemoteWorkspace,
  shellQuoteWord,
  touchRemoteState,
  withRemoteEnsureLock,
  writeRemoteState,
  type RemoteDriver,
  type RemoteExecOpts,
  type RemoteSandboxState,
  type SandboxTrustPolicy,
} from "./bootstrap";
import {
  isIpv4,
  PODMAN_NAME_PREFIX,
  PODMAN_WORKLOAD_HOME,
  PODMAN_WORKLOAD_USER,
  podCreateArgs,
  podmanEnv,
  podmanExec,
  podmanNames,
  runPodman,
  volumeCreateArgs,
  workloadCreateArgs,
  type PodmanNames,
  type PodmanRunner,
} from "./podman-cli";
import {
  egressCounterProof,
  installEgressRules,
  localInterfaceAddresses,
  podmanEgressRuleset,
  resolveEgressInput,
  verifyEgressRulesAt,
  workloadNetnsPath,
  type EgressInput,
} from "./podman-egress";
import { ensurePodmanImage, podmanImageTag } from "./podman-image";
import {
  hostControlCheck,
  hostTcpProbe,
  isolationTargets,
  runIsolationSelfTest,
  type IsolationResult,
} from "./podman-selftest";

export const PODMAN_PROVIDER_LABEL = "This machine (container)";
const LOG = "[sandbox:podman]";
const DEFAULT_IDLE_STOP_MINUTES = 30;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
/** Client-side margin over the in-container `timeout`. */
const EXEC_KILL_MARGIN_MS = 10_000;
const STOP_TIMEOUT_SEC = 10;
const RM_TIMEOUT_SEC = 5;

// ── Settings ─────────────────────────────────────────────────────────────────

export interface PodmanSettings {
  memoryMb: number;
  pidsLimit: number;
  /** Applied only when this host delegates the cgroup `cpu` controller. */
  cpu?: number;
  /** The only resolvers the sandbox may reach (IPv4, public). */
  dns: string[];
}

export const PODMAN_DEFAULT_DNS = ["1.1.1.1", "9.9.9.9"];

/** The connection's machine shape, with defaults for anything missing or
 *  invalid. */
export function podmanSettings(raw: unknown): PodmanSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const int = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
  const dns = Array.isArray(r.dns)
    ? r.dns.filter((v): v is string => typeof v === "string" && isIpv4(v))
    : [];
  const cpu =
    typeof r.cpu === "number" && Number.isFinite(r.cpu) && r.cpu > 0
      ? r.cpu
      : undefined;
  return {
    memoryMb: int(r.memoryMb, PODMAN_DEFAULT_MEMORY_MB),
    pidsLimit: int(r.pidsLimit, PODMAN_DEFAULT_PIDS_LIMIT),
    ...(cpu !== undefined ? { cpu } : {}),
    dns: dns.length ? dns : [...PODMAN_DEFAULT_DNS],
  };
}

// ── Host facts ───────────────────────────────────────────────────────────────

/** Whether systemd delegates the `cpu` controller to this user's manager, so
 *  `--cpus` can be applied rootless. */
export function hostCpuDelegated(uid = process.getuid?.()): boolean {
  if (uid === undefined) return false;
  try {
    const controllers = readFileSync(
      `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
      "utf8",
    );
    return /(^|\s)cpu(\s|$)/.test(controllers);
  } catch {
    return false;
  }
}

function inCgnat(address: string): boolean {
  if (!isIpv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b! >= 64 && b! <= 127;
}

function httpBase(callbackBaseUrl: string): string {
  return callbackBaseUrl
    .replace(/^ws(s?):\/\//, "http$1://")
    .replace(/\/+$/, "");
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Commands in the workload: `podman exec` as uid 1000 with the caller's env
 * in a private env file (never argv), under an in-container `timeout`.
 */
export function podmanDriver(
  run: PodmanRunner,
  names: PodmanNames,
  o: { ensureStarted: () => Promise<void>; runtimeDir?: string },
): RemoteDriver {
  return {
    async exec(cmd: string, opts?: RemoteExecOpts) {
      if (opts?.detached) {
        await this.execBackground(cmd, opts);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
      try {
        return await podmanExec(run, {
          workload: names.workload,
          cwd: opts?.cwd,
          env: opts?.env,
          timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
          cmd,
          timeoutMs: timeoutMs + EXEC_KILL_MARGIN_MS,
          runtimeDir: o.runtimeDir,
        });
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async execBackground(cmd: string, opts?: RemoteExecOpts) {
      const result = await podmanExec(run, {
        workload: names.workload,
        cwd: opts?.cwd,
        env: opts?.env,
        timeoutSec: 0,
        detached: true,
        cmd,
        runtimeDir: o.runtimeDir,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `${PODMAN_PROVIDER_LABEL} background command failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        );
    },

    async writeFile(path: string, content: string) {
      if (!path.startsWith("/") || /[\0\r\n]/.test(path))
        throw new Error(`sandbox file path must be absolute: ${path}`);
      // Written by a process inside the container: `podman cp` would follow
      // container-side symlinks as the host user.
      const result = await podmanExec(run, {
        workload: names.workload,
        timeoutSec: 120,
        stdin: content,
        cmd: `cat > ${shellQuoteWord(path)}`,
        timeoutMs: 120_000 + EXEC_KILL_MARGIN_MS,
        runtimeDir: o.runtimeDir,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `could not write ${path} into the sandbox: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        );
    },

    ensureStarted: o.ensureStarted,
  };
}

// ── Start sequence ───────────────────────────────────────────────────────────

function failure(what: string, result: { stderr: string; stdout: string }) {
  return new Error(
    `${what}: ${(result.stderr || result.stdout).trim().slice(0, 400) || "failed"}`,
  );
}

async function must(
  run: PodmanRunner,
  argv: string[],
  what: string,
  timeoutMs?: number,
): Promise<string> {
  const result = await run(argv, timeoutMs ? { timeoutMs } : undefined);
  if (result.exitCode !== 0) throw failure(what, result);
  return result.stdout;
}

async function workloadRunning(
  run: PodmanRunner,
  names: PodmanNames,
): Promise<boolean> {
  const result = await run([
    "container",
    "inspect",
    "--format",
    "{{.State.Running}}",
    names.workload,
  ]);
  if (result.exitCode !== 0) throw failure(`inspect ${names.workload}`, result);
  return result.stdout.trim() === "true";
}

async function stopPod(run: PodmanRunner, names: PodmanNames): Promise<void> {
  const result = await run([
    "pod",
    "stop",
    "-t",
    String(STOP_TIMEOUT_SEC),
    names.pod,
  ]);
  if (result.exitCode !== 0)
    console.warn(
      `${LOG} could not stop ${names.pod}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
    );
}

/**
 * Bring the pod to running behind a verified firewall, then prove it from
 * inside. A stopped workload goes through the whole start sequence; a running
 * one has its namespace re-verified. `selfTest` gets the workload's namespace
 * path. On any failure the pod is stopped and the error rethrown. Returns
 * whether the workload had to be started.
 */
export async function startFirewalledPod(
  run: PodmanRunner,
  names: PodmanNames,
  egress: EgressInput,
  selfTest: (workloadNetns: string) => Promise<void>,
): Promise<boolean> {
  let started = false;
  try {
    // Renders (and validates) before anything starts.
    const ruleset = podmanEgressRuleset(egress);
    if (!(await workloadRunning(run, names))) {
      await must(run, ["start", names.infra], `start ${names.infra}`);
      const netns = await installEgressRules(run, names.infra, ruleset);
      await verifyEgressRulesAt(run, netns, egress);
      // Only now, with the infra running and its rules verified.
      await must(run, ["start", names.workload], `start ${names.workload}`);
      started = true;
    }
    const workloadNetns = await workloadNetnsPath(run, names.workload);
    await verifyEgressRulesAt(run, workloadNetns, egress);
    await selfTest(workloadNetns);
    return started;
  } catch (error) {
    await stopPod(run, names);
    throw error;
  }
}

function selfTestFailure(result: {
  results: IsolationResult[];
  error?: string;
}): Error {
  const bad = result.results
    .filter((r) => !r.pass)
    .map((r) => `${r.name} (expected ${r.expect}, got ${r.got || "nothing"})`);
  return new Error(
    `${PODMAN_PROVIDER_LABEL} isolation self-test failed: ` +
      [...(result.error ? [result.error] : []), ...bad]
        .join("; ")
        .slice(0, 1500),
  );
}

// ── Provider ─────────────────────────────────────────────────────────────────

export interface PodmanWorkspacePlan {
  repoId: string;
  branch: string;
  defaultBranch: string;
  cwd: string;
}

export interface PodmanPrepareContext {
  driver: RemoteDriver;
  spec: SandboxSessionSpec;
  plan: PodmanWorkspacePlan;
  sandboxId: string;
  trust: SandboxTrustPolicy;
  callbackBaseUrl: string;
}

export interface PodmanProviderDeps {
  run?: PodmanRunner;
  lookup?: (host: string) => Promise<string[]>;
  hostAddresses?: () => string[];
  extraHostAddresses?: () => string[];
  cpuDelegated?: () => boolean;
  settings?: () => PodmanSettings;
  /** The base URL sandboxes dial back to (ws(s) or http(s)). */
  callbackBaseUrl?: () => string;
  /** The gateway's own port (self-test target on loopback). */
  appPort?: () => number;
  /** Other local listener ports (the public ingress). */
  loopbackPorts?: () => number[];
  /** Where exec env files go (default `$XDG_RUNTIME_DIR`). */
  runtimeDir?: string;
  imageTag?: () => string;
  workspacePlan?: (
    spec: SandboxSessionSpec,
    previous: RemoteSandboxState | null,
  ) => Promise<PodmanWorkspacePlan>;
  /** Dial-back check, base runtime and workspace clone. */
  prepare?: (ctx: PodmanPrepareContext) => Promise<void>;
  resumeHook?: (
    driver: RemoteDriver,
    sandboxId: string,
    state: RemoteSandboxState,
  ) => Promise<void>;
}

async function defaultWorkspacePlan(
  spec: SandboxSessionSpec,
  previous: RemoteSandboxState | null,
): Promise<PodmanWorkspacePlan> {
  const repo = getRepo(spec.repo || previous?.repoId);
  const branch = spec.branch || previous?.branch || repo.defaultBranch;
  return {
    repoId: repo.id,
    branch,
    defaultBranch: repo.defaultBranch,
    cwd:
      spec.cwd ||
      previous?.cwd ||
      worktreePathFor(branch, repo.id, { isolated: true }),
  };
}

async function defaultPrepare(ctx: PodmanPrepareContext): Promise<void> {
  await assertDialbackReachable(
    ctx.driver,
    PODMAN_PROVIDER_LABEL,
    ctx.callbackBaseUrl,
  );
  await bootstrapRemoteSandbox(ctx.driver, PODMAN_PROVIDER_LABEL);
  const repo = getRepo(ctx.plan.repoId);
  const cloneUrl = await remoteCloneUrl(repo, {
    credential: ctx.spec.cloneCredential,
  });
  await setupRemoteWorkspace(
    ctx.driver,
    ctx.plan.cwd,
    cloneUrl,
    ctx.plan.branch,
    ctx.plan.defaultBranch,
    repo.id,
    {
      sandboxId: ctx.sandboxId,
      provider: "podman",
      sessionId: ctx.spec.sessionId,
      repoId: repo.id,
      trustProfile: ctx.trust.trustProfile,
    },
    {
      seedPrivateFiles: true,
      runLifecycleHooks: true,
      ...(ctx.spec.restoreCheckpoint
        ? { restoreCheckpoint: ctx.spec.restoreCheckpoint }
        : {}),
    },
  );
}

/** Names for a pod this provider created, from its id. */
function namesForPod(pod: string): PodmanNames {
  if (!pod.startsWith(PODMAN_NAME_PREFIX) || !/^[a-z0-9_.-]+$/.test(pod))
    throw new Error(`not an Open Session podman sandbox: ${pod}`);
  return {
    key: pod.slice(PODMAN_NAME_PREFIX.length),
    pod,
    infra: `${pod}-infra`,
    volume: `${pod}-home`,
    workload: `${pod}-ws`,
  };
}

/** Starts per pod are serialized: two wakes must not interleave. */
const startChains = new Map<string, Promise<unknown>>();

function withStartLock<T>(pod: string, fn: () => Promise<T>): Promise<T> {
  const prev = startChains.get(pod) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => {},
    () => {},
  );
  startChains.set(pod, tail);
  void tail.finally(() => {
    if (startChains.get(pod) === tail) startChains.delete(pod);
  });
  return next;
}

export class PodmanProvider implements SandboxProvider {
  readonly id = "podman" as const;
  private readonly run: PodmanRunner;
  private readonly d: Required<Omit<PodmanProviderDeps, "runtimeDir">> & {
    runtimeDir?: string;
  };

  constructor(deps: PodmanProviderDeps = {}) {
    this.run = deps.run ?? runPodman;
    this.d = {
      run: this.run,
      lookup: deps.lookup ?? defaultLookup,
      hostAddresses: deps.hostAddresses ?? localInterfaceAddresses,
      extraHostAddresses:
        deps.extraHostAddresses ??
        (() => sandboxConfig().podman?.extraHostAddresses ?? []),
      cpuDelegated: deps.cpuDelegated ?? (() => hostCpuDelegated()),
      settings:
        deps.settings ??
        (() => podmanSettings(getSandboxConnection("podman")?.settings)),
      callbackBaseUrl: deps.callbackBaseUrl ?? remoteSandboxCallbackBaseUrl,
      appPort: deps.appPort ?? (() => Number(process.env.PORT) || 3850),
      loopbackPorts:
        deps.loopbackPorts ??
        (() => {
          const ingress = sandboxConfig().publicIngress;
          return ingress?.enabled ? [ingress.port] : [];
        }),
      runtimeDir: deps.runtimeDir,
      imageTag: deps.imageTag ?? (() => podmanImageTag()),
      workspacePlan: deps.workspacePlan ?? defaultWorkspacePlan,
      prepare: deps.prepare ?? defaultPrepare,
      resumeHook:
        deps.resumeHook ??
        ((driver, sandboxId, state) =>
          runResumeHook(driver, "podman", sandboxId, state)),
    };
  }

  ensure(spec: SandboxSessionSpec): Promise<Sandbox> {
    return withRemoteEnsureLock(this.id, spec.sessionId, () =>
      this.ensureInner(spec),
    );
  }

  private async ensureInner(spec: SandboxSessionSpec): Promise<Sandbox> {
    const startedAt = Date.now();
    const mark = (stage: string) =>
      console.log(
        `${LOG} ${spec.sessionId}: ${stage} (+${Date.now() - startedAt}ms)`,
      );
    if (spec.attachedDirs?.length)
      throw new Error(
        "attached repos are not supported in remote sandboxes — detach them or use docker/local",
      );
    const prevState = findRemoteStateBySession(this.id, spec.sessionId);
    const trust = resolveTrustPolicy(spec, prevState);
    if (trust.trustProfile === "automation" || spec.sourceVerification)
      throw new Error(
        `automation runs are not supported on ${PODMAN_PROVIDER_LABEL}`,
      );
    const plan = await this.d.workspacePlan(spec, prevState);
    const names = podmanNames(spec.sessionId);
    const callbackBaseUrl = this.d.callbackBaseUrl();
    // Resolved now and validated before anything is created: a callback on
    // a private, tailnet or host address is refused here.
    const egress = await this.egressInput(callbackBaseUrl);
    podmanEgressRuleset(egress);

    const exists = (await this.run(["pod", "exists", names.pod])).exitCode;
    if (exists !== 0 && exists !== 1)
      throw new Error(`podman pod exists ${names.pod} failed (exit ${exists})`);
    const fresh = exists === 1;
    if (fresh) await this.create(spec, names);
    else if (
      (await this.run(["container", "exists", names.workload])).exitCode !== 0
    )
      await this.createWorkload(names);
    mark(fresh ? "pod created" : "pod found");
    writeRemoteState({
      sandboxId: names.pod,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd: plan.cwd,
      repoId: plan.repoId,
      branch: plan.branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    });

    const started = await this.startLocked(names, egress, callbackBaseUrl);
    mark(started ? "started behind a verified firewall" : "firewall verified");
    const driver = this.driver(names);
    try {
      await this.d.prepare({
        driver,
        spec,
        plan,
        sandboxId: names.pod,
        trust,
        callbackBaseUrl: httpBase(callbackBaseUrl),
      });
    } catch (error) {
      await stopPod(this.run, names);
      throw error;
    }
    mark("workspace ready");
    const state: RemoteSandboxState = {
      sandboxId: names.pod,
      provider: this.id,
      sessionId: spec.sessionId,
      cwd: plan.cwd,
      repoId: plan.repoId,
      branch: plan.branch,
      createdAt: prevState?.createdAt || new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...trust,
    };
    const wokeFromSleep = started && !fresh;
    if (wokeFromSleep) await this.d.resumeHook(driver, names.pod, state);
    writeRemoteState(state);
    return Object.assign(this.handle(names, state), { wokeFromSleep });
  }

  private async create(
    spec: SandboxSessionSpec,
    names: PodmanNames,
  ): Promise<void> {
    const image = this.d.imageTag();
    if ((await this.run(["image", "exists", image])).exitCode !== 0)
      throw new Error(
        `the sandbox image ${image} is missing. Requalify ${PODMAN_PROVIDER_LABEL} in Workspace → Sandboxes.`,
      );
    const { dns } = this.d.settings();
    if ((await this.run(["volume", "exists", names.volume])).exitCode !== 0)
      await must(
        this.run,
        volumeCreateArgs({ names, sessionId: spec.sessionId }),
        `create ${names.volume}`,
      );
    await must(
      this.run,
      podCreateArgs({ names, sessionId: spec.sessionId, dns }),
      `create ${names.pod}`,
    );
    await this.createWorkload(names, image);
  }

  private async createWorkload(
    names: PodmanNames,
    image = this.d.imageTag(),
  ): Promise<void> {
    const settings = this.d.settings();
    await must(
      this.run,
      workloadCreateArgs({
        names,
        image,
        memoryMb: settings.memoryMb,
        pidsLimit: settings.pidsLimit,
        ...(settings.cpu !== undefined && this.d.cpuDelegated()
          ? { cpu: settings.cpu }
          : {}),
      }),
      `create ${names.workload}`,
    );
  }

  private egressInput(callbackBaseUrl: string): Promise<EgressInput> {
    return resolveEgressInput(
      httpBase(callbackBaseUrl),
      this.d.settings().dns,
      this.d.lookup,
      this.d.hostAddresses,
      this.d.extraHostAddresses(),
    );
  }

  /** The start sequence (or re-verification) plus the network self-test,
   *  one at a time per pod. */
  private startLocked(
    names: PodmanNames,
    egress: EgressInput,
    callbackBaseUrl: string,
  ): Promise<boolean> {
    return withStartLock(names.pod, () =>
      startFirewalledPod(this.run, names, egress, (netns) =>
        this.networkSelfTest(names, egress, netns, callbackBaseUrl),
      ),
    );
  }

  /** The self-test's probes, built from this host's addresses now. */
  private selfTestTargets(
    egress: EgressInput,
    callbackBaseUrl: string,
    full: boolean,
    hostPaths: string[] = [],
  ) {
    const v4 = egress.hostAddresses.filter(isIpv4);
    return isolationTargets({
      callbackBaseUrl: `${httpBase(callbackBaseUrl)}/`,
      callbackAddresses: egress.callback.addresses,
      hostAddresses: v4,
      tailnetAddresses: v4.filter(inCgnat),
      extraHostAddresses: egress.extraHostAddresses ?? [],
      appPort: this.d.appPort(),
      loopbackPorts: this.d.loopbackPorts(),
      hostPaths,
      full,
    });
  }

  /** The network half of the self-test, on every ensure and wake. */
  private async networkSelfTest(
    names: PodmanNames,
    egress: EgressInput,
    workloadNetns: string,
    callbackBaseUrl: string,
  ): Promise<void> {
    const result = await runIsolationSelfTest(
      this.driver(names, async () => {}),
      this.selfTestTargets(egress, callbackBaseUrl, false),
      { counters: egressCounterProof(this.run, workloadNetns, egress) },
    );
    if (!result.ok) throw selfTestFailure(result);
  }

  /**
   * Qualification's checks on a running sandbox: the full self-test (file
   * and process probes too, each blocked target first proven live from the
   * host) and the workload's cgroup, which must sit under the user's systemd
   * manager so a gateway restart cannot kill it.
   */
  async qualificationChecks(
    sandboxId: string,
    o: {
      uid: number;
      hostPaths: string[];
      hostControl?: (host: string, port: number) => Promise<boolean>;
    },
  ): Promise<void> {
    const names = namesForPod(sandboxId);
    const callbackBaseUrl = this.d.callbackBaseUrl();
    const egress = await this.egressInput(callbackBaseUrl);
    const netns = await workloadNetnsPath(this.run, names.workload);
    await verifyEgressRulesAt(this.run, netns, egress);
    const { targets, notLiveOnHost } = await hostControlCheck(
      this.selfTestTargets(egress, callbackBaseUrl, true, o.hostPaths),
      o.hostControl ?? hostTcpProbe,
    );
    if (notLiveOnHost.length)
      console.log(
        `${LOG} qualification: not live on this host: ${notLiveOnHost.map((t) => t.name).join(", ")}`,
      );
    const result = await runIsolationSelfTest(
      this.driver(names, async () => {}),
      targets,
      { counters: egressCounterProof(this.run, netns, egress) },
    );
    if (!result.ok) throw selfTestFailure(result);
    const cgroup = (
      await must(
        this.run,
        [
          "container",
          "inspect",
          "--format",
          "{{.State.CgroupPath}}",
          names.workload,
        ],
        `inspect ${names.workload}`,
      )
    ).trim();
    if (!cgroup.includes(`/user@${o.uid}.service/`))
      throw new Error(
        `sandbox containers land in ${cgroup || "an unknown cgroup"}, not under user@${o.uid}.service: ` +
          "give podman the user's XDG_RUNTIME_DIR and D-Bus session (enable linger), or a gateway restart would kill every sandbox",
      );
  }

  /** Start a stopped pod behind its firewall (any wake path). */
  private async wake(names: PodmanNames): Promise<boolean> {
    const callbackBaseUrl = this.d.callbackBaseUrl();
    const egress = await this.egressInput(callbackBaseUrl);
    return this.startLocked(names, egress, callbackBaseUrl);
  }

  private driver(
    names: PodmanNames,
    ensureStarted?: () => Promise<void>,
  ): RemoteDriver {
    return podmanDriver(this.run, names, {
      runtimeDir: this.d.runtimeDir,
      ensureStarted:
        ensureStarted ??
        (async () => {
          if (await workloadRunning(this.run, names)) return;
          await this.wake(names);
        }),
    });
  }

  private handle(names: PodmanNames, state: RemoteSandboxState): Sandbox {
    return makeRemoteSandbox({
      providerId: this.id,
      sandboxId: names.pod,
      sessionId: state.sessionId,
      cwd: state.cwd,
      driver: this.driver(names),
      // Portals ride the outbound relay; nothing is published on the host.
      ports: async () => ({}),
      status: () => this.status(names.pod),
      touchActivity: () => touchRemoteState(this.id, names.pod),
    });
  }

  /** `running`, `stopped`, or `gone` when the pod no longer exists. */
  async status(sandboxId: string): Promise<SandboxStatus> {
    const names = namesForPod(sandboxId);
    const exists = (await this.run(["pod", "exists", names.pod])).exitCode;
    if (exists === 1) return "gone";
    if (exists !== 0)
      throw new Error(`podman pod exists ${names.pod} failed (exit ${exists})`);
    const result = await this.run([
      "pod",
      "inspect",
      "--format",
      "{{.State}}",
      names.pod,
    ]);
    if (result.exitCode !== 0) {
      if (/no such pod/i.test(result.stderr)) return "gone";
      throw failure(`inspect ${names.pod}`, result);
    }
    return result.stdout.trim() === "Running" ? "running" : "stopped";
  }

  async get(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const names = podmanNames(state.sessionId);
    if (names.pod !== sandboxId) return null;
    if ((await this.run(["pod", "exists", names.pod])).exitCode !== 0)
      return null;
    return this.handle(names, state);
  }

  /** Stop the pod. Its network namespace and egress table go with it; the
   *  volume keeps the workspace. */
  async pause(sandboxId: string): Promise<void> {
    const names = namesForPod(sandboxId);
    if ((await this.run(["pod", "exists", names.pod])).exitCode !== 0) return;
    await must(
      this.run,
      ["pod", "stop", "-t", String(STOP_TIMEOUT_SEC), names.pod],
      `stop ${names.pod}`,
    );
  }

  async resume(sandboxId: string): Promise<Sandbox | null> {
    const state = readRemoteState(this.id, sandboxId);
    if (!state) return null;
    const names = podmanNames(state.sessionId);
    if (names.pod !== sandboxId) return null;
    if ((await this.run(["pod", "exists", names.pod])).exitCode !== 0)
      return null;
    const woke = await this.wake(names);
    if (woke) await this.d.resumeHook(this.driver(names), names.pod, state);
    return Object.assign(this.handle(names, state), { wokeFromSleep: woke });
  }

  /** Remove the pod (and its containers) and the session volume: the
   *  workspace is deleted with it. Only resources with this provider's name
   *  prefix and sandbox label are touched. */
  async destroy(
    sandboxId: string,
    options: { strict?: boolean } = {},
  ): Promise<void> {
    const names = namesForPod(sandboxId);
    if (await this.owned("pod", names.pod))
      await must(
        this.run,
        ["pod", "rm", "-f", "-t", String(RM_TIMEOUT_SEC), names.pod],
        `remove ${names.pod}`,
      );
    if (await this.owned("volume", names.volume))
      await must(
        this.run,
        ["volume", "rm", "-f", names.volume],
        `remove ${names.volume}`,
      );
    if (options.strict) {
      for (const [kind, name] of [
        ["pod", names.pod],
        ["volume", names.volume],
      ] as const) {
        const exists = (await this.run([kind, "exists", name])).exitCode;
        if (exists !== 1)
          throw new Error(
            exists === 0
              ? `podman ${kind} ${name} still exists after removal`
              : `podman ${kind} exists ${name} failed (exit ${exists})`,
          );
      }
    }
    removeRemoteState(this.id, sandboxId);
  }

  /** Whether a pod or volume exists and carries the sandbox label. */
  private async owned(kind: "pod" | "volume", name: string): Promise<boolean> {
    const result = await this.run([
      kind,
      "inspect",
      "--format",
      '{{index .Labels "opensession.sandbox"}}',
      name,
    ]);
    if (result.exitCode !== 0) return false;
    if (result.stdout.trim() === "1") return true;
    console.warn(`${LOG} ${kind} ${name} has no sandbox label; left alone`);
    return false;
  }
}

// ── Qualification ────────────────────────────────────────────────────────────

export interface PodmanQualifyDeps extends PodmanProviderDeps {
  platform?: string;
  uid?: number;
  /** Linger enabled for the gateway user (its systemd manager outlives
   *  logins). */
  linger?: () => boolean;
  /** The host's `nft` binary exists. */
  nftPresent?: () => boolean;
  ensureImage?: (
    run: PodmanRunner,
    log: (line: string) => void,
  ) => Promise<string>;
  hostControl?: (host: string, port: number) => Promise<boolean>;
  hostPaths?: string[];
}

const MIN_PODMAN_MAJOR = 5;

function versionMajor(version: unknown): number {
  const match = typeof version === "string" ? /^(\d+)\./.exec(version) : null;
  return match ? Number(match[1]) : 0;
}

/** Host prerequisites, each refusal naming the fix. Returns warnings. */
async function podmanPrerequisites(
  run: PodmanRunner,
  d: { linger: () => boolean; nftPresent: () => boolean },
): Promise<string[]> {
  const info = await run(["info", "--format", "json"]);
  if (info.exitCode !== 0)
    throw new Error(
      info.exitCode === 127
        ? `${PODMAN_PROVIDER_LABEL} needs Linux with rootless Podman: podman is not installed`
        : `podman info failed: ${(info.stderr || info.stdout).trim().slice(0, 300)}`,
    );
  let parsed: any;
  try {
    parsed = JSON.parse(info.stdout);
  } catch {
    throw new Error("podman info did not return JSON");
  }
  const host = parsed?.host ?? {};
  const version = parsed?.version?.Version;
  if (versionMajor(version) < MIN_PODMAN_MAJOR)
    throw new Error(
      `${PODMAN_PROVIDER_LABEL} needs Podman ${MIN_PODMAN_MAJOR}.0 or newer (found ${version || "unknown"})`,
    );
  if (host.security?.rootless !== true)
    throw new Error(
      `${PODMAN_PROVIDER_LABEL} needs rootless Podman: run Open Session as an unprivileged user`,
    );
  if (host.cgroupVersion !== "v2")
    throw new Error(`${PODMAN_PROVIDER_LABEL} needs cgroups v2`);
  const controllers: unknown[] = Array.isArray(host.cgroupControllers)
    ? host.cgroupControllers
    : [];
  for (const controller of ["memory", "pids"])
    if (!controllers.includes(controller))
      throw new Error(
        `${PODMAN_PROVIDER_LABEL} needs the ${controller} cgroup controller delegated to this user: add Delegate=memory pids (and cpu) to user@.service`,
      );
  if (!d.linger())
    throw new Error(
      `${PODMAN_PROVIDER_LABEL} needs linger for this user: run loginctl enable-linger ${userInfo().username}`,
    );
  if (!d.nftPresent())
    throw new Error(
      `${PODMAN_PROVIDER_LABEL} needs nftables on the host: install the nft binary`,
    );
  const warnings: string[] = [];
  if (host.security?.selinuxEnabled !== true)
    warnings.push(
      "SELinux is not enabled: containers rely on namespaces and seccomp alone",
    );
  return warnings;
}

/** Absent-path probes for qualification: this host's state roots that do not
 *  overlap the sandbox's own home. */
function stateHostPaths(): string[] {
  const candidates = ["/opt/opensession", sessionsDir()];
  return candidates.filter(
    (path) =>
      /^\/[A-Za-z0-9._/-]+$/.test(path) &&
      !path.split("/").includes("..") &&
      path !== PODMAN_WORKLOAD_HOME &&
      !path.startsWith(`${PODMAN_WORKLOAD_HOME}/`) &&
      !path.startsWith("/tmp/"),
  );
}

/**
 * Prove this host can run "This machine (container)" sandboxes: Linux with
 * rootless Podman and its prerequisites, the sandbox image (built here, never
 * during a user's session), then a disposable sandbox that must pass the
 * full isolation self-test and sit in the user's systemd cgroup. The
 * disposable sandbox is removed whatever happens. Any failure refuses.
 */
export async function qualifyPodmanConnection(
  progress: (stage: string, progress?: number) => void = () => {},
  deps: PodmanQualifyDeps = {},
): Promise<PodmanConnectionFacts & { warnings: string[] }> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux")
    throw new Error(
      `${PODMAN_PROVIDER_LABEL} needs Linux with rootless Podman`,
    );
  const uid = deps.uid ?? process.getuid?.();
  if (uid === undefined)
    throw new Error(`${PODMAN_PROVIDER_LABEL} needs a POSIX host`);
  const run = deps.run ?? runPodman;
  progress("Checking Podman", 30);
  const warnings = await podmanPrerequisites(run, {
    linger:
      deps.linger ??
      (() => existsSync(`/var/lib/systemd/linger/${userInfo().username}`)),
    nftPresent:
      deps.nftPresent ??
      (() =>
        ["/usr/sbin/nft", "/sbin/nft", "/usr/bin/nft"].some((p) =>
          existsSync(p),
        )),
  });
  progress("Building the sandbox image", 40);
  const imageTag = await (deps.ensureImage ?? ensurePodmanImage)(run, (line) =>
    progress(line, 45),
  );
  const provider = new PodmanProvider({
    ...deps,
    run,
    imageTag: () => imageTag,
    workspacePlan: async () => ({
      repoId: "",
      branch: "",
      defaultBranch: "",
      cwd: PODMAN_WORKLOAD_HOME,
    }),
    prepare: async () => {},
    resumeHook: async () => {},
  });
  const sessionId = `qual-${randomBytes(6).toString("hex")}`;
  const { pod } = podmanNames(sessionId);
  let failure: unknown;
  try {
    progress("Starting a test sandbox behind its firewall", 60);
    await provider.ensure({ sessionId });
    progress("Running the isolation self-test", 80);
    await provider.qualificationChecks(pod, {
      uid,
      hostPaths: deps.hostPaths ?? stateHostPaths(),
      hostControl: deps.hostControl,
    });
  } catch (error) {
    failure = error;
  }
  progress("Removing the test sandbox", 95);
  try {
    await provider.destroy(pod, { strict: true });
  } catch (cleanup) {
    if (!failure) throw cleanup;
    console.warn(`${LOG} qualification cleanup of ${pod} failed:`, cleanup);
  }
  if (failure) throw failure;
  return {
    imageTag,
    cpuLimited: (deps.cpuDelegated ?? (() => hostCpuDelegated(uid)))(),
    selfTestAt: new Date().toISOString(),
    warnings,
  };
}

// ── Terminal ─────────────────────────────────────────────────────────────────

/**
 * A Terminal tab inside the workload: a local PTY running `podman exec -it`
 * as uid 1000, with podman's minimal env (the gateway's env never reaches
 * podman). A sleeping sandbox is woken through the firewall first, as a
 * terminal is an interactive gesture.
 */
export async function podmanTerminalTarget(
  sandboxId: string,
  provider: Pick<PodmanProvider, "status" | "resume"> = new PodmanProvider(),
  uid = process.getuid?.(),
): Promise<{ argv: string[]; cwd: string }> {
  const state = readRemoteState("podman", sandboxId);
  if (!state) throw new Error(`Unknown sandbox ${sandboxId}`);
  const names = podmanNames(state.sessionId);
  if (names.pod !== sandboxId) throw new Error(`Unknown sandbox ${sandboxId}`);
  if (uid === undefined) throw new Error("podman needs a POSIX host");
  if ((await provider.status(sandboxId)) !== "running") {
    const woken = await provider.resume(sandboxId);
    if (!woken) throw new Error("The sandbox could not be woken");
  }
  const cwd = state.cwd.startsWith("/") ? state.cwd : PODMAN_WORKLOAD_HOME;
  return {
    cwd,
    argv: [
      "/usr/bin/env",
      "-i",
      ...Object.entries(podmanEnv(uid)).map(([k, v]) => `${k}=${v}`),
      "TERM=xterm-256color",
      "podman",
      "exec",
      "-it",
      "--user",
      PODMAN_WORKLOAD_USER,
      "--workdir",
      cwd,
      "--env",
      "TERM=xterm-256color",
      names.workload,
      "/bin/bash",
      "-l",
    ],
  };
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(host, { all: true, family: 4 });
  return results.map((r) => r.address);
}

// ── Idle sleep ───────────────────────────────────────────────────────────────

/** Podman has no idle timer of its own. Stop session pods whose last activity
 *  is older than idleStopMinutes; the next command wakes them through the
 *  firewall sequence. */
export async function sweepIdlePodmanSandboxes(
  now = Date.now(),
  provider: Pick<PodmanProvider, "pause" | "status"> = new PodmanProvider(),
): Promise<string[]> {
  const idleMs =
    (sandboxConfig().idleStopMinutes || DEFAULT_IDLE_STOP_MINUTES) * 60_000;
  const stale = listRemoteStates("podman").filter(
    (state) =>
      now - Date.parse(state.lastActivityAt || state.createdAt) > idleMs,
  );
  const stopped: string[] = [];
  for (const state of stale) {
    const { hostRunBusy } = await import("../../host-registry");
    if (hostRunBusy(state.sessionId)) continue;
    try {
      if ((await provider.status(state.sandboxId)) !== "running") continue;
      await provider.pause(state.sandboxId);
      stopped.push(state.sandboxId);
      console.log(
        `${LOG} stopped idle pod ${state.sandboxId} (${state.sessionId})`,
      );
    } catch (error) {
      console.warn(`${LOG} idle stop of ${state.sandboxId} failed:`, error);
    }
  }
  return stopped;
}

const IDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
let idleSweep: ReturnType<typeof setInterval> | undefined;

/** Idempotent; called from boot. */
export function startPodmanIdleSweep(): void {
  if (idleSweep) return;
  idleSweep = setInterval(() => {
    void sweepIdlePodmanSandboxes().catch((error) =>
      console.warn(`${LOG} idle sweep failed:`, error),
    );
  }, IDLE_SWEEP_INTERVAL_MS);
  idleSweep.unref?.();
}
