/**
 * What changed on a project's default branch: the repository signal of
 * knowledge freshness. An article that depends on `repo:docs/export.md`
 * and was valid as of commit X goes stale when a default-branch commit
 * after X touches that path.
 *
 * Read-only git subprocesses on the project's own checkout (`Repo.repo`).
 * Only `refs/remotes/origin/<default branch>` is read or fetched (the same
 * refspec worktree.ts uses for the Ask checkout); the work tree, index and
 * HEAD are never touched. Every path goes through `--literal-pathspecs`, so
 * `docs/*` or `:/` mean those characters, not pathspec magic. A path that
 * ends in `/` is a folder and matches everything under it.
 *
 * An unknown project reads as nothing (`[]`, `null`, `false`). A git
 * failure on a known project throws, so callers that decide freshness fail
 * closed instead of reading "no change". Nothing runs at import.
 */

import { LITERAL_PATHSPECS } from "../../memory-repo/git-store";
import { workloadArgv } from "../../workload-scope";

export interface RepoCommit {
  sha: string;
  /** Committer date, ISO 8601. */
  at: string;
  /** The asked-for paths this commit touched (all its paths when none
   *  were asked for). */
  paths: string[];
}

export interface RepoChangeDeps {
  /** Run git in `dir`; resolves stdout, rejects on a non-zero exit. */
  git(dir: string, args: string[]): Promise<string>;
  repo(project: string): { dir: string; defaultBranch: string } | null;
  /** Serialises the fetch with the server's other git work on the same
   *  checkout (worktree.ts withGitLock). Tests run it directly. */
  serialize?<T>(fn: () => Promise<T>): Promise<T>;
}

const GIT_TIMEOUT_MS = 10_000;
/** A fetch talks to the remote; give it longer than a local read. */
const FETCH_TIMEOUT_MS = 60_000;
const SHA = /^[0-9a-f]{7,64}$/i;
/** Branch names git accepts and that can't be read as an option. */
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const FIELD = "\x1f";

export class RepoGitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${args.filter((a) => a !== LITERAL_PATHSPECS)[0] ?? ""} failed${code === null ? " (timed out)" : ` (${code})`}: ${stderr.trim().slice(0, 300)}`,
    );
    this.name = "RepoGitError";
  }
}

async function runGit(dir: string, args: string[]): Promise<string> {
  const fetching = args[0] === "fetch";
  const proc = Bun.spawn(workloadArgv(["git", "-C", dir, ...args], "git"), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      proc.kill("SIGKILL");
    },
    fetching ? FETCH_TIMEOUT_MS : GIT_TIMEOUT_MS,
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut || code !== 0)
      throw new RepoGitError(args, timedOut ? null : code, stderr);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function configuredRepo(
  project: string,
): Promise<{ dir: string; defaultBranch: string } | null> {
  const { configuredRepos } = await import("../../config");
  const repo = configuredRepos()[project];
  return repo?.repo
    ? { dir: repo.repo, defaultBranch: repo.defaultBranch }
    : null;
}

async function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const { withGitLock: lock } = await import("../../worktree");
  return lock(fn);
}

interface Resolved {
  git(args: string[]): Promise<string>;
  branch: string;
  /** `refs/remotes/origin/<branch>`. */
  ref: string;
  serialize<T>(fn: () => Promise<T>): Promise<T>;
}

async function resolve(
  project: string,
  deps: Partial<RepoChangeDeps> = {},
): Promise<Resolved | null> {
  const repo = deps.repo ? deps.repo(project) : await configuredRepo(project);
  if (!repo || !repo.dir || !BRANCH.test(repo.defaultBranch)) return null;
  if (repo.defaultBranch.startsWith("-")) return null;
  const git = deps.git ?? runGit;
  return {
    git: (args) => git(repo.dir, args),
    branch: repo.defaultBranch,
    ref: `refs/remotes/origin/${repo.defaultBranch}`,
    serialize:
      deps.serialize ?? (deps.git || deps.repo ? (fn) => fn() : withGitLock),
  };
}

function checkSha(sha: string): string {
  if (!SHA.test(sha)) throw new Error(`Not a commit: ${sha.slice(0, 80)}`);
  return sha.toLowerCase();
}

function checkPath(path: string): string {
  if (!path || path.startsWith("/") || path.split("/").includes(".."))
    throw new Error(`Not a repository path: ${path.slice(0, 200)}`);
  return path;
}

/** A path matches an asked-for path exactly, or lies under a folder. */
function matches(path: string, asked: readonly string[]): boolean {
  return asked.some((a) => (a.endsWith("/") ? path.startsWith(a) : path === a));
}

/** `git log --name-only` output with `%H<US>%cI` headers → commits. */
function parseLog(out: string, asked: readonly string[]): RepoCommit[] {
  const commits: RepoCommit[] = [];
  let current: RepoCommit | null = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const header = line.split(FIELD);
    if (header.length === 2 && SHA.test(header[0]!)) {
      current = { sha: header[0]!, at: header[1]!, paths: [] };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    if (asked.length === 0 || matches(line, asked)) current.paths.push(line);
  }
  return commits;
}

async function log(
  r: Resolved,
  range: string[],
  paths: readonly string[],
): Promise<RepoCommit[]> {
  const asked = paths.map(checkPath);
  const out = await r.git([
    LITERAL_PATHSPECS,
    "log",
    `--format=%H${FIELD}%cI`,
    "--name-only",
    "--no-renames",
    ...range,
    "--",
    ...asked,
  ]);
  return parseLog(out, asked);
}

/** Fetch the default branch from origin into its remote-tracking ref.
 *  False for an unknown project or a failed fetch. */
export async function fetchDefaultBranch(
  project: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<boolean> {
  const r = await resolve(project, deps);
  if (!r) return false;
  try {
    await r.serialize(() =>
      r.git(["fetch", "origin", `+refs/heads/${r.branch}:${r.ref}`, "--quiet"]),
    );
    return true;
  } catch (error) {
    console.warn(
      `[knowledge] Could not fetch ${project}'s default branch: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}

