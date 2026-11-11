// What an owner's approval can wait for before the lead applies it: a pull
// request merged, a pull request's checks green at a pinned head, or an
// incident resolved. Each check reads the live state through injected deps
// (GitHub as the App, the incident store); a read that fails is unknown,
// never met, so an approval only becomes ready on a positive answer.
import type { IncidentState } from "../../shared/incidents";
import type { PrCheckOutcome } from "../pr-merge-readiness";

export type LeadCondition =
  | { kind: "pr-merged"; ghRepo: string; number: number }
  | { kind: "checks-green"; ghRepo: string; number: number; headSha: string }
  | { kind: "incident-resolved"; id: string };

export type ConditionResult =
  | { met: true }
  | { met: false; reason: string }
  | { unknown: string };

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

export const defaultConditionDeps: ConditionDeps = {
  async readPr(ghRepo, number) {
    const { githubForceMergeApi } = await import("../force-merge");
    // repoId only labels the verdict; the read itself goes by ghRepo.
    const v = await githubForceMergeApi.verdict({
      repoId: ghRepo,
      ghRepo,
      number,
    });
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
  },
  async incidentState(id) {
    const { getIncident } = await import("../incidents/incident-store");
    return (await getIncident(id))?.state ?? null;
  },
};

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
 *  readable and name some, otherwise every check that ran (skipped ones
 *  aside), since nothing tells which of them matter. */
function checksGreen(
  pr: ConditionPr,
  c: Extract<LeadCondition, { kind: "checks-green" }>,
): ConditionResult {
  if (pr.state === "CLOSED")
    return { met: false, reason: `${prName(c)} is closed` };
  if (pr.headSha !== c.headSha)
    return {
      met: false,
      reason: `${prName(c)} has new commits since it was approved`,
    };
  const byRule =
    pr.rulesReadable &&
    (pr.checks.some((k) => k.required) || pr.missingRequired.length > 0);
  const counted = byRule
    ? pr.checks.filter((k) => k.required)
    : pr.checks.filter((k) => k.outcome !== "skipped");
  const failing = counted.filter((k) => k.outcome === "failing");
  if (failing.length)
    return {
      met: false,
      reason: `Checks failed on ${prName(c)}: ${names(failing.map((k) => k.name))}`,
    };
  const pending = [
    ...counted.filter((k) => k.outcome === "pending").map((k) => k.name),
    ...(byRule ? pr.missingRequired : []),
  ];
  if (pending.length)
    return {
      met: false,
      reason: `Checks still running on ${prName(c)}: ${names(pending)}`,
    };
  if (!counted.some((k) => k.outcome === "passing"))
    return { met: false, reason: `No checks have passed on ${prName(c)}` };
  return { met: true };
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
        if (pr.state === "MERGED") return { met: true };
        return {
          met: false,
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
        if (state === "resolved") return { met: true };
        return {
          met: false,
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
    return { unknown: errorText(error) };
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
