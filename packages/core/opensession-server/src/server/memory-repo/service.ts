/**
 * Memory repository service: the canonical git repositories, the derived
 * index, and every server-side write.
 *
 * Layout under the memory state directory:
 *
 *   repos/<name>.git     canonical bare repository (Cognition's "memory
 *                        drive"); sessions clone it and push to it
 *   repo-work/<name>     the service's own checkout for Settings and Slack
 *                        writes, history, revert and remote sync
 *   repo-locks/<name>    cross-process write lock for that checkout
 *   memory-repo-index.sqlite
 *                        derived index (memory-v2 MemoryStore schema);
 *                        delete it and it rebuilds from git
 *
 * The generic git half (bare repositories, the locked service checkout,
 * commit and push, history, diff, revert) is GitRepoStore (git-store.ts);
 * this class adds memory's format, index, session checkouts and remotes.
 *
 * This class is hosted by memory-repo-worker.ts, never on the gateway
 * thread: the index is synchronous SQLite. Git work is async subprocesses.
 * Construction has no side effects beyond opening the index.
 */

import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "../memory-v2/store";
import type { MemoryKind, MemoryRecord, MemoryState } from "../memory-v2/types";
import {
  appendEntry,
  ENTRY_POINT,
  ensureIndexLink,
  extractLinks,
  firstMeta,
  isoDay,
  isMarkdownPath,
  linkFor,
  linkTargetPath,
  parseMemoryFile,
  renderEntry,
  replaceLine,
  slugify,
  type MemoryMeta,
  type ParsedEntry,
  type ParsedMemoryFile,
} from "./format";
import {
  git,
  GitError,
  isolatedGitEnv,
  listTree,
  readBlobs,
  SERVICE_AUTHOR,
} from "./git";
import {
  entryPointFor,
  isValidRepoName,
  joinDir,
  locateScope,
  notesDirFor,
  scopeForPath,
  TEAM_REPO,
  topicFileFor,
  type ScopeLocation,
} from "./layout";
import { recordsForRepo, syntheticEntryId, type RepoFile } from "./records";
import { assertNoSecrets } from "./secrets";
import {
  cleanHookOutput,
  exists,
  GitRepoStore,
  MemoryRepoError,
  PUSH_LOG,
  safePath,
  type Author,
  type HistoryCommit,
  type WithWorkOptions,
  type WorkContext,
} from "./git-store";
import { MAX_FILE_BYTES, validateRepoFile } from "./validate";

export { MemoryRepoError, PUSH_LOG, safePath };
export type { Author, HistoryCommit, WorkContext };

export interface MemoryRepoServiceOptions {
  /** The memory state directory (repos/, repo-work/, the index live here). */
  base: string;
  /** Command prefix that runs the receive hook, e.g. [bun, hook-main.ts]. */
  hookCommand?: string[];
  /** Web base for session links in `source:` metadata. */
  uiBase?: string;
  /** Human label for a scope key (person names for user scopes). */
  labels?: Record<string, string>;
  /** Index path override (tests). */
  indexPath?: string;
}

export interface RemoteStatus {
  url?: string;
  lastSyncAt?: string;
  ok?: boolean;
  error?: string;
  conflict?: { files: string[]; at: string };
}

export interface EntryInput {
  scopeKey: string;
  text: string;
  kind?: MemoryKind;
  pinned?: boolean;
  file?: string;
  id?: string;
  source?: string;
  by?: string;
  via?: string;
  added?: string;
  confirmed?: string;
  expires?: string;
  tags?: string[];
  supersedes?: string[];
  /** Long supporting text: written to a linked note file. */
  details?: string;
}

