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
  runsInRound,
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
import type { DotTone } from "./tone";
import { httpUrl } from "./links";

export interface FindingItem {
  /** `${role}:${block.id}`; the automatic claims block is `auto:claims`. */
  key: string;
  role: AgentRole;
  block: FindingBlock;
  span: "full" | "half";
  byline: string;
  /** Whether the block shows its byline: only when its role differs from
   *  the section's (`FindingsPageView.byline` says it once). */
  ownByline: boolean;
  auto?: true;
  /** Hypothesis only. */
  status?: HypothesisStatus;
  /** Claims only. */
  claims?: ClaimRow[];
}

export interface FindingsPageView {
  round: number;
  /** Who the section's blocks are from and when, said once under its
   *  heading: the first set's role and time. */
  byline: string;
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

/** The round's investigator run, as it was in that round: the attempt
 *  behind its findings when there are some, else the newest attempt. */
function investigatorRun(
  response: IncidentResponse | undefined,
  round: number,
): AgentRun | undefined {
  const runs = runsInRound(response, round).filter(
    (run) => run.role === "investigator",
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

const sentenceCase = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

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

/** Rounds before `round` with findings, oldest first. */
function roundsBefore(sets: readonly FindingsSet[], round: number): number[] {
  return [
    ...new Set(
      sets.filter((s) => s.round < round && hasBlocks(s)).map((s) => s.round),
    ),
  ].sort((a, b) => a - b);
}

/** The earlier rounds the details list, also when the page round has no
 *  blocks and the page shows Cause instead (`findingsPage` is null). */
export function earlierFindingRounds(
  incident: Pick<Incident, "response">,
): number[] {
  const sets = incident.response?.findingSets ?? [];
  const round = pageRound(sets);
  return round === null ? [] : roundsBefore(sets, round);
}

export function findingsPage(
  incident: Pick<Incident, "state" | "response">,
  opts: {
    round?: number;
    /** Leave the open questions out: the Next card shows them
     *  (`asksInNext`). */
    withoutAsks?: boolean;
  } = {},
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

  type Draft = Omit<FindingItem, "span" | "ownByline">;
  const drafts: Draft[] = [];
  for (const role of ROLES) {
    const s = findingSetOf(response, role, round);
    if (!hasBlocks(s)) continue;
    const byline = FINDINGS_COPY.byline(role, clockTime(s.updatedAt));
    for (const block of s.blocks) {
      if (opts.withoutAsks && block.kind === "question") continue;
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

  const lead = drafts[0]!.role;
  const leadSet = findingSetOf(response, lead, round);
  const byline = sentenceCase(
    FINDINGS_COPY.byline(lead, clockTime(leadSet?.updatedAt ?? "")),
  );
  const spans = findingSpans(drafts.map((item) => item.block.size));
  const items = drafts.map((item, i) => ({
    ...item,
    span: spans[i]!,
    ownByline: item.role !== lead,
  }));

  const earlierRounds = roundsBefore(sets, round);

  const current = response?.round ?? round;
  const underWay =
    opts.round === undefined &&
    current > round &&
    !isTerminalIncidentState(incident.state)
      ? current
      : null;

  return { round, byline, underWay, items, earlierRounds };
}

/** Whether the open questions show with the decision in the Next card:
 *  while the incident is open and has agents, so there is a card. A
 *  closed incident keeps them in its Findings. */
export function asksInNext(
  incident: Pick<Incident, "state" | "response">,
): boolean {
  return !!incident.response && !isTerminalIncidentState(incident.state);
}

/** An open question the Next card shows with the decision. */
export interface NextAsk {
  key: string;
  text: string;
  wouldAnswer: string;
}

/** The likely cause the Next card leads with: the page's first
 *  hypothesis in one sentence, with its status. */
export interface NextCause {
  key: string;
  statement: string;
  status: HypothesisStatus;
  confidence: Extract<FindingBlock, { kind: "hypothesis" }>["confidence"];
}

/** What the Next card shows of the findings, so the owner sees the cause
 *  while deciding: the page's first hypothesis, and the page round's open
 *  questions, the owner's asks among them (`asksInNext`). Null without
 *  findings. */
export interface NextFindings {
  cause: NextCause | null;
  asks: NextAsk[];
}

export const NEXT_FINDINGS_COPY = Object.freeze({
  cause: "Likely cause",
  seeFindings: "See findings",
  ask: "Open question",
  wouldAnswer: "What would answer it",
});

export function nextFindings(
  incident: Pick<Incident, "state" | "response">,
): NextFindings | null {
  const page = findingsPage(incident);
  if (!page) return null;
  let cause: NextCause | null = null;
  for (const item of page.items)
    if (item.block.kind === "hypothesis") {
      cause = {
        key: item.key,
        statement: item.block.statement,
        status: item.status ?? "unchecked",
        confidence: item.block.confidence,
      };
      break;
    }
  const asks: NextAsk[] = [];
  if (asksInNext(incident))
    for (const item of page.items)
      if (item.block.kind === "question")
        asks.push({
          key: item.key,
          text: item.block.text,
          wouldAnswer: item.block.wouldAnswer,
        });
  return { cause, asks };
}

const timeOf = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/** A start time older than a run of an earlier round: a session sent back
 *  before its rounds were kept, whose start is its first round's. */
function predatesRound(
  at: string,
  response: IncidentResponse | undefined,
  round: number,
): boolean {
  const ms = timeOf(at);
  for (let earlier = 1; earlier < round; earlier++)
    for (const run of runsInRound(response, earlier))
      if (timeOf(run.startedAt) > ms) return true;
  return false;
}

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
  if (started && !predatesRound(started, response, round))
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

/** An ISO 8601 date and time with a zone, as an agent may write one. */
const ISO_WITH_ZONE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w:])/g;

/** Agent prose with each ISO time that carries a zone written as the
 *  reader's clock time, the way every time from data on the page reads.
 *  Code spans stay as written; a time without a zone can't be placed. */
export function localizeTimes(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(ISO_WITH_ZONE, (iso) => clockTime(iso) || iso),
    )
    .join("");
}

/** Log lines stamped in UTC (an ISO time ending in Z, or "UTC"): quoted
 *  verbatim, so the block says which zone they are in. */
export function logTimesInUtc(lines: readonly string[]): boolean {
  return lines.some((line) =>
    /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b|\bUTC\b/.test(line),
  );
}

/** Said after a log's source when its lines are stamped in UTC. */
export const LOG_UTC_COPY = "times in UTC";

/** How findings prose renders (`renderMarkdown`): it sits under its
 *  block's own heading, so no headings and no embeds of its own. */
export const FINDINGS_MARKDOWN = Object.freeze({ plain: true });

/** Somewhere a block's "Show source" opens. */
export type FindingSource = DetailTarget | { kind: "ledger"; id: string };

/** The sheet the Findings section (or History) has open over the page:
 *  an earlier round's findings, or the agents' cost a ledger ref opens. */
export type FindingsSheetState =
  | { kind: "round"; round: number }
  | { kind: "cost" };

/** Where opening a block's source goes: a sheet over the page, or away
 *  to the session, the PR review or a link. Leaving closes the sheet. */
export function openFindingSource(
  target: FindingSource,
  to: {
    sheet: (next: FindingsSheetState | null) => void;
    session: (sessionId: string) => void;
    pr: (target: Extract<DetailTarget, { kind: "pr" }>) => void;
    url: (url: string) => void;
  },
): void {
  switch (target.kind) {
    case "ledger":
      to.sheet({ kind: "cost" });
      return;
    case "url":
      to.url(target.url);
      return;
    case "session":
      to.sheet(null);
      to.session(target.sessionId);
      return;
    case "pr":
      to.sheet(null);
      to.pr(target);
      return;
    default:
      return;
  }
}

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

/** How a block of a later round differs from the round before. */
export type RoundMark = "new" | "changed";

/** What a later round changed: its blocks marked new or changed against
 *  the newest earlier round with findings, and how many that round had
 *  that this one dropped. Blocks keep their ids across rounds (carried
 *  forward or kept), so the same key is the same block. */
export interface RoundChanges {
  round: number;
  previous: number;
  marks: Map<string, RoundMark>;
  changed: number;
  added: number;
  removed: number;
}

export function roundChanges(
  incident: Pick<Incident, "state" | "response">,
  opts: { round?: number } = {},
): RoundChanges | null {
  const page = findingsPage(incident, opts);
  const previous = page?.earlierRounds.at(-1);
  if (!page || previous === undefined) return null;
  const before = findingsPage(incident, { round: previous });
  if (!before) return null;
  const changed = changedKeys(before.items, page.items);
  const known = new Set(before.items.map((item) => item.key));
  const marks = new Map<string, RoundMark>();
  for (const item of page.items)
    if (!known.has(item.key)) marks.set(item.key, "new");
    else if (changed.has(item.key)) marks.set(item.key, "changed");
  const now = new Set(page.items.map((item) => item.key));
  let added = 0;
  for (const mark of marks.values()) if (mark === "new") added++;
  return {
    round: page.round,
    previous,
    marks,
    changed: marks.size - added,
    added,
    removed: before.items.filter((item) => !now.has(item.key)).length,
  };
}

/** "Round 2: 1 changed, 2 new", under the section's heading. */
export function roundChangesCopy(changes: RoundChanges): string {
  const parts = [
    changes.changed ? `${changes.changed} changed` : "",
    changes.added ? `${changes.added} new` : "",
    changes.removed ? `${changes.removed} removed` : "",
  ].filter(Boolean);
  return `Round ${changes.round}: ${parts.length ? parts.join(", ") : "nothing changed"}`;
}

/** A block's mark beside its heading. */
export function roundMarkCopy(mark: RoundMark, round: number): string {
  return mark === "new" ? `New in round ${round}` : `Changed in round ${round}`;
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

/** A hypothesis or claim status as a mark: the dot's tone beside the
 *  word (the Next card's eyebrow dot). */
export const STATUS_DOT: Record<HypothesisStatus, DotTone> = {
  verified: "green",
  refuted: "red",
  "cant-tell": "yellow",
  unchecked: "faint",
};

/** The agent's own rating, said after the status ("high confidence"). */
export const CONFIDENCE_WORD: Record<
  Extract<FindingBlock, { kind: "hypothesis" }>["confidence"],
  string
> = {
  low: "low confidence",
  medium: "medium confidence",
  high: "high confidence",
};

/** Where the Findings section is, for the Next card's "See findings". */
export const FINDINGS_SECTION_ID = "incident-findings";

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
