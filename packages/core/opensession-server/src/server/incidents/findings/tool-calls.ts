// Tool-call references for incident findings: which of the calling agent's
// own tool calls a block cites, where its output came from, and which quoted
// lines really are in that output. Pure over transcript entries; the caller
// loads the agent's transcript tail and the full result entry.
//
// Defensive by design: a cited call proves only what the server answered.
// Provenance never comes from the agent's input of a failed call, quotes are
// read from a call's output (`quoteSource`), never from the access server's
// JSON envelope or from text the call itself sent, and only the first
// FINDINGS_LIMITS.sourceBytes of a result are searched. `matchToolCall`
// reads the tail's copy of a result, which may be clamped; `checkQuotes`
// takes the full result entry (`transcript.getFullEntry`), searched within
// that same limit.

import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import {
  canonicalToolName,
  isMcpCallDispatcher,
  mcpLabelParts,
  parseMcpTool,
  toolFamily,
  unwrapMcpDispatcher,
} from "@tellahq/opensession-protocol/tool-presentation";
import {
  FINDINGS_LIMITS,
  type Provenance,
  type ToolRef,
} from "../../../shared/findings";
import { INCIDENT_ACCESS_SERVER } from "../../../shared/incident-access";
import { cleanReportText } from "../response/reports";

export const SHOW_FINDINGS_TOOL = "show_findings";

/** The access server's tools as Claude names them (`mcp__<server>__<tool>`)
 *  and as pi's `tool_call` dispatcher names them (`<server>_<tool>`). A bare
 *  `host_command` is some other tool. */
const ACCESS_MCP_PREFIX = `mcp__${INCIDENT_ACCESS_SERVER}__`;
const ACCESS_FLAT_PREFIX = `${INCIDENT_ACCESS_SERVER}_`;
/** Access tools whose answer carries data from outside the agent. */
const ACCESS_DATA_TOOLS = new Set([
  "host_command",
  "egress_fetch",
  "call_credential",
]);

/** Other engines' built-ins whose names read like flat MCP names
 *  (`<server>_<tool>`), by the tool they behave as. */
const BUILTIN_ALIASES: Readonly<Record<string, string>> = {
  write_stdin: "Bash",
  read_file: "Read",
  list_dir: "Glob",
};

/** Characters that count toward a quote's minimum: letters, digits,
 *  punctuation and symbols, after format characters are removed. */
const COUNTED_CHARS = /[\p{L}\p{N}\p{P}\p{S}]/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
const LINE_BREAK = /\r\n|\r|\n/;
const SOURCE_MB = FINDINGS_LIMITS.sourceBytes / (1024 * 1024);

/** A tool call as its transcript stores it, with its result's text. */
export interface QuoteCall {
  /** The tool_use entry's `toolName`, as stored (may be pi's `tool_call`). */
  toolName: string;
  /** The tool_use entry's `toolInput`, as stored. */
  input: unknown;
  /** The tool_result entry's `content`; read the full entry, not the tail's
   *  copy, which may be clamped. */
  content: string;
}

export interface ProvenanceOptions {
  /** MCP servers this session can call. A flat `<server>_<tool>` name is a
   *  connector only when its server is one of them. */
  mcpServers?: readonly string[];
}

/** The tail results' searchable text (`quoteSource`, its first
 *  `FINDINGS_LIMITS.sourceBytes`, cleaned line by line), by call and result
 *  id; null when the call has nothing to quote. Share one across one
 *  `show_findings` call's `matchToolCall`s so each result is cleaned once. */
export type MatchCache = Map<string, { text: string; cut: boolean } | null>;

export interface MatchOptions extends ProvenanceOptions {
  cache?: MatchCache;
}