/** The fetched default-branch head; null when unknown or not fetched. */
export async function defaultHead(
  project: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<string | null> {
  const r = await resolve(project, deps);
  if (!r) return null;
  try {
    const out = (
      await r.git(["rev-parse", "--verify", "--quiet", `${r.ref}^{commit}`])
    ).trim();
    return SHA.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Default-branch commits after `since` that touch `paths`, newest first.
 *  No paths: every commit. Throws when `since` is not a known commit. */
export async function commitsSince(
  project: string,
  since: string,
  paths: string[],
  deps?: Partial<RepoChangeDeps>,
): Promise<RepoCommit[]> {
  const r = await resolve(project, deps);
  if (!r) return [];
  const from = checkSha(since);
  return log(r, [`${from}..${r.ref}`], paths);
}

/** The newest default-branch commit touching any of `paths` (any commit
 *  when none are given); null when there is none. */
export async function latestChange(
  project: string,
  paths: string[],
  deps?: Partial<RepoChangeDeps>,
): Promise<RepoCommit | null> {
  const r = await resolve(project, deps);
  if (!r) return null;
  const commits = await log(r, ["-1", r.ref], paths);
  return commits[0] ?? null;
}

/** The default-branch commit current at `at` (the newest committed at or
 *  before it); null when none. */
export async function commitAt(
  project: string,
  at: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<string | null> {
  const r = await resolve(project, deps);
  if (!r) return null;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) throw new Error(`Not a date: ${at.slice(0, 80)}`);
  const out = (
    await r.git([
      "rev-list",
      "-1",
      `--before=${new Date(time).toISOString()}`,
      r.ref,
    ])
  ).trim();
  return SHA.test(out) ? out : null;
}

/** A file's text at a commit; null when it isn't a file there. */
export async function showAt(
  project: string,
  sha: string,
  path: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<string | null> {
  const r = await resolve(project, deps);
  if (!r) return null;
  const object = `${checkSha(sha)}:${checkPath(path)}`;
  try {
    const type = (await r.git(["cat-file", "-t", object])).trim();
    if (type !== "blob") return null;
    return await r.git(["cat-file", "blob", object]);
  } catch {
    return null;
  }
}

/** What commit `sha` changed in `path` (a unified diff; empty when it
 *  didn't touch it), for the needs-check side-by-side. */
export async function patchFor(
  project: string,
  sha: string,
  path: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<string> {
  const r = await resolve(project, deps);
  if (!r) return "";
  return r.git([
    LITERAL_PATHSPECS,
    "show",
    "--format=",
    "--patch",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    checkSha(sha),
    "--",
    checkPath(path),
  ]);
}
