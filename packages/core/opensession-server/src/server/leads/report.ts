// Where a lead's proposals and digest notes go: the supervisor inbox of the
// person the lead answers to (adrs/supervisor-and-leads.md, section 5). A
// proposal is a needs-you item with numbered options, the first one
// recommended; a digest note is one fyi item per day. Repeats about the
// same subject update one item instead of adding another. Every proposal
// is audited with the rule that decided it. The server writes each item's
// title and the rule line. The body leads with the lead's ```say fence (or,
// without one, its first paragraph), what Blob says when it presents the
// decision (say and show, blob-surface.ts); the rule, the lead's title and
// the rest follow.
//
// A proposal may carry typed steps, a condition and an expiry (the lead act
// stage, approvals.ts). The server checks them, records them bound to the
// item and its revision, and ends the body with lines the lead can't word:
// when the steps run, each step in fixed copy, and when they expire.
import type { SignalRule } from "../../shared/incidents";
import {
  LEAD_CATEGORY_LABELS,
  type LeadCategory,
  type LeadDecision,
} from "../../shared/project-lead";
import type { ProjectSettingsDocument } from "../../shared/project-settings";
import type { MailAddress, SupportConversation } from "../../shared/support";
import { auditDurable, digest } from "../audit";
import type { TeamMember } from "../config";
import {
  instanceOwner,
  instanceOwnerMember,
  personOwner,
  rosterMember,
} from "../incidents/owner";
import { BLOB_ACTOR } from "../session-actors";
import {
  SUPERVISOR_BODY_LEN,
  listSupervisorItems,
  postSupervisorItem,
  type PostDelivery,
} from "../supervisor-inbox";
import {
  type LeadStep,
  type SignalPatchAfter,
  type Valid,
  type ValidProposalInput,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  MAX_STEPS,
  STEP_CATEGORIES,
  recordProposal,
  stepFitsCategory,
  validateLeadCondition,
  validateLeadSteps,
  validateProposalInput,
  voidFor,
} from "./approvals";
import { describeCondition, type LeadCondition } from "./conditions";

/** `proposal`: something the lead suggests; `needs-you`: something only the
 *  owner may do, prepared by the lead. */
export const LEAD_PROPOSAL_KINDS = ["proposal", "needs-you"] as const;
export type LeadProposalKind = (typeof LEAD_PROPOSAL_KINDS)[number];

export interface LeadProposal {
  kind: LeadProposalKind;
  category: LeadCategory;
  title: string;
  body: string;
  /** The owner's choices, the recommended one first. */
  options: string[];
  /** What the proposal is about, stable across wakes (a signal id and the
   *  rule field, a PR number); the title stands in when absent. */
  subject?: string;
  /** The rules' verdict on the action, with the rule that made it. */
  decision: LeadDecision;
  /** What the owner's approval runs, checked by `checkLeadAct`. */
  act?: LeadAct;
}

export type LeadDelivery =
  | {
      queued: true;
      itemId: string;
      created: boolean;
      delivery: PostDelivery;
      /** The recorded proposal, when it carried steps. */
      proposalId?: string;
    }
  | { queued: false; reason: string };

const NOBODY =
  "Nobody to report to: set the lead's owner in the project settings";

/** Why the lead may not report now, or null: it is off, or the project's
 *  kill switch is on. */
export function leadReportRefusal(
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
): string | null {
  if (!doc.lead.enabled) return "The lead is off in the project settings";
  if (doc.incidents.agentsPaused)
    return "Agents are paused for this project: the lead reports nothing until they run again";
  return null;
}

/** The title every proposal goes out under: the project and the kind of
 *  action, never the lead's own words. */
export function proposalTitle(label: string, category: LeadCategory): string {
  return `${label}: ${LEAD_CATEGORY_LABELS[category]}`;
}

/** The longest title line the body carries. */
const TITLE_LEN = 200;

