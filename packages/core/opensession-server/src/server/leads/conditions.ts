// What an owner's approval can wait for before the lead applies it: a pull
// request merged, a pull request's checks green at a pinned head, or an
// incident resolved. Each check reads the live state through injected deps
// (GitHub as the App, the incident store); a read that fails is unknown,
// never met, so an approval only becomes ready on a positive answer.
import type { IncidentState } from "../../shared/incidents";
import type {
  PrCheckOutcome,
  PrMergeVerdict,
  PrReadinessTarget,
} from "../pr-merge-readiness";

export type LeadCondition =
  | { kind: "pr-merged"; ghRepo: string; number: number }
  | { kind: "checks-green"; ghRepo: string; number: number; headSha: string }
  | { kind: "incident-resolved"; id: string };

export type ConditionResult =
  | { status: "met" }
  | { status: "not-met"; reason: string }
  | { status: "unknown"; reason: string };

/** One pull request as the condition checks need it. */
export interface ConditionPr {
  state: "OPEN" | "MERGED" | "CLOSED";
  headSha: string;
  checks: { name: string; outcome: PrCheckOutcome; required: boolean }[];
  /** Required by a ruleset but absent from the PR's rollup. */
  missingRequired: string[];
  /** False when the branch rules were not readable. */
  rulesReadable: boolean;
}

export interface ConditionDeps {
  /** Throws when GitHub cannot be read. */
  readPr(ghRepo: string, number: number): Promise<ConditionPr>;
  /** Null when there is no such incident; throws when the store fails. */
  incidentState(id: string): Promise<IncidentState | null>;
}

/** The condition view of a readiness verdict. */
export function conditionPrFromVerdict(v: PrMergeVerdict): ConditionPr {
  const { passing, failing, pending, skipped } = v.checks;
  return {
    state: v.state,
    headSha: v.pr.headSha,
    checks: [...passing, ...failing, ...pending, ...skipped].map((c) => ({
      name: c.name,
      outcome: c.outcome,
      required: c.required,
    })),
    missingRequired: v.checks.missingRequired,
    rulesReadable: v.rules.readable,
  };
}

/** Condition deps that read pull requests through `verdict`. */
export function conditionDepsWith(
  verdict: (target: PrReadinessTarget) => Promise<PrMergeVerdict>,
): ConditionDeps {
  return {
    async readPr(ghRepo, number) {
      // repoId only labels the verdict; the read itself goes by ghRepo.
      return conditionPrFromVerdict(
        await verdict({ repoId: ghRepo, ghRepo, number }),
      );
    },
    async incidentState(id) {
      const { getIncident } = await import("../incidents/incident-store");
      return (await getIncident(id))?.state ?? null;
    },
  };
}

export const defaultConditionDeps: ConditionDeps = conditionDepsWith(
  async (target) => {
    const { assessPrMergeReadiness, fetchPrReadinessSource } =
      await import("../pr-merge-readiness");
    // No condition reads `mergeable`, so skip the wait for GitHub to compute
    // it: a wake-time check stays one round trip.
    return assessPrMergeReadiness(
      await fetchPrReadinessSource(target, undefined, []),
    );
  },
);

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "failed";
}

function prName(c: { ghRepo: string; number: number }): string {
  return `PR #${c.number} in ${c.ghRepo}`;
}

function names(list: string[]): string {
  return list.join(", ");
}

/** The checks that must pass: the required ones when the branch rules are
 *  readable and name some, otherwise every check that ran. A check that ended
 *  skipped or neutral counts as satisfied, as GitHub treats it. */
function checksGreen(
  pr: ConditionPr,
  c: Extract<LeadCondition, { kind: "checks-green" }>,
): ConditionResult {
  if (!c.headSha)
    return {
      status: "not-met",
      reason: `No commit is pinned for ${prName(c)}`,
    };
  if (pr.state === "CLOSED")
    return { status: "not-met", reason: `${prName(c)} is closed` };
  if (pr.headSha !== c.headSha)
    return {
      status: "not-met",
      reason: `${prName(c)} has new commits since it was approved`,
    };
  // Required checks come only from rulesets. A repo on classic branch
  // protection (or with unreadable rules) names none here, so fall back to
  // the strict reading: every check that ran must pass.
  const byRule =
    pr.rulesReadable &&
    (pr.checks.some((k) => k.required) || pr.missingRequired.length > 0);
  const counted = byRule ? pr.checks.filter((k) => k.required) : pr.checks;
  const failing = counted.filter((k) => k.outcome === "failing");
  if (failing.length)
    return {
      status: "not-met",
      reason: `Checks failed on ${prName(c)}: ${names(failing.map((k) => k.name))}`,
    };
  const pending = [
    ...counted.filter((k) => k.outcome === "pending").map((k) => k.name),
    ...(byRule ? pr.missingRequired : []),
  ];
  if (pending.length)
    return {
      status: "not-met",
      reason: `Checks still running on ${prName(c)}: ${names(pending)}`,
    };
  if (!counted.length)
    return { status: "not-met", reason: `No checks have run on ${prName(c)}` };
  return { status: "met" };
}

/** Whether the condition holds now. Never throws. */
export async function checkCondition(
  condition: LeadCondition,
  deps: ConditionDeps = defaultConditionDeps,
): Promise<ConditionResult> {
  try {
    switch (condition.kind) {
      case "pr-merged": {
        const pr = await deps.readPr(condition.ghRepo, condition.number);
        if (pr.state === "MERGED") return { status: "met" };
        return {
          status: "not-met",
          reason:
            pr.state === "CLOSED"
              ? `${prName(condition)} was closed without merging`
              : `${prName(condition)} is not merged yet`,
        };
      }
      case "checks-green":
        return checksGreen(
          await deps.readPr(condition.ghRepo, condition.number),
          condition,
        );
      case "incident-resolved": {
        const state = await deps.incidentState(condition.id);
        if (state === "resolved") return { status: "met" };
        return {
          status: "not-met",
          reason:
            state === null
              ? `Incident ${condition.id} was not found`
              : state === "closed-without-action"
                ? `Incident ${condition.id} was closed without action`
                : `Incident ${condition.id} is still open`,
        };
      }
    }
  } catch (error) {
    return { status: "unknown", reason: errorText(error) };
  }
}

/** Fixed owner-facing copy for what the approval waits for. */
export function describeCondition(condition: LeadCondition): string {
  switch (condition.kind) {
    case "pr-merged":
      return `${prName(condition)} is merged`;
    case "checks-green":
      return `Checks pass on ${prName(condition)} at ${condition.headSha.slice(0, 7)}`;
    case "incident-resolved":
      return `Incident ${condition.id} is resolved`;
  }
}