const FOLD_LIMIT = 400;
export function newEntryId(): string {
  return `m-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export class MemoryRepoService {
  readonly index: MemoryStore;
  /** The git half: bare repositories, the service checkout, history. */
  readonly store: GitRepoStore;
  private readonly checked = new Map<string, number>();

  constructor(readonly opts: MemoryRepoServiceOptions) {
    this.index = new MemoryStore(
      opts.indexPath ?? join(opts.base, "memory-repo-index.sqlite"),
    );
    this.store = new GitRepoStore({
      base: opts.base,
      isValidName: isValidRepoName,
      validate: (path, bytes) => validateRepoFile(path, bytes),
      onPushed: (name) => this.refresh(name).then(() => {}),
      hookCommand: opts.hookCommand,
      label: "Memory",
    });
  }

  close(): void {
    this.index.close();
  }

  bareDir(name: string): string {
    return this.store.bareDir(name);
  }

  workDir(name: string): string {
    return this.store.workDir(name);
  }

  sessionLink(sessionId: string): string {
    return `${(this.opts.uiBase || "").replace(/\/$/, "")}/session/${sessionId}`;
  }

  labelFor(scopeKey: string): string {
    if (scopeKey === "workspace") return "Workspace";
    if (this.opts.labels?.[scopeKey]) return this.opts.labels[scopeKey];
    return scopeKey.replace(/^(repo|user|channel)-/, "");
  }

  // ── Repositories ────────────────────────────────────────────────────

  async repoExists(name: string): Promise<boolean> {
    return this.store.repoExists(name);
  }

  async listRepos(): Promise<string[]> {
    return this.store.listRepos();
  }

  /** Create the bare repository with a starter MEMORY.md. Idempotent. */
  async ensureRepo(name: string): Promise<void> {
    if (!isValidRepoName(name))
      throw new MemoryRepoError(`Invalid memory repository "${name}".`);
    await this.store.initBare(name);
    await this.installHooks(name);
    if (!(await this.head(name))) {
      const scopeKey = name === TEAM_REPO ? "workspace" : name;
      await this.withWork(
        name,
        async (work) => {
          if (await work.read(ENTRY_POINT)) return;
          await work.write(
            ENTRY_POINT,
            `# Memory: ${this.labelFor(scopeKey)}\n\n## Index\n`,
          );
        },
        { message: "Create memory repository" },
      );
    }
  }

  /** (Re)write the receive hooks so they run this release's validator. */
  async installHooks(name: string, force = false): Promise<void> {
    await this.store.installHooks(name, force);
  }

  /** Point every repository's hooks at this release's validator. */
  async reinstallHooks(): Promise<string[]> {
    const names = await this.listRepos();
    for (const name of names) await this.installHooks(name, true);
    return names;
  }

  /** The commit `main` points at, read from the ref files (no subprocess). */
  async head(name: string): Promise<string | null> {
    return this.store.head(name);
  }

  // ── Index ───────────────────────────────────────────────────────────

  /** Scope keys the index currently holds for a repository. */
  private indexedScopes(name: string): string[] {
    return this.index
      .stats()
      .scopes.map((scope) => scope.scopeKey)
      .filter((key) => locateScope(key)?.repo === name);
  }

  /** Reindex a repository when its HEAD moved. Returns true when it did. */
  async refresh(
    name: string,
    opts: { force?: boolean; retired?: MemoryRecord[] } = {},
  ): Promise<boolean> {
    const head = await this.head(name);
    const metaKey = `head:${name}`;
    if (!head) return false;
    if (!opts.force && this.index.metadata(metaKey) === head) return false;
    const bare = this.bareDir(name);
    const blobs = (await listTree(bare, head)).filter(
      (blob) => blob.size <= MAX_FILE_BYTES && blob.mode !== "160000",
    );
    const contents = await readBlobs(
      bare,
      blobs.map((blob) => blob.sha),
    );
    const decoder = new TextDecoder();
    const files: RepoFile[] = [];
    for (const blob of blobs) {
      const bytes = contents.get(blob.sha);
      if (!bytes || bytes.subarray(0, 8000).includes(0)) continue;
      files.push({ path: blob.path, text: decoder.decode(bytes) });
    }
    const { stdout: time } = await git([
      "--git-dir",
      bare,
      "log",
      "-1",
      "--format=%cI",
      head,
    ]);
    const { records } = recordsForRepo(name, files, {
      fallbackTime: new Date(time.trim() || Date.now()).toISOString(),
    });
    const scopes = [
      ...new Set([
        ...this.indexedScopes(name),
        ...records.map((record) => record.scopeKey),
        ...(opts.retired ?? []).map((record) => record.scopeKey),
      ]),
    ];
    const present = new Set(records.map((record) => record.id));
    const retired = (opts.retired ?? [])
      .filter((record) => !present.has(record.id))
      .map((record) => ({
        ...record,
        state: (record.state === "active"
          ? "archived"
          : record.state) as MemoryState,
      }));
    this.index.syncScopes(scopes, [...records, ...retired]);
    this.index.setMetadata(metaKey, head);
    this.checked.set(name, Date.now());
    return true;
  }

  /** Freshness check before reads: one ref-file read per repository. */
  async fresh(names: string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.refresh(name);
      } catch (error) {
        console.warn(`[memory-repo] reindex of ${name} failed:`, error);
      }
    }
  }

  async freshAll(): Promise<void> {
    await this.fresh(await this.listRepos());
  }

  // ── Writes through the service checkout ─────────────────────────────

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
    return this.store.withWork(name, fn, opts);
  }

  // ── Entry operations (Settings, Slack, migration) ───────────────────

  private metaFor(input: EntryInput, id: string): MemoryMeta {
    const meta: MemoryMeta = { id: [id] };
    if (input.kind && input.kind !== "reference") meta.kind = [input.kind];
    if (input.source) meta.source = [input.source];
    if (input.by) meta.by = [input.by];
    if (input.via) meta.via = [input.via];
    meta.added = [input.added ?? isoDay(new Date())];
    if (input.confirmed) meta.confirmed = [input.confirmed];
    if (input.expires) meta.expires = [input.expires];
    if (input.tags?.length) meta.tags = [input.tags.join(", ")];
    if (input.supersedes?.length)
      meta.supersedes = [input.supersedes.join(", ")];
    return meta;
  }

  /** Place a new entry and return its id. Runs inside withWork. */
  private async placeEntry(
    work: WorkContext,
    input: EntryInput,
  ): Promise<string> {
    const location = locateScope(input.scopeKey);
    if (!location)
      throw new MemoryRepoError(`Invalid scope "${input.scopeKey}".`);
    assertNoSecrets(`${input.text}\n${input.details ?? ""}`);
    const id = input.id || newEntryId();
    let text = input.text.replace(/\s+/g, " ").trim();
    if (!text) throw new MemoryRepoError("Memory text is required.");
    const details = distinctDetails(text, input.details);
    if (details) {
      const folded = `${text.replace(/[.\s]*$/, "")}. ${details.replace(/\s+/g, " ")}`;
      if (Array.from(folded).length <= FOLD_LIMIT && !details.includes("\n")) {
        text = folded;
      } else {
        const notePath = await this.freeNotePath(
          work,
          location,
          text,
          input.added,
        );
        await work.write(
          notePath,
          `# ${text.replace(/\s+/g, " ").slice(0, 200)}\n\n${details}\n`,
        );
        text = `${text.replace(/\s*$/, "")} See [[${linkFor(notePath)}]].`;
      }
    }
    const kind = input.kind ?? "reference";
    const file =
      input.file && isMarkdownPath(input.file)
        ? safePath(input.file)
        : input.pinned
          ? entryPointFor(location)
          : topicFileFor(location, kind);
    await work.write(
      file,
      appendEntry(
        file,
        await work.read(file),
        renderEntry(text, this.metaFor(input, id)),
        {
          title:
            file === entryPointFor(location)
              ? `# Memory: ${this.labelFor(input.scopeKey)}`
              : undefined,
        },
      ),
    );
    await this.ensureLinked(work, location, file);
    return id;
  }

  /** Keep the scope's MEMORY.md (and the team root) linking to `file`. */
  private async ensureLinked(
    work: WorkContext,
    location: ScopeLocation,
    file: string,
  ) {
    const entry = entryPointFor(location);
    if (file !== entry && !file.startsWith(`${notesDirFor(location)}/`)) {
      const current = await work.read(entry);
      const next = ensureIndexLink(
        current ??
          `# Memory: ${this.labelFor(scopeForPath(location.repo, entry))}\n\n## Index\n`,
        linkFor(file),
      );
      if (next !== current) await work.write(entry, next);
    }
    if (location.dir && location.repo === TEAM_REPO) {
      if (!(await work.read(entry)))
        await work.write(
          entry,
          `# Memory: ${this.labelFor(scopeForPath(location.repo, entry))}\n\n## Index\n`,
        );
      const root = await work.read(ENTRY_POINT);
      const next = ensureIndexLink(
        root ?? "# Memory: Team\n\n## Index\n",
        linkFor(entry),
      );
      if (next !== root) await work.write(ENTRY_POINT, next);
    }
  }

  private async freeNotePath(
    work: WorkContext,
    location: ScopeLocation,
    text: string,
    added?: string,
  ): Promise<string> {
    const base = joinDir(
      notesDirFor(location),
      `${added ?? isoDay(new Date())}-${slugify(text)}`,
    );
    for (let n = 1; n < 1000; n++) {
      const path = `${base}${n > 1 ? `-${n}` : ""}.md`;
      if ((await work.read(path)) === undefined) return path;
    }
    return `${base}-${newEntryId()}.md`;
  }

  /** Find an entry by id in the checkout. `hint` is the index's path. */
  private async findEntry(
    work: WorkContext,
    id: string,
    hint?: string,
  ): Promise<{
    path: string;
    file: ParsedMemoryFile;
    entry: ParsedEntry;
  } | null> {
    const files = (await work.list()).filter(isMarkdownPath);
    const ordered =
      hint && files.includes(hint)
        ? [hint, ...files.filter((f) => f !== hint)]
        : files;
    for (const path of ordered) {
      const text = await work.read(path);
      if (text === undefined) continue;
      const file = parseMemoryFile(path, text);
      const entry = file.entries.find(
        (candidate) =>
          firstMeta(candidate.meta, "id") === id ||
          syntheticEntryId(path, candidate.text) === id,
      );
      if (entry) return { path, file, entry };
    }
    return null;
  }

  private repoForRecord(record: Pick<MemoryRecord, "scopeKey">): string {
    const location = locateScope(record.scopeKey);
    if (!location)
      throw new MemoryRepoError(`Invalid scope "${record.scopeKey}".`);
    return location.repo;
  }

  async addEntry(input: EntryInput, author?: Author): Promise<MemoryRecord> {
    const location = locateScope(input.scopeKey);
    if (!location)
      throw new MemoryRepoError(`Invalid scope "${input.scopeKey}".`);
    await this.ensureRepo(location.repo);
    const id = input.id || newEntryId();
    await this.withWork(
      location.repo,
      async (work) => {
        await this.placeEntry(work, { ...input, id });
      },
      {
        message: `Remember: ${shortSubject(input.text)}`,
        author,
        trailers: [`Memory-Id: ${id}`],
      },
    );
    const record = this.index.get(id);
    if (!record)
      throw new MemoryRepoError("The memory was saved but not indexed.", 500);
    return record;
  }

  /**
   * Rewrite one entry in place. `patch` fields left undefined keep their
   * value; `null` clears.
   */
  async updateEntry(
    id: string,
    patch: {
      text?: string;
      kind?: MemoryKind;
      expires?: string | null;
      tags?: string[];
      confirmed?: string | null;
      pinned?: boolean;
    },
    author?: Author,
    message?: string,
  ): Promise<MemoryRecord> {
    const record = this.index.get(id);
    if (!record)
      throw new MemoryRepoError(`No memory record with id "${id}".`, 404);
    const name = this.repoForRecord(record);
    if (patch.text) assertNoSecrets(patch.text);
    let newId = record.id;
    await this.withWork(
      name,
      async (work) => {
        const found = await this.findEntry(work, record.id, record.path);
        if (!found)
          throw new MemoryRepoError(
            `Memory "${id}" is no longer in the repository.`,
            404,
          );
        const meta: MemoryMeta = { ...found.entry.meta };
        if (!firstMeta(meta, "id"))
          meta.id = [record.id.startsWith("h-") ? newEntryId() : record.id];
        newId = firstMeta(meta, "id")!;
        if (patch.kind) {
          if (patch.kind === "reference") delete meta.kind;
          else meta.kind = [patch.kind];
        }
        if (patch.expires === null) delete meta.expires;
        else if (patch.expires) meta.expires = [patch.expires];
        if (patch.tags) {
          if (patch.tags.length) meta.tags = [patch.tags.join(", ")];
          else delete meta.tags;
        }
        if (patch.confirmed === null) delete meta.confirmed;
        else if (patch.confirmed) meta.confirmed = [patch.confirmed];
        const noteLink = /\s*See \[\[[^\]]*notes\/[^\]]+\]\]\.?\s*$/.exec(
          found.entry.text,
        )?.[0];
        let text = patch.text?.replace(/\s+/g, " ").trim() || found.entry.text;
        if (patch.text && noteLink && !text.includes("[["))
          text = `${text.replace(/\s*$/, "")}${noteLink}`;
        if (text !== found.entry.text) meta.updated = [isoDay(new Date())];
        const line = renderEntry(text, meta, found.entry.marker);
        const location = locateScope(record.scopeKey)!;
        const pinnedFile = entryPointFor(location);
        const wantPinned = patch.pinned ?? found.entry.pinned;
        if (
          wantPinned !== found.entry.pinned ||
          (patch.pinned === true && found.path !== pinnedFile)
        ) {
          await work.write(
            found.path,
            replaceLine(found.file, found.entry.line, null),
          );
          const target = wantPinned
            ? pinnedFile
            : topicFileFor(location, firstMeta(meta, "kind") ?? "reference");
          await work.write(
            target,
            appendEntry(target, await work.read(target), line),
          );
          await this.ensureLinked(work, location, target);
        } else {
          await work.write(
            found.path,
            replaceLine(found.file, found.entry.line, line),
          );
        }
      },
      {
        message:
          message ??
          `Update memory: ${shortSubject(patch.text ?? record.summary)}`,
        author,
        trailers: [`Memory-Id: ${record.id}`],
      },
    );
    const updated = this.index.get(newId);
    if (!updated)
      throw new MemoryRepoError("The memory was saved but not indexed.", 500);
    return updated;
  }

  /** Remove entries (archive). History keeps them; the index marks them archived. */
  async removeEntries(
    ids: string[],
    author?: Author,
    reason = "Archive",
  ): Promise<MemoryRecord[]> {
    const records = ids.map((id) => {
      const record = this.index.get(id);
      if (!record)
        throw new MemoryRepoError(`No memory record with id "${id}".`, 404);
      return record;
    });
    const byRepo = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const name = this.repoForRecord(record);
      byRepo.set(name, [...(byRepo.get(name) ?? []), record]);
    }
    for (const [name, group] of byRepo) {
      await this.withWork(
        name,
        async (work) => {
          for (const record of group) {
            const found = await this.findEntry(work, record.id, record.path);
            if (!found) continue;
            await work.write(
              found.path,
              replaceLine(found.file, found.entry.line, null),
            );
            // A linked note only this entry used goes with it.
            for (const link of extractLinks(found.entry.text)) {
              const target = linkTargetPath(link);
              if (!target.includes("/notes/") && !target.startsWith("notes/"))
                continue;
              const users = await this.linkUsers(work, linkFor(target));
              if (users <= 0) await work.remove(target);
            }
          }
        },
        {
          message: `${reason}: ${shortSubject(group[0].summary)}${group.length > 1 ? ` (+${group.length - 1})` : ""}`,
          author,
          trailers: group.map((record) => `Memory-Id: ${record.id}`),
        },
      );
    }
    return ids
      .map((id) => this.index.get(id))
      .filter((r): r is MemoryRecord => !!r);
  }

  private async linkUsers(work: WorkContext, target: string): Promise<number> {
    let count = 0;
    for (const path of (await work.list()).filter(isMarkdownPath)) {
      const text = await work.read(path);
      if (text?.includes(`[[${target}]]`)) count++;
    }
    return count;
  }

  /** Put an archived entry back where it was. */
  async restoreEntry(id: string, author?: Author): Promise<MemoryRecord> {
    const record = this.index.get(id);
    if (!record)
      throw new MemoryRepoError(`No memory record with id "${id}".`, 404);
    if (record.state === "active") return record;
    const location = locateScope(record.scopeKey)!;
    await this.ensureRepo(location.repo);
    await this.withWork(
      location.repo,
      async (work) => {
        if (await this.findEntry(work, record.id, record.path)) return;
        const [text, details] = splitDetails(record);
        await this.placeEntry(work, {
          scopeKey: record.scopeKey,
          id: record.id.startsWith("h-") ? undefined : record.id,
          text,
          details,
          kind: record.kind,
          pinned: record.tier === "pinned",
          file:
            record.path && record.tier !== "pinned" ? record.path : undefined,
          ...this.provenance(record),
        });
      },
      {
        message: `Restore memory: ${shortSubject(record.summary)}`,
        author,
        trailers: [`Memory-Id: ${record.id}`],
      },
    );
    return this.index.get(id) ?? record;
  }

  /** Replace several entries with one. */
  async mergeEntries(
    ids: string[],
    input: EntryInput,
    author?: Author,
  ): Promise<MemoryRecord> {
    const location = locateScope(input.scopeKey);
    if (!location)
      throw new MemoryRepoError(`Invalid scope "${input.scopeKey}".`);
    const records = ids.map((id) => this.index.get(id));
    if (records.some((r) => !r || r.scopeKey !== input.scopeKey))
      throw new MemoryRepoError(
        "Every merged memory must exist in the selected scope.",
      );
    let newId = "";
    await this.withWork(
      location.repo,
      async (work) => {
        for (const record of records as MemoryRecord[]) {
          const found = await this.findEntry(work, record.id, record.path);
          if (found)
            await work.write(
              found.path,
              replaceLine(found.file, found.entry.line, null),
            );
        }
        newId = await this.placeEntry(work, { ...input, supersedes: ids });
      },
      {
        message: `Merge ${ids.length} memories: ${shortSubject(input.text)}`,
        author,
        trailers: ids.map((id) => `Memory-Id: ${id}`),
      },
    );
    const record = this.index.get(newId);
    if (!record)
      throw new MemoryRepoError("The memory was saved but not indexed.", 500);
    return record;
  }

  private provenance(record: MemoryRecord): Partial<EntryInput> {
    return {
      source:
        record.source.url ??
        (record.source.sessionId
          ? this.sessionLink(record.source.sessionId)
          : undefined),
      by: record.source.actor,
      via:
        record.source.type === "agent-verified"
          ? undefined
          : record.source.type,
      added: isoDay(record.createdAt),
      confirmed: record.lastConfirmedAt
        ? isoDay(record.lastConfirmedAt)
        : undefined,
      expires: record.expiresAt,
      tags: record.tags,
      supersedes: record.supersedes,
    };
  }

  // ── Session checkouts ───────────────────────────────────────────────

  /**
   * Give a session a normal git checkout of each repository under `root`.
   * New checkouts are cloned; existing clean ones pull so the session starts
   * each turn on the latest memory. A checkout with local changes or a
   * rebase in progress is left alone: the agent is mid-edit.
   */
  async ensureCheckouts(
    root: string,
    names: string[],
    ident: { sessionId: string; userName?: string; userEmail?: string },
  ): Promise<{ added: string[]; present: string[] }> {
    await mkdir(root, { recursive: true });
    const added: string[] = [];
    const env = isolatedGitEnv();
    for (const name of names) {
      if (!isValidRepoName(name) || !(await this.repoExists(name))) continue;
      const dir = join(root, name);
      if (!(await exists(join(dir, ".git")))) {
        await rm(dir, { recursive: true, force: true });
        await git(["clone", "--quiet", this.bareDir(name), dir], { env });
        const config: Array<[string, string]> = [
          ["push.pushOption", `session=${ident.sessionId}`],
          ["pull.rebase", "true"],
          ["rebase.autoStash", "false"],
          ["user.name", ident.userName || "Open Session agent"],
          ["user.email", ident.userEmail || SERVICE_AUTHOR.email],
        ];
        for (const [key, value] of config)
          await git(["config", key, value], { cwd: dir, env });
        added.push(name);
        continue;
      }
      const busy =
        (await exists(join(dir, ".git", "rebase-merge"))) ||
        (await exists(join(dir, ".git", "rebase-apply"))) ||
        (await exists(join(dir, ".git", "MERGE_HEAD")));
      if (busy) continue;
      const status = await git(["status", "--porcelain"], {
        cwd: dir,
        env,
        check: false,
      });
      if (status.code !== 0 || status.stdout.trim()) continue;
      await git(["pull", "--quiet", "--rebase", "origin", "main"], {
        cwd: dir,
        env,
        check: false,
        timeoutMs: 20_000,
      });
    }
    let present: string[] = [];
    try {
      present = [];
      for (const entry of await readdir(root)) {
        if (isValidRepoName(entry) && (await exists(join(root, entry, ".git"))))
          present.push(entry);
      }
    } catch {}
    return { added, present: present.sort() };
  }

  /**
   * The pinned region of each entry point, verbatim, for the session prompt
   * (what Devin "receives at the start of a session"). Paths that do not
   * exist are skipped.
   */
  async entryPoints(
    files: Array<{ repo: string; path: string }>,
  ): Promise<Array<{ repo: string; path: string; text: string }>> {
    const out: Array<{ repo: string; path: string; text: string }> = [];
    for (const file of files) {
      if (!(await this.head(file.repo))) continue;
      const text = await this.readFile(file.repo, file.path);
      if (text?.trim()) out.push({ ...file, text });
    }
    return out;
  }

  // ── History ─────────────────────────────────────────────────────────

  async pushLog(
    name: string,
  ): Promise<Map<string, { sessionId?: string; actor?: string }>> {
    return this.store.pushLog(name);
  }

  async history(
    name: string,
    opts: { limit?: number; grep?: string; path?: string } = {},
  ): Promise<HistoryCommit[]> {
    return this.store.history(name, opts);
  }

  async diff(name: string, sha: string): Promise<string> {
    return this.store.diff(name, sha);
  }

  async revert(
    name: string,
    sha: string,
    author?: Author,
  ): Promise<string | null> {
    return this.store.revert(name, sha, author);
  }

  /** Every file path at HEAD. */
  async listFiles(name: string): Promise<string[]> {
    return this.store.listFiles(name);
  }

  /**
   * Write (or with `content: null`, delete) one file as a commit, for runs
   * that cannot write a checkout themselves (ask-mode automations, Sandbox
   * sessions). The push is attributed to `session`.
   */
  async writeFile(
    name: string,
    path: string,
    content: string | null,
    opts: {
      message: string;
      author?: Author;
      session?: string;
      sessionLink?: string;
    },
  ): Promise<{ head: string | null }> {
    const clean = safePath(path);
    if (!(await this.repoExists(name)))
      throw new MemoryRepoError(`No memory repository "${name}".`, 404);
    const head = await this.withWork(
      name,
      async (work) => {
        if (content === null) {
          if ((await work.read(clean)) === undefined)
            throw new MemoryRepoError(`${clean} does not exist.`, 404);
          await work.remove(clean);
        } else {
          assertNoSecrets(content);
          await work.write(
            clean,
            content.endsWith("\n") ? content : `${content}\n`,
          );
        }
      },
      {
        message:
          opts.message.trim().split("\n")[0].slice(0, 120) || `Update ${clean}`,
        author: opts.author,
        session: opts.session,
        trailers: opts.sessionLink
          ? [`Session: ${opts.sessionLink}`]
          : undefined,
      },
    );
    return { head };
  }

  /** Read one file at HEAD (Settings file view). */
  async readFile(name: string, path: string): Promise<string | null> {
    return this.store.readFile(name, path);
  }

  // ── Remotes ─────────────────────────────────────────────────────────

  async remoteUrl(name: string): Promise<string | undefined> {
    const result = await git(
      [
        "--git-dir",
        this.bareDir(name),
        "config",
        "--get",
        "opensession.remote",
      ],
      { check: false },
    );
    return result.stdout.trim() || undefined;
  }

  remoteStatus(name: string): RemoteStatus {
    const raw = this.index.metadata(`remote:${name}`);
    try {
      return raw ? (JSON.parse(raw) as RemoteStatus) : {};
    } catch {
      return {};
    }
  }

  private setRemoteStatus(name: string, status: RemoteStatus) {
    this.index.setMetadata(`remote:${name}`, JSON.stringify(status));
  }

  async setRemote(name: string, url: string | null): Promise<RemoteStatus> {
    await this.ensureRepo(name);
    const bare = this.bareDir(name);
    if (!url) {
      await git(
        ["--git-dir", bare, "config", "--unset-all", "opensession.remote"],
        { check: false },
      );
      this.setRemoteStatus(name, {});
      return {};
    }
    const clean = url.trim();
    if (
      !/^(https:\/\/|ssh:\/\/|git@|\/|file:\/\/)/.test(clean) ||
      /\s/.test(clean)
    )
      throw new MemoryRepoError(
        "Use an https, ssh or git@ URL for the remote.",
      );
    if (/^https:\/\/[^/@\s]+:[^/@\s]+@/.test(clean))
      throw new MemoryRepoError("Do not put credentials in the remote URL.");
    await assertPrivateRemote(clean);
    await git(["--git-dir", bare, "config", "opensession.remote", clean]);
    this.setRemoteStatus(name, { url: clean });
    return this.syncRemote(name);
  }

  /**
   * Bring the canonical repository and its remote together without force:
   * fast-forward either side, merge when both moved, and record a conflict
   * for a person to resolve when the merge does not apply cleanly.
   */
  async syncRemote(name: string): Promise<RemoteStatus> {
    const url = await this.remoteUrl(name);
    if (!url) return {};
    try {
      await assertPrivateRemote(url);
    } catch (error) {
      const status = {
        url,
        lastSyncAt: new Date().toISOString(),
        ok: false,
        error: (error as Error).message,
      };
      this.setRemoteStatus(name, status);
      return status;
    }
    const env = isolatedGitEnv();
    const status: RemoteStatus = { url, lastSyncAt: new Date().toISOString() };
    try {
      await this.store.serial(name, async () => {
        const dir = await this.store.syncWork(name, env);
        await git(["remote", "remove", "upstream"], {
          cwd: dir,
          env,
          check: false,
        });
        await git(["remote", "add", "upstream", url], { cwd: dir, env });
        const fetched = await git(["fetch", "--quiet", "upstream"], {
          cwd: dir,
          env,
          check: false,
          timeoutMs: 120_000,
        });
        if (fetched.code !== 0)
          throw new MemoryRepoError(cleanHookOutput(fetched.stderr));
        const upstream = await git(
          ["rev-parse", "--verify", "--quiet", "refs/remotes/upstream/main"],
          { cwd: dir, env, check: false },
        );
        const local = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
          cwd: dir,
          env,
          check: false,
        });
        if (
          upstream.code === 0 &&
          local.code === 0 &&
          upstream.stdout.trim() !== local.stdout.trim()
        ) {
          const upstreamAhead =
            (
              await git(
                ["merge-base", "--is-ancestor", "HEAD", "upstream/main"],
                { cwd: dir, env, check: false },
              )
            ).code === 0;
          const localAhead =
            (
              await git(
                ["merge-base", "--is-ancestor", "upstream/main", "HEAD"],
                { cwd: dir, env, check: false },
              )
            ).code === 0;
          if (upstreamAhead) {
            await git(["merge", "--quiet", "--ff-only", "upstream/main"], {
              cwd: dir,
              env,
            });
          } else if (!localAhead) {
            const merged = await git(
              [
                "merge",
                "--no-edit",
                "--quiet",
                "upstream/main",
                "-m",
                `Merge memory from ${url}`,
              ],
              { cwd: dir, env, check: false },
            );
            if (merged.code !== 0) {
              const conflicted = await git(
                ["diff", "--name-only", "--diff-filter=U"],
                { cwd: dir, env, check: false },
              );
              await git(["merge", "--abort"], { cwd: dir, env, check: false });
              status.ok = false;
              status.conflict = {
                files: conflicted.stdout.split("\n").filter(Boolean),
                at: new Date().toISOString(),
              };
              status.error =
                "The remote and this server changed the same lines. Resolve the conflict in the remote, then sync again.";
              return;
            }
          }
          const pushLocal = await git(
            [
              "push",
              "--quiet",
              "-o",
              "actor=remote-sync",
              "origin",
              "HEAD:main",
            ],
            { cwd: dir, env, check: false },
          );
          if (pushLocal.code !== 0)
            throw new MemoryRepoError(cleanHookOutput(pushLocal.stderr));
        }
        if (local.code === 0 || upstream.code === 0) {
          const pushed = await git(
            ["push", "--quiet", "upstream", "HEAD:main"],
            { cwd: dir, env, check: false, timeoutMs: 120_000 },
          );
          if (pushed.code !== 0)
            throw new MemoryRepoError(cleanHookOutput(pushed.stderr));
        }
        status.ok = true;
      });
    } catch (error) {
      status.ok = false;
      status.error = error instanceof Error ? error.message : String(error);
    }
    this.setRemoteStatus(name, status);
    await this.refresh(name).catch(() => {});
    return status;
  }

  async syncAllRemotes(): Promise<void> {
    for (const name of await this.listRepos()) {
      if (await this.remoteUrl(name)) await this.syncRemote(name);
    }
  }

  // ── Migration from memory-v2 ────────────────────────────────────────

  /**
   * One-time import (repo mode) or one-way mirror (repo-mirror mode) from the
   * memory-v2 store at `v2Path`, with a parity report. The import is sealed
   * in the index so it runs once.
   */
  async migrateFromV2(
    v2Path: string,
    mode: "import" | "mirror",
  ): Promise<V2SyncResult | null> {
    if (mode === "import" && this.index.metadata("migrated-from-v2"))
      return null;
    if (!(await exists(v2Path))) {
      await this.ensureRepo(TEAM_REPO);
      if (mode === "import")
        this.index.setMetadata(
          "migrated-from-v2",
          JSON.stringify({ at: new Date().toISOString(), empty: true }),
        );
      return null;
    }
    await this.ensureRepo(TEAM_REPO);
    const result = await syncFromV2(this, v2Path, mode);
    this.index.setMetadata(
      mode === "import" ? "migrated-from-v2" : "mirror-parity",
      JSON.stringify({
        at: new Date().toISOString(),
        written: result.written,
        retired: result.retired,
        parity: {
          ...result.parity,
          missing: result.parity.missing.slice(0, 50),
          extra: result.parity.extra.slice(0, 50),
          tierMismatches: result.parity.tierMismatches.slice(0, 50),
        },
      }),
    );
    return result;
  }

  async parityReport(v2Path: string): Promise<ParityReport> {
    const v2 = new MemoryStore(v2Path);
    try {
      return parityWithV2(this, v2);
    } finally {
      v2.close();
    }
  }

  async rollbackIntoV2(v2Path: string) {
    return importIntoV2(this, v2Path);
  }

  /**
   * Write every memory-v2 record into the repositories. Active records become
   * entries; retired ones are carried into the index as archived so Settings
   * can still restore them. Idempotent: entries already present by id are
   * left alone.
   */
  async exportFromV2(
    records: MemoryRecord[],
    opts: { mirror?: boolean } = {},
  ): Promise<{ repos: string[]; written: number; retired: number }> {
    const byRepo = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const location = locateScope(record.scopeKey);
      if (!location) continue;
      byRepo.set(location.repo, [...(byRepo.get(location.repo) ?? []), record]);
    }
    let written = 0;
    let retiredCount = 0;
    for (const [name, group] of byRepo) {
      await this.ensureRepo(name);
      const active = group.filter(
        (record) => record.state === "active" || record.state === "expired",
      );
      const retired = group.filter(
        (record) => record.state !== "active" && record.state !== "expired",
      );
      await this.withWork(
        name,
        async (work) => {
          const existing = new Set<string>();
          for (const path of (await work.list()).filter(isMarkdownPath)) {
            const text = await work.read(path);
            if (!text) continue;
            for (const entry of parseMemoryFile(path, text).entries) {
              const id = firstMeta(entry.meta, "id");
              if (id) existing.add(id);
            }
          }
          if (opts.mirror) {
            // One-way mirror: v2 is the record. Retired or changed entries
            // leave the repository; changed ones are placed again below.
            const byId = new Map(group.map((record) => [record.id, record]));
            for (const id of [...existing]) {
              const record = byId.get(id);
              if (!record) continue;
              const found = await this.findEntry(work, id);
              if (!found) continue;
              const retiredNow =
                record.state !== "active" && record.state !== "expired";
              const pinnedNow = record.tier === "pinned";
              const kindNow =
                firstMeta(found.entry.meta, "kind") ?? "reference";
              const changed =
                found.entry.pinned !== pinnedNow ||
                kindNow !== record.kind ||
                !found.entry.text.startsWith(
                  record.summary.replace(/\s+/g, " ").trim().replace(/\]$/, ""),
                );
              if (retiredNow || changed) {
                await work.write(
                  found.path,
                  replaceLine(found.file, found.entry.line, null),
                );
                existing.delete(id);
              }
            }
          }
          const ordered = [...active].sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          );
          for (const record of ordered) {
            if (existing.has(record.id)) continue;
            const [text, details] = splitDetails(record);
            await this.placeEntry(work, {
              scopeKey: record.scopeKey,
              id: record.id,
              text,
              details,
              kind: record.kind,
              pinned: record.tier === "pinned",
              ...this.provenance(record),
            });
            written++;
          }
        },
        {
          message: opts.mirror
            ? "Mirror memory-v2"
            : `Import ${active.length} memories from memory-v2`,
        },
      );
      retiredCount += retired.length;
      await this.refresh(name, { force: true, retired });
    }
    return { repos: [...byRepo.keys()], written, retired: retiredCount };
  }
}

