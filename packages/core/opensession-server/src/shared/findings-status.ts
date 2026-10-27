// A hypothesis's status and the claims block's rows, both read from the
// verifier's claim checks. Hypotheses cite report claims; the verifier
// checks claims only, so its report sets every status. Pure.
import { type ClaimRow, claimKey, type HypothesisStatus } from "./findings";
import type {
  AgentRun,
  ClaimCheck,
  IncidentResponse,
  InvestigatorReport,
  VerifierReport,
} from "./incident-response";

export interface RoundReportRuns {
  investigator?: { run: AgentRun; report: InvestigatorReport };
  verifier?: { run: AgentRun; report: VerifierReport };
}

/** Each run as it was in `round`. A run still in it starts at the
 *  send-back that moved it there; a run a send-back moved past it shows that
 *  round's report and times, so an earlier round keeps its claims. */
export function runsInRound(
  r: Pick<IncidentResponse, "agents"> | undefined,
  round: number,
): AgentRun[] {
  const out: AgentRun[] = [];
  for (const run of r?.agents ?? []) {
    const { pastRounds, roundStartedAt, ...rest } = run;
    if (run.round === round) {
      out.push(roundStartedAt ? { ...rest, startedAt: roundStartedAt } : rest);
      continue;
    }
    const past = pastRounds?.find((p) => p.round === round);
    if (!past) continue;
    const view: AgentRun = {
      ...rest,
      round,
      status: "done",
      startedAt: past.startedAt,
    };
    delete view.endedAt;
    delete view.report;
    if (past.endedAt) view.endedAt = past.endedAt;
    if (past.report) view.report = past.report;
    out.push(view);
  }
  return out;
}

/** Each role's newest attempt in `round` that has a report, with its run. */
export function roundReportRuns(
  r: Pick<IncidentResponse, "agents"> | undefined,
  round: number,
): RoundReportRuns {
  const out: RoundReportRuns = {};
  for (const run of runsInRound(r, round)) {
    const report = run.report;
    if (report?.role === "investigator" && run.role === "investigator") {
      if (!out.investigator || run.attempt >= out.investigator.run.attempt)
        out.investigator = { run, report };
    } else if (report?.role === "verifier" && run.role === "verifier") {
      if (!out.verifier || run.attempt >= out.verifier.run.attempt)
        out.verifier = { run, report };
    }
  }
  return out;
}

export interface RoundReports {
  investigator?: InvestigatorReport;
  verifier?: VerifierReport;
}

/** Each role's newest report in `round`. */
export function roundReports(
  r: Pick<IncidentResponse, "agents"> | undefined,
  round: number,
): RoundReports {
  const runs = roundReportRuns(r, round);
  const out: RoundReports = {};
  if (runs.investigator) out.investigator = runs.investigator.report;
  if (runs.verifier) out.verifier = runs.verifier.report;
  return out;
}

/** The verifier's checks by `claimKey`. The parser stores one check per
 *  claim; should two keys collide anyway, the first one wins. */
function checksByKey(verifier: VerifierReport): Map<string, ClaimCheck> {
  const byKey = new Map<string, ClaimCheck>();
  for (const c of verifier.claims) {
    const key = claimKey(c.text);
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return byKey;
}

/** No verifier report → unchecked; any cited claim refuted → refuted;
 *  every cited claim verified (at least one) → verified; otherwise,
 *  including no cited claims, can't tell. */
export function hypothesisStatus(
  claims: readonly string[],
  verifier: VerifierReport | undefined,
): HypothesisStatus {
  if (!verifier) return "unchecked";
  if (claims.length === 0) return "cant-tell";
  const byKey = checksByKey(verifier);
  const statuses = claims.map((claim) => byKey.get(claimKey(claim))?.status);
  if (statuses.includes("refuted")) return "refuted";
  return statuses.every((s) => s === "verified") ? "verified" : "cant-tell";
}

/** One row per investigator claim, in the report's order, with the
 *  verifier's check of it; unchecked when the verifier has none. */
export function claimRows(
  investigator: InvestigatorReport | undefined,
  verifier: VerifierReport | undefined,
): ClaimRow[] {
  if (!investigator) return [];
  const byKey = verifier
    ? checksByKey(verifier)
    : new Map<string, ClaimCheck>();
  return investigator.claims.map((claim) => {
    const found = byKey.get(claimKey(claim.text));
    const row: ClaimRow = {
      text: claim.text,
      status: found?.status ?? "unchecked",
    };
    if (found?.evidence) row.evidence = found.evidence;
    return row;
  });
}
