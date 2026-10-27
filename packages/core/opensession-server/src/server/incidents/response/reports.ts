// The `incident-report` contract. Each agent ends its final message with
// exactly one fenced block tagged `incident-report` holding a JSON report
// (only the last 256 KB of a message are read, a block is at most 64 KB).
// A report is refused only when something essential is missing or
// unusable: the block, the conclusion, all of the evidence, the candidate
// decision, or what a candidate needs to be run and proven safely. The
// refusal's detail is short, names the field and goes back to the agent;
// the owner reads `plainReportProblem` instead. Each refusal names one of
// `REPORT_RULES`, which the briefs list word for word. Everything else is
// normalised and noted as a warning: order (attempts are sorted
// cheapest-first), case, spacing and synonyms of enum values, unknown enum
// values (to the least certain value), text too long (cut), repeats (kept
// once), bad sources (dropped) and unknown keys (dropped). Terminal
// escapes, control, bidi and zero-width characters are stripped from text.
// Suggested next steps are read tolerantly; the verifier's report has none.
// `effectiveVerdict` turns the verifier's verdict into the one
// Sessions acts on: certainty it cannot back becomes not certain.
import {
  EVIDENCE_RESULTS,
  type ActionKind,
  type AgentRole,
  type CandidatePlan,
  type CandidateCheck,
  type CandidateState,
  type Claim,
  type ClaimCheck,
  type ClaimStatus,
  type EvidenceCost,
  type EvidenceResult,
  type EvidenceRow,
  type InvestigatorReport,
  NEXT_STEP_KINDS,
  NEXT_STEP_TARGETS,
  NEXT_STEP_TITLE_MAX,
  NEXT_STEP_WHY_MAX,
  NEXT_STEPS_MAX,
  type NextStep,
  type NextStepKind,
  type NextStepTarget,
  type ProofResult,
  SEND_BACK_NOTE_MAX,
  type ReadFirst,
  type ReportIssue,
  type ReportProblem,
  type VerifierReport,
} from "../../../shared/incident-response";
import { claimKey } from "../../../shared/findings";
import { validateSource } from "../signal-validation";

export const REPORT_FENCE = "incident-report";

const RUNBOOK = "docs/incidents/runbook.md";
const NOTE_PATH = /^docs\/incidents\/\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,60}\.md$/;
const RUNBOOK_PATH = /^docs\/incidents\/runbooks\/[a-z0-9-]{1,60}\.md$/;
const COSTS: EvidenceCost[] = ["free", "cheap", "expensive"];
/** The allowed attempt results, as the agent is told them. */
export const RESULT_VALUES = EVIDENCE_RESULTS.join(", ");
/** Other spellings agents use for an allowed result, after normalising. */
const RESULT_SYNONYMS: Record<string, EvidenceResult> = {
  ruledout: "ruled-out",
  "rule-out": "ruled-out",
  excluded: "ruled-out",
  confirm: "confirmed",
  unclear: "inconclusive",
  context: "informative",
  info: "informative",
  informational: "informative",
};
/** Other spellings agents use for a cost, after normalising. */
const COST_SYNONYMS: Record<string, EvidenceCost> = {
  none: "free",
  zero: "free",
  "no-cost": "free",
  low: "cheap",
  inexpensive: "cheap",
  high: "expensive",
  costly: "expensive",
};
/** Other spellings verifiers use for a claim status, after normalising. */
const STATUS_SYNONYMS: Record<string, ClaimStatus> = {
  confirmed: "verified",
  true: "verified",
  false: "refuted",
  disproved: "refuted",
  unverified: "unverifiable",
  unknown: "unverifiable",
  unclear: "unverifiable",
  inconclusive: "unverifiable",
};
/** Stands in for evidence a row did not give. */
const NO_EVIDENCE = "No evidence given.";
const READ_FIRST_MAX = 20;
const ATTEMPTS_MAX = 40;
const CLAIMS_MAX = 30;
const RUNBOOK_PATHS_MAX = 5;
const CANDIDATE_ACTIONS_MAX = 5;
const REASONS_MAX = 20;
const VERIFIER_CLAIMS_MAX = 60;
/** The longest part of an unreadable result kept in the evidence. */
const RESULT_ECHO_MAX = 60;
const CLAIM_STATUSES: ClaimStatus[] = ["verified", "refuted", "unverifiable"];

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Only the end of a message is read for its report. */
export const REPORT_TAIL_CHARS = 256 * 1024;
/** A report block larger than this is refused before parsing. */
export const REPORT_BLOCK_MAX_BYTES = 64 * 1024;

/** The end of `text`, from the first whole line inside the last 256 KB. */
function messageTail(text: string): string {
  if (text.length <= REPORT_TAIL_CHARS) return text;
  const tail = text.slice(-REPORT_TAIL_CHARS);
  const newline = tail.indexOf("\n");
  return newline === -1 ? "" : tail.slice(newline + 1);
}

/** The contents of every fenced block whose info string is exactly
 *  `incident-report`, in the last 256 KB of `text`. An unclosed block runs
 *  to the end of the text. */
export function reportBlocks(text: string): string[] {
  const lines = messageTail(text).split(/\r?\n/);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const info = open[2].trim();
    if (marker[0] === "`" && info.includes("`")) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close &&
        close[1][0] === marker[0] &&
        close[1].length >= marker.length
      )
        break;
      body.push(line);
    }
    if (info === REPORT_FENCE) found.push(body.join("\n"));
    i = j;
  }
  return found;
}