export interface ParityReport {
  v2Active: number;
  repoActive: number;
  missing: string[];
  extra: string[];
  tierMismatches: string[];
  ok: boolean;
}

function allRecords(store: MemoryStore, states: MemoryState[]): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = store.list({ states }, { cursor, limit: 100 });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export interface V2SyncResult {
  repos: string[];
  written: number;
  retired: number;
  parity: ParityReport;
}

/**
 * memory-v2 <-> repository migration, hosted on the service so it runs on
 * the memory worker (the v2 store is synchronous SQLite too).
 */
export async function syncFromV2(
  service: MemoryRepoService,
  v2Path: string,
  mode: "import" | "mirror",
): Promise<V2SyncResult> {
  const v2 = new MemoryStore(v2Path);
  try {
    v2.expireDue();
    const records = allRecords(v2, [
      "active",
      "expired",
      "archived",
      "superseded",
    ]);
    const result = await service.exportFromV2(records, {
      mirror: mode === "mirror",
    });
    return { ...result, parity: parityWithV2(service, v2) };
  } finally {
    v2.close();
  }
}

/** Same active ids, same tiers, in every scope v2 holds. */
export function parityWithV2(
  service: MemoryRepoService,
  v2: MemoryStore,
): ParityReport {
  const v2Active = allRecords(v2, ["active"]).filter((record) =>
    locateScope(record.scopeKey),
  );
  const scopes = [...new Set(v2Active.map((record) => record.scopeKey))];
  const repoActive = service.index.all(scopes, ["active"]);
  const repoById = new Map(repoActive.map((record) => [record.id, record]));
  const v2Ids = new Set(v2Active.map((record) => record.id));
  const missing = v2Active
    .filter((record) => !repoById.has(record.id))
    .map((record) => record.id);
  const extra = repoActive
    .filter((record) => !v2Ids.has(record.id) && !record.id.startsWith("f-"))
    .map((record) => record.id);
  const tierMismatches = v2Active
    .filter(
      (record) =>
        repoById.has(record.id) &&
        repoById.get(record.id)!.tier !== record.tier,
    )
    .map((record) => record.id);
  return {
    v2Active: v2Active.length,
    repoActive: repoActive.length,
    missing,
    extra,
    tierMismatches,
    ok: !missing.length && !tierMismatches.length,
  };
}

