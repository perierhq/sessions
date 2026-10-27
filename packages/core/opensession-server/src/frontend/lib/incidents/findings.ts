// The incident page's Findings section as data: which round's blocks show,
// in what order, how wide, with whose byline, plus the timeline's own
// anchors and where each block's "Show source" leads. Pure.
import {
  type ClaimRow,
  type FindingBlock,
  type FindingKind,
  type FindingRef,
  FINDINGS_COPY,
  type FindingsSet,
  findingSetOf,
  type HypothesisStatus,
} from "../../../shared/findings";
import {
  claimRows,
  hypothesisStatus,
  roundReportRuns,
} from "../../../shared/findings-status";
import type {
  AgentRole,
  AgentRun,
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

  // Statuses and claim rows come from this round's reports, so an earlier
  // round's page keeps the checks it had.
  const reports = roundReportRuns(response, round);
  const verifier = reports.verifier?.report;
  const rows = () => claimRows(reports.investigator?.report, verifier);

  type Draft = Omit<FindingItem, "span">;
  const drafts: Draft[] = [];
  for (const role of ROLES) {
    const s = findingSetOf(response, role, round);
    if (!hasBlocks(s)) continue;
    const byline = FINDINGS_COPY.byline(role, clockTime(s.updatedAt));
    for (const block of s.blocks) {
      const item: Draft = { key: `${role}:${block.id}`, role, block, byline };
      if (block.kind === "hypothesis")
        item.status = hypothesisStatus(block.claims, verifier);
      if (block.kind === "claims") item.claims = rows();
      drafts.push(item);
    }
  }
  if (drafts.length === 0) return null;

  const report = reports.investigator;
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
      claims: rows(),
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

/** Somewhere a block's "Show source" opens. */
export type FindingSource = DetailTarget | { kind: "ledger"; id: string };

/** How long a block whose content changed keeps its tint, in ms. */
export const FINDINGS_HIGHLIGHT_MS = 1200;

/** Where a block's "Show source" leads: the agent session behind a tool
 *  call, the PR, the cost ledger. Null when the page has nothing to open
 *  (commit links come from the loaded commit). */
export function sourceTarget(
  ref: FindingRef,
  incident: Pick<Incident, "project" | "response">,
): FindingSource | null {
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

/** What a block's content is, for telling a changed block from one the
 *  agent only sent again: the block itself and what the page derived for it
 *  (status, claim rows), not the byline, whose time moves on every call. */
const contentOf = (item: FindingItem) =>
  JSON.stringify([item.block, item.status ?? null, item.claims ?? null]);

/** The keys of blocks on both pages whose content changed. A block that is
 *  new, or only re-sent unchanged, is not in the set; without a previous
 *  page nothing is. */
export function changedKeys(
  prev: readonly FindingItem[] | null,
  next: readonly FindingItem[],
): Set<string> {
  const changed = new Set<string>();
  if (!prev) return changed;
  const before = new Map(prev.map((item) => [item.key, contentOf(item)]));
  for (const item of next) {
    const was = before.get(item.key);
    if (was !== undefined && was !== contentOf(item)) changed.add(item.key);
  }
  return changed;
}

/** Ref types the page has somewhere to open (`sourceTarget`). */
const OPENS: ReadonlySet<FindingRef["type"]> = new Set([
  "tool",
  "pr",
  "ledger",
]);

/** The data behind a block's "Show source": the quoted call of a log (or
 *  of a compare's first log side), a change's PR, a hypothesis's first
 *  evidence that opens. Null when nothing opens (signals, questions,
 *  timelines, claims, commits). */
export function itemSource(item: FindingItem): FindingRef | null {
  const block = item.block;
  switch (block.kind) {
    case "log":
      return block.source;
    case "change":
      return block.change.type === "pr" ? block.change : null;
    case "hypothesis":
      return block.evidence.find((ref) => OPENS.has(ref.type)) ?? null;
    case "compare":
      for (const side of block.sides) if ("log" in side) return side.log.source;
      return null;
    default:
      return null;
  }
}

/** A block's heading when the agent gave it no title. */
export const BLOCK_TITLES: Record<FindingKind, string> = {
  hypothesis: "Hypothesis",
  timeline: "Timeline",
  signal: "Signal",
  log: "Log",
  change: "Change",
  claims: "Claims",
  compare: "Compare",
  question: "Open question",
};

export const CONFIDENCE_COPY: Record<
  Extract<FindingBlock, { kind: "hypothesis" }>["confidence"],
  string
> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

/** A claim row's status in words; "unverifiable" reads as the hypothesis
 *  status does. */
export const CLAIM_STATUS_COPY: Record<ClaimRow["status"], string> = {
  verified: FINDINGS_COPY.status.verified,
  refuted: FINDINGS_COPY.status.refuted,
  unverifiable: FINDINGS_COPY.status["cant-tell"],
  unchecked: FINDINGS_COPY.status.unchecked,
};