/** A leading ```say fence, through its closing fence. */
const SAY_FENCE = /^(`{3,}|~{3,})[ \t]*say[ \t]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/;

/** What Blob says and what it shows: the leading say fence and the rest, or
 *  the first paragraph and the rest when the body has no fence. */
function splitSay(body: string): { say: string; shown: string } {
  const fence = SAY_FENCE.exec(body);
  if (fence)
    return { say: fence[0].trim(), shown: body.slice(fence[0].length).trim() };
  const [say = "", ...shown] = body.split(/\n\s*\n/);
  return { say: say.trim(), shown: shown.join("\n\n").trim() };
}

/** The lead's part of the body: what Blob says (the lead's say fence), then
 *  the rule the server applied, the lead's title on one line and the rest of
 *  its text (what Blob shows). */
export function proposalLead(
  proposal: Pick<LeadProposal, "title" | "body" | "decision">,
): string {
  const { say, shown } = splitSay(proposal.body.trim());
  return [
    say,
    `Rule: ${proposal.decision.rule}.`,
    oneLine(proposal.title, TITLE_LEN),
    shown,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The body: the lead's part, and last the server's lines for any steps. */
export function proposalBody(
  proposal: Pick<LeadProposal, "title" | "body" | "decision" | "act">,
): string {
  return [proposalLead(proposal), proposal.act ? actLines(proposal.act) : ""]
    .filter(Boolean)
    .join("\n\n");
}

// ── Steps, condition and expiry ─────────────────────────────────────────────

const DAY_MS = 86_400_000;
export const DEFAULT_EXPIRES_IN_DAYS = DEFAULT_APPROVAL_TTL_MS / DAY_MS;
export const MAX_EXPIRES_IN_DAYS = MAX_APPROVAL_TTL_MS / DAY_MS;

/** A proposal's steps as the server checked them. */
export interface LeadAct {
  steps: LeadStep[];
  condition?: LeadCondition;
  expiresAt: number;
  /** Signal names by id, for the steps' copy. */
  signalNames: Record<string, string>;
}

export interface LeadActInput {
  category: LeadCategory;
  steps: unknown;
  condition?: unknown;
  expiresInDays?: number;
}

export interface LeadActContext {
  now: number;
  /** The project's GitHub repositories, `owner/name`. */
  repos: readonly string[];
  /** Every signal, so a dependency elsewhere still has a name. */
  signals: ReadonlyArray<{ id: string; name: string; project: string }>;
  project: string;
  /** The support conversations the steps name, read now (supportDrafts):
   *  each one's project and live draft. A support-send step is pinned to
   *  its draft's target from here; one missing here is refused. */
  drafts?: Readonly<Record<string, LeadDraftSource>>;
}

/** A support conversation as a support-send step is checked against. */
export interface LeadDraftSource {
  project: string;
  draft: {
    id: string;
    to?: MailAddress[];
    answersMessageId?: string | null;
  } | null;
}

/** The support conversations a proposal's steps name, for checkLeadAct.
 *  Raw steps: they are validated after. */
export async function supportDrafts(
  steps: unknown,
  read: (id: string) => Promise<SupportConversation | null>,
): Promise<Record<string, LeadDraftSource>> {
  const ids = new Set<string>();
  if (Array.isArray(steps))
    for (const step of steps.slice(0, MAX_STEPS))
      if (
        step &&
        typeof step === "object" &&
        (step as { kind?: unknown }).kind === "support-send" &&
        typeof (step as { conversationId?: unknown }).conversationId ===
          "string"
      )
        ids.add((step as { conversationId: string }).conversationId);
  const out: Record<string, LeadDraftSource> = {};
  for (const id of ids) {
    const c = await read(id);
    if (!c) continue;
    out[id] = {
      project: c.project,
      draft: c.draft
        ? {
            id: c.draft.id,
            ...(c.draft.to ? { to: c.draft.to } : {}),
            ...(c.draft.answersMessageId !== undefined
              ? { answersMessageId: c.draft.answersMessageId }
              : {}),
          }
        : null,
    };
  }
  return out;
}

/** Signal names by id, as the steps' copy names them. */
export function signalNamesOf(
  signals: ReadonlyArray<{ id: string; name: string }>,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const s of signals) names[s.id] = oneLine(s.name, 80) || s.id;
  return names;
}

function listOf(items: readonly string[], word = "or"): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

function repoRefusal(
  repo: string,
  repos: readonly string[],
): { error: string } | { repo: string } {
  const match = repos.find((r) => r.toLowerCase() === repo.toLowerCase());
  if (match) return { repo: match };
  return {
    error: repos.length
      ? `${repo} is not this project's repository (${listOf(repos)})`
      : `This project has no GitHub repository, so nothing can run on ${repo}`,
  };
}

