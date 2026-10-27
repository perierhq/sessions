// Wire types for an incident's generated findings: the blocks the incident
// agents compose for the incident page and the references that tie each
// block to data the server checked. Shared by the server and the frontend.
// Types, constant lists, copy and small pure helpers only.

import type { AgentRole, IncidentResponse } from "./incident-response";

export const FINDING_KINDS = [
  "hypothesis",
  "timeline",
  "signal",
  "log",
  "change",
  "claims",
  "compare",
  "question",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDINGS_LIMITS = {
  idMax: 40,
  title: 80,
  prose: 600,
  statement: 200,
  claims: 5,
  evidence: 10,
  timelineEvents: 30,
  eventText: 140,
  markers: 10,
  markerLabel: 40,
  logLines: 40,
  logLineChars: 500,
  sideLabel: 40,
  blocks: 12,
  windowMs: 31 * 86_400_000,
  setBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  inputBytes: 128 * 1024,
  callsPerSet: 60,
  sets: 12,
  notes: 20,
  quoteMinChars: 8,
  /** How much of one tool result a quote or `contains` is checked against:
   *  only the first 1 MB (UTF-8) is searched, and a cut is noted. */
  sourceBytes: 1024 * 1024,
} as const;

/** A block id: a lowercase slug of at most `FINDINGS_LIMITS.idMax` chars. */
export const FINDING_ID = new RegExp(
  `^[a-z0-9][a-z0-9-]{0,${FINDINGS_LIMITS.idMax - 1}}$`,
);

/** Where a quoted tool result came from. */
export type Provenance =
  | { kind: "host" | "fetch" | "connector" | "tool"; label: string }
  | { kind: "web" | "shell" | "workspace" };

/** A stored reference from a block to data the server resolved. */
export type FindingRef =
  | { type: "observation"; signal: string; lane?: string; at: string }
  | { type: "ledger" | "event" | "action"; id: string }
  | { type: "release"; at: string; ref?: string }
  | { type: "pr"; number: number; url: string; sessionId: string }
  | { type: "commit"; sha: string; repo: string }
  | {
      type: "tool";
      sessionId: string;
      useId: string;
      resultId: string;
      tool: string;
      at: string;
      provenance: Provenance;
    }
  | { type: "block"; id: string; role: AgentRole };
export type ToolRef = Extract<FindingRef, { type: "tool" }>;

export interface SignalWindow {
  signalId: string;
  lane?: string;
  from: string;
  to: string;
}

export interface LogExcerptOf<T> {
  source: T;
  lines: string[];
  highlight: number[];
  dropped: number;
}
export type LogExcerpt = LogExcerptOf<ToolRef>;

interface BlockBase {
  id: string;
  title?: string;
  size: "full" | "half";
}

/** Generic over the ref types so A1's unresolved drafts share the shape:
 *  R = any ref, T = a tool ref. */
export type FindingBlockOf<R extends { type: string }, T> = BlockBase &
  (
    | {
        kind: "hypothesis";
        statement: string;
        confidence: "low" | "medium" | "high";
        evidence: R[];
        claims: string[];
      }
    | { kind: "timeline"; events: Array<{ at: string; text: string; ref?: R }> }
    | ({
        kind: "signal";
        markers: Array<{ at: string; label: string }>;
      } & SignalWindow)
    | ({ kind: "log" } & LogExcerptOf<T>)
    | {
        kind: "change";
        change: Extract<R, { type: "pr" | "commit" }>;
        why: string;
      }
    | { kind: "claims" }
    | { kind: "compare"; sides: [CompareSideOf<T>, CompareSideOf<T>] }
    | { kind: "question"; text: string; wouldAnswer: string }
  );
export type CompareSideOf<T> = { label: string } & (
  | { signal: SignalWindow }
  | { log: LogExcerptOf<T> }
);
export type FindingBlock = FindingBlockOf<FindingRef, ToolRef>;
export type CompareSide = CompareSideOf<ToolRef>;

/** One agent's findings for one round. */
export interface FindingsSet {
  role: AgentRole;
  round: number;
  attempt: number;
  sessionId: string;
  source: "tool" | "report";
  updatedAt: string;
  calls: number;
  blocks: FindingBlock[];
  notes: string[];
}

export type HypothesisStatus =
  | "verified"
  | "refuted"
  | "cant-tell"
  | "unchecked";

export interface ClaimRow {
  text: string;
  status: "verified" | "refuted" | "unverifiable" | "unchecked";
  evidence?: string;
}

/** A claim's text for matching the verifier's quote to the listed claim:
 *  case, curly quotes, spacing and a closing full stop do not matter. */
export function claimKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
}

/** The set `role` stored for `round`. */
export function findingSetOf(
  r: Pick<IncidentResponse, "findingSets"> | undefined,
  role: AgentRole,
  round: number,
): FindingsSet | undefined {
  return r?.findingSets?.find((s) => s.role === role && s.round === round);
}

/** The newest set of `role` from a round before `round`. */
export function previousFindingSet(
  r: Pick<IncidentResponse, "findingSets"> | undefined,
  role: AgentRole,
  round: number,
): FindingsSet | undefined {
  let best: FindingsSet | undefined;
  for (const s of r?.findingSets ?? []) {
    if (s.role !== role || s.round >= round) continue;
    if (!best || s.round > best.round) best = s;
  }
  return best;
}

/** The source line under a quoted block. Quiet when the agent could have
 *  produced the output itself (its shell, its workspace, a plain tool). */
export function provenanceLabel(p: Provenance): {
  text: string;
  quiet: boolean;
} {
  switch (p.kind) {
    case "web":
      return { text: "from the web", quiet: false };
    case "shell":
      return { text: "from the agent's shell", quiet: true };
    case "workspace":
      return { text: "from the agent's workspace", quiet: true };
    case "tool":
      return { text: `from ${p.label}`, quiet: true };
    case "host":
    case "fetch":
    case "connector":
      return { text: `from ${p.label}`, quiet: false };
  }
}

export function droppedLinesCopy(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"} couldn't be found in the source`;
}

export const FINDINGS_COPY: Readonly<{
  heading: "Findings";
  showSource: "Show source";
  underWay: (round: number) => string;
  byline: (role: AgentRole, clock: string) => string;
  earlierRow: (round: number) => string;
  status: Readonly<Record<HypothesisStatus, string>>;
}> = Object.freeze({
  heading: "Findings",
  showSource: "Show source",
  underWay: (round: number) => `Round ${round} under way`,
  byline: (role: AgentRole, clock: string) => `from the ${role}, ${clock}`,
  earlierRow: (round: number) => `Round ${round} findings`,
  status: Object.freeze({
    verified: "Verified",
    refuted: "Refuted",
    "cant-tell": "Can't tell",
    unchecked: "Not checked yet",
  }),
});
