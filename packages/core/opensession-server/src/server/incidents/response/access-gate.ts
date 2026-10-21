// The project's kill switch and budget as a plan 3 access gate: while a
// project's agents are paused, or an incident or the month is over budget,
// every incident agent is refused at spawn, at every turn and at every
// incident tool call, not only at the coordinator's next step.
//
// Gates are synchronous, so this reads only what is in memory: the project
// settings this process last read or wrote, and the month's spend loaded at
// boot and re-measured by the coordinator. Until both are in memory the gate
// refuses, so an agent resumed at boot (or after a failed read) can never
// slip past the kill switch or the monthly budget. The coordinator reads
// settings before every step, and boot warms both.
import type { IncidentAgentRole } from "../../../shared/incident-access";
import type { Incident } from "../../../shared/incidents";
import { type AccessGate, registerAccessGate } from "../access/resolve";
import { listIncidents } from "../incident-store";
import { spendInMonth } from "./ledger";
import { budgetProblem } from "./policy";
import { listProjectSettings, peekProjectSettings } from "./project-settings";

const monthSpend = new Map<string, number>();
/** Set once the month's spend of every project was read from the incidents. */
let monthSpendLoaded = false;

/** The project's agent spend this calendar month (UTC), as the coordinator
 *  last measured it. */
export function setProjectMonthSpend(project: string, usd: number): void {
  monthSpend.set(project, usd);
}

/**
 * Reads this UTC month's agent spend of every project from the incidents'
 * recorded runs (the same sum the coordinator keeps up to date, each run in
 * the month it was spent), so a restart does not start the monthly budget
 * at $0.
 */
export async function loadProjectMonthSpend(
  now: number = Date.now(),
  list: () => Promise<Incident[]> = () => listIncidents(),
): Promise<void> {
  const month = new Date(now).toISOString().slice(0, 7);
  const sums = new Map<string, number>();
  for (const incident of await list()) {
    const usd = spendInMonth(incident.response, month, now);
    if (usd)
      sums.set(incident.project, (sums.get(incident.project) ?? 0) + usd);
  }
  for (const [project, usd] of sums)
    monthSpend.set(project, Math.round(usd * 100) / 100);
  monthSpendLoaded = true;
}

export const incidentAccessGate: AccessGate = (
  incident: Incident,
  _role: IncidentAgentRole,
) => {
  const settings = peekProjectSettings(incident.project);
  if (!settings) return "Project settings not loaded";
  if (settings.agentsPaused) return `Agents are paused for ${incident.project}`;
  const month =
    monthSpend.get(incident.project) ?? (monthSpendLoaded ? 0 : undefined);
  if (month === undefined) return "Monthly spend not loaded";
  return (
    budgetProblem({
      incidentCostUsd: incident.response?.costUsd ?? 0,
      monthCostUsd: month,
      budget: settings.budget,
    })?.reason ?? null
  );
};

const KEY = "__incidentAccessGate";
type Registration = { unregister: () => void };
const registry = globalThis as typeof globalThis & {
  [KEY]?: Registration;
};

/** Register the gate once per process (idempotent) and load the settings
 *  and the month's spend in the background. Call from boot and before
 *  spawning agents. */
export function startIncidentAccessGate(): void {
  if (registry[KEY]) return;
  registry[KEY] = { unregister: registerAccessGate(incidentAccessGate) };
  void listProjectSettings().catch((error) => {
    console.warn(
      "[incidents] Could not read project settings for the access gate:",
      error instanceof Error ? error.message : error,
    );
  });
  void loadProjectMonthSpend().catch((error) => {
    console.warn(
      "[incidents] Could not read this month's agent spend for the access gate:",
      error instanceof Error ? error.message : error,
    );
  });
}

export function __resetIncidentAccessGateForTest(): void {
  registry[KEY]?.unregister();
  delete registry[KEY];
  monthSpend.clear();
  monthSpendLoaded = false;
}
