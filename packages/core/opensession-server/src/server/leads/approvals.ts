// What the owner approved a lead to do, recorded by the server
// (the lead act stage). A lead's proposal carries typed steps the server
// validates; the owner's answer turns it into an approval, optionally
// waiting on a condition (a PR merged, checks green on a head, an incident
// resolved) and always with an expiry. `lead_apply` later claims a ready
// approval and runs its steps through existing mechanisms.
//
// Storage follows the supervisor inbox (supervisor-inbox.ts): one catalog
// document per project in `lead-approvals`, holding a bounded list of
// records (a proposal and at most one approval), and every change is one
// compare-and-set on that document, so a claim, a void and an expiry never
// race each other. Settled records past the cap are dropped oldest first.
//
// An approval moves waiting -> ready -> applying -> applied | failed |
// partial, and waiting or ready -> void. A claim is the only way into
// applying, only from ready, and needs a claim id; only that claimant
// finishes it. An interrupted apply is never claimed again: once it is older
// than STALE_APPLY_MS, `settleInterrupted` marks it partial.
//
// A stored record that no longer validates (a later, stricter validator) is
// kept as it is and never offered or claimed; nothing drops it silently.
// Nothing runs at import.
import { randomUUIDv7 } from "bun";
import { LEAD_CATEGORIES, type LeadCategory } from "../../shared/project-lead";
import type { SignalRule } from "../../shared/incidents";
import { catalogDocuments, isValidCatalogKey } from "../catalog-documents";
import { validateRule } from "../incidents/signal-validation";
import type { LeadCondition } from "./conditions";
import { CATALOG_DOCUMENT_MAX_VALUE_BYTES } from "../session-kernel/catalog-document-protocol";

export const LEAD_APPROVALS_NAMESPACE = "lead-approvals";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_APPROVAL_TTL_MS = 7 * DAY_MS;
export const MAX_APPROVAL_TTL_MS = 30 * DAY_MS;
/** An unapproved proposal is voided after this. */
export const PROPOSAL_TTL_MS = 30 * DAY_MS;
/** An apply still running after this was interrupted (the run died). */
export const STALE_APPLY_MS = 30 * 60 * 1000;
/** Records kept per project; settled ones past it are dropped oldest first. */
export const MAX_RECORDS = 200;
export const MAX_STEPS = 10;
export const MAX_PROMPT_LEN = 4000;
const SUBJECT_LEN = 200;
const REASON_LEN = 200;
const NAME_LEN = 120;
const PROJECT_LEN = 80;
const MAX_DEPENDS_ON = 20;
/** Leave room under the hard catalog cap for JSON overhead (comment-threads.ts). */
const DOCUMENT_BUDGET = Math.floor(CATALOG_DOCUMENT_MAX_VALUE_BYTES * 0.9);

// ── Types ───────────────────────────────────────────────────────────────────

export type MergeMethod = "merge" | "squash" | "rebase";

/** The fields a signal-patch step touches (leads/flaps.ts RuleProposal.change).
 *  In `before`, null means the field is unset on the stored signal. */
export interface SignalPatchAfter {
  rule?: SignalRule;
  provider?: boolean;
  dependsOn?: string[];
}
export interface SignalPatchBefore {
  rule?: SignalRule;
  provider?: boolean | null;
  dependsOn?: string[] | null;
}

export type LeadStep =
  | {
      kind: "merge-pr";
      ghRepo: string;
      number: number;
      headSha: string;
      method?: MergeMethod;
    }
  | { kind: "autofix-pr"; ghRepo: string; number: number; headSha: string }
  | { kind: "spawn-worker"; prompt: string }
  | {
      kind: "signal-patch";
      signalId: string;
      before: SignalPatchBefore;
      after: SignalPatchAfter;
    }
  | { kind: "support-send"; conversationId: string; draftId: string };

export type LeadStepKind = LeadStep["kind"];

/** The categories each step kind may serve: a merge only for a verified
 *  fix, a release or a CI repair, a signal patch only for a rule change. */
export const STEP_CATEGORIES: Readonly<
  Record<LeadStepKind, readonly LeadCategory[]>
> = {
  "merge-pr": ["fix-verified", "public-release", "ci-repair"],
  "autofix-pr": ["ci-repair"],
  "spawn-worker": ["fix-verified", "ci-repair"],
  "signal-patch": ["signal-rule-change"],
  "support-send": ["support-routine-reply"],
};

export function stepFitsCategory(
  kind: LeadStepKind,
  category: LeadCategory,
): boolean {
  return STEP_CATEGORIES[kind].includes(category);
}

export interface ActProposal {
  id: string;
  project: string;
  category: LeadCategory;
  subject: string;
  /** The supervisor inbox item the proposal was raised as, and its revision
   *  (the item's updatedAt) when it was. */
  itemId: string;
  itemRevision: number;
  steps: LeadStep[];
  /** What the approval will wait for, shown to the owner; the owner's
   *  answer approves the proposal with it as it is here. */
  condition?: LeadCondition;
  /** When the steps may no longer run, shown to the owner; an unapproved
   *  proposal is voided then, and the owner's answer approves with it. */
  expiresAt?: number;
  createdAt: number;
  /** Voided before it ran: superseded, its subject or level changed, or
   *  expired unapproved. Never approved after this. */
  voidedAt?: number;
  voidReason?: string;
}

