/**
 * What changed on a project's default branch: the repository signal of
 * knowledge freshness. An article that depends on `repo:docs/export.md`
 * and was valid as of commit X goes stale when a default-branch commit
 * after X touches that path.
 *
 * Read-only git subprocesses on the project's own checkout (`Repo.repo`).
 * Only `refs/remotes/origin/<default branch>` is read or fetched (the same
 * refspec worktree.ts uses for the Ask checkout), authenticated the way
 * worktree.ts's own GitHub fetches are (githubServiceGitEnv); the work tree,
 * index and HEAD are never touched. Every path goes through `--literal-pathspecs`, so
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

/** commitsSince's answer: newest first, at most `limits.commits` entries.
 *  `truncated` is true when there were more (the oldest were dropped). */
export type RepoCommits = RepoCommit[] & { truncated: boolean };

export interface RepoChangeLimits {
  /** Most commits commitsSince returns (default 500). */
  commits: number;
  /** Most bytes of git output read before git is killed (default 8 MiB;
   *  patchFor reads at most 2 MiB). */
  outputBytes: number;
  /** Largest file showAt reads (default 1 MiB). */
  showBytes: number;
}

export interface RepoChangeDeps {
  /** Run git in `dir`; resolves stdout, rejects on a non-zero exit. The
   *  output cap is advisory for an injected git (its answer is checked
   *  against it afterwards). `env` is the whole environment, given for the
   *  fetch only (worktree.ts githubServiceGitEnv). */
  git(
    dir: string,
    args: string[],
    opts?: { maxBytes: number; env?: Record<string, string | undefined> },
  ): Promise<string>;
  repo(
    project: string,
  ): { dir: string; defaultBranch: string; ghRepo?: string } | null;
  /** Serialises the fetch with the server's other git work on the same
   *  checkout. Defaults to worktree.ts withGitLock, unless `git` is
   *  injected (then the fetch runs directly). */
  serialize?<T>(fn: () => Promise<T>): Promise<T>;
  limits?: Partial<RepoChangeLimits>;
}

const GIT_TIMEOUT_MS = 10_000;
/** A fetch talks to the remote; give it longer than a local read. */
const FETCH_TIMEOUT_MS = 25_000;
/** SIGTERM first, SIGKILL when git hasn't gone this long after. */
const KILL_GRACE_MS = 2_000;
const MIB = 1024 * 1024;
const LIMITS: RepoChangeLimits = {
  commits: 500,
  outputBytes: 8 * MIB,
  showBytes: MIB,
};
const PATCH_BYTES = 2 * MIB;
const STDERR_BYTES = 64 * 1024;
/** Paths as written (UTF-8, not octal-quoted). */
const GLOBAL = ["-c", "core.quotePath=false"];
const HEADER = /^([0-9a-f]{40,64})\x1f(\d{4}-\d\d-\d\dT[^\x1f\0]*)$/;
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

/** The git subcommand in `args` (global options and `-c` values skipped). */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else if (!args[i]!.startsWith("-")) return args[i]!;
  }
  return "";
}