/** The proposal's steps, condition and expiry, checked for `ctx.project`:
 *  each step valid and fit for the category, every pull request in one of
 *  the project's repositories, every patched signal the project's own. */
export function checkLeadAct(
  input: LeadActInput,
  ctx: LeadActContext,
): Valid<LeadAct> {
  const steps = validateLeadSteps(input.steps);
  if (!steps.ok) return { ok: false, error: `Steps: ${steps.error}` };
  const label = LEAD_CATEGORY_LABELS[input.category].toLowerCase();
  const signalNames = signalNamesOf(ctx.signals);
  const checked: LeadStep[] = [];
  for (const [index, step] of steps.value.entries()) {
    const n = index + 1;
    if (!stepFitsCategory(step.kind, input.category)) {
      const fits = STEP_CATEGORIES[step.kind].map((c) =>
        LEAD_CATEGORY_LABELS[c].toLowerCase(),
      );
      return {
        ok: false,
        error: `Step ${n}: ${step.kind} doesn't fit ${label}; it serves only ${listOf(fits)}`,
      };
    }
    if (step.kind === "merge-pr" || step.kind === "autofix-pr") {
      const repo = repoRefusal(step.ghRepo, ctx.repos);
      if ("error" in repo)
        return { ok: false, error: `Step ${n}: ${repo.error}` };
      checked.push({ ...step, ghRepo: repo.repo });
      continue;
    }
    // leads/apply.ts WORKER_UNAVAILABLE: no restricted worker path yet.
    if (step.kind === "spawn-worker")
      return {
        ok: false,
        error: `Step ${n}: starting a worker is not available yet`,
      };
    if (step.kind === "support-send") {
      // The pin is the server's, read now; any the lead gave is dropped.
      const source = ctx.drafts?.[step.conversationId];
      if (!source || source.project !== ctx.project)
        return {
          ok: false,
          error: `Step ${n}: ${step.conversationId} is not a support conversation of this project`,
        };
      const draft = source.draft;
      if (draft?.id !== step.draftId)
        return {
          ok: false,
          error: `Step ${n}: ${step.draftId} is not the conversation's current draft`,
        };
      if (!draft.to?.length || draft.answersMessageId === undefined)
        return {
          ok: false,
          error: `Step ${n}: draft ${step.draftId} has no recipient yet`,
        };
      checked.push({
        kind: "support-send",
        conversationId: step.conversationId,
        draftId: step.draftId,
        pin: {
          to: draft.to.map((a) => ({ name: a.name, address: a.address })),
          answersMessageId: draft.answersMessageId,
        },
      });
      continue;
    }
    if (
      step.kind === "signal-patch" &&
      !ctx.signals.some(
        (s) => s.id === step.signalId && s.project === ctx.project,
      )
    )
      return {
        ok: false,
        error: `Step ${n}: ${step.signalId} is not a signal of this project`,
      };
    checked.push(step);
  }
  let condition: LeadCondition | undefined;
  if (input.condition !== undefined) {
    const valid = validateLeadCondition(input.condition);
    if (!valid.ok) return { ok: false, error: `Condition: ${valid.error}` };
    condition = valid.value;
    if (condition.kind !== "incident-resolved") {
      const repo = repoRefusal(condition.ghRepo, ctx.repos);
      if ("error" in repo)
        return { ok: false, error: `Condition: ${repo.error}` };
      condition = { ...condition, ghRepo: repo.repo };
    }
  }
  const days = input.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS)
    return {
      ok: false,
      error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRES_IN_DAYS}`,
    };
  return {
    ok: true,
    value: {
      steps: checked,
      ...(condition ? { condition } : {}),
      expiresAt: ctx.now + days * DAY_MS,
      signalNames,
    },
  };
}

/** Characters that render as nothing or bend the line around them: the
 *  default-ignorable ones (zero-width, bidi, soft hyphen, tag characters,
 *  variation selectors) and the C0 and C1 controls. */
const INVISIBLE =
  /[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;

/** Where a line ends, for Markdown and for Unicode. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** Cyrillic and Greek letters that look like the Latin ones, lower case. */
const LOOKALIKES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  п: "n",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ѕ: "s",
  і: "i",
  ј: "j",
  ԁ: "d",
  һ: "h",
  ԛ: "q",
  ԝ: "w",
  ү: "y",
  ɡ: "g",
  α: "a",
  β: "b",
  ε: "e",
  ζ: "z",
  η: "n",
  ι: "i",
  κ: "k",
  μ: "u",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ϲ: "c",
  ϳ: "j",
};

const COLONS =
  /[\u02d0\u02f8\u0589\u05c3\u16ec\u1803\u1809\u205a\u2236\ua789\ufe13\ufe55\uff1a]/g;

function entity(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** A line as it reads once rendered: entities decoded, invisible characters
 *  dropped, NFKD with the combining marks gone, lower case, lookalike
 *  letters as Latin, HTML tags, heading anchors, link targets, backslash
 *  escapes and Markdown punctuation gone, and whatever precedes the first
 *  letter (list markers, bullets, numbers). */
export function lineSkeleton(row: string): string {
  const decoded = row
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) =>
      entity(parseInt(hex, 16)),
    )
    .replace(/&#(\d{1,7});?/g, (_, dec: string) => entity(Number(dec)))
    .replace(/&colon;/gi, ":")
    .replace(/&nbsp;/gi, " ");
  const plain = [
    ...decoded
      .replace(INVISIBLE, "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase(),
  ]
    .map((c) => LOOKALIKES[c] ?? c)
    .join("")
    .replace(INVISIBLE, "")
    .replace(COLONS, ":")
    .replace(/<!--.*?-->|<\/?[a-z][^>]*>/g, " ")
    .replace(/\{#[\w-]+\}/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/[*_`|#>~\\[\]]/g, " ");
  return plain.replace(/^[^\p{L}]*/u, "").trim();
}

