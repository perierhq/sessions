/**
 * Where things live in a project's private `knowledge-<project>` repository.
 *
 *   KNOWLEDGE.md                          starter readme (not an item)
 *   articles/<slug>.md                    person-written or approved articles
 *   suggestions/<slug>.md                 proposals from ingestion
 *   sources/mail/<yyyy-mm>/<id>.md        stripped Q&A pairs
 *   sources/repo/<repo path>.md           docs and README mirror
 *   sources/releases/<tag>.md             release notes
 *   sources/web/<host>/<path-slug>.md     crawled pages
 *   sources/issues/<n>.md                 open bug issues
 *   sources/files/<slug>.md               uploaded files' text
 *   attachments/<slug>/<name>             the uploaded files themselves
 *
 * The repository name never matches memory's `isValidRepoName`, so memory
 * (listing, Dreaming, Settings → Memories) never sees a knowledge repo.
 */

import { createHash } from "node:crypto";
import type { KnowledgeOrigin } from "../../shared/knowledge";
import { isMarkdownPath, slugify } from "../memory-repo/format";

export const KNOWLEDGE_ENTRY = "KNOWLEDGE.md";
export const ATTACHMENTS_DIR = "attachments";

const REPO_PREFIX = "knowledge-";
const REPO_NAME = /^knowledge-[A-Za-z0-9@._-]+$/;
const MAX_SLUG = 80;
const MAX_MESSAGE_ID = 120;

/** Folder per origin, without a trailing slash. */
const ORIGIN_FOLDERS: Record<KnowledgeOrigin, string> = {
  article: "articles",
  suggestion: "suggestions",
  mail: "sources/mail",
  repo: "sources/repo",
  release: "sources/releases",
  web: "sources/web",
  issue: "sources/issues",
  file: "sources/files",
};

export function knowledgeRepoName(project: string): string {
  const name = `${REPO_PREFIX}${project}`;
  if (!isKnowledgeRepoName(name))
    throw new Error(`"${project}" can't name a knowledge repository.`);
  return name;
}

export function isKnowledgeRepoName(name: string): boolean {
  return REPO_NAME.test(name) && !name.includes("..");
}

export function projectFromRepo(name: string): string | null {
  return isKnowledgeRepoName(name) ? name.slice(REPO_PREFIX.length) : null;
}

/** A relative path with no empty, `.` or `..` segment, no backslash and no
 *  control characters. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** The origin an item path's folder stands for; null for anything that is
 *  not an item (isItemPath). */
export function originForPath(path: string): KnowledgeOrigin | null {
  if (!isSafeRelativePath(path) || !isMarkdownPath(path)) return null;
  for (const [origin, folder] of Object.entries(ORIGIN_FOLDERS)) {
    if (path.startsWith(`${folder}/`) && path.length > folder.length + 1)
      return origin as KnowledgeOrigin;
  }
  return null;
}

/** Markdown under one of the item folders. KNOWLEDGE.md and attachments are
 *  not items. */
export function isItemPath(path: string): boolean {
  return originForPath(path) !== null;
}

export function isAttachmentPath(path: string): boolean {
  return (
    isSafeRelativePath(path) &&
    path.startsWith(`${ATTACHMENTS_DIR}/`) &&
    path.split("/").length >= 3
  );
}

/** The folder new items of an origin go to. Mail items are filed by the
 *  month they were answered, web items by host. */
export function folderFor(
  origin: KnowledgeOrigin,
  opts: { answeredAt?: string; host?: string } = {},
): string {
  const base = ORIGIN_FOLDERS[origin];
  if (origin === "mail" && opts.answeredAt)
    return `${base}/${monthOf(opts.answeredAt)}`;
  if (origin === "web" && opts.host)
    return `${base}/${safeSegment(opts.host.toLowerCase(), "host")}`;
  return base;
}

function monthOf(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`"${iso}" is not a timestamp.`);
  return new Date(ms).toISOString().slice(0, 7);
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** One path segment from free text: unsafe characters become `-`, leading
 *  dots go, and anything changed gets a short hash of the original so two
 *  different inputs never share a segment. */
function safeSegment(raw: string, fallback: string, max = MAX_MESSAGE_ID) {
  let segment = raw.replace(/[^A-Za-z0-9@._+-]/g, "-").replace(/^\.+/, "");
  const changed = segment !== raw || segment.length > max;
  segment = segment.slice(0, max) || fallback;
  return changed ? `${segment}-${shortHash(raw)}` : segment;
}

export function mailItemPath(messageId: string, answeredAt: string): string {
  const id = messageId.trim().replace(/^<(.*)>$/, "$1");
  return `${folderFor("mail", { answeredAt })}/${safeSegment(id, "message")}.md`;
}

/** Host plus a slug of the URL path; query and fragment are dropped. */
export function webItemPath(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error(`"${url}" is not a web address.`);
  const host = parsed.port
    ? `${parsed.hostname}-${parsed.port}`
    : parsed.hostname;
  const path = decodePath(parsed.pathname).replace(/^\/+|\/+$/g, "");
  const slug = path ? trimSlug(slugify(path, 40)) : "index";
  return `${folderFor("web", { host })}/${slug}.md`;
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The mirror of a code repository file; non-Markdown files get `.md`. */
export function repoItemPath(repoPath: string): string {
  if (!isSafeRelativePath(repoPath))
    throw new Error(`"${repoPath}" is not a repository path.`);
  const file = /\.md$/i.test(repoPath) ? repoPath : `${repoPath}.md`;
  return `${ORIGIN_FOLDERS.repo}/${file}`;
}

export function releaseItemPath(tag: string): string {
  return `${ORIGIN_FOLDERS.release}/${safeSegment(tag, "release")}.md`;
}

export function issueItemPath(issue: number): string {
  if (!Number.isSafeInteger(issue) || issue <= 0)
    throw new Error(`${issue} is not an issue number.`);
  return `${ORIGIN_FOLDERS.issue}/${issue}.md`;
}

function trimSlug(slug: string): string {
  return slug.slice(0, MAX_SLUG).replace(/-+$/, "") || "note";
}

/** `<dir>/<slug>.md` for a title, counting up `-2`, `-3` on collision. */
export function freeSlugPath(
  existing: Set<string>,
  dir: string,
  title: string,
): string {
  const slug = trimSlug(slugify(title, 40));
  const folder = dir.replace(/\/+$/, "");
  let path = `${folder}/${slug}.md`;
  for (let n = 2; existing.has(path); n++) path = `${folder}/${slug}-${n}.md`;
  return path;
}
