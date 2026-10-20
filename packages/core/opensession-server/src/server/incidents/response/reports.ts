// The `incident-report` contract. Each agent ends its final message with
// exactly one fenced block tagged `incident-report` holding a JSON report
// (only the last 256 KB of a message are read, a block is at most 64 KB). Errors are
// short, name the field, and go back to the agent verbatim. Unknown keys are
// dropped. `effectiveVerdict` turns the verifier's verdict into the one
// Sessions acts on: certainty it cannot back becomes not certain.
import type {
  ActionKind,
  CandidatePlan,
  CandidateCheck,
  CandidateState,
  Claim,
  ClaimCheck,
  ClaimStatus,
  EvidenceCost,
  EvidenceRow,
  InvestigatorReport,
  ProofResult,
  ReadFirst,
  VerifierReport,
} from "../../../shared/incident-response";
import { validateSource } from "../signal-validation";

export const REPORT_FENCE = "incident-report";

const RUNBOOK = "docs/incidents/runbook.md";
const NOTE_PATH = /^docs\/incidents\/\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,60}\.md$/;
const RUNBOOK_PATH = /^docs\/incidents\/runbooks\/[a-z0-9-]{1,60}\.md$/;
const COSTS: EvidenceCost[] = ["free", "cheap", "expensive"];
const RESULTS: EvidenceRow["result"][] = [
  "ruled-out",
  "confirmed",
  "inconclusive",
];
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

type Result<T> = T | { error: string };
function failed<T>(r: Result<T>): r is { error: string } {
  return (
    typeof r === "object" && r !== null && !Array.isArray(r) && "error" in r
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Wrapped, so a report with its own `error` key is not taken for a failure. */
function parseBlock(
  text: string,
): { value: Record<string, unknown> } | { error: string } {
  const blocks = reportBlocks(text);
  if (blocks.length === 0) return { error: "No incident-report block" };
  if (blocks.length > 1)
    return { error: "End with exactly one incident-report block" };
  const block = blocks[0];
  if (Buffer.byteLength(block, "utf8") > REPORT_BLOCK_MAX_BYTES)
    return { error: "The incident-report block is too large" };
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch {
    return { error: "The incident-report block is not valid JSON" };
  }
  if (!isRecord(value))
    return { error: "The incident-report block must be a JSON object" };
  return { value };
}

function text(
  value: unknown,
  field: string,
  max: number,
  min = 1,
): Result<string> {
  const s = typeof value === "string" ? value.trim() : "";
  if (typeof value !== "string" || s.length < min || s.length > max)
    return { error: `The ${field} field must be ${min} to ${max} characters` };
  return s;
}

function list(
  value: unknown,
  field: string,
  min: number,
  max: number,
): Result<unknown[]> {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    return {
      error: `The ${field} field must be a list of ${min} to ${max} entries`,
    };
  return value;
}

/** An http(s) URL or a repository path, at most 2048 characters. */
function source(value: unknown, field: string): Result<string | undefined> {
  if (value === undefined || value === null || value === "") return undefined;
  const bad = {
    error: `The ${field} field must be an http(s) URL or a repository path`,
  };
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\u0000]/.test(value)
  )
    return bad;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? value
        : bad;
    } catch {
      return bad;
    }
  }
  if (value.startsWith("/") || value.split("/").includes("..")) return bad;
  return value;
}

function claimsOf(value: unknown): Result<Claim[]> {
  const items = list(value ?? [], "claims", 0, 30);
  if (failed(items)) return items;
  const out: Claim[] = [];
  for (const [i, item] of items.entries()) {
    if (!isRecord(item)) return { error: `Claim ${i + 1} must be an object` };
    const t = text(item.text, `claims[${i}].text`, 500);
    if (failed(t)) return t;
    const s = source(item.source, `claims[${i}].source`);
    if (failed(s)) return s;
    out.push({ text: t, ...(s ? { source: s } : {}) });
  }
  return out;
}

function readFirstOf(value: unknown): Result<ReadFirst[]> {
  const items = list(value, "readFirst", 1, 20);
  if (failed(items)) return items;
  const out: ReadFirst[] = [];
  for (const [i, item] of items.entries()) {
    if (!isRecord(item) || typeof item.found !== "boolean")
      return { error: `The readFirst[${i}] entry needs a path and found` };
    const path = text(item.path, `readFirst[${i}].path`, 512);
    if (failed(path)) return path;
    out.push({ path, found: item.found });
  }
  if (!out.some((r) => r.path === RUNBOOK))
    return { error: `List ${RUNBOOK} in readFirst, found or not` };
  return out;
}

