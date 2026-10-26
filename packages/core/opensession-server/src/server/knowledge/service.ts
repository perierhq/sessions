/**
 * A project's private knowledge repository and its search index.
 *
 * Runs on the memory-repo worker. Builds on GitRepoStore (the same bare
 * repository + locked service checkout memory uses) with knowledge's own
 * name rule and validator. Only this service writes: people through the
 * API, ingestion as "Pat". No receive hooks (the bare repository is never
 * served) and never a remote.
 *
 * The index (KnowledgeIndex) mirrors HEAD; `fresh` reindexes a project
 * when its `main` ref moved, like MemoryRepoService.refresh. Callers read
 * through the service's methods (read, search, list, counts,
 * internalBodies, dependents), which run `fresh` first.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DependencyRef,
  KnowledgeFilter,
  KnowledgeFrontMatter,
  KnowledgeItem,
  KnowledgeSearchHit,
} from "../../shared/knowledge";
import { git, isolatedGitEnv, listTree, readBlobs } from "../memory-repo/git";
import {
  GitRepoStore,
  MemoryRepoError,
  safePath,
  type Author,
  type HistoryCommit,
} from "../memory-repo/git-store";
import { findSecrets } from "../memory-repo/secrets";
import { KnowledgeConflictError } from "./errors";
import { parseArticle, renderArticle } from "./format";
import {
  excerptOf,
  KnowledgeIndex,
  type KnowledgeListFilter,
  type KnowledgeSearchOptions,
} from "./index-store";
import {
  isAttachmentPath,
  isItemPath,
  isKnowledgeRepoName,
  KNOWLEDGE_ENTRY,
  knowledgeRepoName,
  originForPath,
  projectFromRepo,
} from "./layout";
import {
  formatProblems,
  MAX_ARTICLE_BYTES,
  MAX_ATTACHMENT_BYTES,
  validateKnowledgeFile,
} from "./validate";

export interface KnowledgeServiceOptions {
  /** The memory state directory; knowledge repos sit next to memory's. */
  base: string;
  /** Index path override (tests). */
  indexPath?: string;
}

export type KnowledgeChange =
  | { op: "put"; path: string; fm: KnowledgeFrontMatter; body: string }
  | {
      op: "move";
      from: string;
      to: string;
      fm: KnowledgeFrontMatter;
      body: string;
    }
  | { op: "delete"; path: string }
  | { op: "attach"; path: string; bytes: Uint8Array };

export interface KnowledgeWriteOptions {
  message: string;
  author: Author;
  trailers?: string[];
  /** Blob id per path the caller read; null = the path must not exist. */
  expected?: Record<string, string | null>;
}

export { KnowledgeConflictError };

const STARTER = `# Knowledge

This project's support knowledge. Open Session writes this repository; edit
it from the project's Knowledge page.

- \`articles/\`: articles people wrote or approved
- \`suggestions/\`: proposals waiting for a person
- \`sources/\`: material imported from mail, the code repository, releases,
  the website, issues and files
- \`attachments/\`: uploaded files
`;

function noSecrets(text: string): void {
  const [finding] = findSecrets(text);
  if (finding)
    throw new MemoryRepoError(
      `This looks like a ${finding.name}. Knowledge never stores credentials; remove it and try again.`,
    );
}

function invalidPath(path: string): MemoryRepoError {
  return new MemoryRepoError(`Invalid knowledge path "${path}".`);
}

/** A segment git would treat as its own (`.git`, `.gitmodules`, any case):
 *  never a knowledge file. */
function hasGitSegment(path: string): boolean {
  return path.split("/").some((segment) => /^\.git/i.test(segment));
}

function itemPath(path: string): boolean {
  return isItemPath(path) && !hasGitSegment(path);
}

function attachmentPath(path: string): boolean {
  return isAttachmentPath(path) && !hasGitSegment(path);
}

/** The validator on what a change would write, before any git work. */
function checkFile(path: string, bytes: Uint8Array): void {
  const problems = validateKnowledgeFile(path, bytes);
  if (problems.length) throw new MemoryRepoError(formatProblems(problems));
}

