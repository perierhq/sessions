// Pure view models for a project's Knowledge: an item's badges and freshness
// line, the list filters' labels and empty states, an import's progress
// line, and the counts the project page shows. No I/O, no React.

import {
  KNOWLEDGE_COPY,
  type KnowledgeFilter,
  type KnowledgeImportJob,
  type KnowledgeImportKind,
  type KnowledgeItem,
  type KnowledgeOrigin,
} from "../../../shared/knowledge";
import { ApiError } from "../api/request";
import { agentInProse } from "../brand";
import { errorMessage } from "../error-message";

export type KnowledgeBadgeLabel =
  | "Internal"
  | "Reference"
  | "Needs check"
  | "Retired"
  | "Overdue";

/** ui/badge tones. */
export type KnowledgeBadgeTone = "neutral" | "info" | "warning" | "danger";

export interface KnowledgeBadge {
  label: KnowledgeBadgeLabel;
  tone: KnowledgeBadgeTone;
}

type BadgeItem = Pick<
  KnowledgeItem,
  "kind" | "trust" | "status" | "effective" | "reviewBy"
>;

/** Active by its own status, but its review date has passed. */
function isOverdue(item: BadgeItem): boolean {
  return item.status === "active" && item.effective === "needs-check";
}

/** What an item is, then why it can't back a reply. An answer is the
 *  default kind, so a trusted, active answer carries no badge at all and a
 *  list of them stays calm. */
