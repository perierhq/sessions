// Pure view models for a project's Knowledge → Import tab: which inboxes a
// mailbox import may read, the backfill windows, the websites a crawl
// visits, the files the server would refuse, and how often the jobs list
// is polled. No I/O, no React.

import {
  DEFAULT_BACKFILL_MONTHS,
  type KnowledgeImportJob,
} from "../../../shared/knowledge";
import { importLabel, jobLine } from "./models";

/** The mailbox backfill windows offered, in months. */
export const BACKFILL_MONTH_CHOICES = [3, 6, 12, 24, 36] as const;
export const DEFAULT_IMPORT_MONTHS = DEFAULT_BACKFILL_MONTHS;

export function monthsLabel(months: number): string {
  return months === 1 ? "1 month" : `${months} months`;
}

/** The window select's options. */
export function monthOptions(): Array<{ value: string; label: string }> {
  return BACKFILL_MONTH_CHOICES.map((months) => ({
    value: String(months),
    label: monthsLabel(months),
  }));
}

interface InboxChoice {
  id: string;
  label: string;
  address: string;
  project: string;
}

/** The inboxes a mailbox import on `project` may read: only its own (the
 *  server refuses another project's inbox). */
export function importChoices(
  inboxes: readonly InboxChoice[],
  project: string,
): Array<{ value: string; label: string }> {
  return inboxes
    .filter((inbox) => inbox.project === project)
    .map((inbox) => ({
      value: inbox.id,
      label: `${inbox.label} (${inbox.address})`,
    }));
}

/** How often the jobs list is read while an import is under way. */
export const JOB_POLL_MS = 2_000;

/** SWR's refreshInterval for the jobs list: every 2 s while any job is
 *  queued or running, otherwise no polling. */
export function pollJobs(
  jobs: readonly KnowledgeImportJob[] | undefined,
): number {
  return jobs?.some((job) => job.state === "queued" || job.state === "running")
    ? JOB_POLL_MS
    : 0;
}

/** True while a job can still be cancelled. */
export function isActiveJob(job: KnowledgeImportJob): boolean {
  return job.state === "queued" || job.state === "running";
}

/** A job's progress, 0–100; null while the total is unknown. */
export function jobProgress(job: KnowledgeImportJob): number | null {
  if (job.state === "done") return 100;
  if (job.total === null) return null;
  if (job.total <= 0) return 0;
  return Math.min(100, Math.round((job.done / job.total) * 100));
}

/** The note under a job that stopped at a limit. */
export const TRUNCATED_COPY =
  "Stopped at a limit, so part of the source was left out";

/** One Support website and whether the crawl visits it. */
export interface WebsiteHost {
  host: string;
  /** Why the crawl leaves it out; null when it is crawled. */
  skipped: "skipped: wildcard" | "skipped: not a host name" | null;
}

/** The exact host (and port) a crawl accepts, as the server reads it
 *  (ingest/website.ts exactHosts). */
const EXACT_HOST = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.?(:\d{1,5})?$/;

/**
 * The project's Support websites, in the access table's order: an exact
 * host is crawled, a wildcard (or anything else that isn't one host) is
 * listed as skipped. Rows not ticked for Support are left out; a host
 * listed twice is listed once.
 */
export function websiteHosts(
  rows: ReadonlyArray<{ host: string; roles: readonly string[] }>,
): WebsiteHost[] {
  const out: WebsiteHost[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.roles.includes("support")) continue;
    const entry = row.host.trim().toLowerCase();
    const m = EXACT_HOST.exec(entry);
    const host = m ? `${m[1]}${m[2] ?? ""}` : entry;
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({
      host,
      skipped: m
        ? null
        : host.includes("*")
          ? "skipped: wildcard"
          : "skipped: not a host name",
    });
  }
  return out;
}

// The server's refusals (ingest/files.ts), word for word; the test pins
// them to the server's constants.
export const MAX_IMPORT_FILES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ZIP_COPY = "Unzip the export and upload the files";
const FILE_TOO_BIG_COPY = "Files can be up to 10 MB";
const TOO_MANY_FILES_COPY = `Import up to ${MAX_IMPORT_FILES} files at a time`;
const FILE_TYPES_COPY =
  "Import Markdown, text, HTML or PDF files (.md, .txt, .html, .pdf)";

/** The picker's accept list. */
export const FILE_ACCEPT = ".md,.markdown,.txt,.html,.pdf";

const FILE_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "html",
  "htm",
  "pdf",
]);
const ZIP_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

interface PickedFile {
  name: string;
  type: string;
  size: number;
}

export interface CheckedFiles<F extends PickedFile> {
  /** The files to send. */
  accepted: F[];
  /** Files left out, each with the server's reason. */
  refused: Array<{ name: string; reason: string }>;
  /** Refuses the whole pick (too many files); nothing is sent. */
  error: string | null;
}

/** Splits a pick into what the server takes and what it would refuse, so
 *  one refused file doesn't turn the whole upload away. */
export function checkFiles<F extends PickedFile>(
  files: readonly F[],
): CheckedFiles<F> {
  if (files.length > MAX_IMPORT_FILES)
    return { accepted: [], refused: [], error: TOO_MANY_FILES_COPY };
  const accepted: F[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    const reason =
      ext === "zip" || ZIP_TYPES.has(file.type.toLowerCase())
        ? ZIP_COPY
        : file.size > MAX_FILE_BYTES
          ? FILE_TOO_BIG_COPY
          : FILE_EXTENSIONS.has(ext)
            ? null
            : FILE_TYPES_COPY;
    if (reason) refused.push({ name: file.name, reason });
    else accepted.push(file);
  }
  return { accepted, refused, error: null };
}

const CANCELLED = "Cancelled.";

/** A job's line: its progress and what it made (jobLine), or for a job that
 *  ended badly just the kind and "Failed" or "Cancelled"; the reason goes
 *  on its own line (jobError). */
export function jobTitle(job: KnowledgeImportJob): string {
  if (job.state !== "failed") return jobLine(job);
  const head = importLabel(job.kind);
  return job.error === CANCELLED ? `${head} · Cancelled` : `${head} · Failed`;
}

/** Why a job failed; null for one that didn't, or that a person stopped. */
export function jobError(job: KnowledgeImportJob): string | null {
  return job.state === "failed" && job.error && job.error !== CANCELLED
    ? job.error
    : null;
}
