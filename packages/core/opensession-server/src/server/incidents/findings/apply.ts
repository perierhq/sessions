// One `show_findings` call (or a final report's `findings` key) from load to
// saved set: the calling run is found on the fresh incident by its session
// and role, the blocks are checked for shape (validate.ts), every reference
// is resolved (refs.ts for data, tool-calls.ts for the caller's own tool
// calls), quoted log lines are checked against the full tool result, and
// the set is saved through the per-session queue (store.ts). The reply text
// tells the agent what was saved and what was left off, so it can fix it and
// call again. Kept blocks (`keep: true`) are stored blocks and are not
// resolved again. All I/O goes through `ApplyDeps`; the default deps are
// built on first use, never at import.

import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import {
  FINDINGS_LIMITS,
  type FindingBlock,
  type FindingRef,
  type FindingsSet,
  type CompareSide,
  type LogExcerpt,
  type Provenance,
  type ToolRef,
  claimKey,
  droppedLinesCopy,
  findingSetOf,
  previousFindingSet,
} from "../../../shared/findings";
import type { AgentRole, AgentRun } from "../../../shared/incident-response";
import type { Incident } from "../../../shared/incidents";
import { AGENT_AUDIT_TAIL } from "../response/agent-audit";
import {
  type RefDeps,
  type RefScope,
  checkWindow,
  createRefMemo,
  resolveRef,
  shown,
} from "./refs";
import { saveFindingSet, withSessionQueue } from "./store";
import {
  type MatchCache,
  type PreparedQuotes,
  checkQuotes,
  matchToolCall,
  prepareQuotes,
  provenanceOf,
} from "./tool-calls";
import {
  type FindingBlockDraft,
  type RefInput,
  type ToolRefInput,
  validateFindings,
} from "./validate";

export interface ApplyDeps extends Omit<RefDeps, "nowMs"> {
  getIncident: (id: string) => Promise<Incident | null>;
  transcriptTail: (sessionId: string, n: number) => Promise<TranscriptEntry[]>;
  fullEntry: (
    sessionId: string,
    entryId: string,
  ) => Promise<TranscriptEntry | null>;
  /** The project's GitHub repo, `owner/name`; PR refs resolve only there. */
  ghRepoOf: (project: string) => string | undefined;
  save: typeof saveFindingSet;
  now: () => number;
}

export interface ApplyRequest {
  incidentId: string;
  role: AgentRole;
  sessionId: string;
  input: unknown;
  source: "tool" | "report";
  /** Report findings: saved only when this run has no tool set for the round. */
  onlyIfNoToolSet?: boolean;
  /** Claim texts a hypothesis may cite; defaults to the run's report claims,
   *  or the candidate's for the verifier. */
  claims?: string[];
}

export interface ApplyResult {
  saved: boolean;
  blocks: number;
  notes: string[];
  text: string;
}

/** Distinct tool-call refs (tool, nth, contains) one call may look up. */
export const TOOL_REFS_PER_CALL = 12;
/** Distinct full tool results one call may read. Every read comes from a
 *  distinct tool ref, so this only guards against a future caller that
 *  reads more per ref. */
export const RESULT_READS_PER_CALL = 12;

const TOO_BIG = `The findings are over ${FINDINGS_LIMITS.inputBytes / 1024} KB; nothing saved. Send fewer or shorter blocks.`;
const UNREADABLE = 'Send {"blocks": [...]}.';
const NO_TAIL = "your session's transcript couldn't be read right now.";

type Note = (message: string) => void;
/** A cited result as quotes are checked: its cleaned output and where it
 *  came from, or the note when it couldn't be read. */
type Source = { quotes: PreparedQuotes; provenance: Provenance } | string;
type Draft<K extends FindingBlock["kind"]> = Extract<
  FindingBlockDraft,
  { kind: K }
>;
/** A draft whose refs pass 2 resolves (block refs need pass 1's survivors). */
type Pending = Draft<"hypothesis"> | Draft<"timeline">;
/** After pass 1: a finished block, one waiting for pass 2, or dropped. */
type Stage = { block: FindingBlock } | { pending: Pending } | null;

