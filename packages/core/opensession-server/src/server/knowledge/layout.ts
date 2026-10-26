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
 * Every segment of an item or attachment path is a plain ASCII name
 * (isSafeSegment). Names that differ only by case or Unicode normalisation
 * are distinct paths here; the writer refuses such a collision (git on a
 * case-insensitive checkout would merge them).
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
/** One item or attachment path segment. */
const SEGMENT = /^[A-Za-z0-9@._+-]{1,200}$/;
/** File types an attachment may have. Served as downloads (Content-
 *  Disposition: attachment, nosniff), never rendered inline. */
export const ATTACHMENT_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf",
  "md",
  "txt",
] as const;

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

/** A path segment of letters, digits and `@._+-`, at most 200 characters,
 *  not starting with a dot. */
export function isSafeSegment(segment: string): boolean {
  return SEGMENT.test(segment) && !segment.startsWith(".");
}

/** A safe relative path whose every segment is isSafeSegment. */
export function hasSafeSegments(path: string): boolean {
  return isSafeRelativePath(path) && path.split("/").every(isSafeSegment);
}

/** The origin an item path's folder stands for; null for anything that is
 *  not an item (isItemPath). */
export function originForPath(path: string): KnowledgeOrigin | null {
  if (!hasSafeSegments(path) || !isMarkdownPath(path)) return null;
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

/** Exactly `attachments/<slug>/<name>` with an ATTACHMENT_EXTENSIONS type. */
export function isAttachmentPath(path: string): boolean {
  if (!hasSafeSegments(path)) return false;
  const parts = path.split("/");
  return (
    parts.length === 3 &&
    parts[0] === ATTACHMENTS_DIR &&
    hasAttachmentExtension(parts[2])
  );
}

export function hasAttachmentExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  return (ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension);
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

/** Accents folded to their base letters (NFKD, combining marks dropped). */
function foldAccents(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "");
}

/** One path segment from free text: accents fold, unsafe characters become
 *  `-`, leading dots go, and anything changed gets a short hash of the
 *  original so two different inputs never share a segment. */
function safeSegment(raw: string, fallback: string, max = MAX_MESSAGE_ID) {
  let segment = foldAccents(raw)
    .replace(/[^A-Za-z0-9@._+-]/g, "-")
    .replace(/^\.+/, "");
  const changed = segment !== raw || segment.length > max;
  segment = segment.slice(0, max) || fallback;
  return changed ? `${segment}-${shortHash(raw)}` : segment;
}

export function mailItemPath(messageId: string, answeredAt: string): string {
  const id = messageId
    .trim()
    .replace(/^<(.*)>$/, "$1")
    .toLowerCase();
  return `${folderFor("mail", { answeredAt })}/${safeSegment(id, "message")}.md`;
}

/** Host plus a slug of the URL path and a short hash of the decoded path,
 *  so paths that slug alike (`/a-b`, `/a/b`, `/A/B`) never share an item.
 *  Query and fragment are dropped; the site root is `index.md`. */
export function webItemPath(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error(`"${url}" is not a web address.`);
  const host = parsed.port
    ? `${parsed.hostname}-${parsed.port}`
    : parsed.hostname;
  const path = decodePath(parsed.pathname).replace(/^\/+|\/+$/g, "");
  const slug = path ? `${textSlug(path, "page")}-${shortHash(path)}` : "index";
  return `${folderFor("web", { host })}/${slug}.md`;
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The mirror of a code repository file; non-Markdown files get `.md`.
 *  Each segment goes through safeSegment, so a name with spaces, accents
 *  or a leading dot gets a hashed safe form. */
export function repoItemPath(repoPath: string): string {
  if (!isSafeRelativePath(repoPath))
    throw new Error(`"${repoPath}" is not a repository path.`);
  const parts = repoPath.split("/");
  const name = parts.pop() as string;
  const dirs = parts.map((part) => safeSegment(part, "folder"));
  const md = /\.md$/i.exec(name);
  const file = md
    ? `${safeSegment(name.slice(0, md.index), "file")}${md[0]}`
    : `${safeSegment(name, "file")}.md`;
  return `${ORIGIN_FOLDERS.repo}/${[...dirs, file].join("/")}`;
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

/** A lower-case ASCII slug of free text; `fallback` when nothing Latin is
 *  left (e.g. a title in Japanese). */
function textSlug(text: string, fallback: string): string {
  const folded = foldAccents(text);
  return /[A-Za-z0-9]/.test(folded) ? trimSlug(slugify(folded, 40)) : fallback;
}

/** `<dir>/<slug>.md` for a title, counting up `-2`, `-3` on collision. */
export function freeSlugPath(
  existing: Set<string>,
  dir: string,
  title: string,
): string {
  const slug = textSlug(title, "note");
  const folder = dir.replace(/\/+$/, "");
  let path = `${folder}/${slug}.md`;
  for (let n = 2; existing.has(path); n++) path = `${folder}/${slug}-${n}.md`;
  return path;
}
