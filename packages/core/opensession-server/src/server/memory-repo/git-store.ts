/**
 * The git half of a server-owned repository store: canonical bare
 * repositories, a locked service checkout for writes, history, diff and
 * revert. Memory (memory-repo/service.ts) and knowledge both build on it;
 * each supplies its own name rule, file validator and post-push refresh.
 *
 * Layout under `base`:
 *
 *   repos/<name>.git     canonical bare repository
 *   repo-work/<name>     the service's own checkout for writes
 *   repo-locks/<name>    cross-process write lock for that checkout
 *
 * Construction has no side effects. Git work is async subprocesses.
 */

import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitBytes, isolatedGitEnv, listTree, SERVICE_AUTHOR } from "./git";
import { formatProblems, type FileProblem } from "./validate";

export const PUSH_LOG = "opensession-pushes.jsonl";

export interface Author {
  name: string;
  email?: string;
}

export interface WorkContext {
  dir: string;
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(): Promise<string[]>;
  git(args: string[]): Promise<string>;
}

export interface HistoryCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ status: string; path: string }>;
  sessionId?: string;
  pushedBy?: string;
}

export interface WithWorkOptions {
  message: string;
  author?: Author;
  trailers?: string[];
  /** Session the change is made for; recorded by the push log. */
  session?: string;
}

export interface GitRepoStoreOptions {
  /** repos/, repo-work/ and repo-locks/ live here. */
  base: string;
  isValidName(name: string): boolean;
  /** Run on every touched file before a commit. */
  validate(path: string, bytes: Uint8Array): FileProblem[];
  /** After a successful push from the service checkout. */
  onPushed?(name: string): Promise<void>;
  /** Command prefix that runs the receive hook (memory only). */
  hookCommand?: string[];
  /** "Memory" | "Knowledge", for error copy. */
  label: string;
}

export class MemoryRepoError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "MemoryRepoError";
  }
}

const LOCK_STALE_MS = 120_000;
const COMMIT = /^[0-9a-f]{7,64}$/;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function authorEnv(author?: Author): Record<string, string> {
  const name = author?.name?.trim() || SERVICE_AUTHOR.name;
  const email =
    author?.email?.trim() ||
    (author?.name
      ? `${author.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")}@users.opensession.local`
      : SERVICE_AUTHOR.email);
  return isolatedGitEnv({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email });
}

/** Repository-relative path without traversal. */
function safePath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !clean ||
    clean
      .split("/")
      .some((part) => part === ".." || part === ".git" || part === "")
  )
    throw new MemoryRepoError(`Invalid path "${path}".`);
  return clean;
}

/** A revision a caller may name: a branch, tag or commit, never an option. */
function safeRev(rev: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(rev) || rev.includes(".."))
    throw new MemoryRepoError(`Invalid revision "${rev}".`);
  return rev;
}

export function cleanHookOutput(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/^remote:\s?/, "").trimEnd())
    .filter(
      (line) => line.trim() && !/^To |^error: failed to push|^hint:/.test(line),
    );
  return lines.join("\n").slice(0, 4000) || "The push was rejected.";
}

function sessionIdFromLink(link?: string): string | undefined {
  if (!link) return undefined;
  return /\/session\/([A-Za-z0-9._-]+)/.exec(link)?.[1] ?? link;
}

