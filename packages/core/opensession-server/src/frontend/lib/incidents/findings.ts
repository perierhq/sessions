// The incident page's Findings section as data: which round's blocks show,
// in what order, how wide, with whose byline, plus the timeline's own
// anchors and where each block's "Show source" leads. Pure.
import {
  type ClaimRow,
  type FindingBlock,
  type FindingRef,
  FINDINGS_COPY,
  type FindingsSet,
  findingSetOf,
  type HypothesisStatus,
} from "../../../shared/findings";
import type {
  AgentRole,
  AgentRun,
  InvestigatorReport,
  IncidentResponse,
} from "../../../shared/incident-response";
import {
  type Incident,
  isTerminalIncidentState,
} from "../../../shared/incidents";
import { clockTime } from "../time";
import type { DetailTarget } from "./details";
import { httpUrl } from "./links";

export interface FindingItem {
  /** `${role}:${block.id}`; the automatic claims block is `auto:claims`. */
  key: string;
  role: AgentRole;
  block: FindingBlock;
  span: "full" | "half";
  byline: string;
  auto?: true;
  /** Hypothesis only. */
  status?: HypothesisStatus;
  /** Claims only. */
  claims?: ClaimRow[];
}

export interface FindingsPageView {
  round: number;
  /** The newer round under way while this one still shows, else null. */
  underWay: number | null;
  items: FindingItem[];
  /** Rounds before `round` with findings, oldest first. */
  earlierRounds: number[];
}

export interface TimelineRow {
  at: string;
  text: string;
  /** Added by the page (incident opened, proof, merge), not the agent. */
  anchor: boolean;
  ref?: FindingRef;
}

const ROLES: readonly AgentRole[] = ["investigator", "verifier"];

const hasBlocks = (s: FindingsSet | undefined): s is FindingsSet =>
  !!s && s.blocks.length > 0;

/** The round the page shows: the newest round the investigator has shown
 *  findings for (a set, even an empty one, so clearing goes back to Cause).
 *  Without any investigator set, the newest round with any set. */
function pageRound(sets: readonly FindingsSet[]): number | null {
  let investigator: number | null = null;
  let any: number | null = null;
  for (const s of sets) {
    if (any === null || s.round > any) any = s.round;
    if (
      s.role === "investigator" &&
      (investigator === null || s.round > investigator)
    )
      investigator = s.round;
  }
  return investigator ?? any;
}

/** The round's investigator run: the attempt behind its findings when
 *  there are some, else the newest attempt. */
function investigatorRun(
  response: IncidentResponse | undefined,
  round: number,
): AgentRun | undefined {
  const runs = (response?.agents ?? []).filter(
    (run) => run.role === "investigator" && run.round === round,
  );
  const attempt = findingSetOf(response, "investigator", round)?.attempt;
  return (
    runs.find((run) => run.attempt === attempt) ??
    runs.reduce<AgentRun | undefined>(
      (newest, run) => (!newest || run.attempt > newest.attempt ? run : newest),
      undefined,
    )
  );
}

/** The round's newest investigator report. */
function investigatorReport(
  response: IncidentResponse | undefined,
  round: number,
): { run: AgentRun; report: InvestigatorReport } | null {
  let best: { run: AgentRun; report: InvestigatorReport } | null = null;
  for (const run of response?.agents ?? []) {
    if (run.round !== round || run.report?.role !== "investigator") continue;
    if (!best || run.attempt >= best.run.attempt)
      best = { run, report: run.report };
  }
  return best;
}

/** Consecutive `half` blocks pair up; a `half` without a partner spans the
 *  full width, so the grid never leaves a hole. */
export function findingSpans(
  sizes: ReadonlyArray<"full" | "half">,
): Array<"full" | "half"> {
  const spans: Array<"full" | "half"> = [];
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i] === "half" && sizes[i + 1] === "half") {
      spans.push("half", "half");
      i++;
    } else spans.push("full");
  }
  return spans;
}