const SERVER_LINE = /^(?:runs\s*when|steps|expires)\s*:/;

/** Whether a line of the lead's text reads as one of the server's lines. */
function forgesServerLine(text: string): boolean {
  return text
    .split(LINE_BREAK)
    .some((row) => SERVER_LINE.test(lineSkeleton(row)));
}

/** Raw HTML the inbox would not show as written, outside code. */
const RAW_HTML = /<[a-z!?/]/i;

/** An HTML entity, named or numeric, with or without its semicolon; one
 *  letter after `&` (R&D, Q&A) passes. */
const ENTITY = /&(?:#|[a-z][a-z0-9]+)/i;

/** The text with closed code fences and code spans taken out. */
function withoutCode(text: string): string {
  const rows: string[] = [];
  let open: { char: string; len: number } | null = null;
  for (const row of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row);
    if (!open) {
      if (m) open = { char: m[1]![0]!, len: m[1]!.length };
      else rows.push(row);
    } else if (
      m &&
      m[1]![0] === open.char &&
      m[1]!.length >= open.len &&
      !m[2]!.trim()
    )
      open = null;
  }
  return rows.join("\n").replace(/(`+)[^`]*?\1/g, "");
}

/** Why the lead's text (title and body) can't go out, or null. Never may it
 *  word the server's Runs when, Steps or Expires lines. With steps, it must
 *  also close every code fence and comment and leave raw HTML and HTML
 *  entities out, so nothing swallows, hides or spells the server's lines. */
export function actBodyRefusal(text: string, withSteps = true): string | null {
  if (forgesServerLine(text))
    return "Leave the Runs when, Steps and Expires lines out of the title and body: the server writes them from steps, condition and expiresInDays";
  if (!withSteps) return null;
  if (openFence(text) || text.lastIndexOf("<!--") > text.lastIndexOf("-->"))
    return "Close every code fence and comment in the title and body";
  const prose = withoutCode(text);
  if (RAW_HTML.test(prose))
    return "Leave raw HTML out of the title and body: write Markdown, or put the HTML in backticks";
  if (ENTITY.test(prose))
    return "Leave HTML entities out of the title and body: write the character itself, or put the text in backticks";
  return null;
}

function openFence(text: string): boolean {
  let open: { char: string; len: number } | null = null;
  for (const row of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row);
    if (!m) continue;
    const fence = m[1]!;
    if (!open) open = { char: fence[0]!, len: fence.length };
    else if (
      fence[0] === open.char &&
      fence.length >= open.len &&
      !m[2]!.trim()
    )
      open = null;
  }
  return open !== null;
}

const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

