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
 * "Couldn't check" never reads as "unchanged": a project that can't be
 * resolved (not configured any more, no local checkout, a default branch
 * git refuses) makes commitsSince, latestChange, commitAt, showAt and
 * patchFor throw RepoUnavailableError, and a git failure throws
 * RepoGitError, so callers that decide freshness fail closed. `null` and
 * `[]` only ever mean "none found". fetchDefaultBranch answers false and
 * defaultHead null for an unresolvable project (neither reads as
 * "unchanged"). Nothing runs at import.
 */

import { stat } from "node:fs/promises";
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
const FIELD = "\x1f";

/** The project's repository can't be read at all: it isn't configured (any
 *  more), has no local checkout, or its default branch is not a name git
 *  accepts. Distinct from "nothing changed"; callers fail closed. */
export class RepoUnavailableError extends Error {
  constructor(
    readonly project: string,
    readonly reason: string,
  ) {
    super(`${project}'s repository can't be read: ${reason}`);
    this.name = "RepoUnavailableError";
  }
}

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

/** Branch names `git check-ref-format --branch` accepted (it only
 *  depends on the name, so it is asked once per name). */
const validBranches = new Set<string>();

async function validBranch(name: string): Promise<boolean> {
  if (!name || name.startsWith("-") || name.includes("@{")) return false;
  if (validBranches.has(name)) return true;
  const proc = Bun.spawn(["git", "check-ref-format", "--branch", name], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0 || out.trim() !== name) return false;
  } finally {
    clearTimeout(timer);
  }
  if (validBranches.size >= 256) validBranches.clear();
  validBranches.add(name);
  return true;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

interface Resolved {
  git(args: string[]): Promise<string>;
  branch: string;
  /** `refs/remotes/origin/<branch>`. */
  ref: string;
  serialize<T>(fn: () => Promise<T>): Promise<T>;
}

/** The project's checkout and default branch; throws RepoUnavailableError
 *  when there is none to read. */
async function resolve(
  project: string,
  deps: Partial<RepoChangeDeps> = {},
): Promise<Resolved> {
  const repo = deps.repo ? deps.repo(project) : await configuredRepo(project);
  if (!repo) throw new RepoUnavailableError(project, "not configured");
  if (!repo.dir) throw new RepoUnavailableError(project, "no local checkout");
  // An injected git may not touch the disk at all; the real one needs the
  // checkout to exist.
  if (!deps.git && !(await isDirectory(repo.dir)))
    throw new RepoUnavailableError(project, "the checkout is missing");
  if (!(await validBranch(repo.defaultBranch)))
    throw new RepoUnavailableError(
      project,
      `not a branch name: ${repo.defaultBranch.slice(0, 80)}`,
    );
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
  try {
    const r = await resolve(project, deps);
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
  try {
    const r = await resolve(project, deps);
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

/** A file's text at a commit; null when it isn't a file there. Throws
 *  when the commit itself is unknown. */
export async function showAt(
  project: string,
  sha: string,
  path: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<string | null> {
  const r = await resolve(project, deps);
  const commit = checkSha(sha);
  const object = `${commit}:${checkPath(path)}`;
  await r.git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  let type: string;
  try {
    type = (await r.git(["cat-file", "-t", object])).trim();
  } catch (error) {
    // The commit exists, so a refused lookup means no such path; a
    // timeout is still "couldn't check".
    if (error instanceof RepoGitError && error.code === null) throw error;
    return null;
  }
  if (type !== "blob") return null;
  return r.git(["cat-file", "blob", object]);
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
