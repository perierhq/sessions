// Tool-call references for incident findings: which of the calling agent's
// own tool calls a block cites, where its output came from, and which quoted
// lines really are in that output. Pure over transcript entries; the caller
// loads the agent's transcript tail and the full result entry.

import type { TranscriptEntry } from "@tellahq/opensession-protocol/session";
import {
  canonicalToolName,
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

/** The names a call answers to, lowercased: as stored, canonical, and the
 *  MCP tool part. */
function namesOf(toolName: string): string[] {
  const names = [toolName, canonicalToolName(toolName)];
  const mcp = parseMcpTool(toolName);
  if (mcp) names.push(mcp.tool);
  return names.map((n) => n.toLowerCase());
}

function isShowFindings(toolName: string): boolean {
  return namesOf(toolName).includes(SHOW_FINDINGS_TOOL);
}

/** The tool_result entry answering a call: by toolUseId, else by the ids
 *  Claude (`tr-<id>`) and pi (`<id>-result`) give results. */
function resultIndex(
  tail: readonly TranscriptEntry[],
): (callId: string) => TranscriptEntry | undefined {
  const byUseId = new Map<string, TranscriptEntry>();
  const byId = new Map<string, TranscriptEntry>();
  for (const e of tail) {
    if (e.type !== "tool_result") continue;
    if (e.toolUseId) byUseId.set(e.toolUseId, e);
    byId.set(e.id, e);
  }
  return (callId) =>
    byUseId.get(callId) ??
    byId.get(`tr-${callId}`) ??
    byId.get(`${callId}-result`);
}

/**
 * The calling agent's `nth` most recent call of `tool` (1 = the latest) that
 * has a result, optionally one whose cleaned result contains `contains`.
 * Only `tail`, the caller's own transcript, is searched; `show_findings`
 * calls never count. Returns the note to show the agent when nothing fits.
 */
export function matchToolCall(
  tail: readonly TranscriptEntry[],
  sessionId: string,
  ref: { tool: string; nth: number; contains?: string },
): ToolRef | string {
  const wanted = ref.tool.toLowerCase();
  const wantedCanonical = canonicalToolName(ref.tool).toLowerCase();
  const contains =
    ref.contains === undefined
      ? undefined
      : cleanReportText(ref.contains, true);
  const resultOf = resultIndex(tail);
  let seen = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const use = tail[i]!;
    if (use.type !== "tool_use" || !use.toolName) continue;
    const call = unwrapMcpDispatcher(use.toolName, use.toolInput);
    if (isShowFindings(use.toolName) || isShowFindings(call.toolName)) continue;
    const names = namesOf(call.toolName);
    if (!names.includes(wanted) && !names.includes(wantedCanonical)) continue;
    const result = resultOf(use.toolUseId ?? use.id);
    if (!result) continue;
    if (
      contains !== undefined &&
      !cleanReportText(result.content, true).includes(contains)
    )
      continue;
    seen += 1;
    if (seen < ref.nth) continue;
    return {
      type: "tool",
      sessionId,
      useId: use.id,
      resultId: result.id,
      tool: call.toolName,
      at: use.timestamp,
      provenance: provenanceOf(call.toolName, call.input),
    };
  }
  const which = ref.nth === 1 ? "" : `${ordinal(ref.nth)} `;
  return contains === undefined
    ? `No ${which}${ref.tool} call in your session.`
    : `No ${which}${ref.tool} call in your session has that text in its result.`;
}

function field(input: unknown, key: string): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function urlHost(input: unknown): string {
  try {
    return new URL(field(input, "url")).host;
  } catch {
    return "";
  }
}

/** Where a tool's output came from, for the line under a quoted block. */
export function provenanceOf(toolName: string, input: unknown): Provenance {
  const call = unwrapMcpDispatcher(toolName, input);
  const name = call.toolName;
  const mcp = parseMcpTool(name);
  const fallback: Provenance = { kind: "tool", label: canonicalToolName(name) };
  // The incident access server's own tools, also under their bare names
  // (which read like a flat MCP name to parseMcpTool).
  const own = (
    mcp?.server === INCIDENT_ACCESS_SERVER ? mcp.tool : name
  ).toLowerCase();
  if (own === "host_command") {
    const runner = field(call.input, "runner");
    return runner ? { kind: "host", label: runner } : fallback;
  }
  if (own === "egress_fetch") {
    const host = urlHost(call.input);
    return host ? { kind: "fetch", label: host } : fallback;
  }
  if (own === "call_credential") {
    const credential = field(call.input, "credential");
    return credential ? { kind: "connector", label: credential } : fallback;
  }
  const canonical = canonicalToolName(name);
  if (canonical === "WebFetch") {
    const host = urlHost(call.input);
    return host ? { kind: "fetch", label: host } : fallback;
  }
  if (canonical === "WebSearch") return { kind: "web" };
  if (mcp) {
    const label = mcpLabelParts(mcp.server, mcp.tool).slice(0, -1).join(" ");
    return { kind: "connector", label: label || mcp.server };
  }
  const family = toolFamily(name);
  if (family === "run") return { kind: "shell" };
  if (family === "file" || family === "find") return { kind: "workspace" };
  return fallback;
}

function nonSpaceChars(s: string): number {
  return s.replace(/\s/g, "").length;
}

/**
 * The quoted lines that really are in `resultText`. A quote is kept when,
 * cleaned of escapes and trailing space, it has at least 8 non-space
 * characters and sits inside one line of the cleaned result. Highlights are
 * renumbered to the kept lines.
 */
export function checkQuotes(
  resultText: string,
  lines: string[],
  highlight: number[],
): { lines: string[]; highlight: number[]; dropped: number } {
  const source = cleanReportText(resultText, true)
    .split("\n")
    .map((l) => l.trimEnd());
  const kept: string[] = [];
  const keptIndex = new Map<number, number>();
  lines.forEach((line, i) => {
    const quote = cleanReportText(line, false).trimEnd();
    if (nonSpaceChars(quote) < FINDINGS_LIMITS.quoteMinChars) return;
    if (!source.some((s) => s.includes(quote))) return;
    keptIndex.set(i, kept.length);
    kept.push(quote);
  });
  const marks: number[] = [];
  for (const i of highlight) {
    const j = keptIndex.get(i);
    if (j !== undefined && !marks.includes(j)) marks.push(j);
  }
  return { lines: kept, highlight: marks, dropped: lines.length - kept.length };
}
