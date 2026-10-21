// The cause an incident page shows: the newest investigator's one sentence,
// where it came from, and whether the verifier stood behind it. Pure.
import type {
  AgentRun,
  InvestigatorReport,
  IncidentResponse,
} from "../../../shared/incident-response";
import { httpUrl } from "./links";

export interface IncidentCauseView {
  text: string;
  source?: { label: string; url: string };
  status: "verified" | "doubted" | "unverified";
}

const LABEL_MAX = 40;

/** A link's short name: host without `www.` and the first two path
 *  segments, at most 40 characters. */
export function sourceLabel(url: string): string {
  let label = url;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    label = [parsed.hostname.replace(/^www\./, ""), ...path].join("/");
  } catch {
    // Not a URL: show it as written, shortened.
  }
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

type InvestigatorRun = AgentRun & { report: InvestigatorReport };

function isInvestigatorWithCause(run: AgentRun): run is InvestigatorRun {
  return (
    run.report?.role === "investigator" && run.report.cause.trim().length > 0
  );
}

export function causeOf(
  response: IncidentResponse | undefined,
): IncidentCauseView | null {
  let newest: InvestigatorRun | null = null;
  for (const run of response?.agents ?? [])
    if (isInvestigatorWithCause(run) && (!newest || run.round >= newest.round))
      newest = run;
  if (!newest) return null;

  const verdict = response?.verdict;
  const status =
    verdict?.round === newest.round
      ? verdict.verdict === "certain"
        ? "verified"
        : "doubted"
      : "unverified";
  const view: IncidentCauseView = {
    text: newest.report.cause.trim(),
    status,
  };
  for (const claim of newest.report.claims) {
    const url = httpUrl(claim.source);
    if (url) {
      view.source = { label: sourceLabel(url), url };
      break;
    }
  }
  return view;
}
