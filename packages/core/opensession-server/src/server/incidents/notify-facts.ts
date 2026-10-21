// The facts an incident notification needs that the incident does not
// carry: the signal's state, whether the project's night rule is on,
// whether the fix loop's "fully down" holds, the owner's time zone and what
// the veto will run. Night and fully down are the fix loop's own rules
// (`nightActive`, `fullyDown`), never worked out again here. A missing
// project or signal degrades to "not night, not fully down", never a throw.
import type { IncidentProjectSettings } from "../../shared/incident-response";
import type {
  Incident,
  Observation,
  Signal,
  SignalEvaluation,
} from "../../shared/incidents";
import { timezoneForUser } from "../shared/user-mappings";
import type { VetoChange } from "./notify-copy";
import type { NotifyFacts } from "./notify-plan";
import { recentObservations } from "./observation-store";
import { fullyDown, nightActive } from "./response/policy";
import { getProjectSettings } from "./response/project-settings";
import { allSignalEvaluations } from "./signal-runtime";
import { getSignal } from "./signal-store";

export interface NotifyFactsDeps {
  settings(project: string): Promise<IncidentProjectSettings>;
  signal(id: string): Promise<Signal | null>;
  evaluations(): ReadonlyMap<string, SignalEvaluation>;
  recent(signalId: string): Observation[];
  timeZone(user: string): string;
}

export const defaultNotifyFactsDeps: NotifyFactsDeps = {
  settings: getProjectSettings,
  signal: getSignal,
  evaluations: allSignalEvaluations,
  recent: (signalId) => recentObservations(signalId),
  timeZone: timezoneForUser,
};

/** What the veto runs when nobody stops it, or null when it is unclear. */
export function vetoChange(
  incident: Incident,
  settings: IncidentProjectSettings,
): VetoChange | null {
  const candidate = incident.response?.candidate;
  if (!candidate) return null;
  if (candidate.rollbackFirst) return { kind: "rollback" };
  if (candidate.plan.pr) return { kind: "deploy" };
  const first = candidate.plan.actions[0];
  const action = settings.actions.find((a) => a.id === first);
  if (!action) return null;
  if (action.kind === "rollback") return { kind: "rollback" };
  if (action.kind === "deploy") return { kind: "deploy" };
  return { kind: "action", label: action.label };
}

async function settingsOrNull(
  project: string,
  deps: NotifyFactsDeps,
): Promise<IncidentProjectSettings | null> {
  try {
    return await deps.settings(project);
  } catch {
    return null;
  }
}

async function isFullyDown(
  incident: Incident,
  now: number,
  deps: NotifyFactsDeps,
): Promise<boolean> {
  try {
    const signals = await Promise.all(
      incident.signalIds.map((id) => deps.signal(id)),
    );
    const ownSignalIds = signals.flatMap((signal) =>
      signal && !signal.provider ? [signal.id] : [],
    );
    const primary = signals.find(
      (signal) => signal?.id === incident.primarySignalId,
    );
    if (!primary) return false;
    return fullyDown({
      ownSignalIds,
      evaluations: deps.evaluations(),
      primaryRecent: deps.recent(incident.primarySignalId),
      primary,
      now,
    });
  } catch {
    return false;
  }
}

function timeZoneOf(owner: string, deps: NotifyFactsDeps): string {
  try {
    return deps.timeZone(owner) || "UTC";
  } catch {
    return "UTC";
  }
}

export async function loadNotifyFacts(
  incident: Incident,
  now: number,
  deps: NotifyFactsDeps = defaultNotifyFactsDeps,
): Promise<NotifyFacts> {
  const [settings, down] = await Promise.all([
    settingsOrNull(incident.project, deps),
    isFullyDown(incident, now, deps),
  ]);
  return {
    signal: deps.evaluations().get(incident.primarySignalId)?.state ?? null,
    night: settings ? nightActive(settings.night, now) : false,
    fullyDown: down,
    timeZone: timeZoneOf(incident.owner, deps),
    change: settings ? vetoChange(incident, settings) : null,
  };
}