/** A call's quotable output, cleaned once for {@link checkQuotes}. */
export interface PreparedQuotes {
  /** The source's cleaned lines; null when the call has nothing to quote. */
  sourceLines: string[] | null;
  /** Whether the source was cut at `FINDINGS_LIMITS.sourceBytes`. */
  cut: boolean;
  /** The cleaned, non-blank lines of every string the call itself sent. */
  sent: string[];
}

interface Call {
  name: string;
  input: unknown;
  /** Unwrapped from pi's `tool_call` dispatcher. */
  dispatched: boolean;
}

function callOf(toolName: string, input: unknown): Call {
  if (!isMcpCallDispatcher(toolName))
    return { name: toolName, input, dispatched: false };
  const inner = unwrapMcpDispatcher(toolName, input);
  return {
    name: inner.toolName,
    input: inner.input,
    dispatched: inner.toolName !== toolName,
  };
}

/** The access server's tool a call reached, lowercased, or null. */
function accessTool(call: Call): string | null {
  if (call.name.startsWith(ACCESS_MCP_PREFIX))
    return call.name.slice(ACCESS_MCP_PREFIX.length).toLowerCase();
  if (call.dispatched && call.name.startsWith(ACCESS_FLAT_PREFIX))
    return call.name.slice(ACCESS_FLAT_PREFIX.length).toLowerCase();
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An access tool's answer when it succeeded, else null: JSON with
 *  `ok: true` (a lent credential's answer has no `ok`; it succeeded when it
 *  has a status and no error). */
function accessAnswer(
  tool: string,
  content: string,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.ok === true) return value;
  return tool === "call_credential" &&
    value.ok === undefined &&
    value.error === undefined &&
    typeof value.status === "number"
    ? value
    : null;
}

/**
 * The text quotes from a call are checked against, or null when the call
 * has nothing to quote. The incident access server's data tools answer with
 * JSON: a quote must come from what the host printed (`stdout`, a newline,
 * `stderr`) or the response body, never the envelope, and a failed or
 * refused call has no output. Every other tool's result is its plain text.
 */
export function quoteSource(
  toolName: string,
  input: unknown,
  content: string,
): string | null {
  const tool = accessTool(callOf(toolName, input));
  if (tool === null || !ACCESS_DATA_TOOLS.has(tool)) return content;
  const answer = accessAnswer(tool, content);
  if (!answer) return null;
  return tool === "host_command"
    ? `${text(answer.stdout)}\n${text(answer.stderr)}`
    : text(answer.body);
}

/** The first `FINDINGS_LIMITS.sourceBytes` of `value` (UTF-8), never
 *  splitting a character. */
function headOf(value: string): { text: string; cut: boolean } {
  const cap = FINDINGS_LIMITS.sourceBytes;
  // Every UTF-16 unit is at most 3 UTF-8 bytes.
  if (value.length * 3 <= cap) return { text: value, cut: false };
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= cap) return { text: value, cut: false };
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, cap))
    .replace(/\uFFFD+$/, "");
  return { text: head, cut: true };
}

/** One line as quotes are compared: no escapes or invisible characters, no
 *  trailing space, composed (NFC). */
function cleanLine(line: string): string {
  return cleanReportText(line, false).trimEnd().normalize("NFC");
}

/** Lines are split before they are cleaned, so an escape sequence can never
 *  reach across a line break. */
function cleanLines(value: string): string[] {
  return value.split(LINE_BREAK).map(cleanLine);
}

function countedChars(value: string): number {
  return value.replace(FORMAT_CHARS, "").match(COUNTED_CHARS)?.length ?? 0;
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st". */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen
    ? "th"
    : n % 10 === 1
      ? "st"
      : n % 10 === 2
        ? "nd"
        : n % 10 === 3
          ? "rd"
          : "th";
  return `${n}${suffix}`;
}

function canonicalOf(name: string): string {
  return BUILTIN_ALIASES[name] ?? canonicalToolName(name);
}

/** The names a call answers to, lowercased: as stored, canonical, and the
 *  MCP tool part. */
