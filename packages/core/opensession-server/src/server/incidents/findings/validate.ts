// Shape and limit checks for the findings an incident agent sends: the block
// list `show_findings` takes, or the `findings` key of its final report.
// Hand-written like the report parser (`response/reports.ts`), not zod, so
// every problem becomes a one-line note the agent can act on and one bad
// block never sinks the others. References are parsed here and resolved
// later (refs.ts, tool-calls.ts); nothing here reads the incident.

import {
  FINDING_ID,
  FINDING_KINDS,
  FINDINGS_LIMITS,
  type FindingBlock,
  type FindingBlockOf,
  type FindingKind,
  type LogExcerptOf,
  type SignalWindow,
} from "../../../shared/findings";
import { cleanReportText } from "../response/reports";

export const REF_TYPES = [
  "observation",
  "ledger",
  "event",
  "action",
  "release",
  "pr",
  "commit",
  "tool",
  "block",
] as const;

/** A reference as the agent wrote it, before the server resolves it. */
export type RefInput =
  | { type: "observation"; signal: string; lane?: string; at: string }
  | { type: "ledger" | "event" | "action"; id: string }
  | { type: "release"; at: string; ref?: string }
  | { type: "pr"; number: number }
  | { type: "commit"; sha: string }
  | { type: "tool"; tool: string; nth: number; contains?: string }
  | { type: "block"; id: string };
export type ToolRefInput = Extract<RefInput, { type: "tool" }>;

/** Unresolved: refs as written, `dropped: 0`. */
export type FindingBlockDraft = FindingBlockOf<RefInput, ToolRefInput>;

/** A block as the agent wrote it, checked for shape and limits; refs not
 *  resolved yet. Kept blocks are already stored blocks. */
export type DraftBlock =
  | { kept: true; block: FindingBlock }
  | { kept: false; block: FindingBlockDraft };

export interface ValidateContext {
  /** Stored blocks `keep` may copy, by id: this role's current set first,
   *  then its previous round's. */
  keepFrom: ReadonlyMap<string, FindingBlock>;
  nowMs: number;
}

const L = FINDINGS_LIMITS;
const SEND_BLOCKS = 'Send {"blocks": [...]}.';
const BAD_ID = "id must be lowercase letters, digits and dashes, at most 40.";
const BAD_COMMIT = "commit must be 7 to 40 hex characters.";
const BAD_SOURCE = 'source must be a {"type":"tool"} reference.';
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
/** A full ISO time with its zone: `Z` or `±hh:mm`. Without one, the time
 *  would be read in the server's own zone. */
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
/** Ids of ledger entries, events, signals and the like. */
const NAME_MAX = 200;
const CONTAINS_MAX = 500;
/** Notes returned per call; the rest are counted. */
export const NOTES_MAX = 40;
/** How much of an agent's value a note repeats. */
const ECHO_MAX = 40;

type Note = (message: string) => void;
type Body<K extends FindingKind> = Omit<
  Extract<FindingBlockDraft, { kind: K }>,
  "id" | "title" | "size"
>;
type AnyBody = { [K in FindingKind]: Body<K> }[FindingKind];

/** `value` as a list; an absent field is an empty one. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clean single-line or multiline text, trimmed; null when not text. */
function cleanText(value: unknown, multiline = false): string | null {
  return typeof value === "string"
    ? cleanReportText(value, multiline).trim()
    : null;
}

/** The first `max` UTF-16 units of `value`, one fewer when the cut would
 *  split a surrogate pair. */