function refusal(text: string): ApplyResult {
  return { saved: false, blocks: 0, notes: [], text };
}

function inputBytes(input: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(input) ?? "");
  } catch {
    return Number.NaN;
  }
}

/** The refusal for an input that is unreadable or too big, else null. */
function inputRefusal(input: unknown): ApplyResult | null {
  const bytes = inputBytes(input);
  if (Number.isNaN(bytes)) return refusal(UNREADABLE);
  if (bytes > FINDINGS_LIMITS.inputBytes) return refusal(TOO_BIG);
  return null;
}

/**
 * Validates, resolves and saves one call's findings for the run that owns
 * `sessionId` in `role`. Calls from one session apply in the order they
 * were made: the call joins the session's queue before its first await.
 */
export function applyFindings(
  req: ApplyRequest,
  deps?: ApplyDeps,
): Promise<ApplyResult> {
  const refused = inputRefusal(req.input);
  if (refused) return Promise.resolve(refused);
  return withSessionQueue(req.sessionId, () => applyFindingsNow(req, deps));
}

/**
 * {@link applyFindings} without the session queue, for a caller that already
 * holds the session's place in it (`withSessionQueue`), like show_findings,
 * which checks the agent's access inside its turn.
 */
export async function applyFindingsNow(
  req: ApplyRequest,
  deps?: ApplyDeps,
): Promise<ApplyResult> {
  const refused = inputRefusal(req.input);
  if (refused) return refused;
  return applyInOrder(req, deps ?? (await defaultApplyDeps()));
}

/** The newest run of `sessionId` in `role`. */
function runOf(
  incident: Incident,
  sessionId: string,
  role: AgentRole,
): AgentRun | undefined {
  let best: AgentRun | undefined;
  for (const run of incident.response?.agents ?? []) {
    if (run.sessionId !== sessionId || run.role !== role) continue;
    if (
      !best ||
      run.round > best.round ||
      (run.round === best.round && run.attempt >= best.attempt)
    )
      best = run;
  }
  return best;
}

function defaultClaims(incident: Incident, run: AgentRun): string[] {
  if (run.role === "investigator")
    return run.report?.role === "investigator"
      ? run.report.claims.map((c) => c.text)
      : [];
  return (incident.response?.candidate?.claims ?? []).map((c) => c.text);
}

async function applyInOrder(
  req: ApplyRequest,
  d: ApplyDeps,
): Promise<ApplyResult> {
  const incident = await d.getIncident(req.incidentId);
  if (!incident) return refusal(`No incident ${req.incidentId}.`);
  const run = runOf(incident, req.sessionId, req.role);
  if (!run)
    return refusal(
      `This session is not an agent of incident ${req.incidentId}.`,
    );
  if (run.status === "cancelled" || run.supersededBy !== undefined)
    return refusal(
      `This session no longer works on incident ${req.incidentId}.`,
    );
  const response = incident.response;
  const current = findingSetOf(response, req.role, run.round);
  if (
    req.onlyIfNoToolSet &&
    current?.source === "tool" &&
    current.attempt >= run.attempt
  )
    return refusal("");

  const keepFrom = new Map<string, FindingBlock>();
  const previous = previousFindingSet(response, req.role, run.round);
  for (const block of previous?.blocks ?? []) keepFrom.set(block.id, block);
  for (const block of current?.blocks ?? []) keepFrom.set(block.id, block);
  const nowMs = d.now();
  const validated = validateFindings(req.input, { keepFrom, nowMs });

  const resolver = new Resolver(incident, run, req, d, nowMs);
  const resolved = await resolver.resolve(validated.blocks);
  const notes = [...validated.notes, ...resolved.notes];

  if (!validated.cleared && resolved.blocks.length === 0)
    return {
      saved: false,
      blocks: 0,
      notes,
      text: ["Nothing saved: no block was valid.", ...notesText(notes)].join(
        "\n",
      ),
    };

  const next: FindingsSet = {
    role: req.role,
    round: run.round,
    attempt: run.attempt,
    sessionId: req.sessionId,
    source: req.source,
    updatedAt: new Date(nowMs).toISOString(),
    calls: 0,
    blocks: resolved.blocks,
    notes,
  };
  const result = await d.save(req.incidentId, next);
  if (!result.saved)
    return {
      saved: false,
      blocks: 0,
      notes: [...notes, ...result.notes],
      text: result.notes.join("\n"),
    };
  const all = [...notes, ...result.notes];
  const count = result.saved.blocks.length;
  const head =
    count === 0
      ? `Cleared your findings for round ${run.round}.`
      : count === 1
        ? `Saved 1 block for round ${run.round}. It is on the incident page now.`
        : `Saved ${count} blocks for round ${run.round}. They are on the incident page now.`;
  return {
    saved: true,
    blocks: count,
    notes: all,
    text: [head, ...notesText(all)].join("\n"),
  };
}

