// Production Runners for incidents: which paired Runners can serve a
// project, pairing a new one for production, and binding a Runner to a
// project. A bound Runner is reserved for incidents: only the incident
// service may run commands on it, for its projects only, and no session,
// agent, terminal or Portal can reach it. Uses the Runner registry's
// existing synchronous store functions only.
import { configuredServer } from "../../config";
import { isRunnerConnected } from "../../runner-ws";
import {
  type Runner,
  createRunnerPairing,
  getRunner,
  listRunners,
  reserveRunnerForIncidents,
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

/** What else the Runner serves that reserving it for `project` would
 *  change, as a sentence; undefined when nothing. */
function sharedWith(runner: Runner, project: string): string | undefined {
  if (!runner.incidentReserved && runner.allowedRepos.length === 0)
    return `Runner ${runner.name} serves every repository`;
  // Already reserved for this project: binding again changes nothing.
  if (runner.incidentReserved && runner.allowedRepos.includes(project))
    return undefined;
  const others = runner.allowedRepos.filter((repo) => repo !== project);
  return others.length
    ? `Runner ${runner.name} serves ${others.join(", ")}`
    : undefined;
}

export function listProductionRunnerCandidates(
  project: string,
  bound: string[],
): ProductionRunnerView[] {
  return listRunners().map((runner) => {
    const isBound = bound.includes(runner.id);
    const confirm = isBound ? undefined : sharedWith(runner, project);
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
  });
}

const bindings = new Set<Promise<void>>();

/** Fire-and-forget from the pairing callback, tracked for tests. */
function trackBinding(project: string, runnerId: string, by: string): void {
  const binding = bindProductionRunner(project, runnerId, by, {
    fresh: true,
  }).catch((error: unknown) => {
    console.warn(
      `[incidents] could not bind Runner ${runnerId} to ${project}:`,
      error instanceof Error ? error.message : error,
    );
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
    // Always a new Runner: a name match must never hand an existing
    // Runner's record to production.
    fresh: true,
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
 * production Runners. A Runner that already serves other repositories
 * (every repository, or other projects' incidents) is bound only with
 * `confirmShared`: once reserved, nothing but the incident service can use
 * it. `fresh` is a Runner this project's own pairing just created.
 */
export async function bindProductionRunner(
  project: string,
  runnerId: string,
  by: string,
  opts: { confirmShared?: boolean; fresh?: boolean } = {},
): Promise<void> {
  const runner = getRunner(runnerId);
  if (!runner) throw new Error(`Runner ${runnerId} is not paired`);
  if (!incidentProjectExists(project))
    throw new Error(`Unknown project ${project}`);
  const platform = runnerPlatformProblem(runner);
  if (platform) throw new Error(platform);
  const shared = opts.fresh ? undefined : sharedWith(runner, project);
  if (shared && !opts.confirmShared)
    throw new Error(
      `${shared}. Confirm to reserve it for ${project} incidents only`,
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