export function findingsPage(
  incident: Pick<Incident, "state" | "response">,
  opts: { round?: number } = {},
): FindingsPageView | null {
  const response = incident.response;
  const sets = response?.findingSets ?? [];
  const round = opts.round ?? pageRound(sets);
  if (round === null) return null;

  type Draft = Omit<FindingItem, "span">;
  const drafts: Draft[] = [];
  for (const role of ROLES) {
    const s = findingSetOf(response, role, round);
    if (!hasBlocks(s)) continue;
    const byline = FINDINGS_COPY.byline(role, clockTime(s.updatedAt));
    for (const block of s.blocks) {
      const item: Draft = { key: `${role}:${block.id}`, role, block, byline };
      if (block.kind === "hypothesis") item.status = "unchecked"; // D1 replaces this
      if (block.kind === "claims") item.claims = []; // D1 replaces this
      drafts.push(item);
    }
  }
  if (drafts.length === 0) return null;

  const report = investigatorReport(response, round);
  if (
    report &&
    report.report.claims.length > 0 &&
    !drafts.some((item) => item.block.kind === "claims")
  ) {
    const updatedAt =
      report.run.endedAt ??
      findingSetOf(response, "investigator", round)?.updatedAt ??
      report.run.turnSentAt;
    drafts.push({
      key: "auto:claims",
      role: "investigator",
      block: { id: "claims", kind: "claims", size: "full" },
      byline: FINDINGS_COPY.byline("investigator", clockTime(updatedAt)),
      auto: true,
      claims: [], // D1 replaces this
    });
  }

  const spans = findingSpans(drafts.map((item) => item.block.size));
  const items = drafts.map((item, i) => ({ ...item, span: spans[i]! }));

  const earlierRounds = [
    ...new Set(
      sets.filter((s) => s.round < round && hasBlocks(s)).map((s) => s.round),
    ),
  ].sort((a, b) => a - b);

  const current = response?.round ?? round;
  const underWay =
    opts.round === undefined &&
    current > round &&
    !isTerminalIncidentState(incident.state)
      ? current
      : null;

  return { round, underWay, items, earlierRounds };
}

const timeOf = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/** The agent's events with the incident's own moments for that round,
 *  sorted by time; on a tie the incident's moment comes first. */
export function timelineRows(
  block: Extract<FindingBlock, { kind: "timeline" }>,
  incident: Pick<Incident, "openedAt" | "response">,
  round: number,
): TimelineRow[] {
  const response = incident.response;
  const anchors: TimelineRow[] = [
    { at: incident.openedAt, text: "Incident opened", anchor: true },
  ];
  const started = investigatorRun(response, round)?.startedAt;
  if (started)
    anchors.push({ at: started, text: "Investigator started", anchor: true });
  if (response?.proof?.round === round)
    anchors.push({
      at: response.proof.at,
      text: "Proof measured",
      anchor: true,
    });
  // A merge has no round of its own: it belongs to the candidate's round.
  const mergeRound = response?.candidate?.round ?? response?.round;
  if (response?.merge?.status === "merged" && mergeRound === round)
    anchors.push({ at: response.merge.at, text: "Merged", anchor: true });

  const events = block.events.map((event) => {
    const row: TimelineRow = { at: event.at, text: event.text, anchor: false };
    if (event.ref) row.ref = event.ref;
    return row;
  });
  return [...anchors, ...events].sort((a, b) => timeOf(a.at) - timeOf(b.at));
}

/** Where a block's "Show source" leads: the agent session behind a tool
 *  call, the PR, the cost ledger. Null when the page has nothing to open
 *  (commit links come from the loaded commit). */
export function sourceTarget(
  ref: FindingRef,
  incident: Pick<Incident, "project" | "response">,
): DetailTarget | { kind: "ledger"; id: string } | null {
  switch (ref.type) {
    case "tool":
      return { kind: "session", sessionId: ref.sessionId };
    case "pr": {
      const target: DetailTarget = {
        kind: "pr",
        repo: incident.project,
        number: ref.number,
      };
      const url = httpUrl(ref.url);
      if (url) target.url = url;
      return target;
    }
    case "ledger":
      return { kind: "ledger", id: ref.id };
    default:
      return null;
  }
}