function namesOf(toolName: string): string[] {
  const names = [toolName, canonicalOf(toolName)];
  const mcp = BUILTIN_ALIASES[toolName] ? null : parseMcpTool(toolName);
  if (mcp) names.push(mcp.tool);
  return names.map((n) => n.toLowerCase());
}

function isShowFindings(toolName: string): boolean {
  return namesOf(toolName).includes(SHOW_FINDINGS_TOOL);
}

/** The tool_result entry answering the call at `index`: the first result
 *  after it whose toolUseId is the call's, or whose id is the one Claude
 *  (`tr-<id>`) or pi (`<id>-result`) gives it. */
function resultPairs(
  tail: readonly TranscriptEntry[],
): (index: number, callId: string) => TranscriptEntry | undefined {
  const positions = new Map<string, number[]>();
  const add = (key: string, j: number) => {
    const list = positions.get(key);
    if (list) list.push(j);
    else positions.set(key, [j]);
  };
  tail.forEach((e, j) => {
    if (e.type !== "tool_result") return;
    if (e.toolUseId) add(`use:${e.toolUseId}`, j);
    add(`id:${e.id}`, j);
  });
  return (index, callId) => {
    let best = -1;
    for (const key of [
      `use:${callId}`,
      `id:tr-${callId}`,
      `id:${callId}-result`,
    ]) {
      const j = positions.get(key)?.find((p) => p > index);
      if (j !== undefined && (best < 0 || j < best)) best = j;
    }
    return best < 0 ? undefined : tail[best];
  };
}

/** What `contains` is searched in for a tail result: its quotable text,
 *  cut and cleaned, from `cache` when it was cleaned before. */
function searchText(
  use: { id: string; toolName: string; toolInput: unknown },
  result: TranscriptEntry,
  cache: MatchCache | undefined,
): { text: string; cut: boolean } | null {
  const key = `${use.id}\n${result.id}`;
  const known = cache?.get(key);
  if (known !== undefined) return known;
  const source = quoteSource(use.toolName, use.toolInput, result.content);
  const head = source === null ? null : headOf(source);
  const searched = head
    ? { text: cleanLines(head.text).join("\n"), cut: head.cut }
    : null;
  cache?.set(key, searched);
  return searched;
}

/** `contains` as it is searched for: each line cleaned, then trimmed. */
function containsText(value: string): string {
  return cleanLines(value).join("\n").trim();
}

/**
 * The calling agent's `nth` most recent call of `tool` (1 = the latest) that
 * has a result, optionally one whose quotable text (`quoteSource`, cleaned
 * line by line, first `FINDINGS_LIMITS.sourceBytes`) contains `contains`.
 * Only `tail`, the caller's own transcript, is searched; `show_findings`
 * calls never count. Returns the note to show the agent when nothing fits.
 * `opts.cache` keeps each result's cleaned text for the next search.
 */
export function matchToolCall(
  tail: readonly TranscriptEntry[],
  sessionId: string,
  ref: { tool: string; nth: number; contains?: string },
  opts: MatchOptions = {},
): ToolRef | string {
  const wanted = ref.tool.toLowerCase();
  const wantedCanonical = canonicalOf(ref.tool).toLowerCase();
  const contains =
    ref.contains === undefined ? undefined : containsText(ref.contains);
  if (contains === "") return '"contains" has no text once cleaned.';
  const resultOf = resultPairs(tail);
  let seen = 0;
  let cutShort = false;
  for (let i = tail.length - 1; i >= 0; i--) {
    const use = tail[i]!;
    if (use.type !== "tool_use" || !use.toolName) continue;
    const call = unwrapMcpDispatcher(use.toolName, use.toolInput);
    if (isShowFindings(use.toolName) || isShowFindings(call.toolName)) continue;
    const names = namesOf(call.toolName);
    if (!names.includes(wanted) && !names.includes(wantedCanonical)) continue;
    const result = resultOf(i, use.toolUseId ?? use.id);
    if (!result) continue;
    if (contains !== undefined) {
      const searched = searchText(
        { id: use.id, toolName: use.toolName, toolInput: use.toolInput },
        result,
        opts.cache,
      );
      if (!searched?.text.includes(contains)) {
        if (result.contentClamped || searched?.cut) cutShort = true;
        continue;
      }
    }
    seen += 1;
    if (seen < ref.nth) continue;
    return {
      type: "tool",
      sessionId,
      useId: use.id,
      resultId: result.id,
      tool: call.toolName,
      at: use.timestamp,
      provenance: provenanceOf(use.toolName, use.toolInput, result, opts),
    };
  }
  const which = ref.nth === 1 ? "" : `${ordinal(ref.nth)} `;
  if (contains === undefined)
    return `No ${which}${ref.tool} call in your session.`;
  const note = `No ${which}${ref.tool} call in your session has that text in its result.`;
  return cutShort
    ? `${note} Some ${ref.tool} results were cut short, so text near their end can't be found.`
    : note;
}