/** The report block when the message holds exactly one, else null. */
export function extractReportBlock(text: string): string | null {
  const blocks = reportBlocks(text);
  return blocks.length === 1 ? blocks[0] : null;
}

const BOTH: readonly AgentRole[] = ["investigator", "verifier"];
const INVESTIGATOR: readonly AgentRole[] = ["investigator"];
const VERIFIER: readonly AgentRole[] = ["verifier"];

/** One reason a report is refused: who it binds, what the owner is told
 *  when it is broken, and the rule as the agent's brief states it. */
export interface ReportRule {
  roles: readonly AgentRole[];
  problem: ReportProblem;
  text: string;
}

/**
 * Every reason a report is refused, and nothing else. The briefs list
 * these words (`reportRules`) and the parsers refuse only by naming one,
 * so the brief and the check cannot drift apart. Guidance the brief gives
 * (cheapest-first order, lengths, sources, readFirst) is never a rule
 * here: it is repaired and noted as a warning (`REPORT_REPAIRS`).
 */
export const REPORT_RULES = {
  block: {
    roles: BOTH,
    problem: "missing",
    text: `End your final message with exactly one fenced block tagged ${REPORT_FENCE}.`,
  },
  json: {
    roles: BOTH,
    problem: "unreadable",
    text: "The block holds one JSON object of at most 64 KB.",
  },
  summary: {
    roles: INVESTIGATOR,
    problem: "conclusion",
    text: "summary says in one line what broke.",
  },
  cause: {
    roles: INVESTIGATOR,
    problem: "conclusion",
    text: "cause says what caused it.",
  },
  attempts: {
    roles: INVESTIGATOR,
    problem: "evidence",
    text: "attempts has at least one row with a step.",
  },
  candidate: {
    roles: INVESTIGATOR,
    problem: "decision",
    text: "candidate is { pr, actions } with pr true or false and the PR or at least one action, or null with noCandidateReason saying why.",
  },
  actions: {
    roles: INVESTIGATOR,
    problem: "action",
    text: `candidate.actions lists at most ${CANDIDATE_ACTIONS_MAX} ids from the actions you may propose, never a deploy (it runs with the PR).`,
  },
  check: {
    roles: INVESTIGATOR,
    problem: "check",
    text: "With a candidate, check is a request or an after-deploy check as described under Deliverable.",
  },
  claims: {
    roles: INVESTIGATOR,
    problem: "claims",
    text: "With a candidate, claims lists at least one claim.",
  },
  note: {
    roles: INVESTIGATOR,
    problem: "note",
    text: "With a candidate, notePath is docs/incidents/YYYY-MM-DD-<slug>.md.",
  },
  pr: {
    roles: INVESTIGATOR,
    problem: "pr",
    text: "With a candidate, this session's pull request is open when you end. If pushing or opening it fails, say what failed and keep the candidate.",
  },
  verdict: {
    roles: VERIFIER,
    problem: "conclusion",
    text: "verdict is certain or not-certain.",
  },
  rulings: {
    roles: VERIFIER,
    problem: "claims",
    text: "claims has a ruling on every listed claim, with its text unchanged.",
  },
} as const satisfies Record<string, ReportRule>;
export type ReportRuleId = keyof typeof REPORT_RULES;

/** The rules a role's report is refused for, in the brief's words. */
export function reportRules(role: AgentRole): string[] {
  return Object.values(REPORT_RULES)
    .filter((r: ReportRule) => r.roles.includes(role))
    .map((r) => r.text);
}

/** What Sessions repairs and notes instead of refusing, in the
 *  investigator brief's words. */
export const REPORT_REPAIRS: readonly string[] = [
  "attempts out of cost order are sorted cheapest-first",
  "an unknown cost is recorded as expensive and an unknown result as inconclusive",
  "text that is too long is cut",
  "a source that is not an http(s) URL or a repository path is dropped, and so is a claim's source no attempt cites",
  "a missing readFirst entry or runbook path is noted",
  "unknown keys and unusable next steps are dropped",
];

/** One broken rule: which, and the parser's detail for the agent. */
export interface ReportRuleIssue extends ReportIssue {
  rule: ReportRuleId;
}

/** A refused report, with every rule it broke found in one pass, so the
 *  agent can fix them all at once. `error`, `problem` and `rule` are the
 *  first issue's (all the errors, for `error`); `candidate` says whether
 *  the report meant to propose a fix, which then needs its pull request. */
export interface ReportRejection {
  error: string;
  problem: ReportProblem;
  rule: ReportRuleId;
  issues: ReportRuleIssue[];
  candidate: boolean;
}