function notesText(notes: readonly string[]): string[] {
  return notes.length === 0
    ? ["No notes."]
    : ["Notes:", ...notes.map((n) => `- ${n}`)];
}

/** Resolves one call's drafts against the incident and the caller's
 *  transcript; each block's notes are kept in block order. */
class Resolver {
  private readonly scope: RefScope;
  private readonly refDeps: RefDeps;
  private tail: Promise<TranscriptEntry[] | null> | undefined;
  private readonly claims: ReadonlySet<string>;
  /** This call's tool-call lookups, by (tool, nth, contains). */
  private readonly toolRefs = new Map<string, Promise<ToolRef | string>>();
  /** The tail results' cleaned text, shared by those lookups. */
  private readonly matchCache: MatchCache = new Map();
  /** This call's full-result reads, by result id. */
  private readonly sources = new Map<string, Promise<Source>>();

  constructor(
    incident: Incident,
    run: AgentRun,
    private readonly req: ApplyRequest,
    private readonly d: ApplyDeps,
    nowMs: number,
  ) {
    let ghRepo: string | undefined;
    try {
      ghRepo = d.ghRepoOf(incident.project);
    } catch {
      ghRepo = undefined;
    }
    const investigator =
      req.role === "verifier"
        ? findingSetOf(incident.response, "investigator", run.round)
        : undefined;
    this.scope = {
      incident,
      role: req.role,
      ownIds: new Set(),
      investigatorIds: new Set(investigator?.blocks.map((b) => b.id) ?? []),
      ghRepo,
      memo: createRefMemo(),
    };
    this.refDeps = { ...d, nowMs };
    this.claims = new Set(
      (req.claims ?? defaultClaims(incident, run)).map(claimKey),
    );
  }

  async resolve(
    drafts: ReturnType<typeof validateFindings>["blocks"],
  ): Promise<{ blocks: FindingBlock[]; notes: string[] }> {
    const notes = drafts.map((): string[] => []);
    const noteFor =
      (i: number, id: string): Note =>
      (m) =>
        notes[i]?.push(`Block \`${id}\`: ${m}`);
    // Pass 1: the blocks whose data may be missing (change, log, signal,
    // compare); they carry no block refs.
    const first = await Promise.all(
      drafts.map((draft, i): Promise<Stage> =>
        draft.kept
          ? Promise.resolve({ block: draft.block })
          : this.resolveData(draft.block, noteFor(i, draft.block.id)),
      ),
    );
    const ids = new Set<string>();
    for (const stage of first)
      if (stage) ids.add("block" in stage ? stage.block.id : stage.pending.id);
    // Pass 2: hypothesis and timeline refs, block refs against the blocks
    // that survived pass 1.
    const scope: RefScope = { ...this.scope, ownIds: ids };
    const blocks = await Promise.all(
      first.map((stage, i) => {
        if (!stage) return Promise.resolve(null);
        if ("block" in stage) return Promise.resolve(stage.block);
        return this.resolveRefs(
          stage.pending,
          scope,
          noteFor(i, stage.pending.id),
        );
      }),
    );
    return {
      blocks: blocks.filter((b): b is FindingBlock => b !== null),
      notes: notes.flat(),
    };
  }

