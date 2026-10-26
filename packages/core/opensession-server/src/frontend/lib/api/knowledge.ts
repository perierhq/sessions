// A project's support knowledge (/api/knowledge/<project>/…, see
// server/routes/knowledge.ts). Signed-in people only; every write is one
// commit in the project's knowledge repository and answers with it. A write
// sends the blob it read, and a 409 means someone changed the item since.
import type {
  KnowledgeFilter,
  KnowledgeFrontMatter,
  KnowledgeImportJob,
  KnowledgeImportKind,
  KnowledgeItem,
} from "../../../shared/knowledge";
import { z } from "zod";
import { API_BASE, ApiError, request } from "./request";

const ERROR_RESPONSE_SCHEMA = z.object({ error: z.string() });

/** A page of the list (50 items), the counts per filter and the
 *  knowledge repository's head (null before anything was written). */
export interface KnowledgeList {
  items: KnowledgeItem[];
  total: number;
  counts: Record<KnowledgeFilter, number>;
  head: string | null;
}

export interface KnowledgeRead {
  item: KnowledgeItem;
  body: string;
  commit: string;
}

/** What changed under an item that needs a check, for the comparison. */
export interface KnowledgeNeedsCheckChange {
  kind: "repo" | "url" | "release" | "issue" | "conflict" | "review";
  title: string;
  before?: string;
  after?: string;
  patch?: string;
  link?: string;
}

export interface KnowledgeNeedsCheckRow {
  item: KnowledgeItem;
  body: string;
  change: KnowledgeNeedsCheckChange;
}

/** A commit in the knowledge repository's history. */
export interface KnowledgeCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ status: string; path: string }>;
}

/** One re-validation run's outcome (freshness/revalidate.ts). */
export interface KnowledgeRevalidateResult {
  checked: number;
  flipped: Array<{ path: string; reason: string }>;
  refreshed: number;
  conflicts: Array<{ a: string; b: string }>;
  errors: string[];
}

/** The article to save: new when `path` is left out. */
export interface KnowledgeSave {
  fm: KnowledgeFrontMatter;
  body: string;
  /** The item's path; omit to create a new article. */
  path?: string;
  /** The blob read before editing; null for a path that must not exist. */
  expectedBlob?: string | null;
}

/** What PUT item takes: `path` and `expectedBlob` travel together. */
interface KnowledgeSaveBody {
  fm: KnowledgeFrontMatter;
  body: string;
  path?: string;
  expectedBlob?: string | null;
}

function base(project: string): string {
  return `/knowledge/${encodeURIComponent(project)}`;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== "") q.set(key, String(value));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function fetchKnowledge(
  project: string,
  opts: { filter?: KnowledgeFilter; q?: string; offset?: number } = {},
): Promise<KnowledgeList> {
  return request<KnowledgeList>(
    `${base(project)}${query({ filter: opts.filter, q: opts.q?.trim(), offset: opts.offset })}`,
    { label: "Couldn't load the knowledge" },
  );
}

export function fetchKnowledgeItem(
  project: string,
  path: string,
): Promise<KnowledgeRead> {
  return request<KnowledgeRead>(`${base(project)}/item${query({ path })}`, {
    label: "Couldn't load the article",
  });
}

export function saveKnowledgeItem(
  project: string,
  save: KnowledgeSave,
): Promise<{ item: KnowledgeItem | null; commit: string | null }> {
  const body: KnowledgeSaveBody = { fm: save.fm, body: save.body };
  if (save.path !== undefined) {
    body.path = save.path;
    body.expectedBlob = save.expectedBlob ?? null;
  }
  return request(`${base(project)}/item`, {
    method: "PUT",
    body,
    label: "Couldn't save the article",
  });
}

/** Mark items as still right as of today (and the code's current head). */
export function confirmKnowledge(
  project: string,
  paths: string[],
): Promise<{ commit: string | null }> {
  return request(`${base(project)}/confirm`, {
    method: "POST",
    body: { paths },
    label: "Couldn't confirm",
  });
}

export function retireKnowledge(
  project: string,
  paths: string[],
): Promise<{ commit: string | null }> {
  return request(`${base(project)}/retire`, {
    method: "POST",
    body: { paths },
    label: "Couldn't retire",
  });
}

/** Approve suggestions as articles, with an edited version of some. */
export function approveSuggestions(
  project: string,
  paths: string[],
  edits?: Record<string, { fm: KnowledgeFrontMatter; body: string }>,
): Promise<{ commit: string | null; approved: string[] }> {
  return request(`${base(project)}/suggestions/approve`, {
    method: "POST",
    body: edits ? { paths, edits } : { paths },
    label: "Couldn't approve",
  });
}