type Result<T> = T | ReportRuleIssue;
function reject(
  rule: ReportRuleId,
  error: string,
  problem: ReportProblem = REPORT_RULES[rule].problem,
): ReportRuleIssue {
  return { rule, problem, error };
}
function failed<T>(r: Result<T>): r is ReportRuleIssue {
  return (
    typeof r === "object" && r !== null && !Array.isArray(r) && "error" in r
  );
}
function rejected(
  issues: ReportRuleIssue[],
  candidate: boolean,
): ReportRejection {
  const first = issues[0]!;
  return {
    error: issues.map((i) => i.error).join("; "),
    problem: first.problem,
    rule: first.rule,
    issues,
    candidate,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const INVESTIGATOR_PROBLEMS: Record<ReportProblem, string> = {
  missing:
    "The investigator finished without writing its report. Try again so it writes one.",
  unreadable:
    "The investigator's report could not be read. Try again so it writes the report again.",
  conclusion:
    "The investigator's report was missing its conclusion. Try again so it finishes the report.",
  evidence:
    "The investigator's report did not record what it checked. Try again so it finishes the report.",
  decision:
    "The investigator's report did not say whether it found a fix. Try again so it finishes the report.",
  action:
    "The investigator's fix asked for an action this project cannot run. Check the project's actions, then try again.",
  check:
    "The investigator's fix had no safe way to be proven. Try again so it gives a check Sessions can run.",
  claims:
    "The investigator's fix listed nothing for the verifier to check. Try again so it finishes the report.",
  note: "The investigator's fix did not name its incident note. Try again so it finishes the report.",
  pr: "The investigator proposed a fix but did not open a pull request. Try again so it opens one.",
};
const VERIFIER_PROBLEMS: Partial<Record<ReportProblem, string>> = {
  missing: "The verifier finished without writing its report",
  unreadable: "The verifier's report could not be read",
  conclusion: "The verifier's report was missing its verdict",
  claims: "The verifier's report did not rule on every claim",
};

/** What the owner reads when a report is refused: plain words and, for
 *  the investigator, what to do next. Never the parser's detail. */
export function plainReportProblem(
  role: AgentRole,
  problem: ReportProblem | undefined,
): string {
  if (role === "verifier")
    return (
      (problem && VERIFIER_PROBLEMS[problem]) ??
      "The verifier did not return a valid report"
    );
  return problem
    ? INVESTIGATOR_PROBLEMS[problem]
    : "The investigator's report could not be used. Try again so it finishes the report.";
}

/** Wrapped, so a report with its own `error` key is not taken for a failure. */
function parseBlock(
  text: string,
): { value: Record<string, unknown> } | ReportRuleIssue {
  const blocks = reportBlocks(text);
  if (blocks.length === 0) return reject("block", "No incident-report block");
  if (blocks.length > 1)
    return reject(
      "block",
      "End with exactly one incident-report block",
      "unreadable",
    );
  const block = blocks[0];
  if (Buffer.byteLength(block, "utf8") > REPORT_BLOCK_MAX_BYTES)
    return reject("json", "The incident-report block is too large");
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return reject("json", "The incident-report block is not valid JSON");
  }
  if (!isRecord(value))
    return reject("json", "The incident-report block must be a JSON object");
  return { value };
}

/** The raw `findings` value of the message's one incident-report block;
 *  undefined when absent or unreadable. The report's own parser ignores the
 *  key, so a report reads the same with or without it. */
export function reportFindingsInput(text: string): unknown {
  const block = parseBlock(text);
  if (!("value" in block) || !Object.hasOwn(block.value, "findings"))
    return undefined;
  return block.value.findings;
}

const ANSI_ESCAPE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// C0 and C1 controls except the newline, bidi marks, embeddings, overrides
// and isolates, and zero-width characters.
const INVISIBLE =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const HAS_INVISIBLE = new RegExp(INVISIBLE.source);

/** Report text without terminal escapes or invisible characters. Multiline
 *  fields keep their paragraphs (at most one blank line between them) and
 *  inline code; single-line fields fold newlines into spaces. */
export function cleanReportText(value: string, multiline: boolean): string {
  const out = value
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_ESCAPE, "")
    .replace(/\t/g, " ")
    .replace(INVISIBLE, "");
  return multiline
    ? out.replace(/[ ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    : out.replace(/\s*\n\s*/g, " ");
}

/** `value` as clean, trimmed text, or "" when it is not text. */
function cleanText(value: unknown, multiline = false): string {
  return typeof value === "string"
    ? cleanReportText(value, multiline).trim()
    : "";
}

/** `value` cut to `max` characters, ending in an ellipsis; a cut is noted. */
function fitted(
  value: string,
  max: number,
  field: string,
  warnings: string[],
): string {
  if (value.length <= max) return value;
  warnings.push(`${field} was longer than ${max} characters; cut`);
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** `value` as clean text cut to `max` characters, or "" when it is not
 *  text. A cut ends in an ellipsis. */
function clipped(value: unknown, max: number, multiline = false): string {
  const s = cleanText(value, multiline);
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** A value as written, for a warning. */
function shownValue(value: unknown): string {
  if (typeof value !== "string")
    return value === undefined ? "none" : "not text";
  const s = cleanReportText(value, false).trim().slice(0, RESULT_ECHO_MAX);
  return `"${s.replace(/`/g, "'")}"`;
}

/** Lower case, with spaces, underscores and hyphens as one hyphen. */
function enumKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return cleanReportText(value, false)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

/** true or false, also written as text ("true", "yes", "no"). */
function booleanOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const key = enumKey(value);
  if (key === "true" || key === "yes") return true;
  if (key === "false" || key === "no") return false;
  return null;
}

/** `value` as a list: missing is empty, a lone value is a list of one, and
 *  entries past `max` are dropped. Each repair is noted. */
function listOf(
  value: unknown,
  field: string,
  max: number,
  warnings: string[],
): unknown[] {
  if (value === undefined || value === null) return [];
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else {
    warnings.push(`${field} was not a list; read as a list of one`);
    items = [value];
  }
  if (items.length > max) {
    warnings.push(
      `Only ${max} entries of ${field} are kept; dropped ${items.length - max}`,
    );
    items = items.slice(0, max);
  }
  return items;
}

/** A report's role is known from the agent that wrote it; a different one
 *  is noted, not refused. */
function checkRole(value: unknown, role: AgentRole, warnings: string[]): void {
  if (enumKey(value) !== role)
    warnings.push(`role was ${shownValue(value)}; read as ${role}`);
}

/** An http(s) URL or a repository path, at most 2048 characters; null when
 *  it is neither. */
function sourceOf(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /\s/.test(value) ||
    HAS_INVISIBLE.test(value)
  )
    return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? value
        : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("/") || value.split("/").includes("..")) return null;
  return value;
}

