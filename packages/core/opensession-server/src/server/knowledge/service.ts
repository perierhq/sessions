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
 * when its `main` ref moved, like MemoryRepoService.refresh.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  KnowledgeFrontMatter,
  KnowledgeItem,
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
import { parseArticle, renderArticle } from "./format";
import { KnowledgeIndex } from "./index-store";
import {
  isAttachmentPath,
  isItemPath,
  isKnowledgeRepoName,
  KNOWLEDGE_ENTRY,
  knowledgeRepoName,
  originForPath,
  projectFromRepo,
} from "./layout";
import { MAX_ARTICLE_BYTES, validateKnowledgeFile } from "./validate";

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

/** Someone else changed a file between the caller's read and this write. */
export class KnowledgeConflictError extends MemoryRepoError {
  constructor(message = "Someone changed this article. Reload and try again.") {
    super(message, 409);
    this.name = "KnowledgeConflictError";
  }
}

const STARTER = `# Knowledge

This project's support knowledge. Open Session writes this repository; edit
it from the project's Knowledge page.

- \`articles/\`: articles people wrote or approved
- \`suggestions/\`: proposals waiting for a person
- \`sources/\`: material imported from mail, the code repository, releases,
  the website, issues and files
- \`attachments/\`: uploaded files
`;

const EXCERPT_CHARS = 240;

function excerptOf(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > EXCERPT_CHARS
    ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`
    : text;
}

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
  readonly index: KnowledgeIndex;
  readonly store: GitRepoStore;

  constructor(readonly opts: KnowledgeServiceOptions) {
    this.index = new KnowledgeIndex(
      opts.indexPath ?? join(opts.base, "knowledge-index.sqlite"),
    );
    this.store = new GitRepoStore({
      base: opts.base,
      isValidName: isKnowledgeRepoName,
      validate: (path, bytes) => validateKnowledgeFile(path, bytes),
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
      .filter((project): project is string => !!project);
  }

  async head(project: string): Promise<string | null> {
    return this.store.head(this.repo(project));
  }

  // ── Index ───────────────────────────────────────────────────────────

  /** Reindex the project when its `main` moved (one ref-file read when it
   *  didn't). Throws when the reindex fails, so readers never act on an
   *  index they couldn't bring up to date. */
  async fresh(project: string): Promise<void> {
    const name = this.repo(project);
    const head = await this.store.head(name);
    if (!head || this.index.head(project) === head) return;
    const bare = this.store.bareDir(name);
    const blobs = (await listTree(bare, head)).filter((blob) =>
      isItemPath(blob.path),
    );
    const readable = blobs.filter(
      (blob) => blob.size <= MAX_ARTICLE_BYTES && blob.mode !== "160000",
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
    const items: KnowledgeItem[] = [];
    const bodies = new Map<string, string>();
    for (const blob of blobs) {
      const bytes = contents.get(blob.sha);
      let fm: KnowledgeFrontMatter;
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
      } else {
        const text = decoder.decode(bytes);
        const parsed = parseArticle(blob.path, text);
        body = parsed.body;
        fm =
          parsed.fm && !parsed.problems.length
            ? parsed.fm
            : unreadable(
                blob.path,
                text,
                parsed.problems[0]?.message ?? "unknown problem.",
                day,
              );
      }
      // Keep the time an unchanged file was first indexed at.
      const previous = this.index.get(project, blob.path);
      items.push({
        ...fm,
        project,
        path: blob.path,
        blob: blob.sha,
        commit: head,
        updatedAt:
          previous && previous.blob === blob.sha
            ? previous.updatedAt
            : headTime,
        effective: fm.status,
        excerpt: excerptOf(body),
      });
      bodies.set(blob.path, body);
    }
    this.index.replaceProject(project, head, items, bodies);
  }

  // ── Reads ───────────────────────────────────────────────────────────

  /** The item at HEAD, from the index after a freshness check. */
  async read(
    project: string,
    path: string,
  ): Promise<{ item: KnowledgeItem; body: string } | null> {
    await this.fresh(project);
    const item = this.index.get(project, path);
    if (!item) return null;
    return { item, body: this.index.body(project, path) ?? "" };
  }

  /** An item as it was at `commit`; null when it wasn't a readable item
   *  there. */
  async readAt(
    project: string,
    path: string,
    commit: string,
  ): Promise<{ fm: KnowledgeFrontMatter; body: string; blob: string } | null> {
    if (!isItemPath(path)) return null;
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
    if (!isAttachmentPath(path)) throw invalidPath(path);
    const name = this.repo(project);
    if (!(await this.store.head(name))) return null;
    return this.store.readAt(name, "main", path);
  }

  // ── Writes ──────────────────────────────────────────────────────────

  /**
   * Apply `changes` as one commit by `author`. Refuses credentials before
   * anything is written, checks `expected` blobs inside the repository
   * lock (KnowledgeConflictError on a mismatch), validates every changed
   * file, then reindexes. Returns the new HEAD, or null when nothing
   * changed.
   */
  async write(
    project: string,
    changes: KnowledgeChange[],
    opts: KnowledgeWriteOptions,
  ): Promise<string | null> {
    const name = this.repo(project);
    for (const change of changes) {
      switch (change.op) {
        case "put":
          if (!isItemPath(change.path)) throw invalidPath(change.path);
          noSecrets(`${change.fm.title}\n${change.body}`);
          break;
        case "move":
          if (!isItemPath(change.from)) throw invalidPath(change.from);
          if (!isItemPath(change.to)) throw invalidPath(change.to);
          noSecrets(`${change.fm.title}\n${change.body}`);
          break;
        case "delete":
          if (!isItemPath(change.path) && !isAttachmentPath(change.path))
            throw invalidPath(change.path);
          break;
        case "attach":
          if (!isAttachmentPath(change.path)) throw invalidPath(change.path);
          break;
      }
    }
    for (const path of Object.keys(opts.expected ?? {}))
      if (!isItemPath(path) && !isAttachmentPath(path)) throw invalidPath(path);
    if (!(await this.store.head(name)))
      throw new MemoryRepoError(
        `Knowledge for "${project}" isn't set up yet.`,
        404,
      );

    const sha = await this.store.withWork(
      name,
      async (work) => {
        const env = isolatedGitEnv();
        for (const [path, blob] of Object.entries(opts.expected ?? {})) {
          const current = await git(
            ["rev-parse", "--verify", "--quiet", `HEAD:${safePath(path)}`],
            { cwd: work.dir, env, check: false },
          );
          const actual =
            current.code === 0 ? current.stdout.trim() || null : null;
          if (actual !== blob) throw new KnowledgeConflictError();
        }
        for (const change of changes) {
          switch (change.op) {
            case "put":
              await work.write(
                change.path,
                renderArticle(change.fm, change.body),
              );
              break;
            case "move":
              await work.remove(change.from);
              await work.write(
                change.to,
                renderArticle(change.fm, change.body),
              );
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
    return this.store.revert(this.repo(project), sha, author);
  }
}