export class RepoGitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${subcommand(args)} failed${code === null ? " (timed out)" : ` (${code})`}: ${stderr.trim().slice(0, 300)}`,
    );
    this.name = "RepoGitError";
  }
}

/** Git answered more than the cap allows (git was killed). */
export class RepoTooLargeError extends Error {
  constructor(
    readonly what: string,
    readonly limit: number,
  ) {
    super(`${what} is larger than ${limit} bytes`);
    this.name = "RepoTooLargeError";
  }
}

/** Read a stream up to `max` bytes. Past it: `onOver` (then stop reading)
 *  or, without one, keep draining and drop the rest. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  max: number,
  onOver?: () => void,
): Promise<{ data: Buffer; over: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (over) continue;
    if (size + value.byteLength > max) {
      over = true;
      if (onOver) {
        onOver();
        await reader.cancel().catch(() => {});
        break;
      }
      continue;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { data: Buffer.concat(chunks), over };
}

async function runGit(
  dir: string,
  args: string[],
  opts: { maxBytes: number; env?: Record<string, string | undefined> } = {
    maxBytes: LIMITS.outputBytes,
  },
): Promise<string> {
  const fetching = subcommand(args) === "fetch";
  const proc = Bun.spawn(workloadArgv(["git", "-C", dir, ...args], "git"), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(opts.env ?? process.env),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    proc.kill("SIGTERM");
    killer ??= setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  };
  const timer = setTimeout(
    () => {
      timedOut = true;
      stop();
    },
    fetching ? FETCH_TIMEOUT_MS : GIT_TIMEOUT_MS,
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      drain(proc.stdout, opts.maxBytes, stop),
      drain(proc.stderr, STDERR_BYTES),
      proc.exited,
    ]);
    if (stdout.over)
      throw new RepoTooLargeError(`git ${subcommand(args)}`, opts.maxBytes);
    if (timedOut || code !== 0)
      throw new RepoGitError(
        args,
        timedOut ? null : code,
        stderr.data.toString("utf8"),
      );
    return stdout.data.toString("utf8");
  } finally {
    clearTimeout(timer);
    clearTimeout(killer);
  }
}

async function configuredRepo(
  project: string,
): Promise<{ dir: string; defaultBranch: string; ghRepo?: string } | null> {
  const { configuredRepos } = await import("../../config");
  const repo = configuredRepos()[project];
  return repo?.repo
    ? { dir: repo.repo, defaultBranch: repo.defaultBranch, ghRepo: repo.ghRepo }
    : null;
}

async function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const { withGitLock: lock } = await import("../../worktree");
  return lock(fn);
}

/** The environment worktree.ts fetches from GitHub with: the service token
 *  and a helper list that replaces whatever the checkout's .git/config
 *  names (an earlier install's helper may not be there or readable). */
async function fetchEnv(
  ghRepo: string | undefined,
): Promise<Record<string, string | undefined>> {
  const { githubServiceGitEnv } = await import("../../worktree");
  return githubServiceGitEnv(ghRepo);
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
  /** git with `-c core.quotePath=false`; output capped at `maxBytes`
   *  (default limits.outputBytes). */
  git(
    args: string[],
    maxBytes?: number,
    env?: Record<string, string | undefined>,
  ): Promise<string>;
  limits: RepoChangeLimits;
  branch: string;
  /** `owner/name` on GitHub, when configured. */
  ghRepo: string | undefined;
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
  const limits = { ...LIMITS, ...deps.limits };
  return {
    git: async (args, maxBytes = limits.outputBytes, env) => {
      const full = [...GLOBAL, ...args];
      const out = await git(
        repo.dir,
        full,
        env ? { maxBytes, env } : { maxBytes },
      );
      if (Buffer.byteLength(out) > maxBytes)
        throw new RepoTooLargeError(`git ${subcommand(full)}`, maxBytes);
      return out;
    },
    limits,
    branch: repo.defaultBranch,
    ghRepo: repo.ghRepo,
    ref: `refs/remotes/origin/${repo.defaultBranch}`,
    // Only a fake git may skip the lock: a real fetch on the project's
    // checkout always queues behind the server's other git work.
    serialize: deps.serialize ?? (deps.git ? (fn) => fn() : withGitLock),
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

/** `git log -z --name-only` output with `%H<US>%cI` headers → commits.
 *  With -z every header and path ends in NUL, and the first path after a
 *  header starts with a newline. */
function parseLog(out: string, asked: readonly string[]): RepoCommit[] {
  const commits: RepoCommit[] = [];
  let current: RepoCommit | null = null;
  let afterHeader = false;
  for (let token of out.split("\0")) {
    if (token.startsWith("\n") && (afterHeader || HEADER.test(token.slice(1))))
      token = token.slice(1);
    afterHeader = false;
    if (!token) continue;
    const header = HEADER.exec(token);
    if (header) {
      current = { sha: header[1]!, at: header[2]!, paths: [] };
      commits.push(current);
      afterHeader = true;
      continue;
    }
    if (!current) continue;
    if (asked.length === 0 || matches(token, asked)) current.paths.push(token);
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
    "-z",
    `--format=%H${FIELD}%cI`,
    "--name-only",
    "--no-renames",
    ...range,
    "--",
    ...asked,
  ]);
  return parseLog(out, asked);
}

/** Fetch the default branch from origin into its remote-tracking ref,
 *  with worktree.ts's GitHub credentials. False for an unknown project or a
 *  failed fetch. */
export async function fetchDefaultBranch(
  project: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<boolean> {
  try {
    const r = await resolve(project, deps);
    const env = await fetchEnv(r.ghRepo);
    await r.serialize(() =>
      r.git(
        [
          "fetch",
          "--quiet",
          "--no-auto-gc",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "origin",
          `+refs/heads/${r.branch}:${r.ref}`,
        ],
        undefined,
        env,
      ),
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

/** Default-branch commits after `since` that touch `paths`, newest first,
 *  over the full topology (commits merged in from branches included, at
 *  their own dates). No paths: every commit. At most `limits.commits`
 *  (500) entries; `truncated` says more were left out. Throws when `since`
 *  is not a known commit. */
export async function commitsSince(
  project: string,
  since: string,
  paths: string[],
  deps?: Partial<RepoChangeDeps>,
): Promise<RepoCommits> {
  const r = await resolve(project, deps);
  const from = checkSha(since);
  const cap = r.limits.commits;
  const commits = await log(
    r,
    [`--max-count=${cap + 1}`, `${from}..${r.ref}`],
    paths,
  );
  return Object.assign(commits.slice(0, cap), {
    truncated: commits.length > cap,
  });
}

/** The newest default-branch commit touching any of `paths` (any commit
 *  when none are given); null when there is none. Walks first parents
 *  only, so a change merged in from a branch is reported as the merge
 *  commit, at the date it landed. */
export async function latestChange(
  project: string,
  paths: string[],
  deps?: Partial<RepoChangeDeps>,
): Promise<RepoCommit | null> {
  const r = await resolve(project, deps);
  const commits = await log(
    r,
    ["-1", "--first-parent", "--diff-merges=first-parent", r.ref],
    paths,
  );
  return commits[0] ?? null;
}

/** The default-branch commit current at `at` (the newest first-parent
 *  commit at or before it, so a branch commit's own older date doesn't
 *  count); null when none. */
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
      "--first-parent",
      `--before=${new Date(time).toISOString()}`,
      r.ref,
    ])
  ).trim();
  return SHA.test(out) ? out : null;
}

/** A file's text at a commit; null when it isn't a file there. Throws
 *  when the commit itself is unknown, and RepoTooLargeError for a file over
 *  `limits.showBytes` (1 MiB). */
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
  const size = Number((await r.git(["cat-file", "-s", object])).trim());
  if (!Number.isSafeInteger(size) || size > r.limits.showBytes)
    throw new RepoTooLargeError(path, r.limits.showBytes);
  return r.git(["cat-file", "blob", object], r.limits.showBytes);
}

/** What commit `sha` changed in `path` (a unified diff; empty when it
 *  didn't touch it), for the needs-check side-by-side. RepoTooLargeError
 *  past 2 MiB (or `limits.outputBytes` when smaller). */
export async function patchFor(
  project: string,
  sha: string,
  path: string,
  deps?: Partial<RepoChangeDeps>,
): Promise<string> {
  const r = await resolve(project, deps);
  return r.git(
    [
      LITERAL_PATHSPECS,
      "show",
      "--format=",
      "--patch",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      checkSha(sha),
      "--",
      checkPath(path),
    ],
    Math.min(PATCH_BYTES, r.limits.outputBytes),
  );
}
