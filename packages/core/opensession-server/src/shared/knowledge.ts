/** Per-project support knowledge: the shapes the server, the support agent's
 *  tools and the web UI share. Pure; no I/O.
 *
 *  A knowledge item is a Markdown file with YAML front matter in the
 *  project's private `knowledge-<project>` repository. Only an item that is
 *  trusted, active and not past its review date may back an automatic reply
 *  (isBacking); the send-time checks add the rest (server/knowledge). */

/** `answer` may be quoted to a customer; `internal` is for the team only and
 *  must never be quoted (INTERNAL_QUOTE_WORDS). */
export const KNOWLEDGE_KINDS = ["answer", "internal"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** `trusted` may back an automatic reply; `reference` only informs. */
export const KNOWLEDGE_TRUST = ["trusted", "reference"] as const;
export type KnowledgeTrust = (typeof KNOWLEDGE_TRUST)[number];

export const KNOWLEDGE_STATUSES = ["active", "needs-check", "retired"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/** Where an item came from; decides its folder and default trust. */
export const KNOWLEDGE_ORIGINS = [
  "article",
  "suggestion",
  "mail",
  "repo",
  "release",
  "web",
  "issue",
  "file",
] as const;
export type KnowledgeOrigin = (typeof KNOWLEDGE_ORIGINS)[number];

/** Why an item needs a check, written with `status: needs-check`. */
export interface KnowledgeCheckNote {
  reason: string;
  /** YYYY-MM-DD. */
  since: string;
  /** The change that triggered it, e.g. `repo:docs/export.md@<sha>`. */
  source?: string;
  /** Another item's path this one disagrees with. */
  conflictWith?: string;
}

export interface KnowledgeFrontMatter {
  /** At most 200 characters. */
  title: string;
  kind: KnowledgeKind;
  trust: KnowledgeTrust;
  status: KnowledgeStatus;
  origin: KnowledgeOrigin;
  /** At most 12, each at most 60 characters. */
  topics: string[];
  /** What the text was taken from: `mail:<id>`, `repo:<path>@<sha>`,
   *  `url:<url>#sha256=<hex>`, `issue:<n>`, `release:<tag>`, `file:<name>`. */
  sources: string[];
  /** What would make it stale (parseDependency). */
  dependsOn: string[];
  /** YYYY-MM-DD. */
  validAsOf: string;
  /** The code repository's default-branch commit the item was checked
   *  against; optional for items that depend on URLs only. */
  validAsOfCommit?: string;
  /** YYYY-MM-DD; past it the item needs a check (effectiveStatus). */
  reviewBy?: string;
  /** Only with `status: needs-check`. */
  check?: KnowledgeCheckNote;
  suggestedBy?: string;
  approvedBy?: string;
  /** Mail items only: when the reply was sent (ISO timestamp). */
  answeredAt?: string;
}

/** A parsed `dependsOn` entry. `repo:<path>/` (trailing slash) is a prefix
 *  that depends on everything under that folder. */
export type DependencyRef =
  | { type: "repo"; path: string; prefix: boolean }
  | { type: "url"; url: string }
  | { type: "issue"; number: number }
  | { type: "pr"; number: number }
  | { type: "release"; tag: string };

/** A relative path with no empty, `.`, `..` or `.git` segment and no
 *  backslash or control character. `allowTrailingSlash` lets a folder prefix
 *  through. */
function safeRelativePath(path: string, allowTrailingSlash: boolean): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const body =
    allowTrailingSlash && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!body) return false;
  return body
    .split("/")
    .every(
      (s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git",
    );
}

/** Git's flag that makes every pathspec in a command literal: no `:(magic)`,
 *  no `*`, `?` or `[...]` wildcards. Every git call that passes a `repo:`
 *  dependency path (or any other caller-supplied path) as a pathspec must
 *  pass it first, e.g. `git --literal-pathspecs log -- <path>`. parseDependency
 *  already refuses those characters; this is the second lock. */
export const LITERAL_PATHSPECS = "--literal-pathspecs";

/** Characters git reads as pathspec magic or wildcards. */
const PATHSPEC_SPECIAL = /[*?[\]]/;

/** A tag name git accepts and no caller can turn into an option or a range. */
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/;

/** YYYY-MM-DD. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const POSITIVE_INT = /^[1-9]\d{0,9}$/;

/** Reads one `dependsOn` entry; null when it is malformed or of a kind the
 *  freshness check can't follow. */
export function parseDependency(raw: string): DependencyRef | null {
  if (typeof raw !== "string") return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const type = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  switch (type) {
    case "repo":
      // Read as a literal path (LITERAL_PATHSPECS); refuse what git would
      // read as magic (`:(exclude)…`, `:/…`) or a wildcard anyway.
      if (value.startsWith(":") || PATHSPEC_SPECIAL.test(value)) return null;
      if (!safeRelativePath(value, true)) return null;
      return { type: "repo", path: value, prefix: value.endsWith("/") };
    case "url": {
      if (value !== value.trim() || !value) return null;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return null;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      // Credentials don't belong in front matter (and would be fetched).
      if (url.username || url.password) return null;
      return { type: "url", url: value };
    }
    case "issue":
    case "pr":
      if (!POSITIVE_INT.test(value)) return null;
      return { type, number: Number(value) };
    case "release":
      if (!RELEASE_TAG.test(value) || value.includes("..")) return null;
      return { type: "release", tag: value };
    default:
      return null;
  }
}

export function formatDependency(d: DependencyRef): string {
  switch (d.type) {
    case "repo":
      return `repo:${d.path}`;
    case "url":
      return `url:${d.url}`;
    case "issue":
      return `issue:${d.number}`;
    case "pr":
      return `pr:${d.number}`;
    case "release":
      return `release:${d.tag}`;
  }
}

/** Folders whose files are knowledge items (KNOWLEDGE.md is not one). */
const ITEM_FOLDERS = ["articles/", "suggestions/", "sources/"] as const;
const COMMIT = /^[0-9a-f]{7,64}$/;
const CITATION_PREFIX = "knowledge:";

/** Reads a knowledge citation, `<path>@<commit>` or its display form
 *  `knowledge:<path>@<commit>`. `<commit>` is the knowledge repository commit
 *  the agent read (7–64 hex). Null for anything outside the item folders. */
export function parseKnowledgeCitation(
  ref: string,
): { path: string; commit: string } | null {
  if (typeof ref !== "string") return null;
  const raw = ref.startsWith(CITATION_PREFIX)
    ? ref.slice(CITATION_PREFIX.length)
    : ref;
  // Paths may hold "@" (mail items are named by Message-ID); the commit is
  // after the last one.
  const at = raw.lastIndexOf("@");
  if (at <= 0) return null;
  const path = raw.slice(0, at);
  const commit = raw.slice(at + 1);
  if (!COMMIT.test(commit)) return null;
  if (!safeRelativePath(path, false)) return null;
  const folder = ITEM_FOLDERS.find((f) => path.startsWith(f));
  if (!folder || path.length === folder.length) return null;
  return { path, commit };
}

export function formatKnowledgeCitation(path: string, commit: string): string {
  return `${CITATION_PREFIX}${path}@${commit}`;
}

/** The status that counts today: an active item past its review date, or
 *  with a review date that isn't YYYY-MM-DD, needs a check. Dates compare as
 *  strings. Throws when `today` isn't YYYY-MM-DD (a caller bug). */
export function effectiveStatus(
  fm: Pick<KnowledgeFrontMatter, "status" | "reviewBy">,
  today: string,
): KnowledgeStatus {
  if (!DAY.test(today)) throw new Error(`Invalid date "${today}".`);
  if (fm.status !== "active" || fm.reviewBy == null) return fm.status;
  if (!DAY.test(fm.reviewBy) || fm.reviewBy < today) return "needs-check";
  return fm.status;
}

/** Whether the item may back an automatic reply by itself (the send-time
 *  checks in server/knowledge/backing.ts come on top). */
export function isBacking(
  fm: Pick<KnowledgeFrontMatter, "trust" | "status" | "reviewBy">,
  today: string,
): boolean {
  return fm.trust === "trusted" && effectiveStatus(fm, today) === "active";
}

/** One item as the index and the API return it. */
export interface KnowledgeItem extends KnowledgeFrontMatter {
  project: string;
  /** Repository path, e.g. `articles/export.md`. */
  path: string;
  /** Git blob sha of the file. */
  blob: string;
  /** The knowledge repository commit this content was read at. */
  commit: string;
  updatedAt: string;
  effective: KnowledgeStatus;
  excerpt: string;
}

export interface KnowledgeSearchHit {
  item: KnowledgeItem;
  rank: number;
}

/** What the server found about a draft's knowledge at the moment of sending
 *  (server/knowledge/backing.ts). Shown to people only. */
export interface KnowledgeVerdict {
  /** Citations that may back the reply. */
  backing: Array<{ kind: "knowledge"; ref: string }>;
  /** Citations that can't, with the KNOWLEDGE_COPY reason. `uncited`:
   *  not cited, but the session read it (`<path>@<commit read>`), so the
   *  reply may rest on it whatever else the draft cites. */
  blocked: Array<{
    ref: string;
    path: string;
    title: string;
    reason: string;
    uncited?: true;
  }>;
  /** An internal article the draft quotes; the draft then waits. */
  internalQuoted: { path: string; title: string } | null;
  /** The check itself failed; the draft waits (fail closed). */
  failed: boolean;
  at: string;
}

/** The words people see. Exact; tests and the E2E match them. */
export const KNOWLEDGE_COPY = {
  stale: (title: string) => `Knowledge may be out of date: ${title}`,
  internalQuoted: "The reply quotes an internal note",
  unchecked: "Knowledge couldn't be checked",
  changedSinceRead: "Changed since the agent read it",
  reviewPassed: (d: string) => `Review date passed (${d})`,
  notTrusted: "Reference material, not approved for replies",
  notRead: "This session didn't read it",
} as const;

/** The Knowledge page's list filters. */
export const KNOWLEDGE_FILTERS = [
  "all",
  "answer",
  "internal",
  "needs-check",
  "reference",
  "suggestions",
  "retired",
] as const;
export type KnowledgeFilter = (typeof KNOWLEDGE_FILTERS)[number];

export const KNOWLEDGE_IMPORT_KINDS = [
  "mailbox",
  "website",
  "repo",
  "files",
  "known-problems",
] as const;
export type KnowledgeImportKind = (typeof KNOWLEDGE_IMPORT_KINDS)[number];

/** One import run and its progress (catalog namespace `knowledge-jobs`). */
export interface KnowledgeImportJob {
  id: string;
  project: string;
  kind: KnowledgeImportKind;
  state: "queued" | "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  done: number;
  /** Null while the total is unknown. */
  total: number | null;
  created: {
    trusted: number;
    reference: number;
    suggestions: number;
    skipped: number;
  };
  error?: string;
  options: Record<string, unknown>;
}

/** Mailbox backfill window, in months. */
export const DEFAULT_BACKFILL_MONTHS = 12;
export const MAX_BACKFILL_MONTHS = 36;
/** Consecutive normalized words of an internal article that count as a
 *  quote. */
export const INTERNAL_QUOTE_WORDS = 12;
/** How often each project's knowledge is re-validated. */
export const KNOWLEDGE_REVALIDATE_MS = 24 * 60 * 60 * 1000;
/** How often a crawled page is fetched again. */
export const WEB_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
