/**
 * The repository import: the project's own documentation and releases as
 * trusted knowledge mirrors.
 *
 * mirrorRepoDocs copies `README.md`, `docs/**\/*.md` and everything under
 * `docs/incidents/` from the fetched default branch
 * (`refs/remotes/origin/<default>`) to `sources/repo/<path>`. Runbooks
 * (`docs/incidents/`) are `kind: internal`: they steer Pat and are never
 * quoted. Each mirror records the head it was read at (`validAsOfCommit`,
 * `sources: repo:<path>@<head>`) and depends on its own path, so B2's
 * re-validation refreshes it when the file changes. A file that is gone
 * retires its mirror (text kept). mirrorReleases copies the newest
 * RELEASES_KEPT GitHub releases to `sources/releases/<tag>.md`.
 *
 * Text is copied as written, never redacted: a file that looks like it
 * holds a credential, is binary, empty, a Git LFS pointer or too large is
 * skipped and counted, and a mirror it already has is flipped to
 * needs-check (its old text can't stand as trusted). A mirror whose text
 * and kind are unchanged is left alone, so a re-run at the same head makes
 * no commit. A mirror whose last commit isn't Pat's (a person retired or
 * edited it) is never overwritten: skipped and counted. A run reads at
 * most MAX_FILES files or MAX_TOTAL_BYTES (then `truncated`), stops when
 * cancelled and fails past its deadline (jobs.ts stepper). One commit per
 * mirror run, authored by Pat. A release gone from GitHub retires its
 * mirror.
 *
 * Reuses repo-changes.ts (fetch, head, showAt with its size cap), github.ts
 * listReleases, the job records of jobs.ts and B2's frontMatterOf, PAT
 * author and trailer. Nothing runs at import.
 */
import type { Author } from "../../memory-repo/git-store";
import { git, isolatedGitEnv } from "../../memory-repo/git";
import { MemoryRepoError } from "../../memory-repo/git-store";
import { findSecrets } from "../../memory-repo/secrets";
import {
  type KnowledgeFrontMatter,
  type KnowledgeImportJob,
  type KnowledgeItem,
  type KnowledgeKind,
  LITERAL_PATHSPECS,
  parseDependency,
} from "../../../shared/knowledge";
import { knowledgeRepo } from "../client";
import {
  type GithubReadOptions,
  listReleases,
  type ReleaseInfo,
} from "../freshness/github";
import {
  fetchDefaultBranch,
  latestChange,
  type RepoChangeDeps,
  RepoGitError,
  RepoUnavailableError,
  showAt,
} from "../freshness/repo-changes";
import {
  frontMatterOf,
  PAT_AUTHOR,
  PAT_TRAILER,
} from "../freshness/revalidate";
import { knowledgeRepoName, releaseItemPath, repoItemPath } from "../layout";
import type { KnowledgeChange } from "../service";
import { MAX_ARTICLE_BYTES } from "../validate";
import { JOB_DEADLINE_MS, type Step, startJob, stepper } from "./jobs";
import { lastWrittenByPat, needsCheckChange } from "./mirrors";

export interface RepoDocsDeps {
  /** YYYY-MM-DD, UTC. */
  today(): string;
  repoChanges: Partial<RepoChangeDeps>;
  github: GithubReadOptions;
  /** The project's releases, newest first; null when it has no GitHub
   *  repository. Throws when they can't be read (default listReleases). */
  releases(project: string): Promise<ReleaseInfo[] | null>;
  /** Files read per run at most (MAX_FILES). */
  maxFiles: number;
  /** Bytes of files read per run at most (MAX_TOTAL_BYTES). */
  maxBytes: number;
  /** How long a job may take before it stops (JOB_DEADLINE_MS). */
  deadlineMs: number;
  /** Throws when the run must stop (cancelled, past its deadline); called
   *  per file and release and before each write. The job sets it. */
  step: Step;
}

export interface MirrorResult {
  /** Items written (new or changed). */
  written: number;
  /** Mirrors retired because their file is gone. */
  retired: number;
  /** Files left out: a credential, binary, empty, an LFS pointer, too
   *  large, or a mirror a person edited last. */
  skipped: number;
  /** MAX_FILES or MAX_TOTAL_BYTES left files out. */
  truncated: boolean;
}