function rendered(path: string, fm: KnowledgeFrontMatter, body: string) {
  let text: string;
  try {
    text = renderArticle(fm, body);
  } catch (error) {
    throw new MemoryRepoError(
      `Can't write "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return new TextEncoder().encode(text);
}

/** Front matter for a file that can't be read: never backs (reference,
 *  needs-check), and treated as internal so the quote check still sees
 *  its text (fail closed). */
function unreadable(
  path: string,
  text: string,
  problem: string,
  day: string,
): KnowledgeFrontMatter {
  const title =
    /^title:[ \t]*["']?(.+?)["']?[ \t]*$/m.exec(text)?.[1]?.slice(0, 200) ||
    path.split("/").pop()!.replace(/\.md$/i, "");
  return {
    title,
    kind: "internal",
    trust: "reference",
    status: "needs-check",
    origin: originForPath(path) ?? "article",
    topics: [],
    sources: [],
    dependsOn: [],
    validAsOf: day,
    check: { reason: `The file can't be read: ${problem}`, since: day },
  };
}

export class KnowledgeService {
  /** @internal The raw index, which may be behind the repository. Callers
   *  (gateway dispatch, routes, the agent) use the service's read, search,
   *  list, counts, internalBodies and dependents, which run `fresh` first. */
  readonly index: KnowledgeIndex;
  readonly store: GitRepoStore;
  /** The reindex running per project; later `fresh` calls wait for it and
   *  then check the head again. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(readonly opts: KnowledgeServiceOptions) {
    this.index = new KnowledgeIndex(
      opts.indexPath ?? join(opts.base, "knowledge-index.sqlite"),
    );
    this.store = new GitRepoStore({
      base: opts.base,
      isValidName: isKnowledgeRepoName,
      validate: (path, bytes, mode) => validateKnowledgeFile(path, bytes, mode),
      // The commit is in; a failed reindex leaves the index on the old
      // head, so the next `fresh` (every read does one) tries again.
      onPushed: (name) => this.fresh(projectFromRepo(name)!),
      logOnPushedErrors: true,
      label: "Knowledge",
    });
  }

  close(): void {
    this.index.close();
  }

  private repo(project: string): string {
    // One repository per project on case-insensitive disks too.
    if (/[A-Z]/.test(project))
      throw new MemoryRepoError(`Invalid knowledge project "${project}".`);
    try {
      return knowledgeRepoName(project);
    } catch {
      throw new MemoryRepoError(`Invalid knowledge project "${project}".`);
    }
  }

  // ── Repositories ────────────────────────────────────────────────────

  /** Create the bare repository with a starter KNOWLEDGE.md. Idempotent.
   *  No hooks and no remote: nothing but this service touches it. */
  async ensureRepo(project: string): Promise<void> {
    const name = this.repo(project);
    await this.store.initBare(name);
    if (await this.store.head(name)) return;
    await this.store.withWork(
      name,
      async (work) => {
        if (await work.read(KNOWLEDGE_ENTRY)) return;
        await work.write(KNOWLEDGE_ENTRY, STARTER);
      },
      { message: "Create knowledge repository" },
    );
  }

  async hasRepo(project: string): Promise<boolean> {
    return this.store.repoExists(this.repo(project));
  }

  async listProjects(): Promise<string[]> {
    return (await this.store.listRepos())
      .map((name) => projectFromRepo(name))
      .filter(
        (project): project is string => !!project && !/[A-Z]/.test(project),
      );
  }

  async head(project: string): Promise<string | null> {
    return this.store.head(this.repo(project));
  }

  // ── Index ───────────────────────────────────────────────────────────

  /** Reindex the project when its `main` moved (one ref-file read when it
   *  didn't). One reindex per project at a time: a call made while one runs
   *  waits for it, then checks the head again, so it sees every commit
   *  made before it was called. Throws when the reindex fails, so readers
   *  never act on an index they couldn't bring up to date. */
  fresh(project: string): Promise<void> {
    const name = this.repo(project);
    const running = this.refreshing.get(project);
    if (running)
      return running.then(
        () => this.fresh(project),
        () => this.fresh(project),
      );
    const job = this.reindex(project, name).finally(() => {
      if (this.refreshing.get(project) === job) this.refreshing.delete(project);
    });
    this.refreshing.set(project, job);
    return job;
  }

  private async reindex(project: string, name: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // The indexed head before the repository's: if another index writer
      // lands in between, replaceProject's compare-and-swap refuses ours.
      const previous = this.index.head(project);
      const head = await this.store.head(name);
      if (!head || previous === head) return;
      const { items, bodies } = await this.build(project, name, head);
      if (this.index.replaceProject(project, head, items, bodies, previous))
        return;
    }
    throw new MemoryRepoError(
      `Knowledge for "${project}" kept changing. Try again.`,
      503,
    );
  }

  /** Every item at `head`, with the text the index keeps for it. */
  private async build(
    project: string,
    name: string,
    head: string,
  ): Promise<{ items: KnowledgeItem[]; bodies: Map<string, string> }> {
    const bare = this.store.bareDir(name);
    const blobs = (await listTree(bare, head)).filter((blob) =>
      isItemPath(blob.path),
    );
    // Oversized items are read up to the attachment limit and kept as a
    // capped prefix; anything bigger is never read.
    const readable = blobs.filter(
      (blob) => blob.size <= MAX_ATTACHMENT_BYTES && blob.mode !== "160000",
    );
    const contents = await readBlobs(
      bare,
      readable.map((blob) => blob.sha),
    );
    const { stdout: time } = await git([
      "--git-dir",
      bare,
      "log",
      "-1",
      "--format=%cI",
      head,
    ]);
    const headTime = new Date(time.trim() || Date.now()).toISOString();
    const day = headTime.slice(0, 10);
    const decoder = new TextDecoder();
    const stamps = this.index.stamps(project);
    const items: KnowledgeItem[] = [];
    const bodies = new Map<string, string>();
    for (const blob of blobs) {
      const bytes = contents.get(blob.sha);
      let fm: KnowledgeFrontMatter;
      // Unreadable items keep their raw text: they index as internal, and
      // the quote check must still see what they say.
      let body = "";
      if (!bytes) {
        fm = unreadable(
          blob.path,
          "",
          blob.size > MAX_ARTICLE_BYTES
            ? `it is larger than ${MAX_ARTICLE_BYTES} bytes.`
            : "it isn't a file.",
          day,
        );
      } else if (bytes.subarray(0, 8000).includes(0)) {
        fm = unreadable(blob.path, "", "it is a binary file.", day);
      } else if (bytes.byteLength > MAX_ARTICLE_BYTES) {
        body = decoder.decode(bytes.subarray(0, MAX_ARTICLE_BYTES));
        fm = unreadable(
          blob.path,
          body,
          `it is larger than ${MAX_ARTICLE_BYTES} bytes.`,
          day,
        );
      } else {
        const text = decoder.decode(bytes);
        const parsed = parseArticle(blob.path, text);
        if (parsed.fm && !parsed.problems.length) {
          fm = parsed.fm;
          body = parsed.body;
        } else {
          fm = unreadable(
            blob.path,
            text,
            parsed.problems[0]?.message ?? "unknown problem.",
            day,
          );
          body = parsed.body || text;
        }
      }
      // Keep the time an unchanged file was first indexed at.
      const stamp = stamps.get(blob.path);
      items.push({
        ...fm,
        project,
        path: blob.path,
        blob: blob.sha,
        commit: head,
        updatedAt:
          stamp && stamp.blob === blob.sha ? stamp.updatedAt : headTime,
        effective: fm.status,
        excerpt: excerptOf(body),
      });
      bodies.set(blob.path, body);
    }
    return { items, bodies };
  }

  // ── Reads ───────────────────────────────────────────────────────────

  /** The item at HEAD, from the index after a freshness check. `today`
   *  (YYYY-MM-DD, default today in UTC) decides `effective`. */
  async read(
    project: string,
    path: string,
    today?: string,
  ): Promise<{ item: KnowledgeItem; body: string } | null> {
    await this.fresh(project);
    const item = this.index.get(project, path, today);
    if (!item) return null;
    return { item, body: this.index.body(project, path) ?? "" };
  }

  /** KnowledgeIndex.get after a freshness check: the item without its
   *  body. */
  async get(
    project: string,
    path: string,
    today?: string,
  ): Promise<KnowledgeItem | null> {
    await this.fresh(project);
    return this.index.get(project, path, today);
  }

  /** KnowledgeIndex.search after a freshness check. */
  async search(
    project: string,
    query: string,
    opts: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchHit[]> {
    await this.fresh(project);
    return this.index.search(project, query, opts);
  }

  /** KnowledgeIndex.list after a freshness check. */
  async list(
    project: string,
    filter: KnowledgeListFilter,
    opts: { today: string; query?: string; limit?: number; offset?: number },
  ): Promise<{ items: KnowledgeItem[]; total: number }> {
    await this.fresh(project);
    return this.index.list(project, filter, opts);
  }

  /** KnowledgeIndex.counts after a freshness check. */
  async counts(
    project: string,
    today: string,
  ): Promise<Record<KnowledgeFilter, number>> {
    await this.fresh(project);
    return this.index.counts(project, today);
  }

  /** KnowledgeIndex.internalBodies after a freshness check. */
  async internalBodies(
    project: string,
  ): Promise<Array<{ path: string; title: string; body: string }>> {
    await this.fresh(project);
    return this.index.internalBodies(project);
  }

  /** KnowledgeIndex.dependents after a freshness check. */
  async dependents(
    project: string,
    dep: DependencyRef,
    today: string,
  ): Promise<KnowledgeItem[]> {
    await this.fresh(project);
    return this.index.dependents(project, dep, today);
  }

  /** An item as it was at `commit`; null when it wasn't a readable item
   *  there. */
  async readAt(
    project: string,
    path: string,
    commit: string,
  ): Promise<{ fm: KnowledgeFrontMatter; body: string; blob: string } | null> {
    if (!itemPath(path)) return null;
    const name = this.repo(project);
    const blob = await this.store.blobAt(name, commit, path);
    if (!blob) return null;
    // A commit is immutable, so the blob id and the bytes agree.
    const text = await this.store.readAt(name, commit, path);
    if (!text) return null;
    const parsed = parseArticle(path, new TextDecoder().decode(text));
    if (!parsed.fm || parsed.problems.length) return null;
    return { fm: parsed.fm, body: parsed.body, blob };
  }

  async blobAt(
    project: string,
    path: string,
    commit: string,
  ): Promise<string | null> {
    return this.store.blobAt(this.repo(project), commit, path);
  }

  /** Whether `a` is `b` or an ancestor. Throws MemoryRepoError 404 for an
   *  unknown commit; callers checking freshness treat that as not backed. */
  async isAncestor(project: string, a: string, b: string): Promise<boolean> {
    return this.store.isAncestor(this.repo(project), a, b);
  }

  async readAttachment(
    project: string,
    path: string,
  ): Promise<Uint8Array | null> {
    if (!attachmentPath(path)) throw invalidPath(path);
    const name = this.repo(project);
    if (!(await this.store.head(name))) return null;
    return this.store.readAt(name, "main", path);
  }

  /** The attachment paths in `folder` (`attachments/<slug>`) at HEAD. */
  async listAttachments(project: string, folder: string): Promise<string[]> {
    const name = this.repo(project);
    const prefix = `${folder.replace(/\/+$/, "")}/`;
    return (await this.store.listFiles(name)).filter(
      (path) => path.startsWith(prefix) && attachmentPath(path),
    );
  }

  // ── Writes ──────────────────────────────────────────────────────────

  /**
   * Apply `changes` as one commit by `author`. Checks everything it can
   * before any git work: paths, credentials in the message and trailers,
   * and the validator on each file as it would be written. Then, inside the
   * repository lock, checks `expected` blobs and that each move has its
   * source and (unless `expected` names it) no file at its target
   * (KnowledgeConflictError on a mismatch), writes, validates what is
   * staged, and reindexes. Returns the new HEAD, or null when nothing
   * changed.
   */
  async write(
    project: string,
    changes: KnowledgeChange[],
    opts: KnowledgeWriteOptions,
  ): Promise<string | null> {
    const name = this.repo(project);
    noSecrets([opts.message, ...(opts.trailers ?? [])].join("\n"));
    // What each put or move writes, rendered once.
    const writes = new Map<KnowledgeChange, Uint8Array>();
    for (const change of changes) {
      switch (change.op) {
        case "put":
          if (!itemPath(change.path)) throw invalidPath(change.path);
          noSecrets(`${change.fm.title}\n${change.body}`);
          writes.set(change, rendered(change.path, change.fm, change.body));
          checkFile(change.path, writes.get(change)!);
          break;
        case "move":
          if (!itemPath(change.from)) throw invalidPath(change.from);
          if (!itemPath(change.to)) throw invalidPath(change.to);
          if (change.from === change.to)
            throw new MemoryRepoError("A move needs two different paths.");
          noSecrets(`${change.fm.title}\n${change.body}`);
          writes.set(change, rendered(change.to, change.fm, change.body));
          checkFile(change.to, writes.get(change)!);
          break;
        case "delete":
          if (!itemPath(change.path) && !attachmentPath(change.path))
            throw invalidPath(change.path);
          break;
        case "attach":
          if (!attachmentPath(change.path)) throw invalidPath(change.path);
          checkFile(change.path, change.bytes);
          break;
      }
    }
    const expected = opts.expected ?? {};
    for (const path of Object.keys(expected))
      if (!itemPath(path) && !attachmentPath(path)) throw invalidPath(path);
    if (!(await this.store.head(name)))
      throw new MemoryRepoError(
        `Knowledge for "${project}" isn't set up yet.`,
        404,
      );

    const sha = await this.store.withWork(
      name,
      async (work) => {
        const env = isolatedGitEnv();
        const blobAtHead = async (path: string) => {
          const current = await git(
            ["rev-parse", "--verify", "--quiet", `HEAD:${safePath(path)}`],
            { cwd: work.dir, env, check: false },
          );
          return current.code === 0 ? current.stdout.trim() || null : null;
        };
        for (const [path, blob] of Object.entries(expected))
          if ((await blobAtHead(path)) !== blob)
            throw new KnowledgeConflictError();
        for (const change of changes) {
          if (change.op !== "move") continue;
          if (!Object.hasOwn(expected, change.from)) {
            if (!(await blobAtHead(change.from)))
              throw new KnowledgeConflictError(
                "This article was moved or deleted. Reload and try again.",
              );
          }
          if (!Object.hasOwn(expected, change.to)) {
            if (await blobAtHead(change.to))
              throw new KnowledgeConflictError(
                "An article already exists at that path. Reload and try again.",
              );
          }
        }
        const decoder = new TextDecoder();
        for (const change of changes) {
          switch (change.op) {
            case "put":
              await work.write(
                change.path,
                decoder.decode(writes.get(change)!),
              );
              break;
            case "move":
              await work.remove(change.from);
              await work.write(change.to, decoder.decode(writes.get(change)!));
              break;
            case "delete":
              await work.remove(change.path);
              break;
            case "attach": {
              const target = join(work.dir, safePath(change.path));
              await mkdir(dirname(target), { recursive: true });
              await writeFile(target, change.bytes);
              break;
            }
          }
        }
        // Attachments are bytes, not text: validate what is staged.
        await this.store.validateStagedPaths(work);
      },
      { message: opts.message, author: opts.author, trailers: opts.trailers },
    );
    if (sha) {
      try {
        await this.fresh(project);
      } catch (error) {
        console.warn(`[knowledge] reindex of ${project} failed:`, error);
      }
    }
    return sha;
  }

  // ── History ─────────────────────────────────────────────────────────

  async history(
    project: string,
    path?: string,
    limit?: number,
  ): Promise<HistoryCommit[]> {
    if (path !== undefined) safePath(path);
    return this.store.history(this.repo(project), { path, limit });
  }

  async diff(project: string, sha: string): Promise<string> {
    return this.store.diff(this.repo(project), sha);
  }

  async revert(
    project: string,
    sha: string,
    author: Author,
  ): Promise<string | null> {
    return this.store.revert(this.repo(project), sha, author, {
      validate: true,
    });
  }
}