function field(input: unknown, key: string): string {
  return isRecord(input) ? text(input[key]).trim() : "";
}

function urlHost(input: unknown): string {
  try {
    return new URL(field(input, "url")).host;
  } catch {
    return "";
  }
}

/** Where an access tool's output came from, from the server's answer: a
 *  refused, failed or unreadable call is only "a tool". */
function accessProvenance(
  tool: string,
  call: Call,
  result: Pick<TranscriptEntry, "content" | "isError"> | null,
): Provenance {
  const quiet: Provenance = { kind: "tool", label: tool };
  if (!result || result.isError || !ACCESS_DATA_TOOLS.has(tool)) return quiet;
  const answer = accessAnswer(tool, result.content);
  if (!answer) return quiet;
  if (tool === "host_command") {
    const runner = text(answer.runner).trim();
    const ssh = text(answer.ssh).trim();
    if (!runner) return quiet;
    return { kind: "host", label: ssh ? `${ssh} via ${runner}` : runner };
  }
  if (tool === "egress_fetch") {
    // The server answers only for a URL on the egress list it checked.
    const host = text(answer.host).trim() || urlHost(call.input);
    return host ? { kind: "fetch", label: host } : quiet;
  }
  // call_credential: answered only for a credential lent to this agent.
  const credential =
    text(answer.service).trim() || field(call.input, "credential");
  return credential ? { kind: "connector", label: credential } : quiet;
}

/**
 * Where a tool's output came from, for the line under a quoted block.
 * `toolName` and `input` are the tool_use entry's, as stored; `result` is
 * its tool_result. Host, fetch and connector labels need a result that is
 * not an error; for the incident access server's tools they come from its
 * successful answer only. Bare names are never the access server's tools.
 */
export function provenanceOf(
  toolName: string,
  input: unknown,
  result: Pick<TranscriptEntry, "content" | "isError"> | null,
  opts: ProvenanceOptions = {},
): Provenance {
  const call = callOf(toolName, input);
  const own = accessTool(call);
  if (own !== null) return accessProvenance(own, call, result);
  const name = call.name;
  const canonical = canonicalOf(name);
  const quiet: Provenance = { kind: "tool", label: canonical };
  const answered = result !== null && result.isError !== true;
  if (canonical === "WebFetch") {
    const host = answered ? urlHost(call.input) : "";
    return host ? { kind: "fetch", label: host } : quiet;
  }
  if (canonical === "WebSearch") return { kind: "web" };
  const mcp = BUILTIN_ALIASES[name] ? null : parseMcpTool(name);
  const isConnector =
    mcp?.server !== INCIDENT_ACCESS_SERVER &&
    (name.startsWith("mcp__")
      ? mcp !== null
      : call.dispatched ||
        (mcp !== null && (opts.mcpServers ?? []).includes(mcp.server)));
  if (isConnector) {
    if (!answered) return quiet;
    const label = mcp
      ? mcpLabelParts(mcp.server, mcp.tool).slice(0, -1).join(" ") || mcp.server
      : name;
    return { kind: "connector", label };
  }
  if (mcp) return quiet;
  const family = toolFamily(canonical);
  if (family === "run") return { kind: "shell" };
  if (family === "file" || family === "find") return { kind: "workspace" };
  return quiet;
}