/** Files read per run at most. */
export const MAX_FILES = 2000;
/** Bytes of files read per run at most. */
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const LFS_POINTER = "version https://git-lfs";

/** Releases mirrored, newest first. */
export const RELEASES_KEPT = 30;
/** Room left for the front matter under the article cap. */
const BODY_BYTES = MAX_ARTICLE_BYTES - 4096;
const LIST_PAGE = 200;
const WRITE_ATTEMPTS = 3;
const LS_TREE_TIMEOUT_MS = 10_000;
const README = "README.md";
const INCIDENTS = "docs/incidents/";

function bind(over: Partial<RepoDocsDeps>): RepoDocsDeps {
  const github = over.github ?? {};
  return {
    today: over.today ?? (() => new Date().toISOString().slice(0, 10)),
    repoChanges: over.repoChanges ?? {},
    github,
    releases: over.releases ?? ((project) => listReleases(project, github)),
    maxFiles: over.maxFiles ?? MAX_FILES,
    maxBytes: over.maxBytes ?? MAX_TOTAL_BYTES,
    deadlineMs: over.deadlineMs ?? JOB_DEADLINE_MS,
    step: over.step ?? (() => undefined),
  };
}

function checkProject(project: string): void {
  try {
    knowledgeRepoName(project);
  } catch {
    throw new MemoryRepoError(`"${project}" isn't a project name.`);
  }
}

// ── What the repository holds ───────────────────────────────────────────

/** A repository path the mirror copies, and as what kind. */
export function mirroredKind(path: string): KnowledgeKind | null {
  if (path === README) return "answer";
  if (path.startsWith(INCIDENTS)) return "internal";
  if (path.startsWith("docs/") && /\.md$/i.test(path)) return "answer";
  return null;
}

interface TreeFile {
  path: string;
  size: number;
}

async function checkoutOf(
  project: string,
  deps: Partial<RepoChangeDeps>,
): Promise<string> {
  let repo: { dir: string } | null;
  if (deps.repo) repo = deps.repo(project);
  else {
    const { configuredRepos } = await import("../../config");
    const configured = configuredRepos()[project];
    repo = configured?.repo ? { dir: configured.repo } : null;
  }
  if (!repo?.dir) throw new RepoUnavailableError(project, "not configured");
  return repo.dir;
}

/** The regular files under README.md and docs/ at `head`. */
async function listFiles(
  project: string,
  head: string,
  deps: Partial<RepoChangeDeps>,
): Promise<TreeFile[]> {
  const dir = await checkoutOf(project, deps);
  const args = [
    "-c",
    "core.quotePath=false",
    LITERAL_PATHSPECS,
    "ls-tree",
    "-r",
    "-l",
    "-z",
    head,
    "--",
    README,
    "docs/",
  ];
  let out: string;
  if (deps.git) out = await deps.git(dir, args);
  else {
    const result = await git(args, {
      cwd: dir,
      env: isolatedGitEnv(),
      timeoutMs: LS_TREE_TIMEOUT_MS,
      check: false,
    });
    if (result.code !== 0)
      throw new RepoGitError(args, result.code, result.stderr);
    out = result.stdout;
  }
  const files: TreeFile[] = [];
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, , size] = record.slice(0, tab).split(/\s+/);
    // Regular files only: no symlinks, no submodules.
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    files.push({ path: record.slice(tab + 1), size: Number(size) || 0 });
  }
  return files;
}

// ── Knowledge already there ─────────────────────────────────────────────

async function listItems(
  project: string,
  today: string,
): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const page = await knowledgeRepo.call("index.list", project, "all", {
      today,
      limit: LIST_PAGE,
      offset,
    });
    items.push(...page.items);
    if (page.items.length < LIST_PAGE || offset + LIST_PAGE >= page.total)
      return items;
  }
}

/** The repository path a repo mirror stands for. */
function mirroredPath(item: KnowledgeItem): string | null {
  for (const source of item.sources) {
    if (!source.startsWith("repo:")) continue;
    const value = source.slice("repo:".length);
    const at = value.lastIndexOf("@");
    return at > 0 ? value.slice(0, at) : value;
  }
  return null;
}