function attemptsOf(value: unknown): Result<EvidenceRow[]> {
  if (Array.isArray(value) && value.length === 0)
    return { error: "The evidence table is empty" };
  const items = list(value, "attempts", 1, 40);
  if (failed(items)) return items;
  const out: EvidenceRow[] = [];
  for (const [i, item] of items.entries()) {
    if (!isRecord(item))
      return { error: `Row ${i + 1} of attempts must be an object` };
    const step = text(item.step, `attempts[${i}].step`, 200);
    if (failed(step)) return step;
    const evidence = text(item.evidence, `attempts[${i}].evidence`, 1000);
    if (failed(evidence)) return evidence;
    if (!COSTS.includes(item.cost as EvidenceCost))
      return {
        error: `The attempts[${i}].cost field must be free, cheap or expensive`,
      };
    if (!RESULTS.includes(item.result as EvidenceRow["result"]))
      return {
        error: `The attempts[${i}].result field must be ruled-out, confirmed or inconclusive`,
      };
    const s = source(item.source, `attempts[${i}].source`);
    if (failed(s)) return s;
    const cost = item.cost as EvidenceCost;
    const previous = out.at(-1);
    if (previous && COSTS.indexOf(cost) < COSTS.indexOf(previous.cost))
      return {
        error: `Work cheapest-first: row ${i + 1} is ${cost} after ${previous.cost}`,
      };
    out.push({
      step,
      cost,
      result: item.result as EvidenceRow["result"],
      evidence,
      ...(s ? { source: s } : {}),
    });
  }
  return out;
}

export interface InvestigatorReportContext {
  actionIds: ReadonlySet<string>;
  /** Kind of each project action; a `deploy` runs only with the PR. */
  actionKinds: ReadonlyMap<string, ActionKind>;
  signalOrigin: string | null;
}

function candidateOf(
  value: unknown,
  ctx: Pick<InvestigatorReportContext, "actionIds" | "actionKinds">,
): Result<CandidatePlan | null> {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.pr !== "boolean")
    return { error: "The candidate field must be null or { pr, actions }" };
  const actions = list(value.actions ?? [], "candidate.actions", 0, 5);
  if (failed(actions)) return actions;
  const seen = new Set<string>();
  for (const id of actions) {
    if (typeof id !== "string" || !ctx.actionIds.has(id))
      return { error: `Unknown action "${String(id)}"` };
    if (ctx.actionKinds.get(id) === "deploy")
      return { error: "Deploy runs only with the PR" };
    if (seen.has(id)) return { error: `List each action once: "${id}"` };
    seen.add(id);
  }
  if (!value.pr && actions.length === 0)
    return { error: "The candidate field needs a PR or at least one action" };
  return { pr: value.pr, actions: [...(actions as string[])] };
}

function checkOf(
  value: unknown,
  signalOrigin: string | null,
): Result<CandidateCheck> {
  if (!isRecord(value))
    return { error: "The check field must be a request or after-deploy check" };
  if (value.kind === "after-deploy") {
    const reason = text(value.reason, "check.reason", 500);
    if (failed(reason)) return reason;
    return { kind: "after-deploy", reason };
  }
  if (value.kind !== "request")
    return { error: "The check field must be a request or after-deploy check" };
  if (signalOrigin === null)
    return { error: "A request check needs an http signal" };
  const validated = validateSource(value.source);
  if ("error" in validated)
    return { error: `The check.source field is not valid: ${validated.error}` };
  if (validated.kind !== "http")
    return { error: "A request check needs an http source" };
  let origin: string;
  try {
    origin = new URL(validated.url).origin;
  } catch {
    return {
      error: "The check.source field is not valid: The URL is not valid",
    };
  }
  if (origin !== signalOrigin)
    return {
      error: `A request check must use the signal's own origin ${signalOrigin}`,
    };
  return { kind: "request", source: validated };
}

