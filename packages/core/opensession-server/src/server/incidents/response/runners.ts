// Production Runners for incidents: which paired Runners can serve a
// project, pairing a new one for production, and binding a Runner to a
// project. A bound Runner is reserved for incidents: only the incident
// service may run commands on it, for its projects only, and no session,
// agent, terminal or Portal can reach it. Uses the Runner registry's
// existing synchronous store functions only.
import { configuredServer } from "../../config";
import {
  disconnectRunner,
  isRunnerConnected,
  runnerTerminalCount,
} from "../../runner-ws";
import {
  type Runner,
  createRunnerPairing,
  getRunner,
  listRunners,
  removeRunner,
  reserveRunnerForIncidents,
  setRunnerWorkload,
} from "../../runners";
import { incidentAudit } from "../audit-sink";
import {
  getProjectSettings,
  incidentProjectExists,
  patchProjectSettings,
  productionRunnerProblem,
  runnerPlatformProblem,
  type SettingsWriter,
} from "./project-settings";

export interface ProductionRunnerView {
  id: string;
  name: string;
  label?: string;
  platform: string;
  online: boolean;
  bound: boolean;
  /** Why the Runner cannot serve the project (bound: now; unbound: at all). */
  problem: string | null;
  /** Binding it takes it away from what it serves now: ask first. */
  confirm?: string;
}

/** What a Runner is doing now that reserving it would end. The Portal
 *  store loads on demand: it pulls in the session cache. */
export interface RunnerActivity {
  terminals: (runnerId: string) => number;
  portals: (runnerId: string) => Promise<number>;
  dropPortals: (runnerId: string) => Promise<void>;
  disconnect: (runnerId: string, reason: string) => boolean;
}

const defaultActivity: RunnerActivity = {
  terminals: runnerTerminalCount,
  portals: async (id) =>
    (await import("../../runner-portals")).runnerPortalCount(id),
  dropPortals: async (id) =>
    (await import("../../runner-portals")).dropRunnerPortalsForRunner(id),
  disconnect: disconnectRunner,
};
let activity = defaultActivity;

export function __setRunnerActivityForTest(
  over: Partial<RunnerActivity> | undefined,
): void {
  activity = over ? { ...defaultActivity, ...over } : defaultActivity;
}

interface RunnerUse {
  workloads: number;
  terminals: number;
  portals: number;
}

async function runnerUse(runner: Runner): Promise<RunnerUse> {
  return {
    workloads: runner.workloads?.length ?? (runner.workload ? 1 : 0),
    terminals: activity.terminals(runner.id),
    portals: await activity.portals(runner.id),
  };
}