export const LEAD_APPROVAL_STATES = [
  "waiting",
  "ready",
  "applying",
  "applied",
  "failed",
  "partial",
  "void",
] as const;
export type LeadApprovalState = (typeof LEAD_APPROVAL_STATES)[number];

/** Every legal move. `applying` is entered only through `claimApply`. */
export const LEAD_APPROVAL_TRANSITIONS: Readonly<
  Record<LeadApprovalState, readonly LeadApprovalState[]>
> = {
  waiting: ["ready", "void"],
  ready: ["applying", "void"],
  applying: ["applied", "failed", "partial"],
  applied: [],
  failed: [],
  partial: [],
  void: [],
};

export interface LeadApproval {
  proposalId: string;
  /** The person who approved, as the supervisor inbox names them; the
   *  lead itself when `rule` is set. */
  approvedBy: string;
  /** Their GitHub login; absent when `rule` is set. */
  login?: string;
  /** Set when the lead's rules let it run without the owner (`claimAlone`):
   *  the rule that did. */
  rule?: string;
  at: number;
  condition?: LeadCondition;
  expiresAt: number;
  state: LeadApprovalState;
  updatedAt: number;
  /** Who holds the apply, set by `claimApply`. */
  claimId?: string;
  claimedAt?: number;
  /** Why it is void, failed or partial. */
  reason?: string;
}

export interface LeadRecord {
  proposal: ActProposal;
  approval?: LeadApproval;
}

interface ApprovalsDocument {
  project: string;
  /** Newest first. */
  records: LeadRecord[];
  /** Stored records that no longer validate, written back unchanged after
   *  `records`. Never listed, claimed or pruned. */
  unreadable: unknown[];
}

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

// ── Validation ──────────────────────────────────────────────────────────────

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function validate<T>(run: () => T): Valid<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra) fail(`${label} has an unknown field: ${extra}`);
  return value;
}

// Control, bidi and line separator characters: never in one-line fields.
const UNSAFE_LINE =
  /[\u0000-\u001f\u007f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// The same, but newlines and tabs are allowed (a worker's prompt), and
// zero-width characters are refused too, so nothing in a prompt is hidden
// from the owner who approved it.
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;

function line(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${label} is empty`);
  if (trimmed.length > max) fail(`${label} is longer than ${max} characters`);
  if (UNSAFE_LINE.test(trimmed)) fail(`${label} has control characters`);
  return trimmed;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value))
    fail(`${label} must be an id (letters, digits, . _ : -)`);
  return value;
}

// GitHub: owner up to 39 characters, letters, digits and inner hyphens;
// repository name letters, digits, . _ -, never . or ..
const GH_REPO =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;

function ghRepo(value: unknown): string {
  const match = typeof value === "string" ? GH_REPO.exec(value) : null;
  if (!match || match[2] === "." || match[2] === "..")
    fail("ghRepo must be owner/name");
  return value as string;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function prNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("number must be a positive integer");
  return value;
}

function headSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    fail("headSha must be 40 lowercase hex characters");
  return value;
}

function time(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a time in ms`);
  return value;
}

function prompt(value: unknown): string {
  if (typeof value !== "string") fail("prompt must be a string");
  const trimmed = value.trim();
  if (!trimmed) fail("prompt is empty");
  if (trimmed.length > MAX_PROMPT_LEN)
    fail(`prompt is longer than ${MAX_PROMPT_LEN} characters`);
  if (UNSAFE_TEXT.test(trimmed)) fail("prompt has control characters");
  return trimmed;
}