  /** Change, log, signal and compare: their data or the block is dropped.
   *  Hypothesis and timeline wait for pass 2. */
  private async resolveData(
    draft: FindingBlockDraft,
    note: Note,
  ): Promise<Stage> {
    switch (draft.kind) {
      case "change": {
        const ref = await resolveRef(draft.change, this.scope, this.refDeps);
        if (typeof ref === "string") return (note(ref), null);
        if (ref.type !== "pr" && ref.type !== "commit") return null;
        return { block: { ...draft, change: ref } };
      }
      case "signal": {
        const ok = await checkWindow(draft, this.scope, this.refDeps);
        if (ok !== true) return (note(ok), null);
        return { block: draft };
      }
      case "log": {
        const excerpt = await this.excerpt(draft, note);
        if (!excerpt) return null;
        return { block: { ...draft, ...excerpt } };
      }
      case "compare": {
        const sides: Array<
          Extract<FindingBlock, { kind: "compare" }>["sides"][number]
        > = [];
        for (const [i, side] of draft.sides.entries()) {
          const sideNote: Note = (m) => note(`side ${i + 1}: ${m}`);
          if ("signal" in side) {
            const ok = await checkWindow(side.signal, this.scope, this.refDeps);
            if (ok !== true) return (sideNote(ok), null);
            sides.push({ label: side.label, signal: side.signal });
          } else {
            const log = await this.excerpt(side.log, sideNote);
            if (!log) return null;
            sides.push({ label: side.label, log });
          }
        }
        const [before, after] = sides;
        if (!before || !after) return null;
        return { block: { ...draft, sides: [before, after] } };
      }
      case "hypothesis":
      case "timeline":
        return { pending: draft };
      case "claims":
      case "question":
        return { block: draft };
    }
  }

  /** Hypothesis evidence and timeline refs; a ref that fails is left off
   *  with a note, the block stays. Hypothesis claims are matched to the
   *  report's. */
  private async resolveRefs(
    draft: Pending,
    scope: RefScope,
    note: Note,
  ): Promise<FindingBlock> {
    switch (draft.kind) {
      case "hypothesis": {
        const evidence: FindingRef[] = [];
        const refs = await Promise.all(
          draft.evidence.map((r) => this.ref(r, scope)),
        );
        refs.forEach((ref, i) => {
          if (typeof ref === "string")
            note(`evidence ${i + 1} left off: ${ref}`);
          else evidence.push(ref);
        });
        return { ...draft, evidence, claims: this.matchClaims(draft, note) };
      }
      case "timeline": {
        const events = await Promise.all(
          draft.events.map(async (event, i) => {
            if (!event.ref) return { at: event.at, text: event.text };
            const ref = await this.ref(event.ref, scope);
            if (typeof ref !== "string") return { ...event, ref };
            note(`event ${i + 1} reference left off: ${ref}`);
            return { at: event.at, text: event.text };
          }),
        );
        return { ...draft, events };
      }
    }
  }

  private matchClaims(draft: Draft<"hypothesis">, note: Note): string[] {
    if (this.claims.size === 0 || draft.claims.length === 0)
      return draft.claims;
    const kept = draft.claims.filter((c) => this.claims.has(claimKey(c)));
    if (kept.length === 0) {
      note("none of its claims are in the report.");
      return [];
    }
    for (const claim of draft.claims)
      if (!kept.includes(claim))
        note(`claim ${JSON.stringify(claim)} isn't in the report; left off.`);
    return kept;
  }

  private ref(ref: RefInput, scope: RefScope): Promise<FindingRef | string> {
    return ref.type === "tool"
      ? this.toolRef(ref)
      : resolveRef(ref, scope, this.refDeps);
  }

  private loadTail(): Promise<TranscriptEntry[] | null> {
    this.tail ??= this.d
      .transcriptTail(this.req.sessionId, AGENT_AUDIT_TAIL)
      .catch(() => null);
    return this.tail;
  }