/** A row's source, dropped with a warning when it is not usable. */
function keptSource(
  value: unknown,
  at: string,
  warnings: string[],
): string | undefined {
  const s = sourceOf(value);
  if (s !== null) return s;
  warnings.push(
    `${at} had a source that is not an http(s) URL or a repository path; dropped the source`,
  );
  return undefined;
}

/** A repository path as written, without a leading `./`. */
function repoPath(value: unknown): string {
  return cleanText(value).replace(/^(\.\/)+/, "");
}

function readFirstOf(value: unknown, warnings: string[]): ReadFirst[] {
  if (value === undefined || value === null)
    warnings.push("readFirst was missing");
  const items = listOf(value, "readFirst", READ_FIRST_MAX, warnings);
  const out: ReadFirst[] = [];
  for (const [i, item] of items.entries()) {
    const at = `readFirst entry ${i + 1}`;
    const path = isRecord(item) ? repoPath(item.path) : "";
    const found = isRecord(item) ? booleanOf(item.found) : null;
    if (!path || path.length > 512 || found === null) {
      warnings.push(`${at} needs a path and found; dropped`);
      continue;
    }
    if (out.some((r) => r.path === path)) {
      warnings.push(`${at} (${path}) was listed twice; kept once`);
      continue;
    }
    out.push({ path, found });
  }
  if (!out.some((r) => r.path === RUNBOOK))
    warnings.push(`readFirst did not list ${RUNBOOK}`);
  return out;
}

/** `value` as an allowed result: lower-cased, spaces and underscores as
 *  hyphens, and a few synonyms. Null when it is still not one. */
function normaliseResult(value: unknown): EvidenceResult | null {
  const key = enumKey(value);
  if (key === null) return null;
  if ((EVIDENCE_RESULTS as readonly string[]).includes(key))
    return key as EvidenceResult;
  return RESULT_SYNONYMS[key] ?? null;
}

/** `value` as an allowed cost, the same way. */
function normaliseCost(value: unknown): EvidenceCost | null {
  const key = enumKey(value);
  if (key === null) return null;
  if ((COSTS as string[]).includes(key)) return key as EvidenceCost;
  return COST_SYNONYMS[key] ?? null;
}

/** The evidence with the unreadable result appended, within 1000
 *  characters. */
function withReportedResult(evidence: string, shown: string): string {
  const suffix = `\n(Reported result: ${shown})`;
  const room = 1000 - suffix.length;
  const kept =
    evidence.length <= room ? evidence : `${evidence.slice(0, room - 1)}…`;
  return `${kept}${suffix}`;
}

function shownResult(value: unknown): string {
  if (typeof value !== "string")
    return value === undefined ? "none" : "not text";
  const s = cleanReportText(value, false).trim();
  if (!s) return "empty";
  const clip =
    s.length > RESULT_ECHO_MAX ? `${s.slice(0, RESULT_ECHO_MAX - 1)}…` : s;
  return `"${clip.replace(/`/g, "'")}"`;
}

/** The rows in cost order, cheapest first, keeping the order within a
 *  cost. The same array when they already are. */
function cheapestFirst(rows: EvidenceRow[]): EvidenceRow[] {
  const rank = (r: EvidenceRow) => COSTS.indexOf(r.cost);
  if (rows.every((r, i) => i === 0 || rank(rows[i - 1]) <= rank(r)))
    return rows;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/**
 * The evidence table. Refused only when no row is usable. Otherwise rows
 * are repaired with a warning: an unknown cost is recorded as expensive,
 * an unknown result as inconclusive, long text is cut, a bad source is
 * dropped, a row without a step or a repeated row is dropped, and rows out
 * of cost order are sorted cheapest-first.
 */
function attemptsOf(value: unknown, warnings: string[]): Result<EvidenceRow[]> {
  const items = listOf(value, "attempts", ATTEMPTS_MAX, warnings);
  if (items.length === 0)
    return reject("attempts", "The evidence table is empty");
  const rows: EvidenceRow[] = [];
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const at = `Attempt ${i + 1}`;
    if (!isRecord(item)) {
      warnings.push(`${at} was not an object; dropped`);
      continue;
    }
    const rawStep = cleanText(item.step);
    if (!rawStep) {
      warnings.push(`${at} had no step; dropped`);
      continue;
    }
    const step = fitted(rawStep, 200, `${at}'s step`, warnings);
    let evidence = cleanText(item.evidence, true);
    if (!evidence) {
      warnings.push(`${at} (${step}) had no evidence`);
      evidence = NO_EVIDENCE;
    }
    evidence = fitted(evidence, 1000, `${at}'s evidence`, warnings);
    let cost = normaliseCost(item.cost);
    if (cost === null) {
      cost = "expensive";
      warnings.push(
        `${at} (${step}) had cost ${shownValue(item.cost)}, not one of ${COSTS.join(", ")}; recorded as expensive`,
      );
    }
    let result = normaliseResult(item.result);
    if (result === null) {
      const shown = shownResult(item.result);
      result = "inconclusive";
      evidence = withReportedResult(evidence, shown);
      warnings.push(
        `${at} (${step}) had result ${shown}, not one of ${RESULT_VALUES}; recorded as inconclusive`,
      );
    }
    const s = keptSource(item.source, at, warnings);
    const row: EvidenceRow = {
      step,
      cost,
      result,
      evidence,
      ...(s ? { source: s } : {}),
    };
    const key = JSON.stringify([step, cost, result, evidence, s ?? null]);
    if (seen.has(key)) {
      warnings.push(`${at} (${step}) repeated an earlier attempt; dropped`);
      continue;
    }
    seen.add(key);
    rows.push(row);
  }
  if (rows.length === 0)
    return reject("attempts", "No row of attempts has a step");
  const sorted = cheapestFirst(rows);
  if (sorted !== rows)
    warnings.push("The attempts were not cheapest-first; sorted by cost");
  return sorted;
}