function dependsOn(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label}.dependsOn must be a list`);
  if (value.length > MAX_DEPENDS_ON)
    fail(`${label}.dependsOn has more than ${MAX_DEPENDS_ON} signals`);
  const ids = value.map((entry) => id(entry, `${label}.dependsOn`));
  if (new Set(ids).size !== ids.length)
    fail(`${label}.dependsOn repeats a signal`);
  return ids;
}

const PATCH_FIELDS = ["rule", "provider", "dependsOn"] as const;

function rule(value: unknown, label: string): SignalRule {
  const result = validateRule(value);
  if ("error" in result) fail(`${label}.rule: ${result.error}`);
  return result;
}

function patchAfter(value: unknown): SignalPatchAfter {
  const raw = object(value, "after", PATCH_FIELDS);
  const after: SignalPatchAfter = {};
  if (raw.rule !== undefined) after.rule = rule(raw.rule, "after");
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "boolean")
      fail("after.provider must be true or false");
    after.provider = raw.provider;
  }
  if (raw.dependsOn !== undefined)
    after.dependsOn = dependsOn(raw.dependsOn, "after");
  if (!Object.keys(after).length) fail("after changes nothing");
  return after;
}

function patchBefore(
  value: unknown,
  after: SignalPatchAfter,
): SignalPatchBefore {
  const raw = object(value, "before", PATCH_FIELDS);
  const before: SignalPatchBefore = {};
  if (raw.rule !== undefined) before.rule = rule(raw.rule, "before");
  if (raw.provider !== undefined) {
    if (raw.provider !== null && typeof raw.provider !== "boolean")
      fail("before.provider must be true, false or null");
    before.provider = raw.provider;
  }
  if (raw.dependsOn !== undefined)
    before.dependsOn =
      raw.dependsOn === null ? null : dependsOn(raw.dependsOn, "before");
  const want = Object.keys(after).sort().join();
  if (Object.keys(before).sort().join() !== want)
    fail("before must hold exactly the fields after changes");
  return before;
}

function stepOf(value: unknown): LeadStep {
  if (!isRecord(value)) fail("step must be an object");
  switch (value.kind) {
    case "merge-pr": {
      const raw = object(value, "merge-pr", [
        "kind",
        "ghRepo",
        "number",
        "headSha",
        "method",
      ]);
      const step: LeadStep = {
        kind: "merge-pr",
        ghRepo: ghRepo(raw.ghRepo),
        number: prNumber(raw.number),
        headSha: headSha(raw.headSha),
      };
      if (raw.method !== undefined) {
        if (
          raw.method !== "merge" &&
          raw.method !== "squash" &&
          raw.method !== "rebase"
        )
          fail("method must be merge, squash or rebase");
        step.method = raw.method;
      }
      return step;
    }
    case "autofix-pr": {
      const raw = object(value, "autofix-pr", [
        "kind",
        "ghRepo",
        "number",
        "headSha",
      ]);
      return {
        kind: "autofix-pr",
        ghRepo: ghRepo(raw.ghRepo),
        number: prNumber(raw.number),
        headSha: headSha(raw.headSha),
      };
    }
    case "spawn-worker": {
      const raw = object(value, "spawn-worker", ["kind", "prompt"]);
      return { kind: "spawn-worker", prompt: prompt(raw.prompt) };
    }
    case "signal-patch": {
      const raw = object(value, "signal-patch", [
        "kind",
        "signalId",
        "before",
        "after",
      ]);
      const after = patchAfter(raw.after);
      return {
        kind: "signal-patch",
        signalId: id(raw.signalId, "signalId"),
        before: patchBefore(raw.before, after),
        after,
      };
    }
    case "support-send": {
      const raw = object(value, "support-send", [
        "kind",
        "conversationId",
        "draftId",
      ]);
      return {
        kind: "support-send",
        conversationId: id(raw.conversationId, "conversationId"),
        draftId: id(raw.draftId, "draftId"),
      };
    }
    default:
      fail(
        "step kind must be merge-pr, autofix-pr, spawn-worker, signal-patch or support-send",
      );
  }
}

function conditionOf(value: unknown): LeadCondition {
  if (!isRecord(value)) fail("condition must be an object");
  switch (value.kind) {
    case "pr-merged": {
      const raw = object(value, "pr-merged", ["kind", "ghRepo", "number"]);
      return {
        kind: "pr-merged",
        ghRepo: ghRepo(raw.ghRepo),
        number: prNumber(raw.number),
      };
    }
    case "checks-green": {
      const raw = object(value, "checks-green", [
        "kind",
        "ghRepo",
        "number",
        "headSha",
      ]);
      return {
        kind: "checks-green",
        ghRepo: ghRepo(raw.ghRepo),
        number: prNumber(raw.number),
        headSha: headSha(raw.headSha),
      };
    }
    case "incident-resolved": {
      const raw = object(value, "incident-resolved", ["kind", "id"]);
      return { kind: "incident-resolved", id: id(raw.id, "incident id") };
    }
    default:
      fail(
        "condition kind must be pr-merged, checks-green or incident-resolved",
      );
  }
}

function stepsOf(value: unknown): LeadStep[] {
  if (!Array.isArray(value) || !value.length)
    fail("steps must be a non-empty list");
  if (value.length > MAX_STEPS) fail(`more than ${MAX_STEPS} steps`);
  return value.map((step, index) => {
    const result = validate(() => stepOf(step));
    if (!result.ok) fail(`step ${index + 1}: ${result.error}`);
    return result.value;
  });
}

function projectOf(value: unknown): string {
  const project = line(value, "project", PROJECT_LEN);
  if (!isValidCatalogKey(project)) fail("project is not a valid key");
  return project;
}

function categoryOf(value: unknown): LeadCategory {
  const category = LEAD_CATEGORIES.find((c) => c === value);
  if (!category) fail("category is not a lead category");
  return category;
}

function reasonOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail("reason must be a string");
  return (
    value
      .replace(new RegExp(UNSAFE_LINE.source, "g"), " ")
      .trim()
      .slice(0, REASON_LEN) || undefined
  );
}

export function validateLeadStep(value: unknown): Valid<LeadStep> {
  return validate(() => stepOf(value));
}

export function validateLeadSteps(value: unknown): Valid<LeadStep[]> {
  return validate(() => stepsOf(value));
}

export function validateLeadCondition(value: unknown): Valid<LeadCondition> {
  return validate(() => conditionOf(value));
}

export interface ActProposalInput {
  project: string;
  category: string;
  subject: string;
  itemId: string;
  itemRevision: number;
  steps: unknown;
  condition?: unknown;
  expiresAt?: number;
}

export type ValidProposalInput = Omit<
  ActProposal,
  "id" | "createdAt" | "voidedAt" | "voidReason"
>;

export function validateProposalInput(
  value: unknown,
): Valid<ValidProposalInput> {
  return validate(() => {
    const raw = object(value, "proposal", [
      "project",
      "category",
      "subject",
      "itemId",
      "itemRevision",
      "steps",
      "condition",
      "expiresAt",
    ]);
    const category = categoryOf(raw.category);
    const steps = stepsOf(raw.steps);
    steps.forEach((step, index) => {
      if (!stepFitsCategory(step.kind, category))
        fail(`step ${index + 1}: ${step.kind} does not fit ${category}`);
    });
    const proposal: ValidProposalInput = {
      project: projectOf(raw.project),
      category,
      subject: line(raw.subject, "subject", SUBJECT_LEN),
      itemId: id(raw.itemId, "itemId"),
      itemRevision: time(raw.itemRevision, "itemRevision"),
      steps,
    };
    if (raw.condition !== undefined)
      proposal.condition = conditionOf(raw.condition);
    if (raw.expiresAt !== undefined)
      proposal.expiresAt = time(raw.expiresAt, "expiresAt");
    return proposal;
  });
}

/** The expiry of a new approval: the default, or `requested` when it is in
 *  the future and at most 30 days away. */
export function approvalExpiry(now: number, requested?: number): Valid<number> {
  return validate(() => {
    if (requested === undefined) return now + DEFAULT_APPROVAL_TTL_MS;
    const at = time(requested, "expiresAt");
    if (at <= now) fail("expiresAt is in the past");
    if (at - now > MAX_APPROVAL_TTL_MS)
      fail("expiresAt is more than 30 days away");
    return at;
  });
}

// ── Reading stored records ──────────────────────────────────────────────────

function storedProposal(value: unknown): ActProposal {
  if (!isRecord(value)) fail("proposal must be an object");
  const { id: rawId, createdAt, voidedAt, voidReason, ...input } = value;
  const valid = validateProposalInput(input);
  if (!valid.ok) fail(valid.error);
  const proposal: ActProposal = {
    id: id(rawId, "id"),
    ...valid.value,
    createdAt: time(createdAt, "createdAt"),
  };
  if (voidedAt !== undefined) {
    proposal.voidedAt = time(voidedAt, "voidedAt");
    const reason = reasonOf(voidReason);
    if (reason) proposal.voidReason = reason;
  }
  return proposal;
}

function storedApproval(value: unknown, proposalId: string): LeadApproval {
  const raw = object(value, "approval", [
    "proposalId",
    "approvedBy",
    "login",
    "at",
    "condition",
    "expiresAt",
    "state",
    "updatedAt",
    "claimId",
    "claimedAt",
    "reason",
    "rule",
  ]);
  if (raw.proposalId !== proposalId) fail("approval is for another proposal");
  const state = LEAD_APPROVAL_STATES.find((s) => s === raw.state);
  if (!state) fail("approval state is unknown");
  const byRule = raw.rule !== undefined;
  if (byRule) {
    if (raw.login !== undefined) fail("an approval by the rules has no login");
  } else if (typeof raw.login !== "string" || !LOGIN.test(raw.login))
    fail("login is not a GitHub login");
  const approval: LeadApproval = {
    proposalId,
    approvedBy: line(raw.approvedBy, "approvedBy", NAME_LEN),
    ...(byRule
      ? { rule: line(raw.rule, "rule", REASON_LEN) }
      : { login: raw.login as string }),
    at: time(raw.at, "at"),
    expiresAt: time(raw.expiresAt, "expiresAt"),
    state,
    updatedAt: time(raw.updatedAt, "updatedAt"),
  };
  if (raw.condition !== undefined)
    approval.condition = conditionOf(raw.condition);
  if (raw.claimId !== undefined) approval.claimId = id(raw.claimId, "claimId");
  if (raw.claimedAt !== undefined)
    approval.claimedAt = time(raw.claimedAt, "claimedAt");
  const reason = reasonOf(raw.reason);
  if (reason) approval.reason = reason;
  return approval;
}

function readRecord(value: unknown): Valid<LeadRecord> {
  return validate(() => {
    const raw = object(value, "record", ["proposal", "approval"]);
    const proposal = storedProposal(raw.proposal);
    const record: LeadRecord = { proposal };
    if (raw.approval !== undefined)
      record.approval = storedApproval(raw.approval, proposal.id);
    return record;
  });
}

function cleanDocument(value: unknown, project: string): ApprovalsDocument {
  const doc: ApprovalsDocument = { project, records: [], unreadable: [] };
  if (!isRecord(value) || !Array.isArray(value.records)) return doc;
  for (const raw of value.records) {
    const result = readRecord(raw);
    if (result.ok) doc.records.push(result.value);
    else {
      console.warn(
        `[lead-approvals] kept an unreadable record: ${result.error}`,
      );
      doc.unreadable.push(raw);
    }
  }
  return doc;
}

function storedDocument(doc: ApprovalsDocument) {
  return { project: doc.project, records: [...doc.records, ...doc.unreadable] };
}

// ── Pure state changes ──────────────────────────────────────────────────────

export function canTransition(
  from: LeadApprovalState,
  to: LeadApprovalState,
): boolean {
  return LEAD_APPROVAL_TRANSITIONS[from].includes(to);
}

const TERMINAL = new Set<LeadApprovalState>([
  "applied",
  "failed",
  "partial",
  "void",
]);

/** Done with: the proposal was voided, or its approval reached an end. */
export function isSettled(record: LeadRecord): boolean {
  if (record.approval) return TERMINAL.has(record.approval.state);
  return record.proposal.voidedAt !== undefined;
}

/** Waiting or ready: still to run, and still voidable. */
function isLive(approval: LeadApproval | undefined): approval is LeadApproval {
  return approval?.state === "waiting" || approval?.state === "ready";
}

function voidRecord(
  record: LeadRecord,
  now: number,
  reason: string,
): LeadRecord {
  const next: LeadRecord = {
    proposal: { ...record.proposal, voidedAt: now, voidReason: reason },
  };
  if (record.approval)
    next.approval = isLive(record.approval)
      ? { ...record.approval, state: "void", updatedAt: now, reason }
      : record.approval;
  return next;
}

/** Whether a record can still be voided: not voided yet, and its approval,
 *  if any, has not started or ended. */
function voidable(record: LeadRecord): boolean {
  if (record.proposal.voidedAt !== undefined) return false;
  return !record.approval || isLive(record.approval);
}

/** Void approvals past their expiry and proposals unapproved too long.
 *  Applying approvals never expire. */
export function expireRecords(
  records: readonly LeadRecord[],
  now: number,
): { records: LeadRecord[]; expired: number } {
  let expired = 0;
  const next = records.map((record) => {
    if (!voidable(record)) return record;
    const { createdAt, expiresAt } = record.proposal;
    const due = record.approval
      ? now >= record.approval.expiresAt
      : now - createdAt >= PROPOSAL_TTL_MS ||
        (expiresAt !== undefined && now >= expiresAt);
    if (!due) return record;
    expired++;
    return voidRecord(record, now, "expired");
  });
  return { records: next, expired };
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Bound the list by count and bytes, dropping settled records oldest
 *  first. Records still to run are never dropped: `fits` is false when the
 *  list is still over a bound without them. `budget` is for tests. */
export function pruneRecords(
  records: readonly LeadRecord[],
  cap = MAX_RECORDS,
  budget = DOCUMENT_BUDGET,
): { records: LeadRecord[]; fits: boolean } {
  const kept = [...records];
  let size = 1024 + kept.reduce((sum, record) => sum + byteSize(record) + 1, 0);
  const over = () => kept.length > cap || size > budget;
  for (let i = kept.length - 1; i >= 0 && over(); i--) {
    if (!isSettled(kept[i]!)) continue;
    size -= byteSize(kept[i]) + 1;
    kept.splice(i, 1);
  }
  return { records: kept, fits: !over() };
}

export type TransitionError =
  | "not-found"
  | "no-approval"
  | "illegal"
  | "expired"
  | "not-claimant";

export type ClaimError =
  | "not-found"
  | "no-approval"
  | "voided"
  | "expired"
  | "busy"
  | "not-ready"
  | "settled";

/** Move an approval to `to` when the table allows it. Entering applying
 *  takes `claimApproval`; leaving it takes the claimant's id. A waiting or
 *  ready approval past its expiry can only become void. */
export function transitionApproval(
  approval: LeadApproval,
  to: LeadApprovalState,
  now: number,
  options: { reason?: string; claimId?: string } = {},
):
  | { ok: true; approval: LeadApproval }
  | { ok: false; error: TransitionError } {
  if (to === "applying" || !canTransition(approval.state, to))
    return { ok: false, error: "illegal" };
  if (approval.state === "applying" && options.claimId !== approval.claimId)
    return { ok: false, error: "not-claimant" };
  if (isLive(approval) && to !== "void" && now >= approval.expiresAt)
    return { ok: false, error: "expired" };
  const next: LeadApproval = { ...approval, state: to, updatedAt: now };
  const reason = reasonOf(options.reason);
  if (reason) next.reason = reason;
  else delete next.reason;
  return { ok: true, approval: next };
}

/** Claim a ready approval for applying; a waiting one is `not-ready` until
 *  its condition holds. The same claimant claiming again gets it back
 *  (`already`); anyone else is refused. */
export function claimApproval(
  record: LeadRecord,
  claimId: string,
  now: number,
):
  | { ok: true; approval: LeadApproval; already: boolean }
  | { ok: false; error: ClaimError } {
  const approval = record.approval;
  if (!approval) return { ok: false, error: "no-approval" };
  if (approval.state === "applying")
    return approval.claimId === claimId
      ? { ok: true, approval, already: true }
      : { ok: false, error: "busy" };
  if (approval.state === "void") return { ok: false, error: "voided" };
  if (TERMINAL.has(approval.state)) return { ok: false, error: "settled" };
  if (record.proposal.voidedAt !== undefined)
    return { ok: false, error: "voided" };
  if (now >= approval.expiresAt) return { ok: false, error: "expired" };
  if (approval.state !== "ready") return { ok: false, error: "not-ready" };
  return {
    ok: true,
    already: false,
    approval: {
      ...approval,
      state: "applying",
      updatedAt: now,
      claimId,
      claimedAt: now,
    },
  };
}

// ── Dependencies and storage ────────────────────────────────────────────────

/** The slice of a catalog namespace this store uses (catalog-documents.ts). */
export interface LeadApprovalsDocuments {
  get(key: string): Promise<unknown | null>;
  update<T>(
    key: string,
    mutate: (value: unknown | null) => T | null,
  ): Promise<T | null>;
  list(): Promise<Array<{ key: string; value: unknown }>>;
}

export interface LeadApprovalsDeps {
  now(): number;
  newId(): string;
  documents(): LeadApprovalsDocuments;
}

let documentsCache: LeadApprovalsDocuments | undefined;

const defaultDeps: LeadApprovalsDeps = {
  now: Date.now,
  newId: () => `lp-${randomUUIDv7()}`,
  documents: () =>
    (documentsCache ??= catalogDocuments(LEAD_APPROVALS_NAMESPACE)),
};

let deps: LeadApprovalsDeps = defaultDeps;

/** Swap dependencies in tests. Returns a restore function. */
export function __setLeadApprovalsDepsForTest(
  overrides: Partial<LeadApprovalsDeps>,
): () => void {
  const previous = deps;
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = previous;
  };
}

/** The catalog key for `project`, trimmed like every write's, or null when
 *  it is not a valid project. */
function projectKey(project: string): string | null {
  const result = validate(() => projectOf(project));
  return result.ok ? result.value : null;
}

async function readDocument(project: string): Promise<ApprovalsDocument> {
  return cleanDocument(await deps.documents().get(project), project);
}

/** Compare-and-set one project's document. `mutate` returns null when it
 *  changes nothing, and then nothing is written: a missing document stays
 *  missing. It may run more than once (a first read, then a conflict reruns
 *  it on the committed truth); its last run is the one that counts. */
async function updateDocument(
  project: string,
  mutate: (doc: ApprovalsDocument) => ApprovalsDocument | null,
): Promise<void> {
  const documents = deps.documents();
  if (mutate(cleanDocument(await documents.get(project), project)) === null)
    return;
  await documents.update(project, (current) => {
    const next = mutate(cleanDocument(current, project));
    return next === null ? current : storedDocument(next);
  });
}

function replace(doc: ApprovalsDocument, next: LeadRecord): ApprovalsDocument {
  return {
    ...doc,
    records: doc.records.map((record) =>
      record.proposal.id === next.proposal.id ? next : record,
    ),
  };
}

/** `doc` with expiry applied, or null when nothing was due. */
function expired(
  doc: ApprovalsDocument,
  now: number,
): ApprovalsDocument | null {
  const result = expireRecords(doc.records, now);
  return result.expired ? { ...doc, records: result.records } : null;
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * Record a lead's proposal. Earlier proposals for the same inbox item that
 * have not started are voided as superseded. Refused when the input is
 * invalid, or when the project's records are full of ones still to run.
 */
export async function recordProposal(
  input: ActProposalInput,
): Promise<Valid<ActProposal>> {
  const valid = validateProposalInput(input);
  if (!valid.ok) return valid;
  const now = deps.now();
  if (valid.value.expiresAt !== undefined) {
    const expiry = approvalExpiry(now, valid.value.expiresAt);
    if (!expiry.ok) return expiry;
  }
  const proposal: ActProposal = {
    id: deps.newId(),
    ...valid.value,
    createdAt: now,
  };
  let fits = true;
  await updateDocument(proposal.project, (doc) => {
    const records = expireRecords(doc.records, now).records.map((record) =>
      record.proposal.itemId === proposal.itemId && voidable(record)
        ? voidRecord(record, now, "superseded")
        : record,
    );
    // Unreadable records are kept, so they count against both bounds.
    const pruned = pruneRecords(
      [{ proposal }, ...records],
      MAX_RECORDS - doc.unreadable.length,
      DOCUMENT_BUDGET - byteSize(doc.unreadable),
    );
    fits = pruned.fits;
    return fits ? { ...doc, records: pruned.records } : null;
  });
  if (!fits)
    return {
      ok: false,
      error: "too many proposals still to run in this project",
    };
  return { ok: true, value: proposal };
}

export interface ApproveInput {
  project: string;
  proposalId: string;
  approvedBy: string;
  login: string;
  condition?: unknown;
  expiresAt?: number;
  /** The inbox item revision the owner answered; refused when it is not the
   *  proposal's. The owner's answer passes it only when the client sent
   *  the item's current one (leads/goal.ts); without it nothing is
   *  approved and the answer stays in the ledger. */
  itemRevision: number;
}

export type ApproveError =
  | "invalid"
  | "not-found"
  | "voided"
  | "settled"
  | "stale";

/**
 * The owner's approval of a recorded proposal: waiting when it has a
 * condition, else ready. Refused without the inbox item revision the
 * owner answered (invalid) or with another one than the proposal's
 * (stale). Approving again while one is waiting or ready returns that one
 * (`created: false`).
 */
export async function approve(
  input: ApproveInput,
): Promise<
  | { ok: true; approval: LeadApproval; created: boolean }
  | { ok: false; error: ApproveError; message?: string }
> {
  const now = deps.now();
  const checked = validate(() => {
    if (typeof input.login !== "string" || !LOGIN.test(input.login))
      fail("login is not a GitHub login");
    const expiry = approvalExpiry(now, input.expiresAt);
    if (!expiry.ok) fail(expiry.error);
    return {
      project: projectOf(input.project),
      proposalId: id(input.proposalId, "proposalId"),
      approvedBy: line(input.approvedBy, "approvedBy", NAME_LEN),
      login: input.login,
      itemRevision: time(input.itemRevision, "itemRevision"),
      condition:
        input.condition === undefined
          ? undefined
          : conditionOf(input.condition),
      expiresAt: expiry.value,
    };
  });
  if (!checked.ok)
    return { ok: false, error: "invalid", message: checked.error };
  const fields = checked.value;
  let result:
    | { ok: true; approval: LeadApproval; created: boolean }
    | { ok: false; error: ApproveError } = { ok: false, error: "not-found" };
  await updateDocument(fields.project, (doc) => {
    // Expiry found due is written even when the approval is refused.
    const fresh = expired(doc, now);
    const current = fresh ?? doc;
    const record = current.records.find(
      (r) => r.proposal.id === fields.proposalId,
    );
    if (!record) {
      result = { ok: false, error: "not-found" };
      return fresh;
    }
    if (isLive(record.approval)) {
      result = { ok: true, approval: record.approval, created: false };
      return fresh;
    }
    if (record.proposal.voidedAt !== undefined) {
      result = { ok: false, error: "voided" };
      return fresh;
    }
    if (record.approval) {
      result = { ok: false, error: "settled" };
      return fresh;
    }
    if (fields.itemRevision !== record.proposal.itemRevision) {
      result = { ok: false, error: "stale" };
      return fresh;
    }
    const approval: LeadApproval = {
      proposalId: fields.proposalId,
      approvedBy: fields.approvedBy,
      login: fields.login,
      at: now,
      expiresAt: fields.expiresAt,
      state: fields.condition ? "waiting" : "ready",
      updatedAt: now,
    };
    if (fields.condition) approval.condition = fields.condition;
    result = { ok: true, approval, created: true };
    return replace(current, { ...record, approval });
  });
  return result;
}

/** Move a proposal's approval along the transition table. `applying` is
 *  only entered through `claimApply`; leaving it needs the claim id. */
export async function transition(
  project: string,
  proposalId: string,
  to: LeadApprovalState,
  options: { reason?: string; claimId?: string } = {},
): Promise<
  { ok: true; approval: LeadApproval } | { ok: false; error: TransitionError }
> {
  const key = projectKey(project);
  if (!key) return { ok: false, error: "not-found" };
  const now = deps.now();
  let result:
    | { ok: true; approval: LeadApproval }
    | { ok: false; error: TransitionError } = { ok: false, error: "not-found" };
  await updateDocument(key, (doc) => {
    const record = doc.records.find((r) => r.proposal.id === proposalId);
    if (!record) {
      result = { ok: false, error: "not-found" };
      return null;
    }
    if (!record.approval) {
      result = { ok: false, error: "no-approval" };
      return null;
    }
    if (to !== "void" && record.proposal.voidedAt !== undefined) {
      result = { ok: false, error: "illegal" };
      return null;
    }
    const moved = transitionApproval(record.approval, to, now, options);
    result = moved;
    if (!moved.ok) return null;
    const next: LeadRecord = { ...record, approval: moved.approval };
    if (to === "void")
      next.proposal = {
        ...record.proposal,
        voidedAt: now,
        voidReason: moved.approval.reason ?? "voided",
      };
    return replace(doc, next);
  });
  return result;
}

/**
 * Claim a proposal's approval for applying, in one compare-and-set: ready
 * becomes applying under `claimId`. Idempotent for the same claimant;
 * refused for anyone else, for a waiting approval (`not-ready`), and for
 * one that is void, expired (voided now) or done. Records that no longer
 * validate are not found.
 */
export async function claimApply(
  project: string,
  proposalId: string,
  claimId: string,
): Promise<
  | { ok: true; approval: LeadApproval; already: boolean }
  | { ok: false; error: ClaimError }
> {
  const key = projectKey(project);
  if (!key || !ID.test(claimId)) return { ok: false, error: "not-found" };
  const now = deps.now();
  let result:
    | { ok: true; approval: LeadApproval; already: boolean }
    | { ok: false; error: ClaimError } = { ok: false, error: "not-found" };
  await updateDocument(key, (doc) => {
    const record = doc.records.find((r) => r.proposal.id === proposalId);
    if (!record) {
      result = { ok: false, error: "not-found" };
      return null;
    }
    const claimed = claimApproval(record, claimId, now);
    result = claimed;
    if (claimed.ok && !claimed.already)
      return replace(doc, { ...record, approval: claimed.approval });
    if (!claimed.ok && claimed.error === "expired")
      return replace(doc, voidRecord(record, now, "expired"));
    return null;
  });
  return result;
}

/** Who an approval by the lead's rules names as its approver. */
export const LEAD_RULES_APPROVER = "Blob (lead)";

/** Claim an unapproved proposal for a run the lead's rules allow without
 *  the owner (an alone category at the act stage). Pure; see claimAlone. */
export function claimAloneRecord(
  record: LeadRecord,
  claimId: string,
  rule: string,
  now: number,
): { ok: true; approval: LeadApproval } | { ok: false; error: ClaimError } {
  const approval = record.approval;
  if (approval)
    return {
      ok: false,
      error:
        approval.state === "applying"
          ? "busy"
          : approval.state === "void"
            ? "voided"
            : TERMINAL.has(approval.state)
              ? "settled"
              : "not-ready",
    };
  if (record.proposal.voidedAt !== undefined)
    return { ok: false, error: "voided" };
  const expiresAt =
    record.proposal.expiresAt ?? record.proposal.createdAt + PROPOSAL_TTL_MS;
  if (now >= expiresAt) return { ok: false, error: "expired" };
  return {
    ok: true,
    approval: {
      proposalId: record.proposal.id,
      approvedBy: LEAD_RULES_APPROVER,
      rule: reasonOf(rule) ?? "The project's lead rules",
      at: now,
      expiresAt,
      state: "applying",
      updatedAt: now,
      claimId,
      claimedAt: now,
    },
  };
}

/**
 * Claim a proposal the lead's rules let it run without the owner, in one
 * compare-and-set: a standing proposal with no approval gets one by the
 * rules (`rule` names it), applying under `claimId`. Refused once anything
 * approved or claimed it (`not-ready`, `busy`, `settled`), and for one that
 * is voided or expired (voided now). The caller decides the rules allow it.
 */
export async function claimAlone(
  project: string,
  proposalId: string,
  claimId: string,
  rule: string,
): Promise<
  { ok: true; approval: LeadApproval } | { ok: false; error: ClaimError }
> {
  const key = projectKey(project);
  if (!key || !ID.test(claimId)) return { ok: false, error: "not-found" };
  const now = deps.now();
  let result:
    | { ok: true; approval: LeadApproval }
    | { ok: false; error: ClaimError } = { ok: false, error: "not-found" };
  await updateDocument(key, (doc) => {
    const record = doc.records.find((r) => r.proposal.id === proposalId);
    if (!record) {
      result = { ok: false, error: "not-found" };
      return null;
    }
    const claimed = claimAloneRecord(record, claimId, rule, now);
    result = claimed;
    if (claimed.ok)
      return replace(doc, { ...record, approval: claimed.approval });
    if (claimed.error === "expired")
      return replace(doc, voidRecord(record, now, "expired"));
    return null;
  });
  return result;
}

/** Mark applying approvals claimed at least STALE_APPLY_MS before `now` as
 *  partial: their run died mid-way, and interrupted steps never re-run. */
export function settleInterruptedRecords(
  records: readonly LeadRecord[],
  now: number,
): { records: LeadRecord[]; settled: string[] } {
  const settled: string[] = [];
  const next = records.map((record) => {
    const approval = record.approval;
    if (approval?.state !== "applying") return record;
    if (now - (approval.claimedAt ?? approval.updatedAt) < STALE_APPLY_MS)
      return record;
    settled.push(record.proposal.id);
    return {
      ...record,
      approval: {
        ...approval,
        state: "partial" as const,
        updatedAt: now,
        reason: "interrupted",
      },
    };
  });
  return { records: next, settled };
}

/**
 * Settle applies in `project` that were interrupted: applying for at least
 * STALE_APPLY_MS. They become partial without the claim id and are never
 * claimed or run again. Returns the settled proposal ids.
 */
export async function settleInterrupted(
  project: string,
  now: number = deps.now(),
): Promise<string[]> {
  const key = projectKey(project);
  if (!key) return [];
  let settled: string[] = [];
  await updateDocument(key, (doc) => {
    const result = settleInterruptedRecords(doc.records, now);
    settled = result.settled;
    return settled.length ? { ...doc, records: result.records } : null;
  });
  return settled;
}

/**
 * Void every proposal in `project` that `predicate` picks and has not
 * started: its subject or the category's level changed, or the PR head
 * moved. Waiting and ready approvals become void with it; applying and
 * finished ones are left alone. Returns the voided proposal ids.
 */
export async function voidFor(
  project: string,
  predicate: (record: LeadRecord) => boolean,
  reason: string,
): Promise<string[]> {
  const key = projectKey(project);
  if (!key) return [];
  const now = deps.now();
  const why = reasonOf(reason) ?? "voided";
  let voided: string[] = [];
  await updateDocument(key, (doc) => {
    voided = [];
    const records = doc.records.map((record) => {
      if (!voidable(record) || !predicate(record)) return record;
      voided.push(record.proposal.id);
      return voidRecord(record, now, why);
    });
    return voided.length ? { ...doc, records } : null;
  });
  return voided;
}

/** A project's records, newest first, with expiry applied to the view.
 *  Records that no longer validate are left out. */
export async function listForProject(project: string): Promise<LeadRecord[]> {
  const key = projectKey(project);
  if (!key) return [];
  return expireRecords((await readDocument(key)).records, deps.now()).records;
}

/** The proposal raised as inbox item `itemId` that is still standing: not
 *  voided, and unapproved or with its approval waiting or ready. A newer
 *  proposal for the item supersedes older ones, so there is at most one. */
export async function proposalForItem(
  project: string,
  itemId: string,
): Promise<LeadRecord | undefined> {
  return (await listForProject(project)).find(
    (record) => record.proposal.itemId === itemId && voidable(record),
  );
}

/** One record, with expiry applied to the view. */
export async function getRecord(
  project: string,
  proposalId: string,
): Promise<LeadRecord | undefined> {
  return (await listForProject(project)).find(
    (record) => record.proposal.id === proposalId,
  );
}

/**
 * Void what is past its expiry in every project (one bounded document per
 * project), writing only documents that have something due. Returns how
 * many records were voided.
 */
export async function expire(now: number = deps.now()): Promise<number> {
  let total = 0;
  for (const row of await deps.documents().list()) {
    if (projectKey(row.key) !== row.key) continue;
    if (!expired(cleanDocument(row.value, row.key), now)) continue;
    let count = 0;
    await updateDocument(row.key, (current) => {
      const result = expireRecords(current.records, now);
      count = result.expired;
      return count ? { ...current, records: result.records } : null;
    });
    total += count;
  }
  return total;
}