/**
 * Rollback: bring entries written in repo mode back into memory-v2, by id.
 * New entries are created, changed ones updated, removed ones archived.
 */
export function importIntoV2(
  service: MemoryRepoService,
  v2Path: string,
): { created: number; updated: number; archived: number } {
  const v2 = new MemoryStore(v2Path);
  let created = 0;
  let updated = 0;
  let archived = 0;
  try {
    const scopes = service.index.stats().scopes.map((scope) => scope.scopeKey);
    for (const record of service.index.all(scopes, ["active", "archived"])) {
      const current = v2.get(record.id);
      if (record.state === "archived") {
        if (current?.state === "active") {
          v2.archive(current.id);
          archived++;
        }
        continue;
      }
      const summary = record.summary
        .replace(/\s*See \[\[[^\]]*\]\]\.?/, "")
        .slice(0, 400);
      try {
        if (!current) {
          v2.create({
            id: record.id,
            scopeKey: record.scopeKey,
            summary,
            details: record.details,
            kind: record.kind,
            tier: record.tier,
            source: { ...record.source, url: undefined },
            createdAt: record.createdAt,
            lastConfirmedAt: record.lastConfirmedAt,
            expiresAt: record.expiresAt,
            tags: record.tags,
          });
          created++;
        } else if (
          current.state === "active" &&
          (current.summary !== summary ||
            current.tier !== record.tier ||
            current.kind !== record.kind)
        ) {
          v2.update(current.id, {
            summary,
            tier: record.tier,
            kind: record.kind,
          });
          updated++;
        }
      } catch (error) {
        console.warn(
          `[memory-repo] rollback skipped ${record.id}: ${(error as Error).message}`,
        );
      }
    }
  } finally {
    v2.close();
  }
  return { created, updated, archived };
}