export class GitRepoStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly hooked = new Set<string>();

  constructor(readonly opts: GitRepoStoreOptions) {}

  bareDir(name: string): string {
    return join(this.opts.base, "repos", `${name}.git`);
  }

  workDir(name: string): string {
    return join(this.opts.base, "repo-work", name);
  }

  private lockDir(name: string): string {
    return join(this.opts.base, "repo-locks", `${name}.lock`);
  }

  // ── Repositories ────────────────────────────────────────────────────

  async repoExists(name: string): Promise<boolean> {
    return exists(join(this.bareDir(name), "HEAD"));
  }

  async listRepos(): Promise<string[]> {
    try {
      return (await readdir(join(this.opts.base, "repos")))
        .filter((entry) => entry.endsWith(".git"))
        .map((entry) => entry.slice(0, -4))
        .filter((name) => this.opts.isValidName(name))
        .sort();
    } catch {
      return [];
    }
  }

  /** Create the bare repository and its receive config. Idempotent. */
  async initBare(name: string): Promise<void> {
    if (!this.opts.isValidName(name))
      throw new MemoryRepoError(
        `Invalid ${this.opts.label.toLowerCase()} repository "${name}".`,
      );
    if (await this.repoExists(name)) return;
    const bare = this.bareDir(name);
    await mkdir(dirname(bare), { recursive: true });
    await git(["init", "--bare", "--quiet", "--initial-branch=main", bare]);
    for (const [key, value] of [
      ["receive.denyNonFastForwards", "true"],
      ["receive.denyDeletes", "true"],
      ["receive.advertisePushOptions", "true"],
      ["http.receivepack", "true"],
      ["core.logAllRefUpdates", "true"],
    ]) {
      await git(["--git-dir", bare, "config", key, value]);
    }
  }

  /** (Re)write the receive hooks so they run this release's validator. */
  async installHooks(name: string, force = false): Promise<void> {
    if (!force && this.hooked.has(name)) return;
    const command = this.opts.hookCommand;
    if (!command?.length) return;
    const hooks = join(this.bareDir(name), "hooks");
    await mkdir(hooks, { recursive: true });
    const quoted = command.map((part) => `'${part.replace(/'/g, `'\\''`)}'`);
    for (const hook of ["pre-receive", "post-receive"]) {
      const path = join(hooks, hook);
      await writeFile(
        path,
        `#!/bin/sh\n# Installed by Open Session (memory-repo/service.ts).\nexec ${quoted.join(" ")} ${hook} "$@"\n`,
      );
      await chmod(path, 0o755);
    }
    this.hooked.add(name);
  }

  /** The commit `main` points at, read from the ref files (no subprocess). */
  async head(name: string): Promise<string | null> {
    const bare = this.bareDir(name);
    try {
      const loose = (
        await readFile(join(bare, "refs/heads/main"), "utf8")
      ).trim();
      if (/^[0-9a-f]{40,64}$/.test(loose)) return loose;
    } catch {}
    try {
      const packed = await readFile(join(bare, "packed-refs"), "utf8");
      const line = packed
        .split("\n")
        .find((row) => row.endsWith(" refs/heads/main"));
      if (line) return line.split(" ")[0];
    } catch {}
    return null;
  }

  // ── Writes through the service checkout ─────────────────────────────

  private async lock(name: string): Promise<() => Promise<void>> {
    const dir = this.lockDir(name);
    await mkdir(dirname(dir), { recursive: true });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await mkdir(dir);
        return async () => {
          await rm(dir, { recursive: true, force: true });
        };
      } catch {
        try {
          const info = await stat(dir);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await rm(dir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline)
          throw new MemoryRepoError(
            `${this.opts.label} repository "${name}" is busy. Try again.`,
            503,
          );
        await sleep(100);
      }
    }
  }

  /** Serialize work per repository in this process, and lock across processes. */
  serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(name) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const release = await this.lock(name);
        try {
          return await fn();
        } finally {
          await release();
        }
      });
    this.chains.set(name, next);
    return next;
  }

  /** Bring the service checkout to the canonical `main`. Call inside serial. */
  async syncWork(name: string, env: Record<string, string>): Promise<string> {
    const dir = this.workDir(name);
    if (!(await exists(join(dir, ".git")))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dirname(dir), { recursive: true });
      await git(["clone", "--quiet", this.bareDir(name), dir], { env });
    }
    await git(["fetch", "--quiet", "origin"], { cwd: dir, env });
    const remoteHead = await git(
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
      { cwd: dir, env, check: false },
    );
    if (remoteHead.code === 0) {
      await git(["checkout", "--quiet", "-B", "main", "origin/main"], {
        cwd: dir,
        env,
      });
      await git(["reset", "--quiet", "--hard", "origin/main"], {
        cwd: dir,
        env,
      });
    }
    await git(["clean", "-fdq"], { cwd: dir, env });
    return dir;
  }

  /**
   * Run `fn` against a fresh service checkout of `name`, then commit what it
   * changed and push. A push that lost a race to a session retries on the
   * new HEAD. Returns the new HEAD, or null when nothing changed.
   */
  withWork(
    name: string,
    fn: (work: WorkContext) => Promise<void>,
    opts: WithWorkOptions,
  ): Promise<string | null> {
    return this.serial(name, async () => {
      const env = authorEnv(opts.author);
      for (let attempt = 0; attempt < 4; attempt++) {
        const dir = await this.syncWork(name, env);
        const before = (
          await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
            cwd: dir,
            env,
            check: false,
          })
        ).stdout.trim();
        const touched = new Set<string>();
        const context: WorkContext = {
          dir,
          read: async (path) => {
            try {
              return await readFile(join(dir, safePath(path)), "utf8");
            } catch {
              return undefined;
            }
          },
          write: async (path, text) => {
            const target = join(dir, safePath(path));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, text);
            touched.add(path);
          },
          remove: async (path) => {
            await rm(join(dir, safePath(path)), { force: true });
            touched.add(path);
          },
          list: async () => {
            const { stdout } = await git(["ls-files", "-z"], { cwd: dir, env });
            return stdout.split("\0").filter(Boolean);
          },
          git: async (args) => (await git(args, { cwd: dir, env })).stdout,
        };
        await fn(context);
        for (const path of touched) {
          const text = await context.read(path);
          if (text === undefined) continue;
          const problems = this.opts.validate(
            path,
            new TextEncoder().encode(text),
          );
          if (problems.length)
            throw new MemoryRepoError(formatProblems(problems));
        }
        await git(["add", "-A"], { cwd: dir, env });
        const status = await git(["status", "--porcelain"], { cwd: dir, env });
        if (status.stdout.trim()) {
          const message = [
            opts.message,
            ...(opts.trailers?.length ? ["", ...opts.trailers] : []),
          ].join("\n");
          await git(["commit", "--quiet", "--no-verify", "-m", message], {
            cwd: dir,
            env,
          });
        }
        const after = (
          await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
            cwd: dir,
            env,
            check: false,
          })
        ).stdout.trim();
        if (!after || after === before) return null;
        const push = await git(
          [
            "push",
            "--quiet",
            "-o",
            `actor=${opts.author?.name || "service"}`,
            ...(opts.session ? ["-o", `session=${opts.session}`] : []),
            "origin",
            "HEAD:main",
          ],
          { cwd: dir, env, check: false },
        );
        if (push.code === 0) {
          await this.opts.onPushed?.(name);
          return after;
        }
        const output = `${push.stderr}\n${push.stdout}`;
        if (
          !/non-fast-forward|fetch first|rejected.*stale|failed to update ref|cannot lock ref/i.test(
            output,
          )
        )
          throw new MemoryRepoError(cleanHookOutput(output));
        await sleep(50 * (attempt + 1));
      }
      throw new MemoryRepoError(
        `${this.opts.label} repository "${name}" kept changing. Try again.`,
        503,
      );
    });
  }

  // ── History ─────────────────────────────────────────────────────────

  async pushLog(
    name: string,
  ): Promise<Map<string, { sessionId?: string; actor?: string }>> {
    const out = new Map<string, { sessionId?: string; actor?: string }>();
    try {
      const text = await readFile(join(this.bareDir(name), PUSH_LOG), "utf8");
      for (const line of text.split("\n").slice(-5000)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as {
            commits?: string[];
            session?: string;
            actor?: string;
          };
          for (const sha of row.commits ?? [])
            out.set(sha, { sessionId: row.session, actor: row.actor });
        } catch {}
      }
    } catch {}
    return out;
  }

  async history(
    name: string,
    opts: { limit?: number; grep?: string; path?: string } = {},
  ): Promise<HistoryCommit[]> {
    if (!(await this.head(name))) return [];
    const args = [
      "--git-dir",
      this.bareDir(name),
      "log",
      `-n${Math.min(Math.max(opts.limit ?? 30, 1), 200)}`,
      "--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f",
      "--name-status",
      "--no-renames",
    ];
    if (opts.grep) args.push("-S", opts.grep);
    args.push("main");
    if (opts.path) args.push("--", opts.path);
    const { stdout } = await git(args);
    const pushes = await this.pushLog(name);
    return stdout
      .split("\x1e")
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const [sha, author, date, subject, body, rest = ""] =
          chunk.split("\x1f");
        const files = rest
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [status, ...path] = line.split("\t");
            return { status, path: path.join("\t") };
          });
        const pushed = pushes.get(sha);
        const trailerSession = /^Session:\s*(\S+)/m.exec(body)?.[1];
        return {
          sha,
          author,
          date,
          subject,
          body: body.trim(),
          files,
          sessionId: pushed?.sessionId ?? sessionIdFromLink(trailerSession),
          pushedBy: pushed?.actor,
        };
      });
  }

  async diff(name: string, sha: string): Promise<string> {
    if (!COMMIT.test(sha)) throw new MemoryRepoError("Invalid commit.");
    const { stdout } = await git([
      "--git-dir",
      this.bareDir(name),
      "show",
      "--format=",
      "--no-color",
      "--stat",
      "--patch",
      sha,
    ]);
    return stdout.length > 200_000 ? `${stdout.slice(0, 200_000)}\n…` : stdout;
  }

  async revert(
    name: string,
    sha: string,
    author?: Author,
  ): Promise<string | null> {
    if (!COMMIT.test(sha)) throw new MemoryRepoError("Invalid commit.");
    return this.withWork(
      name,
      async (work) => {
        const result = await git(["revert", "--no-commit", sha], {
          cwd: work.dir,
          env: authorEnv(author),
          check: false,
        });
        if (result.code !== 0) {
          await git(["revert", "--abort"], { cwd: work.dir, check: false });
          throw new MemoryRepoError(
            "This change cannot be reverted automatically because later changes touched the same lines.",
            409,
          );
        }
      },
      {
        message: `Revert ${sha.slice(0, 10)}`,
        author,
        trailers: [`Reverts: ${sha}`],
      },
    );
  }

  // ── Reads ───────────────────────────────────────────────────────────

  /** Every file path at HEAD. */
  async listFiles(name: string): Promise<string[]> {
    const head = await this.head(name);
    if (!head) return [];
    return (await listTree(this.bareDir(name), head))
      .map((blob) => blob.path)
      .sort();
  }

  /** Read one file at HEAD. */
  async readFile(name: string, path: string): Promise<string | null> {
    const clean = safePath(path);
    const result = await git(
      ["--git-dir", this.bareDir(name), "show", `main:${clean}`],
      { check: false },
    );
    return result.code === 0 ? result.stdout : null;
  }

  /** One file's bytes at `rev`, or null when it is not there. */
  async readAt(
    name: string,
    rev: string,
    path: string,
  ): Promise<Uint8Array | null> {
    const spec = `${safeRev(rev)}:${safePath(path)}`;
    const bare = this.bareDir(name);
    const type = await git(["--git-dir", bare, "cat-file", "-t", spec], {
      check: false,
    });
    if (type.code !== 0 || type.stdout.trim() !== "blob") return null;
    return gitBytes(["--git-dir", bare, "cat-file", "blob", spec]);
  }

  /** The blob id of one file at `rev`, or null when it is not there. */
  async blobAt(
    name: string,
    rev: string,
    path: string,
  ): Promise<string | null> {
    const result = await git(
      [
        "--git-dir",
        this.bareDir(name),
        "rev-parse",
        "--verify",
        "--quiet",
        `${safeRev(rev)}:${safePath(path)}`,
      ],
      { check: false },
    );
    const sha = result.stdout.trim();
    return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  /** Whether commit `a` is `b` or one of its ancestors. */
  async isAncestor(name: string, a: string, b: string): Promise<boolean> {
    if (!COMMIT.test(a) || !COMMIT.test(b))
      throw new MemoryRepoError("Invalid commit.");
    const result = await git(
      ["--git-dir", this.bareDir(name), "merge-base", "--is-ancestor", a, b],
      { check: false },
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new MemoryRepoError("Unknown commit.", 404);
  }
}

export { authorEnv, safePath };