/** The title: the first `# heading`, else the path. */
function titleOf(text: string, fallback: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim();
  return (heading || fallback).slice(0, 200);
}

/** Why text can't be stored as written; null when it can. */
function unstorable(title: string, text: string): string | null {
  if (!text.trim()) return "The file is now empty";
  if (text.includes("\0") || text.includes("\uFFFD"))
    return "The file is now binary";
  if (text.startsWith(LFS_POINTER)) return "The file is now a Git LFS pointer";
  if (new TextEncoder().encode(text).length > BODY_BYTES)
    return "The file is now too large to mirror";
  if (findSecrets(`${title}\n${text}`).length)
    return "The file now looks like it holds a credential";
  return null;
}

const sameText = (a: string, b: string) => a.trimEnd() === b.trimEnd();

interface Plan {
  changes: KnowledgeChange[];
  expected: Record<string, string | null>;
}

async function commit(
  project: string,
  build: () => Promise<Plan>,
  message: (plan: Plan) => string,
  step: Step,
): Promise<Plan> {
  for (let attempt = 1; ; attempt++) {
    const plan = await build();
    if (!plan.changes.length) return plan;
    step();
    try {
      await knowledgeRepo.call("write", project, plan.changes, {
        message: message(plan),
        author: PAT_AUTHOR,
        trailers: [PAT_TRAILER],
        expected: plan.expected,
      });
      return plan;
    } catch (error) {
      // Someone wrote meanwhile: plan again from what is there now.
      const conflict =
        error instanceof Error && error.name === "KnowledgeConflictError";
      if (!conflict || attempt >= WRITE_ATTEMPTS) throw error;
    }
  }
}

// ── Docs ────────────────────────────────────────────────────────────────

/**
 * Mirror the project's README, docs and runbooks at the default branch's
 * head (fetched first; a failed fetch mirrors the head last fetched).
 * Throws RepoUnavailableError when the project's repository can't be read.
 */