/** The investigator's claims. A claim without text is dropped, long text
 *  is cut, a bad source is dropped, and a repeated claim is kept once. */
function claimsOf(value: unknown, warnings: string[]): Claim[] {
  const items = listOf(value, "claims", CLAIMS_MAX, warnings);
  const out: Claim[] = [];
  for (const [i, item] of items.entries()) {
    const at = `Claim ${i + 1}`;
    const record = isRecord(item) ? item : { text: item };
    const raw = cleanText(record.text);
    if (!raw) {
      warnings.push(`${at} had no text; dropped`);
      continue;
    }
    const t = fitted(raw, 500, `${at}'s text`, warnings);
    if (out.some((c) => c.text === t)) {
      warnings.push(`${at} repeated an earlier claim; kept once`);
      continue;
    }
    const s = keptSource(record.source, at, warnings);
    out.push({ text: t, ...(s ? { source: s } : {}) });
  }
  return out;
}

/**
 * The report's suggested next steps, read tolerantly: a step with an
 * unknown kind or target, or no title, is dropped with a warning; long
 * text is cut; steps past NEXT_STEPS_MAX are dropped. Never an error, so a
 * bad suggestion cannot cost the report.
 */
function nextStepsOf(value: unknown, warnings: string[]): NextStep[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push("nextSteps was not a list; dropped");
    return [];
  }
  const out: NextStep[] = [];
  for (const [i, item] of value.entries()) {
    const at = `Next step ${i + 1}`;
    if (out.length === NEXT_STEPS_MAX) {
      warnings.push(
        `Only ${NEXT_STEPS_MAX} next steps are kept; dropped ${value.length - i} more`,
      );
      break;
    }
    if (!isRecord(item)) {
      warnings.push(`${at} was not an object; dropped`);
      continue;
    }
    const title = clipped(item.title, NEXT_STEP_TITLE_MAX);
    if (!title) {
      warnings.push(`${at} had no title; dropped`);
      continue;
    }
    const why = clipped(item.why, NEXT_STEP_WHY_MAX);
    const kind = typeof item.kind === "string" ? item.kind.trim() : item.kind;
    if (!(NEXT_STEP_KINDS as readonly unknown[]).includes(kind)) {
      warnings.push(
        `${at} (${title}) had kind ${shownValue(item.kind)}, not one of ${NEXT_STEP_KINDS.join(", ")}; dropped`,
      );
      continue;
    }
    switch (kind as NextStepKind) {
      case "send-back": {
        // The title stands in for a missing note: it says what to do.
        const note = clipped(item.payload, SEND_BACK_NOTE_MAX, true) || title;
        out.push({ kind: "send-back", title, why, payload: note });
        break;
      }
      case "open-settings": {
        const target =
          typeof item.payload === "string"
            ? item.payload.trim().toLowerCase()
            : item.payload;
        if (!(NEXT_STEP_TARGETS as readonly unknown[]).includes(target)) {
          warnings.push(
            `${at} (${title}) opens ${shownValue(item.payload)}, not one of ${NEXT_STEP_TARGETS.join(", ")}; dropped`,
          );
          continue;
        }
        out.push({
          kind: "open-settings",
          title,
          why,
          payload: target as NextStepTarget,
        });
        break;
      }
      case "close-provider":
        out.push({ kind: "close-provider", title, why });
        break;
    }
  }
  return out;
}

export interface InvestigatorReportContext {
  actionIds: ReadonlySet<string>;
  /** Kind of each project action; a `deploy` runs only with the PR. */
  actionKinds: ReadonlyMap<string, ActionKind>;
  signalOrigin: string | null;
  /** The signal's own method and path. A request check may send anything
   *  but GET or HEAD only when it matches both. */
  signalRequest?: { method: "GET" | "HEAD" | "POST"; path: string } | null;
  /** Receives a line for each value Sessions repaired instead of refusing
   *  the report. Filled only when the report parses. */
  warnings?: string[];
}

/** An action id as the project spells it, matched without case. */
function actionId(
  value: unknown,
  ids: ReadonlySet<string>,
  warnings: string[],
): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (ids.has(id)) return id;
  const match = [...ids].find(
    (known) => known.toLowerCase() === id.toLowerCase(),
  );
  if (match) warnings.push(`Action ${shownValue(value)} read as "${match}"`);
  return match ?? null;
}

/**
 * The candidate plan. Missing, or with no usable pr flag, the report has no
 * decision and is refused. An action the project does not have, a deploy
 * without the PR, or more than five actions are refused too: Sessions
 * runs these on production and does not guess which were meant. A deploy
 * listed beside the PR is dropped (it runs with the PR anyway) and a
 * repeated action is kept once.
 */