function andList(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** What reserving the Runner for `project` would take from whatever it
 *  serves now, as a sentence; undefined when nothing. */
function bindingChanges(
  runner: Runner,
  project: string,
  use: RunnerUse,
): string | undefined {
  const clauses: string[] = [];
  if (!runner.incidentReserved) {
    if (runner.allowedRepos.length === 0)
      clauses.push("serves every repository");
    if (runner.allowedUsers.length)
      clauses.push(`is open to ${andList(runner.allowedUsers)}`);
    const { fullSessions, terminals, portals } = runner.permissions;
    const allows = [
      ...(fullSessions ? ["full sessions"] : []),
      ...(terminals ? ["terminals"] : []),
      ...(portals ? ["Portals"] : []),
    ];
    if (allows.length) clauses.push(`allows ${andList(allows)}`);
  }
  // Already reserved for this project: binding again changes nothing.
  if (!(runner.incidentReserved && runner.allowedRepos.includes(project))) {
    const others = runner.allowedRepos.filter((repo) => repo !== project);
    if (others.length) clauses.push(`serves ${others.join(", ")}`);
  }
  const running = [
    ...(use.workloads ? [counted(use.workloads, "workload")] : []),
    ...(use.terminals ? [counted(use.terminals, "terminal")] : []),
    ...(use.portals ? [counted(use.portals, "Portal")] : []),
  ];
  if (running.length) clauses.push(`is running ${andList(running)}`);
  return clauses.length
    ? `Runner ${runner.name} ${andList(clauses)}`
    : undefined;
}

export async function listProductionRunnerCandidates(
  project: string,
  bound: string[],
): Promise<ProductionRunnerView[]> {
  return Promise.all(
    listRunners().map(async (runner) => {
      const isBound = bound.includes(runner.id);
      const confirm = isBound
        ? undefined
        : bindingChanges(runner, project, await runnerUse(runner));
      return {
        id: runner.id,
        name: runner.name,
        ...(runner.label ? { label: runner.label } : {}),
        platform: runner.platform,
        online: isRunnerConnected(runner.id),
        bound: isBound,
        problem: isBound
          ? productionRunnerProblem(runner.id, project)
          : runnerPlatformProblem(runner),
        ...(confirm ? { confirm } : {}),
      };
    }),
  );
}

const bindings = new Set<Promise<void>>();

/** Fire-and-forget from the pairing callback, tracked for tests. A Runner
 *  that cannot be bound is removed: it never stays paired outside the
 *  project it was paired for. */
function trackBinding(project: string, runnerId: string, by: string): void {
  // The pairing was started by a signed-in person (`startProductionPairing`).
  const binding = bindProductionRunner(
    project,
    runnerId,
    by,
    { signedInPerson: true },
    { fresh: true },
  ).catch((error: unknown) => {
    console.warn(
      `[incidents] could not bind Runner ${runnerId} to ${project}; removing it:`,
      error instanceof Error ? error.message : error,
    );
    removeRunner(runnerId);
    activity.disconnect(runnerId, "removed");
  });
  bindings.add(binding);
  void binding.finally(() => bindings.delete(binding));
}

/** A one-time code for a new Runner that is reserved for `project` as soon
 *  as it registers. Only a signed-in person may start one; the code is
 *  never audited. */
export function startProductionPairing(
  project: string,
  by: string,
  writer: SettingsWriter,
): { code: string; expiresAt: number; command: string } | { error: string } {
  if (!writer.signedInPerson)
    return { error: "Only a signed-in person can pair a production Runner" };
  if (!incidentProjectExists(project))
    return { error: `Unknown project ${project}` };
  const { code, expiresAt } = createRunnerPairing(by, {
    // Always a new Runner, saved already reserved for the project: a name
    // match must never hand an existing Runner's record to production.
    incidentProject: project,
    onRegistered: (runner) => trackBinding(project, runner.id, by),
  });
  incidentAudit({
    kind: "incident_runner_pairing_started",
    project,
    by,
    expiresAt,
  });
  return {
    code,
    expiresAt,
    command: `opensession runner connect --server ${configuredServer().publicBaseUrl} --code ${code}`,
  };
}

/**
 * Reserve a Runner for `project`'s incidents and add it to the project's
 * production Runners. A Runner that serves anything else (every
 * repository, other repositories or projects, named people, sessions,
 * terminals or Portals) or is running workloads, terminals or Portals is
 * bound only with `confirmShared`: once reserved, nothing but the incident
 * service can use it, and what it was running is ended. `fresh` is a Runner this project's own pairing just created. Only a
 * signed-in person may bind, as only one may start a pairing.
 */
export async function bindProductionRunner(
  project: string,
  runnerId: string,
  by: string,
  writer: SettingsWriter,
  opts: { confirmShared?: boolean; fresh?: boolean } = {},
): Promise<void> {
  if (!writer.signedInPerson)
    throw new Error("Only a signed-in person can bind a production Runner");
  const runner = getRunner(runnerId);
  if (!runner) throw new Error(`Runner ${runnerId} is not paired`);
  if (!incidentProjectExists(project))
    throw new Error(`Unknown project ${project}`);
  const platform = runnerPlatformProblem(runner);
  if (platform) throw new Error(platform);
  const changes = opts.fresh
    ? undefined
    : bindingChanges(runner, project, await runnerUse(runner));
  if (changes && !opts.confirmShared)
    throw new Error(
      `${changes}. Confirm to reserve it for ${project} incidents only`,
    );
  // Incident projects may share a reserved Runner; anything else it served
  // loses it.
  const repos = runner.incidentReserved
    ? [...new Set([...runner.allowedRepos, project])]
    : [project];
  reserveRunnerForIncidents(runnerId, {
    repos,
    ...(runner.label ? {} : { label: `Production · ${project}` }),
  });
  // Whatever the Runner ran before is over: its Portals, its terminals and
  // commands (closing the channel ends them; the Runner reconnects under
  // the new policy) and its workload claims.
  if (!opts.fresh && !runner.incidentReserved) {
    await activity.dropPortals(runnerId);
    activity.disconnect(runnerId, "reserved");
    setRunnerWorkload(runnerId);
  }
  await patchProjectSettings(project, (s) =>
    s.productionRunners.includes(runnerId)
      ? s
      : { ...s, productionRunners: [...s.productionRunners, runnerId] },
  );
  incidentAudit({ kind: "incident_runner_paired", project, runnerId, by });
}

/** Why `runnerId` may not run `project`'s checks or actions now: it must be
 *  one of the project's production Runners and reserved for incidents. The
 *  signal store's `runOn` check and every Runner check at run time use it. */
export async function productionRunOnProblem(
  runnerId: string,
  project: string,
): Promise<string | null> {
  const settings = await getProjectSettings(project);
  if (!settings.productionRunners.includes(runnerId))
    return `Runner ${runnerLabel(runnerId)} is not a production Runner for ${project}`;
  return productionRunnerProblem(runnerId, project);
}

export function runnerLabel(runnerId: string | undefined): string {
  if (runnerId === undefined) return "the Sessions server";
  const runner = getRunner(runnerId);
  return runner ? runner.label || runner.name : runnerId;
}

/** Awaits the bindings `onRegistered` started. */
export async function __flushProductionBindingsForTest(): Promise<void> {
  while (bindings.size) await Promise.allSettled([...bindings]);
}