export async function mirrorRepoDocs(
  project: string,
  over: Partial<RepoDocsDeps> = {},
): Promise<MirrorResult> {
  checkProject(project);
  const deps = bind(over);
  const rc = deps.repoChanges;
  const today = deps.today();
  deps.step();
  await fetchDefaultBranch(project, rc);
  const head = await latestChange(project, [], rc);
  if (!head) return { written: 0, retired: 0, skipped: 0, truncated: false };
  const validAsOf = head.at.slice(0, 10);

  // What the head holds, read once (the retry only re-reads knowledge).
  const wanted = new Map<
    string,
    { repoPath: string; kind: KnowledgeKind; title: string; text: string }
  >();
  /** Mirrors whose file is there but can't be copied, and why. */
  const unreadable = new Map<string, string>();
  const present = new Set<string>();
  let skipped = 0;
  let truncated = false;
  let files = 0;
  let bytes = 0;
  for (const file of await listFiles(project, head.sha, rc)) {
    const kind = mirroredKind(file.path);
    if (!kind) continue;
    // Listed files count as present even past the cap: never retired
    // for being left unread.
    present.add(file.path);
    if (truncated) continue;
    if (files + 1 > deps.maxFiles || bytes + file.size > deps.maxBytes) {
      truncated = true;
      continue;
    }
    deps.step();
    let path: string;
    try {
      path = repoItemPath(file.path);
    } catch {
      skipped++;
      continue;
    }
    if (wanted.has(path) || !parseDependency(`repo:${file.path}`)) {
      skipped++;
      continue;
    }
    if (file.size > BODY_BYTES) {
      unreadable.set(path, "The file is now too large to mirror");
      skipped++;
      continue;
    }
    files++;
    bytes += file.size;
    const raw = await showAt(project, head.sha, file.path, rc);
    const title = titleOf(raw ?? "", file.path);
    const why =
      raw === null ? "The file couldn't be read" : unstorable(title, raw);
    if (raw === null || why) {
      unreadable.set(path, why ?? "The file couldn't be read");
      skipped++;
      continue;
    }
    wanted.set(path, { repoPath: file.path, kind, title, text: raw });
  }

  let retired = 0;
  let flipped = 0;
  let personal = 0;
  const plan = await commit(
    project,
    async () => {
      const changes: KnowledgeChange[] = [];
      const expected: Record<string, string | null> = {};
      retired = 0;
      flipped = 0;
      personal = 0;
      for (const [path, doc] of wanted) {
        deps.step();
        const current = await knowledgeRepo.call("read", project, path, today);
        if (
          current &&
          current.item.status !== "retired" &&
          current.item.kind === doc.kind &&
          current.item.title === doc.title &&
          sameText(current.body, doc.text)
        )
          continue;
        if (current && !(await lastWrittenByPat(project, path))) {
          personal++;
          continue;
        }
        const fm: KnowledgeFrontMatter = {
          title: doc.title,
          kind: doc.kind,
          trust: "trusted",
          status: "active",
          origin: "repo",
          topics: [],
          sources: [`repo:${doc.repoPath}@${head.sha}`],
          dependsOn: [`repo:${doc.repoPath}`],
          validAsOf,
          validAsOfCommit: head.sha,
        };
        changes.push({ op: "put", path, fm, body: doc.text });
        expected[path] = current?.item.blob ?? null;
      }
      for (const [path, reason] of unreadable) {
        deps.step();
        const flip = await needsCheckChange(project, path, reason, today);
        if (!flip) continue;
        changes.push(flip.change);
        expected[path] = flip.blob;
        flipped++;
      }
      for (const item of await listItems(project, today)) {
        if (item.origin !== "repo" || item.status === "retired") continue;
        if (expected[item.path] !== undefined || wanted.has(item.path))
          continue;
        const repoPath = mirroredPath(item);
        if (!repoPath || present.has(repoPath)) continue;
        deps.step();
        // Gone from the default branch: retired, text kept.
        const current = await knowledgeRepo.call(
          "read",
          project,
          item.path,
          today,
        );
        if (!current) continue;
        if (!(await lastWrittenByPat(project, item.path))) {
          personal++;
          continue;
        }
        const { check: _check, ...fm } = frontMatterOf(current.item);
        changes.push({
          op: "put",
          path: item.path,
          fm: { ...fm, status: "retired" },
          body: current.body,
        });
        expected[item.path] = current.item.blob;
        retired++;
      }
      return { changes, expected };
    },
    (p) => {
      const files = p.changes.length - retired - flipped;
      const parts = [
        ...(retired ? [`${retired} retired`] : []),
        ...(flipped ? [`${flipped} need a check`] : []),
      ];
      return parts.length
        ? `Import repository docs: ${files} files (${parts.join(", ")})`
        : `Import repository docs: ${files} files`;
    },
    deps.step,
  );
  return {
    written: plan.changes.length - retired - flipped,
    retired,
    skipped: skipped + personal,
    truncated,
  };
}

// ── Releases ────────────────────────────────────────────────────────────

/** The tag a release mirror stands for. */
function mirroredTag(item: KnowledgeItem): string | null {
  const source = item.sources.find((s) => s.startsWith("release:"));
  return source ? source.slice("release:".length) : null;
}

/** Mirror the newest RELEASES_KEPT releases. A project without a GitHub
 *  repository has none; a list that can't be read throws. A mirrored
 *  release GitHub no longer lists is retired, unless it is older than
 *  everything listed (the list may just stop before it). */