function head(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** `value` cut to `max` characters with an ellipsis, without a note. */
function ellipsis(value: string, max: number): string {
  return value.length <= max ? value : `${head(value, max - 1).trimEnd()}…`;
}

/** `value` cut to `max` characters with an ellipsis; a cut is noted. */
function clip(value: string, max: number, what: string, note: Note): string {
  if (value.length <= max) return value;
  note(`${what} cut to ${max} characters.`);
  return ellipsis(value, max);
}

/** An agent's value as a note repeats it: JSON, cleaned, at most
 *  `ECHO_MAX` characters. */
function shown(value: unknown): string {
  if (typeof value === "string")
    return JSON.stringify(ellipsis(cleanReportText(value, false), ECHO_MAX));
  return ellipsis(String(JSON.stringify(value)), ECHO_MAX);
}

/** An ISO time with a zone, normalised to `toISOString`, or null. */
function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_TIME.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A non-empty name of at most `NAME_MAX` characters, or null. */
function name(value: unknown): string | null {
  const text = cleanText(value);
  return text && text.length <= NAME_MAX ? text : null;
}

function prNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function commitSha(value: unknown): string | null {
  return typeof value === "string" && COMMIT_SHA.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/** Items of `list` up to `max`; a cut is noted as `kept the first <max> <what>.` */
function capped<T>(list: T[], max: number, what: string, note: Note): T[] {
  if (list.length <= max) return list;
  note(`kept the first ${max} ${what}.`);
  return list.slice(0, max);
}

/** A reference as the agent wrote it, or a note saying what is wrong. */
export function parseRefInput(value: unknown): RefInput | string {
  if (!isRecord(value))
    return 'a reference must be an object like {"type": "tool", "tool": "Bash"}.';
  const type = value.type;
  switch (type) {
    case "observation": {
      const signal = name(value.signal);
      const at = isoTime(value.at);
      if (!signal || !at)
        return 'an observation reference needs "signal" and "at" (an ISO time).';
      if (value.lane === undefined) return { type, signal, at };
      const lane = name(value.lane);
      if (!lane) return '"lane" must be the name of a lane.';
      return { type, signal, lane, at };
    }
    case "ledger":
    case "event":
    case "action": {
      const id = name(value.id);
      return id ? { type, id } : `a ${type} reference needs an "id".`;
    }
    case "release": {
      const at = isoTime(value.at);
      if (!at) return 'a release reference needs "at" as an ISO time.';
      if (value.ref === undefined) return { type, at };
      const ref = name(value.ref);
      return ref ? { type, at, ref } : '"ref" must be the release\'s name.';
    }
    case "pr": {
      const number = prNumber(value.number);
      return number ? { type, number } : "a pr reference needs a PR number.";
    }
    case "commit": {
      const sha = commitSha(value.sha);
      return sha ? { type, sha } : BAD_COMMIT;
    }
    case "tool": {
      const tool = name(value.tool);
      if (!tool)
        return 'a tool reference needs "tool", the name of a tool you called.';
      const nth = value.nth === undefined ? 1 : value.nth;
      if (typeof nth !== "number" || !Number.isSafeInteger(nth) || nth < 1)
        return '"nth" must be a whole number from 1 (1 is your most recent call).';
      if (value.contains === undefined) return { type, tool, nth };
      if (
        typeof value.contains !== "string" ||
        !cleanReportText(value.contains, true).trim() ||
        value.contains.length > CONTAINS_MAX
      )
        return `"contains" must be text of at most ${CONTAINS_MAX} characters.`;
      return { type, tool, nth, contains: value.contains };
    }
    case "block": {
      const id = typeof value.id === "string" ? value.id : "";
      return FINDING_ID.test(id)
        ? { type, id }
        : 'a block reference needs the "id" of a block.';
    }
    default:
      return typeof type === "string"
        ? `unknown reference type ${shown(type)}. Use one of: ${REF_TYPES.join(", ")}.`
        : `a reference needs a "type". Use one of: ${REF_TYPES.join(", ")}.`;
  }
}

/** A tool reference for a log source, or null after a note. */
function toolSource(value: unknown, note: Note): ToolRefInput | null {
  const ref = parseRefInput(value);
  if (typeof ref !== "string" && ref.type === "tool") return ref;
  note(
    typeof ref === "string" && isRecord(value) && value.type === "tool"
      ? `source: ${ref}`
      : BAD_SOURCE,
  );
  return null;
}

function parseWindow(
  value: Record<string, unknown>,
  note: Note,
  nowMs: number,
): SignalWindow | null {
  const signalId = name(value.signal);
  if (!signalId) {
    note('"signal" must be the id of one of the incident\'s signals.');
    return null;
  }
  let lane: string | undefined;
  if (value.lane !== undefined) {
    const named = name(value.lane);
    if (!named) {
      note('"lane" must be the name of a lane.');
      return null;
    }
    lane = named;
  }
  const from = isoTime(value.from);
  const to = isoTime(value.to);
  if (!from || !to) {
    note(`"${from ? "to" : "from"}" must be an ISO time.`);
    return null;
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (toMs <= fromMs) {
    note('"to" must be after "from".');
    return null;
  }
  if (fromMs > nowMs) {
    note("the window is in the future.");
    return null;
  }
  let start = from;
  if (toMs - fromMs > L.windowMs) {
    note(`window cut to ${L.windowMs / 86_400_000} days.`);
    start = new Date(toMs - L.windowMs).toISOString();
  }
  return lane === undefined
    ? { signalId, from: start, to }
    : { signalId, lane, from: start, to };
}

function parseExcerpt(
  value: Record<string, unknown>,
  note: Note,
): LogExcerptOf<ToolRefInput> | null {
  const source = toolSource(value.source, note);
  if (!source) return null;
  if (!Array.isArray(value.lines)) {
    note("lines must list the lines you quote.");
    return null;
  }
  // Input index → kept index, so highlights follow the kept lines.
  const index = new Map<number, number>();
  const lines: string[] = [];
  value.lines.forEach((raw, i) => {
    if (typeof raw !== "string") {
      note(`line ${i + 1} left off: it must be text.`);
      return;
    }
    let line = cleanReportText(raw, false).trimEnd();
    if (!line.trim() || lines.length >= L.logLines) return;
    if (line.length > L.logLineChars) {
      note(`line ${i + 1} cut to ${L.logLineChars} characters.`);
      line = head(line, L.logLineChars);
    }
    index.set(i, lines.length);
    lines.push(line);
  });
  const quoted = value.lines.filter(
    (l) => typeof l === "string" && cleanReportText(l, false).trim(),
  ).length;
  if (quoted > L.logLines) note(`kept the first ${L.logLines} lines.`);
  if (lines.length === 0) {
    note("lines must list at least one line.");
    return null;
  }
  const highlight = new Set<number>();
  if (value.highlight !== undefined) {
    if (!Array.isArray(value.highlight))
      note("highlight must be a list of line indexes; ignored.");
    else
      for (const h of value.highlight) {
        const kept =
          typeof h === "number" && Number.isSafeInteger(h)
            ? index.get(h)
            : undefined;
        if (kept === undefined)
          note(`highlight ${shown(h)} is not one of the lines; ignored.`);
        else highlight.add(kept);
      }
  }
  return {
    source,
    lines,
    highlight: [...highlight].sort((a, b) => a - b),
    dropped: 0,
  };
}

function parseHypothesis(
  value: Record<string, unknown>,
  note: Note,
): Body<"hypothesis"> | null {
  const statement = cleanText(value.statement);
  if (!statement) {
    note("statement is required.");
    return null;
  }
  const confidence = value.confidence;
  if (
    confidence !== "low" &&
    confidence !== "medium" &&
    confidence !== "high"
  ) {
    note("confidence must be low, medium or high.");
    return null;
  }
  const evidence: RefInput[] = [];
  if (value.evidence !== undefined && !Array.isArray(value.evidence))
    note("evidence must be a list of references; left off.");
  else
    listOf(value.evidence).forEach((raw, i) => {
      const ref = parseRefInput(raw);
      if (typeof ref === "string") note(`evidence ${i + 1} left off: ${ref}`);
      else evidence.push(ref);
    });
  const claims: string[] = [];
  if (value.claims !== undefined && !Array.isArray(value.claims))
    note("claims must be a list of claim texts; left off.");
  else
    listOf(value.claims).forEach((raw, i) => {
      const text = cleanText(raw);
      if (!text) note(`claim ${i + 1} left off: it must be text.`);
      else claims.push(clip(text, L.statement, `claim ${i + 1}`, note));
    });
  return {
    kind: "hypothesis",
    statement: clip(statement, L.statement, "statement", note),
    confidence,
    evidence: capped(evidence, L.evidence, "evidence references", note),
    claims: capped(claims, L.claims, "claims", note),
  };
}

function parseTimeline(
  value: Record<string, unknown>,
  note: Note,
): Body<"timeline"> | null {
  if (!Array.isArray(value.events)) {
    note("events must be a list of {at, text}.");
    return null;
  }
  const events: Body<"timeline">["events"] = [];
  value.events.forEach((raw: unknown, i: number) => {
    const n = i + 1;
    if (!isRecord(raw))
      return note(`event ${n} dropped: it must be an object.`);
    const at = isoTime(raw.at);
    if (!at) return note(`event ${n} dropped: "at" must be an ISO time.`);
    const text = cleanText(raw.text);
    if (!text) return note(`event ${n} dropped: "text" is required.`);
    const event: Body<"timeline">["events"][number] = {
      at,
      text: clip(text, L.eventText, `event ${n} text`, note),
    };
    if (raw.ref !== undefined) {
      const ref = parseRefInput(raw.ref);
      if (typeof ref === "string")
        note(`event ${n} reference left off: ${ref}`);
      else event.ref = ref;
    }
    events.push(event);
  });
  if (events.length === 0) {
    note("a timeline needs at least one event.");
    return null;
  }
  return {
    kind: "timeline",
    events: capped(events, L.timelineEvents, "events", note),
  };
}

function parseSignal(
  value: Record<string, unknown>,
  note: Note,
  nowMs: number,
): Body<"signal"> | null {
  const window = parseWindow(value, note, nowMs);
  if (!window) return null;
  const markers: Body<"signal">["markers"] = [];
  if (value.markers !== undefined && !Array.isArray(value.markers))
    note("markers must be a list of {at, label}; left off.");
  else
    listOf(value.markers).forEach((raw, i) => {
      const n = i + 1;
      const at = isRecord(raw) ? isoTime(raw.at) : null;
      const label = isRecord(raw) ? cleanText(raw.label) : null;
      if (!at || !label)
        return note(
          `marker ${n} dropped: it needs "at" (an ISO time) and "label".`,
        );
      markers.push({
        at,
        label: clip(label, L.markerLabel, `marker ${n} label`, note),
      });
    });
  return {
    kind: "signal",
    ...window,
    markers: capped(markers, L.markers, "markers", note),
  };
}

function parseChange(
  value: Record<string, unknown>,
  note: Note,
): Body<"change"> | null {
  const hasPr = value.pr !== undefined;
  const hasCommit = value.commit !== undefined;
  if (hasPr === hasCommit) {
    note(
      hasPr
        ? 'give either "pr" or "commit", not both.'
        : 'give "pr" (a PR number) or "commit" (a sha).',
    );
    return null;
  }
  let change: Body<"change">["change"];
  if (hasPr) {
    const number = prNumber(value.pr);
    if (!number) {
      note("pr must be a PR number.");
      return null;
    }
    change = { type: "pr", number };
  } else {
    const sha = commitSha(value.commit);
    if (!sha) {
      note(BAD_COMMIT);
      return null;
    }
    change = { type: "commit", sha };
  }
  const why = cleanText(value.why, true) ?? "";
  return { kind: "change", change, why: clip(why, L.prose, "why", note) };
}

function parseCompare(
  value: Record<string, unknown>,
  note: Note,
  nowMs: number,
): Body<"compare"> | null {
  if (!Array.isArray(value.sides) || value.sides.length !== 2) {
    note("compare needs exactly two sides.");
    return null;
  }
  const sides: Body<"compare">["sides"][number][] = [];
  for (const [i, raw] of value.sides.entries()) {
    const n = i + 1;
    const sideNote: Note = (m) => note(`side ${n}: ${m}`);
    if (!isRecord(raw)) {
      sideNote("it must be an object with a label and a signal or a log.");
      return null;
    }
    const label = cleanText(raw.label);
    if (!label) {
      sideNote("a label is required.");
      return null;
    }
    const sideLabel = clip(label, L.sideLabel, `side ${n} label`, note);
    if ((raw.signal === undefined) === (raw.log === undefined)) {
      sideNote('give either "signal" or "log", not both.');
      return null;
    }
    if (raw.signal !== undefined) {
      const window = isRecord(raw.signal)
        ? parseWindow(raw.signal, sideNote, nowMs)
        : (sideNote('"signal" must be {signal, from, to}.'), null);
      if (!window) return null;
      sides.push({ label: sideLabel, signal: window });
    } else {
      const log = isRecord(raw.log)
        ? parseExcerpt(raw.log, sideNote)
        : (sideNote('"log" must be {source, lines}.'), null);
      if (!log) return null;
      sides.push({ label: sideLabel, log });
    }
  }
  return { kind: "compare", sides: [sides[0]!, sides[1]!] };
}

function parseQuestion(
  value: Record<string, unknown>,
  note: Note,
): Body<"question"> | null {
  const text = cleanText(value.text);
  if (!text) {
    note("text is required.");
    return null;
  }
  const wouldAnswer = cleanText(value.wouldAnswer, true) ?? "";
  return {
    kind: "question",
    text: clip(text, L.statement, "text", note),
    wouldAnswer: clip(wouldAnswer, L.prose, "wouldAnswer", note),
  };
}

function parseBody(
  kind: FindingKind,
  value: Record<string, unknown>,
  note: Note,
  nowMs: number,
): AnyBody | null {
  switch (kind) {
    case "hypothesis":
      return parseHypothesis(value, note);
    case "timeline":
      return parseTimeline(value, note);
    case "signal":
      return parseSignal(value, note, nowMs);
    case "log": {
      const excerpt = parseExcerpt(value, note);
      return excerpt ? { kind: "log", ...excerpt } : null;
    }
    case "change":
      return parseChange(value, note);
    case "claims":
      return { kind: "claims" };
    case "compare":
      return parseCompare(value, note, nowMs);
    case "question":
      return parseQuestion(value, note);
  }
}

function isKind(value: unknown): value is FindingKind {
  return (FINDING_KINDS as readonly unknown[]).includes(value);
}

/** At most `NOTES_MAX` notes, then one line counting the rest. */
export function capNotes(notes: string[]): string[] {
  if (notes.length <= NOTES_MAX) return notes;
  return [
    ...notes.slice(0, NOTES_MAX),
    `…and ${notes.length - NOTES_MAX} more.`,
  ];
}

/** Checks the agent's block list for shape and limits. `cleared` is true
 *  when the agent sent an empty list on purpose. */
export function validateFindings(
  input: unknown,
  ctx: ValidateContext,
): { blocks: DraftBlock[]; notes: string[]; cleared: boolean } {
  const notes: string[] = [];
  if (!isRecord(input) || !Array.isArray(input.blocks))
    return { blocks: [], notes: [SEND_BLOCKS], cleared: false };
  const blocks: DraftBlock[] = [];
  const seen = new Set<string>();
  input.blocks.forEach((value: unknown, i: number) => {
    const id = isRecord(value) ? value.id : undefined;
    if (typeof id !== "string" || !FINDING_ID.test(id)) {
      notes.push(`Block ${i + 1}: ${BAD_ID}`);
      return;
    }
    const note: Note = (m) => notes.push(`Block \`${id}\`: ${m}`);
    if (seen.has(id)) return note("the id is used twice; kept the first.");
    const rec = value as Record<string, unknown>;
    if (rec.keep === true) {
      const stored = ctx.keepFrom.get(id);
      if (!stored) return note("nothing to keep under that id.");
      seen.add(id);
      blocks.push({ kept: true, block: stored });
      return;
    }
    if (!isKind(rec.kind)) {
      const kinds = `Use one of: ${FINDING_KINDS.join(", ")}.`;
      return note(
        typeof rec.kind === "string"
          ? `unknown kind ${shown(rec.kind)}. ${kinds}`
          : `kind is missing. ${kinds}`,
      );
    }
    let size: "full" | "half" = "full";
    if (rec.size === "half") size = "half";
    else if (rec.size !== undefined && rec.size !== "full")
      note('size must be "full" or "half"; used "full".');
    let title: string | undefined;
    if (rec.title !== undefined) {
      const text = cleanText(rec.title);
      if (text === null) note("title must be text; left off.");
      else if (text) title = clip(text, L.title, "title", note);
    }
    const body = parseBody(rec.kind, rec, note, ctx.nowMs);
    if (!body) return;
    seen.add(id);
    const block = (
      title === undefined ? { id, size, ...body } : { id, title, size, ...body }
    ) as FindingBlockDraft;
    blocks.push({ kept: false, block });
  });
  if (blocks.length > L.blocks)
    notes.push(`Kept the first ${L.blocks} blocks.`);
  return {
    blocks: blocks.slice(0, L.blocks),
    notes: capNotes(notes),
    cleared: input.blocks.length === 0,
  };
}