function oneLine(text: string, max: number): string {
  return text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A duration in the largest whole unit. */
function duration(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return plural(ms / DAY_MS, "day");
  if (ms >= 3_600_000 && ms % 3_600_000 === 0)
    return plural(ms / 3_600_000, "hour");
  if (ms >= 60_000 && ms % 60_000 === 0) return plural(ms / 60_000, "minute");
  return plural(Math.round(ms / 1000), "second");
}

/** Fixed copy for a signal rule, lower case: what it alerts on. */
export function ruleCopy(rule: SignalRule): string {
  switch (rule.kind) {
    case "consecutive":
      return `alert after ${plural(rule.failures, "failure")} in a row${rule.recoveries ? `, clear after ${plural(rule.recoveries, "pass", "passes")} in a row` : ""}`;
    case "rate":
      return `alert at ${rule.atLeast} or more failures in ${duration(rule.windowMs)}${rule.ratio !== undefined ? `, and at least ${Math.round(rule.ratio * 100)}% of checks` : ""}`;
    case "threshold":
      return `alert above ${rule.above} for ${duration(rule.forMs)}`;
    case "missing":
      return rule.everyMs !== undefined
        ? `expect a check-in every ${duration(rule.everyMs)}, with ${duration(rule.graceMs)} of grace`
        : `expect a check-in on the schedule ${oneLine(rule.cron ?? "", 60)} (UTC), with ${duration(rule.graceMs)} of grace`;
    case "deadline":
      return `warn ${plural(rule.warnDays, "day")} and alert ${plural(rule.failDays, "day")} before expiry`;
  }
}

function patchCopy(
  after: SignalPatchAfter,
  names: Record<string, string>,
): string {
  const parts: string[] = [];
  if (after.rule) parts.push(ruleCopy(after.rule));
  if (after.provider !== undefined)
    parts.push(
      after.provider ? "mark it a provider" : "stop marking it a provider",
    );
  if (after.dependsOn)
    parts.push(
      after.dependsOn.length
        ? `depend on ${listOf(
            after.dependsOn.map((id) => names[id] ?? id),
            "and",
          )}`
        : "depend on no other signal",
    );
  return parts.join("; ");
}

function sha(headSha: string): string {
  return headSha.slice(0, 7);
}

const METHOD_COPY = {
  merge: "with a merge commit",
  squash: "squashed",
  rebase: "rebased",
} as const;

/** Fixed owner-facing copy for one step. A worker's prompt follows its line
 *  in full, indented and fenced, so the owner reads what the worker gets. */
export function stepCopy(
  step: LeadStep,
  names: Record<string, string>,
): string {
  switch (step.kind) {
    case "merge-pr":
      return `Merge PR #${step.number} in ${step.ghRepo} at ${sha(step.headSha)}${step.method ? `, ${METHOD_COPY[step.method]}` : ""}`;
    case "autofix-pr":
      return `Ask the autofix agent to fix PR #${step.number} in ${step.ghRepo} at ${sha(step.headSha)}`;
    case "signal-patch":
      return `Change the ${names[step.signalId] ?? step.signalId} check: ${patchCopy(step.after, names)}`;
    case "support-send":
      return `Send reply draft ${step.draftId} in support conversation ${step.conversationId}`;
    case "spawn-worker": {
      const longest = Math.max(
        2,
        ...(step.prompt.match(/`+/g) ?? []).map((run) => run.length),
      );
      const fence = "`".repeat(longest + 1);
      const body = [`${fence}text`, ...step.prompt.split("\n"), fence]
        .map((row) => (row ? `   ${row}` : ""))
        .join("\n");
      return `Start a worker with this prompt:\n${body}`;
    }
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** A time as the owner reads it, in UTC. */
export function expiryCopy(at: number): string {
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** The server's lines at the end of a proposal with steps. */
export function actLines(act: LeadAct): string {
  return [
    act.condition ? `Runs when: ${describeCondition(act.condition)}` : "",
    [
      "Steps:",
      ...act.steps.map((s, i) => `${i + 1}. ${stepCopy(s, act.signalNames)}`),
    ].join("\n"),
    `Expires: ${expiryCopy(act.expiresAt)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Every lead item's source: `lead:<project>`. */
export const LEAD_SOURCE_PREFIX = "lead:";
export const leadSource = (project: string) =>
  `${LEAD_SOURCE_PREFIX}${project}`;

const DEFAULT_OPTIONS: Record<LeadProposalKind, string[]> = {
  proposal: ["Approve", "Not now"],
  "needs-you": ["I'll do it", "Not now"],
};

export type LeadAuditSink = (
  event: Record<string, unknown>,
) => void | Promise<void>;

let sink: LeadAuditSink | undefined;

/** Replace the audit sink (undefined restores `auditDurable`); returns the
 *  previous one. */
export function __setLeadAuditForTest(
  next: LeadAuditSink | undefined,
): LeadAuditSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}

/** Audit one lead event. A lead is Blob working on one project, so every
 *  entry names Blob as the actor; the owner it answers to stays `user`. */
export async function leadAudit(event: Record<string, unknown>): Promise<void> {
  await (sink ?? auditDurable)({ actor: BLOB_ACTOR, ...event });
}

/** Who the lead answers to: its owner, else the instance owner; "" when
 *  there is nobody. */
export function leadOwner(doc: Pick<ProjectSettingsDocument, "lead">): string {
  return personOwner(doc.lead.owner) ?? instanceOwner();
}

/** The roster member `leadOwner` names, or null without a roster.
 *  Permission checks compare their GitHub login with the signed-in one,
 *  since a first name can be shared. */
export function leadOwnerMember(
  doc: Pick<ProjectSettingsDocument, "lead">,
): TeamMember | null {
  return personOwner(doc.lead.owner)
    ? rosterMember(doc.lead.owner)
    : instanceOwnerMember();
}

/** A subject as a key: lower case, single spaces, bounded. */
export function subjectKey(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

/** The inbox key a proposal updates: one per project, category and subject. */
export function proposalDedupeKey(
  project: string,
  proposal: Pick<LeadProposal, "category" | "subject" | "title">,
): string {
  return `${leadSource(project)}:${proposal.category}:${subjectKey(proposal.subject || proposal.title)}`;
}

/** The approvals record for an act proposal, checked before the item is
 *  posted; the item id and revision are filled in after. */
function actRecordInput(
  project: string,
  proposal: LeadProposal & { act: LeadAct },
): ValidProposalInput {
  return {
    project,
    category: proposal.category,
    subject: oneLine(proposal.subject || proposal.title, 200),
    itemId: "pending",
    itemRevision: 0,
    steps: proposal.act.steps,
    ...(proposal.act.condition ? { condition: proposal.act.condition } : {}),
    expiresAt: proposal.act.expiresAt,
  };
}

/** What an item says in place of its steps when they could not be
 *  recorded. */
export const UNRECORDED_LINE =
  "Approving this runs nothing: its steps could not be recorded.";

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "failed";
}

/** Hand a proposal to the owner's supervisor inbox, unless the lead is
 *  off or paused. Its title and body may quote customers, so the audit
 *  keeps digests of them, never the text. With steps, the proposal is
 *  recorded bound to the item and its revision; an update without steps
 *  voids what was recorded for the item before, so an answer to the new
 *  text never approves the old steps. */
export async function deliverLeadProposal(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  proposal: LeadProposal,
  label: string = project,
): Promise<LeadDelivery> {
  const owner = leadOwner(doc);
  const dedupeKey = proposalDedupeKey(project, proposal);
  const act = proposal.act;
  const base = {
    kind: "lead_proposal",
    project,
    proposalKind: proposal.kind,
    category: proposal.category,
    level: proposal.decision.level,
    effective: proposal.decision.effective,
    rule: proposal.decision.rule,
    titleDigest: digest(proposal.title),
    bodyDigest: digest(proposal.body),
    options: proposal.options.length,
    dedupeKey,
    ...(act
      ? {
          steps: act.steps.map((s) => s.kind),
          condition: act.condition?.kind ?? null,
          expiresAt: act.expiresAt,
        }
      : {}),
  };
  const refusal = leadReportRefusal(doc);
  if (refusal || !owner) {
    await leadAudit({ ...base, delivered: false });
    return { queued: false, reason: refusal ?? NOBODY };
  }
  const lead = proposalLead(proposal);
  const body = proposalBody(proposal);
  const textRefusal = actBodyRefusal(lead, act !== undefined);
  if (textRefusal) {
    await leadAudit({ ...base, delivered: false });
    return { queued: false, reason: textRefusal };
  }
  let record: ValidProposalInput | undefined;
  if (act) {
    const valid =
      body.length > SUPERVISOR_BODY_LEN
        ? {
            ok: false as const,
            error: `The proposal is ${body.length} characters with its steps, more than the owner's inbox holds (${SUPERVISOR_BODY_LEN}): shorten the body or the steps`,
          }
        : validateProposalInput(actRecordInput(project, { ...proposal, act }));
    if (!valid.ok) {
      await leadAudit({ ...base, delivered: false });
      return { queued: false, reason: valid.error };
    }
    record = valid.value;
  }
  const options = proposal.options.length
    ? proposal.options
    : DEFAULT_OPTIONS[proposal.kind];
  const item = {
    user: owner,
    source: leadSource(project),
    project,
    kind: "needs-you" as const,
    title: proposalTitle(label, proposal.category),
    options,
    dedupeKey,
  };
  const posted = await postSupervisorItem({ ...item, body });
  const itemId = posted.item.id;
  let proposalId: string | undefined;
  let unrecorded: string | undefined;
  try {
    if (record) {
      const recorded = await recordProposal({
        ...record,
        itemId,
        itemRevision: posted.revision,
      });
      if (recorded.ok) proposalId = recorded.value.id;
      else unrecorded = recorded.error;
    } else if (!posted.created) {
      await voidFor(project, (r) => r.proposal.itemId === itemId, "superseded");
    }
  } catch (error) {
    unrecorded = errorText(error);
  }
  // Steps up but not recorded: take them off the item and void anything
  // recorded for it before, so approving never looks like it runs them.
  let withdrawn = false;
  if (record && !proposalId) {
    try {
      await voidFor(project, (r) => r.proposal.itemId === itemId, "superseded");
      await postSupervisorItem({
        ...item,
        body: `${lead}\n\n${UNRECORDED_LINE}`,
      });
      withdrawn = true;
    } catch {}
  }
  await leadAudit({
    ...base,
    delivered: true,
    owner,
    itemId,
    created: posted.created,
    ...(record ? { proposalId: proposalId ?? null } : {}),
    ...(unrecorded ? { unrecorded, withdrawn } : {}),
  });
  if (record && !proposalId)
    return {
      queued: false,
      reason: `The steps were not recorded: ${unrecorded ?? "failed"}. ${withdrawn ? `The owner's item ${itemId} now says approving it runs nothing.` : `The owner's item ${itemId} still lists them, but approving it runs nothing.`} Call propose again.`,
    };
  return {
    queued: true,
    itemId,
    created: posted.created,
    delivery: posted.delivery,
    ...(proposalId ? { proposalId } : {}),
  };
}

/** The day's note for the owner's digest: one fyi item per project and UTC
 *  day; a later note replaces the earlier one, and a note after that day's
 *  digest went out starts a new item, so nothing is lost. */
export async function postLeadDigestNote(
  project: string,
  doc: Pick<ProjectSettingsDocument, "lead" | "incidents">,
  text: string,
  now: number,
  label: string = project,
): Promise<LeadDelivery> {
  const refusal = leadReportRefusal(doc);
  if (refusal) return { queued: false, reason: refusal };
  const owner = leadOwner(doc);
  if (!owner) return { queued: false, reason: NOBODY };
  const day = new Date(now).toISOString().slice(0, 10);
  const base = `${leadSource(project)}:digest:${day}`;
  // Today's notes only, found by their key however full the inbox is.
  const open = await listSupervisorItems(owner, {
    kind: "fyi",
    state: "open",
    dedupeKeyPrefix: base,
    limit: 100,
  });
  let dedupeKey = base;
  for (let n = 2; n < 50; n++) {
    const existing = open.find((item) => item.dedupeKey === dedupeKey);
    if (!existing || existing.digestedAt === undefined) break;
    dedupeKey = `${base}:${n}`;
  }
  const posted = await postSupervisorItem({
    user: owner,
    source: leadSource(project),
    project,
    kind: "fyi",
    title: `${label}: what the lead saw today`,
    body: text,
    dedupeKey,
  });
  return {
    queued: true,
    itemId: posted.item.id,
    created: posted.created,
    delivery: posted.delivery,
  };
}