function candidateOf(
  value: unknown,
  ctx: Pick<InvestigatorReportContext, "actionIds" | "actionKinds">,
  warnings: string[],
): Result<CandidatePlan | null> {
  if (value === null) return null;
  if (value === undefined)
    return reject(
      "candidate",
      "Set candidate to { pr, actions }, or to null and explain noCandidateReason",
    );
  if (!isRecord(value))
    return reject(
      "candidate",
      "The candidate field must be null or { pr, actions }",
    );
  const pr = booleanOf(value.pr);
  if (pr === null)
    return reject("candidate", "The candidate.pr field must be true or false");
  if (typeof value.pr !== "boolean")
    warnings.push(`candidate.pr was ${shownValue(value.pr)}; read as ${pr}`);
  let raw = value.actions ?? [];
  if (typeof raw === "string") {
    warnings.push("candidate.actions was not a list; read as a list of one");
    raw = [raw];
  }
  if (!Array.isArray(raw))
    return reject(
      "actions",
      "The candidate.actions field must be a list of action ids",
    );
  const actions: string[] = [];
  const unknown: string[] = [];
  let deployWithoutPr = false;
  for (const entry of raw) {
    const id = actionId(entry, ctx.actionIds, warnings);
    if (id === null) {
      unknown.push(`"${String(entry)}"`);
      continue;
    }
    if (ctx.actionKinds.get(id) === "deploy") {
      if (!pr) {
        deployWithoutPr = true;
        continue;
      }
      warnings.push(
        `Action "${id}" is a deploy, which runs with the PR; dropped from the actions`,
      );
      continue;
    }
    if (actions.includes(id)) {
      warnings.push(`Action "${id}" was listed twice; kept once`);
      continue;
    }
    actions.push(id);
  }
  const wrong = [
    ...(unknown.length
      ? [`Unknown action${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`]
      : []),
    ...(deployWithoutPr ? ["Deploy runs only with the PR"] : []),
    ...(actions.length > CANDIDATE_ACTIONS_MAX
      ? [`Propose at most ${CANDIDATE_ACTIONS_MAX} actions`]
      : []),
  ];
  if (wrong.length) return reject("actions", wrong.join("; "));
  if (!pr && actions.length === 0)
    return reject(
      "candidate",
      "The candidate field needs a PR or at least one action",
    );
  return { pr, actions };
}

/**
 * How the candidate is proven. A request check stays strict: it must use
 * the signal's own origin, and only the signal's own method and path may
 * send anything but GET or HEAD. Kind is matched loosely and a missing
 * after-deploy reason is filled in.
 */
function checkOf(
  value: unknown,
  ctx: Pick<InvestigatorReportContext, "signalOrigin" | "signalRequest">,
  warnings: string[],
): Result<CandidateCheck> {
  const { signalOrigin } = ctx;
  const bad = reject(
    "check",
    "The check field must be a request or after-deploy check",
  );
  if (!isRecord(value)) return bad;
  const kind = enumKey(value.kind)?.replace(/^afterdeploy$/, "after-deploy");
  if (kind === "after-deploy") {
    let reason = cleanText(value.reason, true);
    if (!reason) {
      warnings.push("check.reason was missing");
      reason = "No reason given.";
    }
    return {
      kind: "after-deploy",
      reason: fitted(reason, 500, "check.reason", warnings),
    };
  }
  if (kind !== "request") return bad;
  if (signalOrigin === null)
    return reject("check", "A request check needs an http signal");
  const validated = validateSource(value.source);
  if ("error" in validated)
    return reject(
      "check",
      `The check.source field is not valid: ${validated.error}`,
    );
  if (validated.kind !== "http")
    return reject("check", "A request check needs an http source");
  let origin: string;
  let path: string;
  try {
    const url = new URL(validated.url);
    origin = url.origin;
    path = url.pathname;
  } catch {
    return reject(
      "check",
      "The check.source field is not valid: The URL is not valid",
    );
  }
  if (origin !== signalOrigin)
    return reject(
      "check",
      `A request check must use the signal's own origin ${signalOrigin}`,
    );
  const method = validated.method ?? "GET";
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    (ctx.signalRequest?.method !== method || ctx.signalRequest.path !== path)
  )
    return reject(
      "check",
      "A request check must use GET or HEAD unless the signal sends that method to that path",
    );
  return { kind: "request", source: validated };
}

/** The runbooks the PR updates. A path outside the runbooks is dropped
 *  with a warning; none left means the main runbook. */
function runbookPathsOf(value: unknown, warnings: string[]): string[] {
  const items = listOf(value, "runbookPaths", RUNBOOK_PATHS_MAX, warnings);
  const out: string[] = [];
  for (const item of items) {
    const path = repoPath(item);
    if (path !== RUNBOOK && !RUNBOOK_PATH.test(path)) {
      warnings.push(
        `runbookPaths ${shownValue(item)} is not ${RUNBOOK} or docs/incidents/runbooks/<slug>.md; dropped`,
      );
      continue;
    }
    if (!out.includes(path)) out.push(path);
  }
  if (out.length === 0) {
    warnings.push(`runbookPaths named no runbook; read as ${RUNBOOK}`);
    out.push(RUNBOOK);
  }
  return out;
}