/** Every string inside a tool input, as cleaned lines; bounded like a
 *  source. */
function inputLines(input: unknown): string[] {
  const lines: string[] = [];
  let budget = FINDINGS_LIMITS.sourceBytes;
  const walk = (value: unknown, depth: number) => {
    if (budget <= 0 || depth > 20) return;
    if (typeof value === "string") {
      const head = value.slice(0, budget);
      budget -= head.length;
      for (const line of cleanLines(head)) if (line.trim()) lines.push(line);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(input, 0);
  return lines;
}

function ownInputCopy(n: number): string {
  return n === 1
    ? "1 line is in the call's own input, so its output can't prove it."
    : `${n} lines are in the call's own input, so its output can't prove them.`;
}

/** A call's output as {@link checkQuotes} searches it, cleaned once, so a
 *  result quoted by several blocks is cleaned (and held) once. */
export function prepareQuotes(call: QuoteCall): PreparedQuotes {
  const source = quoteSource(call.toolName, call.input, call.content);
  if (source === null) return { sourceLines: null, cut: false, sent: [] };
  const head = headOf(source);
  return {
    sourceLines: cleanLines(head.text),
    cut: head.cut,
    sent: inputLines(call.input),
  };
}

/**
 * The quoted lines that really are in a call's output. The source is
 * `quoteSource(call)`, its first `FINDINGS_LIMITS.sourceBytes`, split into
 * lines before each is cleaned. A quote, cleaned the same way, is kept when
 * it has at least `quoteMinChars` letters, digits, punctuation or symbols,
 * sits inside one source line, and is not inside a string the call itself
 * sent (an `echo` proves nothing). Kept quotes are returned cleaned (NFC);
 * highlights are renumbered to them. `notes` say why lines went missing
 * when it isn't simply "not in the source". Pass {@link prepareQuotes}'s
 * answer instead of the call to reuse its cleaned lines.
 */
export function checkQuotes(
  call: QuoteCall | PreparedQuotes,
  lines: string[],
  highlight: number[],
): { lines: string[]; highlight: number[]; dropped: number; notes: string[] } {
  const notes: string[] = [];
  const { sourceLines, cut, sent } =
    "sourceLines" in call ? call : prepareQuotes(call);
  if (sourceLines === null) {
    if (lines.length)
      notes.push("That call failed, so it has no output to quote.");
    return { lines: [], highlight: [], dropped: lines.length, notes };
  }
  const kept: string[] = [];
  const keptIndex = new Map<number, number>();
  let unseen = 0;
  let echoed = 0;
  lines.forEach((line, i) => {
    const quote = cleanLine(line);
    if (countedChars(quote) < FINDINGS_LIMITS.quoteMinChars) return;
    if (!sourceLines.some((s) => s.includes(quote))) {
      unseen += 1;
      return;
    }
    if (sent.some((s) => s.includes(quote))) {
      echoed += 1;
      return;
    }
    keptIndex.set(i, kept.length);
    kept.push(quote);
  });
  if (echoed) notes.push(ownInputCopy(echoed));
  if (cut && unseen)
    notes.push(`Only the first ${SOURCE_MB} MB of the result was searched.`);
  const marks: number[] = [];
  for (const i of highlight) {
    const j = keptIndex.get(i);
    if (j !== undefined && !marks.includes(j)) marks.push(j);
  }
  return {
    lines: kept,
    highlight: marks,
    dropped: lines.length - kept.length,
    notes,
  };
}