export async function mirrorReleases(
  project: string,
  over: Partial<RepoDocsDeps> = {},
): Promise<MirrorResult> {
  checkProject(project);
  const deps = bind(over);
  const today = deps.today();
  deps.step();
  const listed = await deps.releases(project);
  const all = [...(listed ?? [])].filter((r) =>
    Number.isFinite(Date.parse(r.at)),
  );
  const releases = [...all]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RELEASES_KEPT);
  const listedTags = new Set((listed ?? []).map((r) => r.tag));
  const oldestListed = all.length
    ? Math.min(...all.map((r) => Date.parse(r.at)))
    : Number.NEGATIVE_INFINITY;
  let skipped = 0;
  const wanted: Array<{ path: string; release: ReleaseInfo; text: string }> =
    [];
  const seen = new Set<string>();
  for (const release of releases) {
    let path: string;
    try {
      path = releaseItemPath(release.tag);
    } catch {
      skipped++;
      continue;
    }
    const title = (release.name || release.tag).slice(0, 200);
    const body = release.body.trim() || "No release notes were published.";
    const why = unstorable(title, body);
    if (seen.has(path) || !parseDependency(`release:${release.tag}`) || why) {
      skipped++;
      continue;
    }
    seen.add(path);
    wanted.push({ path, release, text: body });
  }

  let retired = 0;
  let personal = 0;
  const plan = await commit(
    project,
    async () => {
      const changes: KnowledgeChange[] = [];
      const expected: Record<string, string | null> = {};
      retired = 0;
      personal = 0;
      for (const { path, release, text } of wanted) {
        deps.step();
        const title = (release.name || release.tag).slice(0, 200);
        const current = await knowledgeRepo.call("read", project, path, today);
        if (
          current &&
          current.item.status !== "retired" &&
          current.item.title === title &&
          sameText(current.body, text)
        )
          continue;
        if (current && !(await lastWrittenByPat(project, path))) {
          personal++;
          continue;
        }
        changes.push({
          op: "put",
          path,
          fm: {
            title,
            kind: "answer",
            trust: "trusted",
            status: "active",
            origin: "release",
            topics: [],
            sources: [`release:${release.tag}`],
            dependsOn: [],
            validAsOf: new Date(release.at).toISOString().slice(0, 10),
          },
          body: text,
        });
        expected[path] = current?.item.blob ?? null;
      }
      // Gone from GitHub (a readable list without it): retired, text kept.
      if (listed)
        for (const item of await listItems(project, today)) {
          if (item.origin !== "release" || item.status === "retired") continue;
          if (expected[item.path] !== undefined || seen.has(item.path))
            continue;
          const tag = mirroredTag(item);
          if (!tag || listedTags.has(tag)) continue;
          if (Date.parse(`${item.validAsOf}T23:59:59Z`) < oldestListed)
            continue;
          deps.step();
          const current = await knowledgeRepo.call(
            "read",
            project,
            item.path,
            today,
          );
          if (!current) continue;
          if (!(await lastWrittenByPat(project, item.path))) {
            personal++;
            continue;
          }
          const { check: _check, ...fm } = frontMatterOf(current.item);
          changes.push({
            op: "put",
            path: item.path,
            fm: { ...fm, status: "retired" },
            body: current.body,
          });
          expected[item.path] = current.item.blob;
          retired++;
        }
      return { changes, expected };
    },
    (p) =>
      retired
        ? `Import releases: ${p.changes.length - retired} (${retired} retired)`
        : `Import releases: ${p.changes.length}`,
    deps.step,
  );
  return {
    written: plan.changes.length - retired,
    retired,
    skipped: skipped + personal,
    truncated: false,
  };
}

// ── The job ─────────────────────────────────────────────────────────────

/**
 * Start the repository import (docs, then releases) for `project`;
 * resolves with the job (it runs in the background). A second repository
 * import while one runs is refused (409). The job stops when cancelled
 * and fails past its deadline.
 */
export async function startRepoImport(
  input: { project: string; by: Author },
  over: Partial<RepoDocsDeps> = {},
): Promise<KnowledgeImportJob> {
  const { project } = input;
  checkProject(project);
  return startJob(project, "repo", { by: input.by.name }, async (job) => {
    const run = {
      ...over,
      step: stepper(job.signal, over.deadlineMs ?? JOB_DEADLINE_MS),
    };
    await knowledgeRepo.call("ensureRepo", project);
    const docs = await mirrorRepoDocs(project, run);
    await job.progress({
      trusted: docs.written,
      skipped: docs.skipped,
      done: docs.written + docs.retired + docs.skipped,
    });
    if (docs.truncated) await job.markTruncated();
    const releases = await mirrorReleases(project, run);
    await job.progress({
      trusted: releases.written,
      skipped: releases.skipped,
      done: releases.written + releases.retired + releases.skipped,
    });
  });
}