export function discardSuggestions(
  project: string,
  paths: string[],
): Promise<{ commit: string | null }> {
  return request(`${base(project)}/suggestions/discard`, {
    method: "POST",
    body: { paths },
    label: "Couldn't discard",
  });
}

/** Up to 100 items that need a check, each with what changed. */
export async function fetchNeedsCheck(
  project: string,
): Promise<KnowledgeNeedsCheckRow[]> {
  const body = await request<{ items: KnowledgeNeedsCheckRow[] } | null>(
    `${base(project)}/needs-check`,
    { label: "Couldn't load what needs a check" },
  );
  return body?.items ?? [];
}

export async function fetchKnowledgeHistory(
  project: string,
  opts: { path?: string; limit?: number } = {},
): Promise<KnowledgeCommit[]> {
  const body = await request<{ commits: KnowledgeCommit[] } | null>(
    `${base(project)}/history${query({ path: opts.path, limit: opts.limit })}`,
    { label: "Couldn't load the history" },
  );
  return body?.commits ?? [];
}

export async function fetchKnowledgeDiff(
  project: string,
  sha: string,
): Promise<string> {
  const body = await request<{ diff: string } | null>(
    `${base(project)}/diff${query({ sha })}`,
    { label: "Couldn't load the change" },
  );
  return body?.diff ?? "";
}

export function revertKnowledge(
  project: string,
  sha: string,
): Promise<{ commit: string | null }> {
  return request(`${base(project)}/revert`, {
    method: "POST",
    body: { sha },
    label: "Couldn't undo the change",
  });
}

/** What an import is started with: a mailbox import names its inbox and
 *  how many months back to read; the others take nothing. */
export interface KnowledgeImportOptions {
  inboxId?: string;
  months?: number;
}

/** Start an import (files go through uploadKnowledgeFiles). */
export async function startKnowledgeImport(
  project: string,
  kind: Exclude<KnowledgeImportKind, "files">,
  body: KnowledgeImportOptions = {},
): Promise<KnowledgeImportJob> {
  const res = await request<{ job: KnowledgeImportJob }>(
    `${base(project)}/import/${kind}`,
    { method: "POST", body, label: "Couldn't start the import" },
  );
  return res.job;
}

/** `request` for a multipart body: the same ApiError on a refusal. */
async function postForm<T>(
  path: string,
  form: FormData,
  label: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: form,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = ERROR_RESPONSE_SCHEMA.safeParse(body);
    throw new ApiError(
      error.success ? error.data.error : `${label}: ${res.status}`,
      res.status,
    );
  }
  // SAFETY: a 2xx from these routes is the JSON shape the caller names,
  // the same contract `request<T>` relies on for every other call here.
  return body as T;
}

/** Import PDF, Markdown and export files (up to 20, 10 MB each). */
export async function uploadKnowledgeFiles(
  project: string,
  files: File[],
): Promise<KnowledgeImportJob> {
  const form = new FormData();
  for (const file of files) form.append("file", file);
  const res = await postForm<{ job: KnowledgeImportJob }>(
    `${base(project)}/import/files`,
    form,
    "Couldn't import the files",
  );
  return res.job;
}

/** Attach an image or a PDF to an article. */
export function attachKnowledgeFile(
  project: string,
  articlePath: string,
  file: File,
): Promise<{ path: string; commit: string | null }> {
  const form = new FormData();
  form.append("file", file);
  form.append("path", articlePath);
  return postForm(
    `${base(project)}/attachments`,
    form,
    "Couldn't attach the file",
  );
}

/** Where an attachment is served (images inline, anything else a
 *  download). */
export function knowledgeAttachmentUrl(project: string, path: string): string {
  return `${API_BASE}${base(project)}/attachment${query({ path })}`;
}

export async function fetchKnowledgeJobs(
  project: string,
): Promise<KnowledgeImportJob[]> {
  const body = await request<{ jobs: KnowledgeImportJob[] } | null>(
    `${base(project)}/jobs`,
    { label: "Couldn't load the imports" },
  );
  return body?.jobs ?? [];
}

/** Check every item against its sources now. */
export async function revalidateKnowledge(
  project: string,
): Promise<KnowledgeRevalidateResult> {
  const body = await request<{ result: KnowledgeRevalidateResult }>(
    `${base(project)}/revalidate`,
    { method: "POST", body: {}, label: "Couldn't check the knowledge" },
  );
  return body.result;
}
