// The project's policy decides what Sessions does with a verified candidate:
// act after the veto window, act right away, ask the owner, or only watch.
// Rules are over action properties, never over scenarios. Every decision
// names the rule that made it.
import {
  NEVER_WITHOUT_YOU,
  type IncidentBudget,
  type IncidentProjectSettings,
  type Independence,
  type NeverWithoutYou,
  type NightRule,
  type PolicyDecision,
} from "../../../shared/incident-response";
import {
  stripIntervalMs,
  type Observation,
  type Signal,
  type SignalEvaluation,
} from "../../../shared/incidents";
import { activeMaintenance } from "../maintenance";
import { MISSED_CHECK_IN_DETAIL } from "../rules";

export const FACT_LABELS: Record<NeverWithoutYou, string> = {
  "costs-money": "costs money",
  "needs-secret": "needs a secret",
  migration: "runs a migration",
  "outside-scope": "goes outside its scope",
  "not-reversible": "can't be undone",
};

const FULLY_DOWN_RUN = 3;
/** The newest observation must be at most this many strip intervals old. */
const FULLY_DOWN_FRESH_INTERVALS = 2;

function resolvableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Whether the daily night window is active at `now`. A rule whose time
 *  zone cannot be resolved counts as active: the night rule only ever asks
 *  for more caution. */
export function nightActive(
  night: NightRule | undefined,
  now: number,
): boolean {
  if (!night) return false;
  if (!night.timeZone || !resolvableTimeZone(night.timeZone)) return true;
  try {
    return (
      activeMaintenance(
        [
          {
            kind: "weekly",
            days: [0, 1, 2, 3, 4, 5, 6],
            start: night.start,
            end: night.end,
            timeZone: night.timeZone,
          },
        ],
        now,
      ) !== null
    );
  } catch {
    return true;
  }
}

/**
 * Every own signal that still exists evaluates `failing`, and the primary
 * signal is down: its last three main-lane observations all failed and the
 * newest is at most two strip intervals old, or it is a heartbeat whose
 * check-ins are missing (owner call). Deleted signals (missing from
 * `evaluations`) are ignored.
 */
export function fullyDown(input: {
  ownSignalIds: string[];
  evaluations: ReadonlyMap<string, SignalEvaluation>;
  primaryRecent: Observation[];
  primary: Pick<Signal, "source" | "rule" | "intervalMs">;
  now: number;
}): boolean {
  const present = input.ownSignalIds.flatMap((id) => {
    const evaluation = input.evaluations.get(id);
    return evaluation ? [evaluation] : [];
  });
  if (!present.length || present.some((e) => e.state !== "failing"))
    return false;
  const main = input.primaryRecent
    .filter((o) => !o.lane)
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.at === b.o.at ? a.i - b.i : a.o.at < b.o.at ? -1 : 1))
    .map(({ o }) => o);
  const latest = main.at(-1);
  // A failing heartbeat with no reported failure is missing its check-ins.
  if (
    input.primary.source.kind === "heartbeat" &&
    input.primary.rule.kind === "missing" &&
    !(latest?.result === "fail" && latest.detail !== MISSED_CHECK_IN_DETAIL)
  )
    return true;
  if (main.length < FULLY_DOWN_RUN || !latest) return false;
  const age = input.now - Date.parse(latest.at);
  if (!(age <= FULLY_DOWN_FRESH_INTERVALS * stripIntervalMs(input.primary)))
    return false;
  return main.slice(-FULLY_DOWN_RUN).every((o) => o.result === "fail");
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function evaluatePolicy(input: {
  settings: IncidentProjectSettings;
  facts: ReadonlySet<NeverWithoutYou>;
  independence: Independence;
  now: number;
  fullyDown: boolean;
}): PolicyDecision {
  const { settings } = input;
  if (settings.agentsPaused)
    return {
      kind: "ask",
      reason: `Agents are paused for ${settings.project}`,
      rule: "Kill switch, from the project settings",
    };
  if (settings.autonomy === "watch")
    return { kind: "watch", rule: "Watch, from the project settings" };

  const hits = NEVER_WITHOUT_YOU.filter(
    (f) => input.facts.has(f) && settings.neverWithoutYou.includes(f),
  );
  if (hits.length) {
    const labels = joinLabels(hits.map((f) => FACT_LABELS[f]));
    return {
      kind: "ask",
      reason: `This change ${labels}, so it needs you`,
      rule: `Never without you: ${labels}, from the project settings`,
    };
  }
  if (input.independence === "same-model")
    return {
      kind: "ask",
      reason:
        "The verifier ran on the same model as the investigator, so it needs you",
      rule: "Independent verification needs a second model",
    };

  let level = settings.autonomy;
  let nightRule: string | undefined;
  if (
    (level === "deploy-after-veto" || level === "deploy-right-away") &&
    settings.night &&
    nightActive(settings.night, input.now) &&
    !input.fullyDown
  ) {
    level = "propose";
    nightRule = `Night rule: Propose between ${settings.night.start} and ${settings.night.end}, from the project settings`;
  }
  if (level === "propose")
    return {
      kind: "ask",
      reason: "Verified and ready. Waiting for you",
      rule: nightRule ?? "Propose, from the project settings",
    };
  if (level === "deploy-after-veto")
    return {
      kind: "act",
      after: "veto",
      vetoMs: settings.vetoMs,
      rule: "Deploy after veto, from the project settings",
    };
  return {
    kind: "act",
    after: "now",
    vetoMs: 0,
    rule: "Deploy right away, from the project settings",
  };
}

/** Dollars without trailing zeros: `$20`, `$12.5`. */
function usd(amount: number): string {
  return `$${Number(amount.toFixed(2))}`;
}

export function budgetProblem(input: {
  incidentCostUsd: number;
  monthCostUsd: number;
  budget: IncidentBudget;
}): { scope: "incident" | "month"; reason: string; rule: string } | null {
  const { budget } = input;
  // Written as "not under the cap" so a NaN cost or cap stops the agents.
  if (!(input.incidentCostUsd < budget.perIncidentUsd))
    return {
      scope: "incident",
      reason: `Agents stopped at the ${usd(budget.perIncidentUsd)} budget for this incident`,
      rule: `Budget: ${usd(budget.perIncidentUsd)} per incident, from the project settings`,
    };
  if (!(input.monthCostUsd < budget.perMonthUsd))
    return {
      scope: "month",
      reason: `Agents stopped at the ${usd(budget.perMonthUsd)} monthly budget`,
      rule: `Budget: ${usd(budget.perMonthUsd)} per month, from the project settings`,
    };
  return null;
}
