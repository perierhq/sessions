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
 * holds a credential, is binary, empty or too large is skipped and
 * counted. A mirror whose text and kind are unchanged is left alone, so a
 * re-run at the same head makes no commit. One commit per mirror run,
 * authored by Pat.
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
import { startJob } from "./jobs";

export interface RepoDocsDeps {
  /** YYYY-MM-DD, UTC. */
  today(): string;
  repoChanges: Partial<RepoChangeDeps>;
  github: GithubReadOptions;
  /** The project's releases, newest first; null when it has no GitHub
   *  repository. Throws when they can't be read (default listReleases). */
  releases(project: string): Promise<ReleaseInfo[] | null>;
}

export interface MirrorResult {
  /** Items written (new or changed). */
  written: number;
  /** Mirrors retired because their file is gone. */
  retired: number;
  /** Files left out: a credential, binary, empty or too large. */
  skipped: number;
}

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

/** Text that can be stored as written; null when it must be skipped. */
function storable(title: string, text: string): string | null {
  if (!text.trim() || text.includes("\0") || text.includes("\uFFFD"))
    return null;
  if (new TextEncoder().encode(text).length > BODY_BYTES) return null;
  if (findSecrets(`${title}\n${text}`).length) return null;
  return text;
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
): Promise<Plan> {
  for (let attempt = 1; ; attempt++) {
    const plan = await build();
    if (!plan.changes.length) return plan;
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
  await fetchDefaultBranch(project, rc);
  const head = await latestChange(project, [], rc);
  if (!head) return { written: 0, retired: 0, skipped: 0 };
  const validAsOf = head.at.slice(0, 10);

  // What the head holds, read once (the retry only re-reads knowledge).
  const wanted = new Map<
    string,
    { repoPath: string; kind: KnowledgeKind; title: string; text: string }
  >();
  const present = new Set<string>();
  let skipped = 0;
  for (const file of await listFiles(project, head.sha, rc)) {
    const kind = mirroredKind(file.path);
    if (!kind) continue;
    present.add(file.path);
    let path: string;
    try {
      path = repoItemPath(file.path);
    } catch {
      skipped++;
      continue;
    }
    if (
      wanted.has(path) ||
      !parseDependency(`repo:${file.path}`) ||
      file.size > BODY_BYTES
    ) {
      skipped++;
      continue;
    }
    const raw = await showAt(project, head.sha, file.path, rc);
    const title = titleOf(raw ?? "", file.path);
    const text = raw === null ? null : storable(title, raw);
    if (text === null) {
      skipped++;
      continue;
    }
    wanted.set(path, { repoPath: file.path, kind, title, text });
  }

  let retired = 0;
  const plan = await commit(
    project,
    async () => {
      const changes: KnowledgeChange[] = [];
      const expected: Record<string, string | null> = {};
      retired = 0;
      for (const [path, doc] of wanted) {
        const current = await knowledgeRepo.call("read", project, path, today);
        if (
          current &&
          current.item.status !== "retired" &&
          current.item.kind === doc.kind &&
          current.item.title === doc.title &&
          sameText(current.body, doc.text)
        )
          continue;
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
      for (const item of await listItems(project, today)) {
        if (item.origin !== "repo" || item.status === "retired") continue;
        if (expected[item.path] !== undefined || wanted.has(item.path))
          continue;
        const repoPath = mirroredPath(item);
        if (!repoPath || present.has(repoPath)) continue;
        // Gone from the default branch: retired, text kept.
        const current = await knowledgeRepo.call(
          "read",
          project,
          item.path,
          today,
        );
        if (!current) continue;
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
      const files = p.changes.length - retired;
      return retired
        ? `Import repository docs: ${files} files (${retired} retired)`
        : `Import repository docs: ${files} files`;
    },
  );
  return { written: plan.changes.length - retired, retired, skipped };
}

// ── Releases ────────────────────────────────────────────────────────────

/** Mirror the newest RELEASES_KEPT releases. A project without a GitHub
 *  repository has none; a list that can't be read throws. */
export async function mirrorReleases(
  project: string,
  over: Partial<RepoDocsDeps> = {},
): Promise<MirrorResult> {
  checkProject(project);
  const deps = bind(over);
  const today = deps.today();
  const releases = [...((await deps.releases(project)) ?? [])]
    .filter((r) => Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RELEASES_KEPT);
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
    const text = storable(
      title,
      release.body.trim() || "No release notes were published.",
    );
    if (seen.has(path) || !parseDependency(`release:${release.tag}`) || !text) {
      skipped++;
      continue;
    }
    seen.add(path);
    wanted.push({ path, release, text });
  }

  const plan = await commit(
    project,
    async () => {
      const changes: KnowledgeChange[] = [];
      const expected: Record<string, string | null> = {};
      for (const { path, release, text } of wanted) {
        const title = (release.name || release.tag).slice(0, 200);
        const current = await knowledgeRepo.call("read", project, path, today);
        if (
          current &&
          current.item.status !== "retired" &&
          current.item.title === title &&
          sameText(current.body, text)
        )
          continue;
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
      return { changes, expected };
    },
    (p) => `Import releases: ${p.changes.length}`,
  );
  return { written: plan.changes.length, retired: 0, skipped };
}

// ── The job ─────────────────────────────────────────────────────────────

/**
 * Start the repository import (docs, then releases) for `project`;
 * resolves with the job (it runs in the background). A second repository
 * import while one runs is refused (409).
 */
export async function startRepoImport(
  input: { project: string; by: Author },
  over: Partial<RepoDocsDeps> = {},
): Promise<KnowledgeImportJob> {
  const { project } = input;
  checkProject(project);
  return startJob(project, "repo", { by: input.by.name }, async (job) => {
    await knowledgeRepo.call("ensureRepo", project);
    const docs = await mirrorRepoDocs(project, over);
    await job.progress({
      trusted: docs.written,
      skipped: docs.skipped,
      done: docs.written + docs.retired + docs.skipped,
    });
    const releases = await mirrorReleases(project, over);
    await job.progress({
      trusted: releases.written,
      skipped: releases.skipped,
      done: releases.written + releases.skipped,
    });
  });
}