export function itemBadges(item: BadgeItem): KnowledgeBadge[] {
  const badges: KnowledgeBadge[] = [];
  if (item.kind === "internal")
    badges.push({ label: "Internal", tone: "info" });
  if (item.trust === "reference")
    badges.push({ label: "Reference", tone: "neutral" });
  if (item.effective === "retired")
    badges.push({ label: "Retired", tone: "neutral" });
  // One badge for the hold: Overdue says it needs a check, and why.
  if (isOverdue(item)) badges.push({ label: "Overdue", tone: "warning" });
  else if (item.effective === "needs-check")
    badges.push({ label: "Needs check", tone: "warning" });
  return badges;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "26 Oct 2026" for 2026-10-26; anything else as written. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return day;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** One line on how current an item is: why it needs a check, when it is
 *  due for review, or the day it was last known right. Beside a Needs
 *  check or Overdue badge the line is the reason alone; the badge already
 *  says it needs a check. */
export function freshnessLine(
  item: Pick<
    KnowledgeItem,
    "status" | "effective" | "check" | "reviewBy" | "validAsOf"
  >,
  today: string,
): string {
  if (item.status === "needs-check")
    return item.check?.reason ?? "Needs a check";
  if (item.status === "active" && item.reviewBy) {
    const passed = KNOWLEDGE_COPY.reviewPassed(formatDay(item.reviewBy));
    if (item.effective === "needs-check") return passed;
    if (item.reviewBy < today) return `Needs a check: ${passed}`;
    return `Review by ${formatDay(item.reviewBy)}`;
  }
  return `Valid as of ${formatDay(item.validAsOf)}`;
}

const ORIGIN_LABELS: Record<KnowledgeOrigin, string | null> = {
  article: null,
  suggestion: "Suggestion",
  mail: "From the mailbox",
  repo: "From the docs",
  release: "From release notes",
  web: "From the website",
  issue: "From an issue",
  file: "From a file",
};

/** Where an item came from, for a list row; null for an article the team
 *  wrote, which is most of them. */
export function originLabel(origin: KnowledgeOrigin): string | null {
  return ORIGIN_LABELS[origin];
}

/** The day, read in UTC, for freshness lines and new articles. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A list row's second line: how current the item is, then where it came
 *  from when that isn't the team. */
export function listLine(
  item: Pick<
    KnowledgeItem,
    "status" | "effective" | "check" | "reviewBy" | "validAsOf" | "origin"
  >,
  today: string,
): string {
  const line = freshnessLine(item, today);
  const origin = originLabel(item.origin);
  return origin ? `${line} · ${origin}` : line;
}

/** How long the search box waits after the last key. */
export const SEARCH_DEBOUNCE_MS = 250;

/** The Articles tab's filter chips (suggestions have their own tab). */
export const LIST_FILTERS = [
  "all",
  "answer",
  "internal",
  "needs-check",
  "reference",
  "retired",
] as const satisfies readonly KnowledgeFilter[];

const FILTER_LABELS: Record<KnowledgeFilter, string> = {
  all: "All",
  answer: "Answer",
  internal: "Internal",
  "needs-check": "Needs check",
  reference: "Reference",
  suggestions: "Suggestions",
  retired: "Retired",
};

export function filterLabel(filter: KnowledgeFilter): string {
  return FILTER_LABELS[filter];
}

const EMPTY_COPY: Record<KnowledgeFilter, string> = {
  all: "No knowledge yet. Write an article, or import your mailbox, docs or website",
  answer: "No answers yet",
  internal: "No internal notes",
  "needs-check": "Nothing needs a check",
  reference: "No reference material",
  suggestions: `No suggestions. ${agentInProse({ start: true })} suggests articles from the replies your team sends`,
  retired: "Nothing retired",
};

/** What a filter's list says when it has nothing in it. */
export function emptyCopy(filter: KnowledgeFilter): string {
  return EMPTY_COPY[filter];
}

const IMPORT_LABELS: Record<KnowledgeImportKind, string> = {
  mailbox: "Mailbox",
  website: "Website",
  repo: "Repository",
  files: "Files",
  "known-problems": "Known problems",
};

export function importLabel(kind: KnowledgeImportKind): string {
  return IMPORT_LABELS[kind];
}

function created(job: KnowledgeImportJob): string {
  const { trusted, reference, suggestions, skipped } = job.created;
  const parts: string[] = [];
  if (trusted) parts.push(`${trusted} trusted`);
  if (reference) parts.push(`${reference} reference`);
  if (suggestions)
    parts.push(
      `${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"}`,
    );
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

/** "Mailbox · 120 of 340 · 80 trusted, 30 reference, 6 suggestions". */
export function jobLine(job: KnowledgeImportJob): string {
  const head = importLabel(job.kind);
  if (job.state === "queued") return `${head} · Waiting to start`;
  if (job.state === "failed")
    return job.error ? `${head} · Failed: ${job.error}` : `${head} · Failed`;
  const progress =
    job.state === "done"
      ? "Done"
      : job.total === null
        ? `${job.done} so far`
        : `${job.done} of ${job.total}`;
  const made = created(job);
  return made ? `${head} · ${progress} · ${made}` : `${head} · ${progress}`;
}

/** The newest import still running or waiting, for the project page. */
export function runningJob(
  jobs: readonly KnowledgeImportJob[],
): KnowledgeImportJob | null {
  let newest: KnowledgeImportJob | null = null;
  for (const job of jobs) {
    if (job.state !== "running" && job.state !== "queued") continue;
    if (!newest || job.startedAt > newest.startedAt) newest = job;
  }
  return newest;
}

export interface KnowledgeSectionCounts {
  /** Answers and internal notes that are active. */
  articles: number;
  needsCheck: number;
  suggestions: number;
  reference: number;
}

/** The counts the project page shows, from the list's per-filter counts. */
export function sectionCounts(
  counts: Record<KnowledgeFilter, number>,
): KnowledgeSectionCounts {
  return {
    articles: counts.answer + counts.internal,
    needsCheck: counts["needs-check"],
    suggestions: counts.suggestions,
    reference: counts.reference,
  };
}

/** The server gave no words of its own (request()'s `<label>: <status>`). */
function bare(error: ApiError): boolean {
  return /: \d{3}$/.test(error.message);
}

/** Not wired on this server (501): nothing to retry, so it reads as info. */
export function knowledgeNotSetUp<Rejected>(error: Rejected): boolean {
  return error instanceof ApiError && error.status === 501;
}

/** What a failed knowledge request says. The server's own words win; a
 *  bare 503 (the worker is down or restarting) and a bare 501 get a
 *  sentence that says what happened instead of a status code. */
export function knowledgeErrorMessage<Rejected>(
  error: Rejected,
  fallback: string,
): string {
  if (error instanceof ApiError && bare(error)) {
    if (error.status === 503)
      return "Knowledge is unavailable right now. Try again in a minute";
    if (error.status === 501) return "Knowledge isn't set up on this server";
  }
  return errorMessage(error, fallback);
}

/** InlineAlert's props for a pane that couldn't load: the error with
 *  Retry, or an info notice without it when knowledge isn't set up. */
export function knowledgeAlert<Rejected>(
  error: Rejected,
  fallback: string,
  onRetry: () => void,
): { variant: "info" | "error"; onRetry?: () => void; children: string } {
  const children = knowledgeErrorMessage(error, fallback);
  return knowledgeNotSetUp(error)
    ? { variant: "info", children }
    : { variant: "error", onRetry, children };
}