export function parseInvestigatorReport(
  report: string,
  ctx: InvestigatorReportContext,
): InvestigatorReport | { error: string } {
  const parsed = parseBlock(report);
  if ("error" in parsed) return parsed;
  const value = parsed.value;
  if (value.role !== "investigator")
    return { error: "The role field must be investigator" };
  const summary = text(value.summary, "summary", 200);
  if (failed(summary)) return summary;
  const cause = text(value.cause, "cause", 1000);
  if (failed(cause)) return cause;
  const readFirst = readFirstOf(value.readFirst);
  if (failed(readFirst)) return readFirst;
  const attempts = attemptsOf(value.attempts);
  if (failed(attempts)) return attempts;
  const candidate = candidateOf(value.candidate, ctx);
  if (failed(candidate)) return candidate;
  let noCandidateReason: string | undefined;
  if (candidate === null) {
    const reason = text(value.noCandidateReason, "noCandidateReason", 1000);
    if (failed(reason))
      return { error: "Explain noCandidateReason when there is no candidate" };
    noCandidateReason = reason;
  }
  const check = checkOf(value.check, ctx.signalOrigin);
  if (failed(check)) return check;
  const claims = claimsOf(value.claims);
  if (failed(claims)) return claims;
  if (typeof value.notePath !== "string" || !NOTE_PATH.test(value.notePath))
    return {
      error: "The notePath field must be docs/incidents/YYYY-MM-DD-<slug>.md",
    };
  const runbookPaths = list(value.runbookPaths, "runbookPaths", 1, 5);
  if (failed(runbookPaths)) return runbookPaths;
  for (const path of runbookPaths)
    if (
      typeof path !== "string" ||
      (path !== RUNBOOK && !RUNBOOK_PATH.test(path))
    )
      return {
        error: `The runbookPaths field may hold only ${RUNBOOK} or docs/incidents/runbooks/<slug>.md`,
      };
  return {
    role: "investigator",
    summary,
    cause,
    readFirst,
    attempts,
    candidate,
    ...(noCandidateReason !== undefined ? { noCandidateReason } : {}),
    check,
    claims,
    notePath: value.notePath,
    runbookPaths: [...(runbookPaths as string[])],
  };
}

export function parseVerifierReport(
  report: string,
  ctx: { claims: Claim[] },
): VerifierReport | { error: string } {
  const parsed = parseBlock(report);
  if ("error" in parsed) return parsed;
  const value = parsed.value;
  if (value.role !== "verifier")
    return { error: "The role field must be verifier" };
  if (value.verdict !== "certain" && value.verdict !== "not-certain")
    return { error: "The verdict field must be certain or not-certain" };
  const reasonItems = list(value.reasons ?? [], "reasons", 0, 20);
  if (failed(reasonItems)) return reasonItems;
  const reasons: string[] = [];
  for (const [i, r] of reasonItems.entries()) {
    const t = text(r, `reasons[${i}]`, 500);
    if (failed(t)) return t;
    reasons.push(t);
  }
  if (value.verdict === "not-certain" && reasons.length === 0)
    return {
      error:
        "Give at least one entry in reasons when the verdict is not-certain",
    };
  if (typeof value.proofAccepted !== "boolean")
    return { error: "The proofAccepted field must be true or false" };
  const checkItems = list(value.claims ?? [], "claims", 0, 60);
  if (failed(checkItems)) return checkItems;
  const checks = new Map<string, ClaimCheck>();
  for (const [i, item] of checkItems.entries()) {
    if (!isRecord(item)) return { error: `Claim ${i + 1} must be an object` };
    const t = text(item.text, `claims[${i}].text`, 500);
    if (failed(t)) return t;
    if (!CLAIM_STATUSES.includes(item.status as ClaimStatus))
      return {
        error: `The claims[${i}].status field must be verified, refuted or unverifiable`,
      };
    const evidence = text(item.evidence, `claims[${i}].evidence`, 1000);
    if (failed(evidence)) return evidence;
    const s = source(item.source, `claims[${i}].source`);
    if (failed(s)) return s;
    if (checks.has(t)) return { error: `Check each claim once: "${t}"` };
    checks.set(t, {
      text: t,
      status: item.status as ClaimStatus,
      evidence,
      ...(s ? { source: s } : {}),
    });
  }
  const expected = ctx.claims.map((c) => c.text.trim());
  for (const t of expected)
    if (!checks.has(t)) return { error: `Check every claim: missing "${t}"` };
  for (const t of checks.keys())
    if (!expected.includes(t))
      return { error: `Check only the listed claims: "${t}"` };
  return {
    role: "verifier",
    verdict: value.verdict,
    reasons,
    claims: expected.map((t) => checks.get(t)!),
    proofAccepted: value.proofAccepted,
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