function comparable(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim()
    .toLowerCase();
}

/** Details that add something to the entry text: details that only repeat it
 *  (legacy imports stored the fact in both) are dropped, and a repeated
 *  leading sentence is cut. */
export function distinctDetails(
  text: string,
  details: string | undefined,
): string | undefined {
  const trimmed = details?.trim();
  if (!trimmed) return undefined;
  const summary = comparable(text);
  const body = comparable(trimmed);
  if (!body || summary.includes(body)) return undefined;
  const head = text.replace(/[.\s]+$/, "").trim();
  if (body.startsWith(summary) && trimmed.startsWith(head))
    return (
      trimmed
        .slice(head.length)
        .replace(/^[.\s]+/, "")
        .trim() || undefined
    );
  return trimmed;
}

/** Summary and details of a record as entry text plus note body. */
function splitDetails(record: MemoryRecord): [string, string | undefined] {
  let details = record.details?.trim();
  if (!details) return [record.summary, undefined];
  // A detail read back from a note file starts with the note's title.
  if (details.startsWith("# "))
    details = details.replace(/^# .*\n+/, "").trim() || undefined;
  details = distinctDetails(record.summary, details);
  if (!details) return [record.summary, undefined];
  // Index records built from a repository carry the linked note as details;
  // the summary already links to it.
  if (/\[\[[^\]]+\]\]/.test(record.summary)) return [record.summary, undefined];
  return [record.summary, details];
}

export function shortSubject(text: string): string {
  const clean = text
    .replace(/\s*See \[\[[^\]]*\]\]\.?/g, "")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
}

/**
 * Refuse a GitHub remote that is public. Other hosts cannot be checked
 * without credentials, so they are allowed; the Settings copy says so.
 */
export async function assertPrivateRemote(url: string): Promise<void> {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return;
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${match[1]}/${match[2]}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "opensession-memory",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    return; // Offline: the next sync checks again.
  }
  if (response.status !== 200) return; // 404: private or missing, both fine.
  const body = (await response.json().catch(() => ({}))) as {
    private?: boolean;
  };
  if (body.private === false)
    throw new MemoryRepoError(
      `${match[1]}/${match[2]} is a public repository. Memory holds internal details; use a private repository.`,
    );
}

export async function appendPushLog(
  gitDir: string,
  row: Record<string, unknown>,
): Promise<void> {
  await appendFile(join(gitDir, PUSH_LOG), `${JSON.stringify(row)}\n`);
}

export { GitError };
