// Production Runners for incidents: which paired Runners can serve a
// project, pairing a new one for production, and binding a Runner to a
// project (commands for that project only, added to its settings). Uses the
// Runner registry's existing synchronous store functions only.
import { configuredServer } from "../../config";
import { isRunnerConnected } from "../../runner-ws";
import {
  createRunnerPairing,
  getRunner,
  listRunners,
  updateRunner,
} from "../../runners";
import { incidentAudit } from "../audit-sink";
import {
  patchProjectSettings,
  productionRunnerProblem,
} from "./project-settings";

export interface ProductionRunnerView {
  id: string;
  name: string;
  label?: string;
  platform: string;
  online: boolean;
  bound: boolean;
  problem: string | null;
  warning?: string;
}

export function listProductionRunnerCandidates(
  project: string,
  bound: string[],
): ProductionRunnerView[] {
  return listRunners().map((runner) => ({
    id: runner.id,
    name: runner.name,
    ...(runner.label ? { label: runner.label } : {}),
    platform: runner.platform,
    online: isRunnerConnected(runner.id),
    bound: bound.includes(runner.id),
    problem: productionRunnerProblem(runner.id, project),
    ...(runner.platform === "win32"
      ? { warning: "Windows Runners cannot run http checks" }
      : {}),
  }));
}

const bindings = new Set<Promise<void>>();

/** Fire-and-forget from the pairing callback, tracked for tests. */
function trackBinding(project: string, runnerId: string, by: string): void {
  const binding = bindProductionRunner(project, runnerId, by).catch(
    (error: unknown) => {
      console.warn(
        `[incidents] could not bind Runner ${runnerId} to ${project}:`,
        error instanceof Error ? error.message : error,
      );
    },
  );
  bindings.add(binding);
  void binding.finally(() => bindings.delete(binding));
}

export function startProductionPairing(
  project: string,
  by: string,
): { code: string; expiresAt: number; command: string } {
  const { code, expiresAt } = createRunnerPairing(by, {
    onRegistered: (runner) => trackBinding(project, runner.id, by),
  });
  return {
    code,
    expiresAt,
    command: `opensession runner connect --server ${configuredServer().publicBaseUrl} --code ${code}`,
  };
}

export async function bindProductionRunner(
  project: string,
  runnerId: string,
  by: string,
): Promise<void> {
  const runner = getRunner(runnerId);
  if (!runner) throw new Error(`Runner ${runnerId} is not paired`);
  updateRunner(runnerId, {
    // A Runner open to every repository is narrowed to this project; one
    // already limited keeps its list and gains this project.
    allowedRepos: runner.allowedRepos.length
      ? [...new Set([...runner.allowedRepos, project])]
      : [project],
    permissions: { commands: true },
    ...(runner.label ? {} : { label: `Production · ${project}` }),
  });
  await patchProjectSettings(project, (s) =>
    s.productionRunners.includes(runnerId)
      ? s
      : { ...s, productionRunners: [...s.productionRunners, runnerId] },
  );
  incidentAudit({ kind: "incident_runner_paired", project, runnerId, by });
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