/**
 * The investigator's report. Refused only when something essential is
 * missing or unusable: the block itself, the summary or cause, every row
 * of evidence, the candidate decision, a candidate's actions, check,
 * claims or note. Everything else is repaired and each repair is noted
 * in `ctx.warnings`.
 */
export function parseInvestigatorReport(
  report: string,
  ctx: InvestigatorReportContext,
): InvestigatorReport | ReportRejection {
  const parsed = parseBlock(report);
  if ("error" in parsed) return rejected([parsed], false);
  const value = parsed.value;
  const repaired: string[] = [];
  const issues: ReportRuleIssue[] = [];
  checkRole(value.role, "investigator", repaired);
  const rawSummary = cleanText(value.summary);
  if (!rawSummary)
    issues.push(reject("summary", "The summary field must say what broke"));
  const summary = fitted(rawSummary, 200, "summary", repaired);
  const rawCause = cleanText(value.cause, true);
  if (!rawCause)
    issues.push(reject("cause", "The cause field must say what caused it"));
  const cause = fitted(rawCause, 1000, "cause", repaired);
  const readFirst = readFirstOf(value.readFirst, repaired);
  const table = attemptsOf(value.attempts, repaired);
  if (failed(table)) issues.push(table);
  const attempts = failed(table) ? [] : table;
  const plan = candidateOf(value.candidate, ctx, repaired);
  if (failed(plan)) issues.push(plan);
  const candidate = failed(plan) ? null : plan;
  // A candidate that is there but unusable still needs what every
  // candidate needs, so those problems come back in the same reply.
  const proposes = failed(plan) ? isRecord(value.candidate) : plan !== null;
  let noCandidateReason: string | undefined;
  if (!proposes) {
    const reason = cleanText(value.noCandidateReason, true);
    if (reason)
      noCandidateReason = fitted(reason, 1000, "noCandidateReason", repaired);
    else
      repaired.push(
        "noCandidateReason was missing; the cause stands in for it",
      );
  }
  let check = checkOf(value.check, ctx, repaired);
  if (failed(check)) {
    if (proposes) issues.push(check);
    else if (value.check !== undefined && value.check !== null)
      repaired.push(
        `Ignored the check, as there is no candidate: ${check.error}`,
      );
    check = { kind: "after-deploy", reason: "No fix was proposed." };
  }
  const claims = claimsOf(value.claims, repaired);
  if (proposes && claims.length === 0)
    issues.push(reject("claims", "Give at least one claim for the candidate"));
  const cited = new Set(attempts.flatMap((a) => (a.source ? [a.source] : [])));
  const citedClaims = claims.map((claim, i) => {
    if (claim.source === undefined || cited.has(claim.source)) return claim;
    repaired.push(
      `Claim ${i + 1} cites a source that is not in the evidence table; dropped the source`,
    );
    return { text: claim.text };
  });
  let notePath = repoPath(value.notePath);
  if (!NOTE_PATH.test(notePath)) {
    if (proposes)
      issues.push(
        reject(
          "note",
          "The notePath field must be docs/incidents/YYYY-MM-DD-<slug>.md",
        ),
      );
    else
      repaired.push(
        `notePath ${shownValue(value.notePath)} is not docs/incidents/YYYY-MM-DD-<slug>.md; ignored, as there is no candidate`,
      );
    notePath = "";
  }
  if (issues.length) return rejected(issues, proposes);
  const runbookPaths = runbookPathsOf(value.runbookPaths, repaired);
  const nextSteps = nextStepsOf(value.nextSteps, repaired);
  ctx.warnings?.push(...repaired);
  return {
    role: "investigator",
    summary,
    cause,
    readFirst,
    attempts,
    candidate,
    ...(noCandidateReason !== undefined ? { noCandidateReason } : {}),
    check,
    claims: citedClaims,
    notePath,
    runbookPaths,
    ...(nextSteps.length ? { nextSteps } : {}),
  };
}

/** How far a ruling is from verified; the less certain ruling wins. */
const STATUS_DOUBT: Record<ClaimStatus, number> = {
  verified: 0,
  unverifiable: 1,
  refuted: 2,
};

function normaliseVerdict(value: unknown): "certain" | "not-certain" | null {
  const key = enumKey(value);
  if (!key) return null;
  if (key === "certain") return "certain";
  return "not-certain";
}

function normaliseStatus(value: unknown): ClaimStatus | null {
  const key = enumKey(value);
  if (key === null) return null;
  if ((CLAIM_STATUSES as string[]).includes(key)) return key as ClaimStatus;
  return STATUS_SYNONYMS[key] ?? null;
}

/**
 * The verifier's report. Refused only when the block, the verdict or a
 * ruling on a listed claim is missing. Otherwise repaired with a warning
 * in `ctx.warnings`, always toward less certainty: an unknown verdict is
 * not-certain, an unknown status or a ruling without evidence is
 * unverifiable, a missing proofAccepted is false, and of two rulings on
 * one claim the less certain is kept.
 */
