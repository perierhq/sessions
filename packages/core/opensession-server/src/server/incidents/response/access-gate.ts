// The project's kill switch and budget as a plan 3 access gate: while a
// project's agents are paused, or an incident or the month is over budget,
// every incident agent is refused at spawn, at every turn and at every
// incident tool call, not only at the coordinator's next step.
//
// Gates are synchronous, so this reads only what is in memory: the project
// settings this process last read or wrote, and the month's spend the
// coordinator last measured. With no settings in memory the gate does not
// refuse; the coordinator reads settings before every step, and boot warms
// the cache.
import type { IncidentAgentRole } from "../../../shared/incident-access";
import type { Incident } from "../../../shared/incidents";
import { type AccessGate, registerAccessGate } from "../access/resolve";
import { budgetProblem } from "./policy";
import { listProjectSettings, peekProjectSettings } from "./project-settings";

const monthSpend = new Map<string, number>();

/** The project's agent spend this calendar month (UTC), as the coordinator
 *  last measured it. */
export function setProjectMonthSpend(project: string, usd: number): void {
  monthSpend.set(project, usd);
}

export const incidentAccessGate: AccessGate = (
  incident: Incident,
  _role: IncidentAgentRole,
) => {
  const settings = peekProjectSettings(incident.project);
  if (!settings) return null;
  if (settings.agentsPaused) return `Agents are paused for ${incident.project}`;
  return (
    budgetProblem({
      incidentCostUsd: incident.response?.costUsd ?? 0,
      monthCostUsd: monthSpend.get(incident.project) ?? 0,
      budget: settings.budget,
    })?.reason ?? null
  );
};

const KEY = "__incidentAccessGate";
type Registration = { unregister: () => void };
const registry = globalThis as typeof globalThis & {
  [KEY]?: Registration;
};

/** Register the gate once per process (idempotent) and warm the settings
 *  cache in the background. Call from boot and before spawning agents. */
export function startIncidentAccessGate(): void {
  if (registry[KEY]) return;
  registry[KEY] = { unregister: registerAccessGate(incidentAccessGate) };
  void listProjectSettings().catch((error) => {
    console.warn(
      "[incidents] Could not read project settings for the access gate:",
      error instanceof Error ? error.message : error,
    );
  });
}

export function __resetIncidentAccessGateForTest(): void {
  registry[KEY]?.unregister();
  delete registry[KEY];
  monthSpend.clear();
}
