// The agents' own options for the owner's current decision: the options on
// a question block of the round's findings (validate.ts checked their
// shape), kept only where Sessions can do each one now. The card offers
// these instead of its own options when any are left; the ones left off
// are named in the ledger when the card is raised. Pure.
import {
  checkFindingSet,
  findingSetOf,
  type FindingsSet,
  type OwnerOption,
} from "../../../shared/findings";
import {
  type AgentOption,
  type AgentRole,
  type AgentRun,
  type IncidentProjectSettings,
  type IncidentResponse,
  type NeedsYouKind,
  OPTION_DECISION,
} from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { changeFacts } from "./facts";
import { parsePrUrl } from "./merge";

export interface AgentOptions {
  options: AgentOption[];
  /** The question the options answer. */
  question?: string;
  /** The session that offered them, which an Answer goes back to. */
  sessionId?: string;
  role?: AgentRole;
  /** Why options were left off, one line each. */
  dropped: string[];
}

const NONE: AgentOptions = { options: [], dropped: [] };

/** Cards that never take an agent's options: an agent waiting on its own
 *  question asks in its session, and a setup card has nothing to choose
 *  yet. */
const NO_OPTIONS: ReadonlySet<NeedsYouKind> = new Set(["question", "setup"]);

/** The round's set whose question offers options: the post-release
 *  check's, then the verifier's, then the investigator's. */
function offeringSet(r: IncidentResponse): FindingsSet | undefined {
  const sets = [
    checkFindingSet(r, r.round),
    findingSetOf(r, "verifier", r.round),
    findingSetOf(r, "investigator", r.round),
  ];
  return sets.find((s) =>
    s?.blocks.some((b) => b.kind === "question" && b.options?.length),
  );
}

function prNumberOf(r: IncidentResponse): number | undefined {
  const c = r.candidate;
  if (!c) return undefined;
  if (c.pr) return c.pr.number;
  const url = c.prUrl;
  return url ? (parsePrUrl(url)?.number ?? undefined) : undefined;
}

/**
 * Why Sessions can't merge the round's pull request for the owner now,
 * as a clause; undefined when it can: a fix with a pull request the
 * verifier reviewed (its head is what gets merged), still open, and no
 * failing check. A project without a deploy action is no reason: the merge
 * then waits for the release.
 */
export function mergeBlocked(
  r: IncidentResponse,
  settings: IncidentProjectSettings,
): string | undefined {
  const c = r.candidate;
  if (!c?.plan.pr || c.rollbackFirst)
    return "there is no pull request to merge";
  if (!r.verdict?.verifiedSha) return "the verifier hasn't reviewed its head";
  const pr = c.pr;
  const n = prNumberOf(r);
  const name = n === undefined ? "the pull request" : `PR #${n}`;
  if (pr?.state === "MERGED") return `${name} is already merged`;
  if (pr?.state === "CLOSED") return `${name} is closed`;
  if (pr?.actionsBlocked) return `GitHub Actions can't run on ${name}`;
  if (pr?.failingChecks.length) {
    const list = pr.failingChecks.slice(0, 3).join(", ");
    return `${pr.failingChecks.length === 1 ? "check" : "checks"} ${list} ${pr.failingChecks.length === 1 ? "fails" : "fail"} on ${name}`;
  }
  const facts = changeFacts({ plan: c.plan, settings, prFiles: [] });
  if ("error" in facts && !/^No deploy action/.test(facts.error))
    return facts.error.charAt(0).toLowerCase() + facts.error.slice(1);
  return undefined;
}

/** Whether the owner may release the round's pull request by hand and have
 *  Sessions watch after: a verified head on an open pull request. */
export function handReleaseOpen(r: IncidentResponse): boolean {
  const c = r.candidate;
  return (
    !!c?.plan.pr &&
    !c.rollbackFirst &&
    !!(c.prUrl ?? c.pr?.url) &&
    !!r.verdict?.verifiedSha &&
    c.pr?.state !== "MERGED" &&
    c.pr?.state !== "CLOSED"
  );
}

/** The run of the session that offered the options. */
function offeringRun(
  r: IncidentResponse,
  set: FindingsSet,
): AgentRun | undefined {
  return r.agents.findLast(
    (a) => a.sessionId === set.sessionId && a.round === set.round,
  );
}

/** Why `option` can't be done now, or undefined when it can. */
function blockedOption(
  option: OwnerOption,
  r: IncidentResponse,
  settings: IncidentProjectSettings,
  run: AgentRun | undefined,
): string | undefined {
  const n = prNumberOf(r);
  const otherPr =
    option.pr !== undefined && option.pr !== n
      ? `PR #${option.pr} isn't this round's fix`
      : undefined;
  switch (option.action) {
    case "merge":
      return otherPr ?? mergeBlocked(r, settings);
    case "release-watch":
      if (otherPr) return otherPr;
      return handReleaseOpen(r)
        ? undefined
        : "there is no reviewed, open pull request to release";
    case "send-back":
      return r.round < r.maxRounds ? undefined : "no round is left";
    case "answer":
      if (!run || run.supersededBy !== undefined)
        return "the agent that asked no longer works on this incident";
      if (run.status === "error" || run.status === "cancelled")
        return "the agent that asked has stopped";
      return undefined;
    case "close":
    case "mark-fixed":
      return undefined;
  }
}

/**
 * The agents' options for the incident's needs-you card, each one Sessions
 * can do now, the first marked recommended when it is the agent's first.
 * Empty (and the card shows its own options) when the incident isn't
 * waiting on its owner, the card's kind takes none, or nothing is left.
 */
export function agentOptionsFor(
  incident: Pick<Incident, "state" | "response">,
  settings: IncidentProjectSettings,
): AgentOptions {
  const r = incident.response;
  if (incident.state !== "needs-you" || !r?.needsYou) return NONE;
  if (NO_OPTIONS.has(r.needsYou.kind)) return NONE;
  const set = offeringSet(r);
  if (!set) return NONE;
  const block = set.blocks.find(
    (b) => b.kind === "question" && b.options?.length,
  );
  if (block?.kind !== "question" || !block.options) return NONE;
  const run = offeringRun(r, set);
  const role: AgentRole = set.role;
  const options: AgentOption[] = [];
  const dropped: string[] = [];
  block.options.forEach((option, i) => {
    const why = blockedOption(option, r, settings, run);
    if (why) {
      dropped.push(
        `Left off the ${set.check ? "post-release check" : role}'s option "${option.label}": ${why}`,
      );
      return;
    }
    options.push({
      ...option,
      decision: OPTION_DECISION[option.action],
      role,
      ...(i === 0 ? { recommended: true as const } : {}),
    });
  });
  return {
    options,
    question: block.text,
    sessionId: set.sessionId,
    role,
    dropped,
  };
}

/** Whether the card offers an agent option posting `action`. */
export function offersOption(
  incident: Pick<Incident, "state" | "response">,
  settings: IncidentProjectSettings,
  action: OwnerOption["action"],
): boolean {
  return agentOptionsFor(incident, settings).options.some(
    (o) => o.action === action,
  );
}