export function parseVerifierReport(
  report: string,
  ctx: { claims: Claim[]; warnings?: string[] },
): VerifierReport | ReportRejection {
  const parsed = parseBlock(report);
  if ("error" in parsed) return rejected([parsed], false);
  const value = parsed.value;
  const repaired: string[] = [];
  const issues: ReportRuleIssue[] = [];
  checkRole(value.role, "verifier", repaired);
  const verdict = normaliseVerdict(value.verdict);
  if (verdict === null)
    issues.push(
      reject("verdict", "The verdict field must be certain or not-certain"),
    );
  else if (value.verdict !== verdict)
    repaired.push(
      `verdict was ${shownValue(value.verdict)}; read as ${verdict}`,
    );
  const reasons: string[] = [];
  for (const [i, r] of listOf(
    value.reasons,
    "reasons",
    REASONS_MAX,
    repaired,
  ).entries()) {
    const t = cleanText(r, true);
    if (!t) {
      repaired.push(`Reason ${i + 1} was empty; dropped`);
      continue;
    }
    reasons.push(fitted(t, 500, `Reason ${i + 1}`, repaired));
  }
  if (verdict === "not-certain" && reasons.length === 0) {
    repaired.push("A not-certain verdict gave no reason");
    reasons.push("The verifier gave no reason.");
  }
  let proofAccepted = booleanOf(value.proofAccepted);
  if (proofAccepted === null) {
    repaired.push(
      `proofAccepted was ${shownValue(value.proofAccepted)}; read as false`,
    );
    proofAccepted = false;
  } else if (typeof value.proofAccepted !== "boolean")
    repaired.push(
      `proofAccepted was ${shownValue(value.proofAccepted)}; read as ${proofAccepted}`,
    );
  const expected = ctx.claims.map((c) => c.text.trim());
  const byKey = new Map(expected.map((t) => [claimKey(t), t]));
  const checks = new Map<string, ClaimCheck>();
  for (const [i, item] of listOf(
    value.claims,
    "claims",
    VERIFIER_CLAIMS_MAX,
    repaired,
  ).entries()) {
    const at = `Claim ${i + 1}`;
    if (!isRecord(item)) {
      repaired.push(`${at} was not an object; dropped`);
      continue;
    }
    // Claims reach the verifier in a data block, where backticks are plain
    // quotes; claimKey reads both alike.
    const quoted = cleanText(item.text);
    const text = quoted ? byKey.get(claimKey(quoted)) : undefined;
    if (text === undefined) {
      repaired.push(
        `${at} ${quoted ? `("${quoted.slice(0, RESULT_ECHO_MAX)}") is not one of the listed claims` : "had no text"}; dropped`,
      );
      continue;
    }
    let status = normaliseStatus(item.status);
    if (status === null) {
      repaired.push(
        `${at} had status ${shownValue(item.status)}, not one of ${CLAIM_STATUSES.join(", ")}; recorded as unverifiable`,
      );
      status = "unverifiable";
    }
    let evidence = cleanText(item.evidence, true);
    if (!evidence) {
      evidence = NO_EVIDENCE;
      if (status === "verified") {
        status = "unverifiable";
        repaired.push(`${at} had no evidence; recorded as unverifiable`);
      } else repaired.push(`${at} had no evidence`);
    }
    evidence = fitted(evidence, 1000, `${at}'s evidence`, repaired);
    const s = keptSource(item.source, at, repaired);
    const prior = checks.get(text);
    if (prior) {
      repaired.push(
        `${at} ruled on a claim twice; kept the less certain ruling`,
      );
      if (STATUS_DOUBT[status] <= STATUS_DOUBT[prior.status]) continue;
    }
    checks.set(text, {
      text,
      status,
      evidence,
      ...(s ? { source: s } : {}),
    });
  }
  const missing = expected.filter((t) => !checks.has(t));
  if (missing.length)
    issues.push(
      reject(
        "rulings",
        `Check every claim: missing ${missing.map((t) => `"${t}"`).join(", ")}`,
      ),
    );
  if (verdict === null || issues.length) return rejected(issues, false);
  ctx.warnings?.push(...repaired);
  return {
    role: "verifier",
    verdict,
    reasons,
    claims: expected.map((t) => checks.get(t)!),
    proofAccepted,
  };
}

export interface KnowledgeCheck {
  note: boolean;
  runbook: boolean;
}

export function checkKnowledge(
  prFiles: string[] | null,
  candidate: Pick<CandidateState, "notePath" | "runbookPaths">,
): KnowledgeCheck {
  if (prFiles === null) return { note: false, runbook: false };
  return {
    note: prFiles.includes(candidate.notePath),
    runbook: candidate.runbookPaths.some((p) => prFiles.includes(p)),
  };
}

export function effectiveVerdict(input: {
  report: VerifierReport;
  proof: ProofResult;
  knowledge: KnowledgeCheck;
}): { verdict: "certain" | "not-certain"; reasons: string[] } {
  const { report, proof, knowledge } = input;
  const reasons: string[] = [];
  if (report.verdict === "not-certain") reasons.push(...report.reasons);
  for (const claim of report.claims)
    if (claim.status !== "verified")
      reasons.push(`Claim not verified: ${claim.text}`);
  if (proof.baseline.verdict !== "fails")
    reasons.push("The baseline did not fail with the incident's signal");
  if (
    proof.candidate.kind === "request" &&
    proof.candidate.verdict !== "passes"
  )
    reasons.push(
      `The candidate check did not pass from production${proof.candidate.refused ? `: ${proof.candidate.refused}` : ""}`,
    );
  if (proof.candidate.kind === "after-deploy" && !report.proofAccepted)
    reasons.push("The verifier did not accept proving this after release");
  if (!knowledge.note) reasons.push("The incident note is missing from the PR");
  if (!knowledge.runbook) reasons.push("The runbook was not updated in the PR");
  return reasons.length === 0 && report.verdict === "certain"
    ? { verdict: "certain", reasons: [] }
    : { verdict: "not-certain", reasons };
}