  /** The call a tool ref cites, looked up once per (tool, nth, contains);
   *  at most {@link TOOL_REFS_PER_CALL} distinct refs per call. */
  private toolRef(ref: ToolRefInput): Promise<ToolRef | string> {
    const key = JSON.stringify([ref.tool, ref.nth, ref.contains ?? null]);
    const known = this.toolRefs.get(key);
    if (known) return known;
    if (this.toolRefs.size >= TOOL_REFS_PER_CALL)
      return Promise.resolve(
        `${shown(ref.tool)} call wasn't looked up: one call looks up at most ${TOOL_REFS_PER_CALL} tool calls.`,
      );
    const answer = this.loadTail().then((tail) =>
      tail
        ? matchToolCall(tail, this.req.sessionId, ref, {
            cache: this.matchCache,
          })
        : NO_TAIL,
    );
    this.toolRefs.set(key, answer);
    return answer;
  }

  /**
   * The cited call's full result, read once per result id (at most
   * {@link RESULT_READS_PER_CALL} per call) and held only as its cleaned
   * quotable lines. The whole entry is read: the transcript store has no
   * prefix read (`getFullEntry` parses the stored row), and an access
   * tool's answer is a JSON envelope that a prefix couldn't parse anyway;
   * `prepareQuotes` searches only its first `FINDINGS_LIMITS.sourceBytes`.
   */
  private source(ref: ToolRef): Promise<Source> {
    const known = this.sources.get(ref.resultId);
    if (known) return known;
    if (this.sources.size >= RESULT_READS_PER_CALL)
      return Promise.resolve(
        `the source's result wasn't read: one call reads at most ${RESULT_READS_PER_CALL} tool results.`,
      );
    const answer = (async (): Promise<Source> => {
      const entry = await this.d
        .fullEntry(this.req.sessionId, ref.resultId)
        .catch(() => null);
      if (!entry) return "the source's result couldn't be read.";
      const use = (await this.loadTail())?.find((e) => e.id === ref.useId);
      if (!use?.toolName) return "the source's call couldn't be read.";
      return {
        quotes: prepareQuotes({
          toolName: use.toolName,
          input: use.toolInput,
          content: entry.content,
        }),
        // The tail's copy of the result may be clamped; the full entry says
        // where the output really came from.
        provenance: provenanceOf(use.toolName, use.toolInput, entry),
      };
    })();
    this.sources.set(ref.resultId, answer);
    return answer;
  }

  /** The quoted lines that are in the cited call's full result; null after
   *  a note when the call, its result or every line is missing. */
  private async excerpt(
    draft: { source: ToolRefInput; lines: string[]; highlight: number[] },
    note: Note,
  ): Promise<LogExcerpt | null> {
    const source = await this.toolRef(draft.source);
    if (typeof source === "string") return (note(source), null);
    const full = await this.source(source);
    if (typeof full === "string") return (note(full), null);
    const checked = checkQuotes(full.quotes, draft.lines, draft.highlight);
    for (const n of checked.notes) note(n);
    if (checked.lines.length === 0)
      return (note("none of the lines are in the source; left off."), null);
    if (checked.dropped > 0) note(`${droppedLinesCopy(checked.dropped)}.`);
    return {
      source: { ...source, provenance: full.provenance },
      lines: checked.lines,
      highlight: checked.highlight,
      dropped: checked.dropped,
    };
  }
}

/** The live stores, imported on first use. */
async function defaultApplyDeps(): Promise<ApplyDeps> {
  const [
    { getIncident },
    { getSessionControl },
    { transcript },
    { lookupCommitIn },
    { hasObservation, nearestObservation },
    { getProjectSettings },
    { getRepo },
  ] = await Promise.all([
    import("../incident-store"),
    import("../../session-control"),
    import("../../actor-transcript"),
    import("../../commit-lookup"),
    import("../observation-store"),
    import("../response/project-settings"),
    import("../../worktree"),
  ]);
  return {
    getIncident,
    transcriptTail: (sessionId, n) =>
      getSessionControl().transcriptTail(sessionId, n),
    fullEntry: (sessionId, entryId) =>
      transcript.getFullEntry(sessionId, entryId),
    ghRepoOf: (project) => getRepo(project).ghRepo,
    lookupCommitIn,
    hasObservation,
    nearestObservation,
    releases: async (project) => (await getProjectSettings(project)).releases,
    save: saveFindingSet,
    now: Date.now,
  };
}
