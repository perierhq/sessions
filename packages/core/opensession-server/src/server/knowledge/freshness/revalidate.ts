/**
 * One project's knowledge re-validation run: every item that isn't retired
 * is evaluated against today's change signals (evaluate.ts), and the run
 * writes what it found as one commit by "Pat".
 *
 *  - A stale item gets `status: needs-check` and a `check` note (reason,
 *    since today, the change that triggered it). Its body, trust and
 *    everything else stay as they are; an item already waiting for a check
 *    is left alone. An active item past its `reviewBy` is written to
 *    `needs-check` too, so the queue shows it.
 *  - Mirrors are refreshed, not flipped: a `sources/repo/*` item whose
 *    file changed is rewritten from the new default-branch head (or retired
 *    when the file is gone), a `sources/web/*` item whose page changed is
 *    rewritten with the new text and hash. The articles that depend on the
 *    same path or page are what flip.
 *
 * Runs on the gateway: signals are network and git reads; the knowledge
 * repository is reached through the worker client. Can't tell is never
 * "unchanged": when a signal fails (the code checkout is gone, GitHub
 * can't say whether an issue is open, a changed mirror can't be rewritten)
 * the item goes to `needs-check` with "Knowledge couldn't be checked" and
 * the failure is listed in `errors`. A page that is gone (404, 410) or no
 * longer on the allowed hosts is a change; a page unreadable for another
 * reason is not, until it has been unreadable for UNREADABLE_RUNS runs in
 * a row. A failed fetch of the code repository is listed in `errors`; once
 * the last good fetch is STALE_FETCH_MS old, repo-dependent items can't be
 * checked.
 *
 * Small server state per project (`revalidate:<project>` in the
 * `knowledge-jobs` catalog namespace): the last good fetch, each page's
 * unreadable-run count and the (item blob, release tag) pairs the release
 * check cleared, so a release isn't asked about again every day. At most
 * MAX_RELEASE_CALLS model calls a run; past that an item can't be checked.
 * Items already `needs-check` are not evaluated again (mirrors are: they
 * refresh whatever their status). Flips are written from the item's git
 * blob, never the index's copy of its text. A write that fails for any
 * reason but a conflict is retried once with only the flips.
 *
 * The daily run (scope "all") then runs the conflict check (conflicts.ts)
 * on the trusted items written since the last run's start, plus the ones
 * an earlier run couldn't finish, as its own commit. The mark (that start
 * and the unfinished paths) lives in the `knowledge-jobs` catalog namespace
 * under `conflicts:<project>`; it only moves when the check ran. Nothing
 * runs at import.
 */

import {
  effectiveStatus,
  KNOWLEDGE_COPY,
  type KnowledgeFrontMatter,
  type KnowledgeItem,
} from "../../../shared/knowledge";
import type { Author } from "../../memory-repo/git-store";
import { findSecrets } from "../../memory-repo/secrets";
import { knowledgeRepo } from "../client";
import type { KnowledgeChange } from "../service";
import type { ConflictVerdict } from "./conflicts";
import { MAX_ARTICLE_BYTES } from "../validate";
import { evaluateItem, type Signals } from "./evaluate";
import {
  defaultAskRelease,
  releaseChecker,
  type AskRelease,
} from "./release-check";
import {
  listReleases,
  refState,
  type GithubSignalDeps,
  type ReleaseInfo,
} from "./github";
import {
  commitAt,
  commitsSince,
  defaultHead,
  fetchDefaultBranch,
  latestChange,
  showAt,
  type RepoChangeDeps,
} from "./repo-changes";

/** Who ingestion and re-validation commit as. */
export const PAT_AUTHOR: Author = { name: "Pat" };
export const PAT_TRAILER = "Suggested-by: Pat";

export interface RevalidateResult {
  /** Items evaluated (everything not retired). */
  checked: number;
  flipped: Array<{ path: string; reason: string }>;
  /** Mirrors rewritten (or retired) from their changed source. */
  refreshed: number;
  /** Trusted pairs that disagree; both now need a check (conflicts.ts). */
  conflicts: Array<{ a: string; b: string }>;
  /** `<path>: <message>` per item a signal couldn't be read for. */
  errors: string[];
}

export interface RevalidateDeps extends Signals {
  /** Bring the code repository's default branch up to date. */
  fetchRepo(): Promise<boolean>;
  /** The fetched default-branch head; null when unknown. */
  head(): Promise<string | null>;
  /** A code repository file at a commit; null when it isn't a file. */
  showAt(sha: string, path: string): Promise<string | null>;
  /** A page's text and hash (web.ts fetchPage on the Support websites). */
  fetchPage(
    url: string,
  ): Promise<
    | { url: string; title?: string; text: string; hash: string }
    | { error: string }
  >;
  /** Passed to the repo-changes defaults (tests point them at a tmp repo). */
  repoChanges: Partial<RepoChangeDeps>;
  /** Passed to the github defaults. */
  github: Partial<GithubSignalDeps>;
  /** The conflict check's model call (conflicts.ts default when unset). */
  classifyConflict?(a: string, b: string): Promise<ConflictVerdict | null>;
  /** Where the last conflict check started and what it left unfinished. */
  conflictMarks: {
    load(): Promise<ConflictMark | null>;
    save(mark: ConflictMark): Promise<void>;
  };
  /** The run state kept between runs (RevalidateState). */
  state: {
    load(): Promise<RevalidateState | null>;
    save(state: RevalidateState): Promise<void>;
  };
  /** The release check's model call (release-check.ts default when unset). */
  askRelease?: AskRelease;
  /** The knowledge write (knowledgeRepo "write" when unset). */
  write?(
    project: string,
    changes: KnowledgeChange[],
    opts: {
      message: string;
      author: Author;
      trailers: string[];
      expected: Record<string, string>;
    },
  ): Promise<unknown>;
  /** Milliseconds since the epoch (Date.now when unset). */
  now?(): number;
}

type WriteOptions = Parameters<NonNullable<RevalidateDeps["write"]>>[2];

/** What a project's runs remember between them. */
export interface RevalidateState {
  /** The last successful fetch of the code repository, ISO time. */
  fetchedAt?: string;
  /** Runs in a row each page couldn't be read (not gone, just unreadable). */
  unreadable: Record<string, number>;
  /** `<item blob>@<release tag>` pairs the release check cleared. */
  releaseClears: string[];
}

/** The last conflict check: its start (ISO time) and the paths it didn't
 *  finish. */
export interface ConflictMark {
  at: string;
  pending: string[];
}

function conflictMarkStore(project: string): RevalidateDeps["conflictMarks"] {
  const key = `conflicts:${project}`;
  const docs = async () =>
    (await import("../../catalog-documents")).catalogDocuments(
      "knowledge-jobs",
    );
  return {
    async load() {
      const value = (await (await docs()).get(key)) as ConflictMark | null;
      if (
        !value ||
        typeof value.at !== "string" ||
        !Array.isArray(value.pending)
      )
        return null;
      return {
        at: value.at,
        pending: value.pending.filter((p) => typeof p === "string"),
      };
    },
    async save(mark) {
      await (await docs()).set(key, mark);
    },
  };
}

function runStateStore(project: string): RevalidateDeps["state"] {
  const key = `revalidate:${project}`;
  const docs = async () =>
    (await import("../../catalog-documents")).catalogDocuments(
      "knowledge-jobs",
    );
  return {
    async load() {
      return readState(await (await docs()).get(key));
    },
    async save(state) {
      await (await docs()).set(key, state);
    },
  };
}

/** A stored state, with anything malformed dropped. */
function readState(value: unknown): RevalidateState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const unreadable: Record<string, number> = {};
  if (raw.unreadable && typeof raw.unreadable === "object")
    for (const [url, n] of Object.entries(raw.unreadable))
      if (Number.isSafeInteger(n) && (n as number) > 0)
        unreadable[url] = n as number;
  return {
    ...(typeof raw.fetchedAt === "string" &&
    Number.isFinite(Date.parse(raw.fetchedAt))
      ? { fetchedAt: raw.fetchedAt }
      : {}),
    unreadable,
    releaseClears: Array.isArray(raw.releaseClears)
      ? raw.releaseClears.filter((c): c is string => typeof c === "string")
      : [],
  };
}

const PAGE_SIZE = 200;
/** Runs in a row a page may be unreadable before its items need a check. */
export const UNREADABLE_RUNS = 3;
/** How old the last good fetch may be before repo checks can't be trusted. */
export const STALE_FETCH_MS = 3 * 86_400_000;
/** Cleared (blob, release) pairs kept; the oldest go first. */
const MAX_RELEASE_CLEARS = 5000;
const MAX_LIST_RESTARTS = 3;
/** A fetchPage error that means the page is gone or no longer allowed. */
const GONE =
  /^(The page answered (404|410)\b|Not an https page of the project's websites|Redirected off the project's)/;
const SHA = /^[0-9a-f]{7,64}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WRITE_ATTEMPTS = 2;

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Default signals ────────────────────────────────────────────────────

async function defaultRepoCommits(
  project: string,
  paths: string[],
  since: string,
  repo: Partial<RepoChangeDeps>,
) {
  // Only whether there is a change matters: the newest is enough.
  const one = { ...repo, limits: { ...repo.limits, commits: 1 } };
  if (SHA.test(since)) return commitsSince(project, since, paths, one);
  if (!DAY.test(since)) throw new Error(`Not a commit or a day: ${since}`);
  // A commit's date is its committer date, not when it landed: commits from
  // two days before the validAsOf day on count. Nothing that old: any
  // commit touching the paths is newer.
  const from = new Date(Date.parse(`${since}T00:00:00Z`) - 2 * 86_400_000);
  const base = await commitAt(project, from.toISOString(), repo);
  if (base) return commitsSince(project, base, paths, one);
  const latest = await latestChange(project, paths, repo);
  return latest ? [latest] : [];
}

/** What one run tracks beyond the stored state. */
interface RunContext {
  state: RevalidateState;
  /** Whether this run's fetch succeeded. */
  fetched: boolean;
  now: number;
  /** Pages asked about this run (their counts are kept). */
  pagesSeen: Set<string>;
  /** `<item blob>@<release tag>` pairs cleared, stored ones included. */
  clears: Set<string>;
}

function bindDeps(
  project: string,
  today: string,
  over: Partial<RevalidateDeps>,
  scope: "all" | "repo",
  run: RunContext,
): RevalidateDeps {
  const repo = over.repoChanges ?? {};
  const github = over.github ?? {};
  // One fetch per page per run: the hash check and the mirror rewrite share
  // it.
  const pages = new Map<string, ReturnType<RevalidateDeps["fetchPage"]>>();
  let hosts: Promise<string[]> | null = null;
  const fetchPage =
    over.fetchPage ??
    ((url: string) => {
      let page = pages.get(url);
      if (!page) {
        hosts ??= import("../../projects/effective").then(
          async ({ roleWebAccess }) =>
            (await roleWebAccess(project, "support")).websites,
        );
        page = hosts.then(async (list) =>
          (await import("./web")).fetchPage(url, list),
        );
        pages.set(url, page);
      }
      return page;
    });
  // One answer per (since, paths) a run: many items share a dependency.
  const commits = new Map<string, ReturnType<Signals["repoCommits"]>>();
  const repoCommits =
    over.repoCommits ??
    ((paths: string[], since: string) =>
      defaultRepoCommits(project, paths, since, repo));
  const deps: RevalidateDeps = {
    today,
    repoChanges: repo,
    github,
    fetchRepo: over.fetchRepo ?? (() => fetchDefaultBranch(project, repo)),
    head: over.head ?? (() => defaultHead(project, repo)),
    showAt: over.showAt ?? ((sha, path) => showAt(project, sha, path, repo)),
    fetchPage,
    classifyConflict: over.classifyConflict,
    conflictMarks: over.conflictMarks ?? conflictMarkStore(project),
    state: over.state ?? runStateStore(project),
    write: over.write,
    now: over.now,
    repoCommits: async (paths, since) => {
      const key = JSON.stringify([since, paths]);
      let answer = commits.get(key);
      if (!answer) {
        answer = repoCommits(paths, since);
        commits.set(key, answer);
      }
      const found = await answer;
      // A specific failure (no checkout) wins over a stale fetch.
      assertFetched(run);
      return found;
    },
    pageHash:
      over.pageHash ??
      (async (url) => {
        const page = await fetchPage(url);
        const first = !run.pagesSeen.has(url);
        run.pagesSeen.add(url);
        if (!("error" in page)) {
          delete run.state.unreadable[url];
          return page.hash;
        }
        if (GONE.test(page.error)) {
          delete run.state.unreadable[url];
          return { gone: page.error };
        }
        if (first)
          run.state.unreadable[url] = (run.state.unreadable[url] ?? 0) + 1;
        const n = run.state.unreadable[url] ?? 0;
        if (n >= UNREADABLE_RUNS)
          throw new Error(
            `${url} couldn't be read for ${n} runs: ${page.error}`,
          );
        return null;
      }),
    releasesSince:
      over.releasesSince ??
      (async (at) =>
        // null only when the project has no GitHub repository; a list
        // that can't be read throws (GithubReadError), never [].
        ((await listReleases(project, github)) ?? []).filter((r) => r.at > at)),
    releaseMentions:
      over.releaseMentions ??
      releaseChecker({
        ask: over.askRelease ?? defaultAskRelease,
        clears: run.clears,
      }),
    refState:
      over.refState ??
      (async (ref) => {
        const state = await refState(project, ref, github);
        // Unreadable (no GitHub repository, GitHub down): can't tell.
        if (!state)
          throw new Error(
            `${ref.type === "pr" ? "Pull request" : "Issue"} #${ref.number} couldn't be read`,
          );
        return state;
      }),
  };
  if (scope === "repo") {
    // After a push: only the code repository moved.
    deps.pageHash = async () => null;
    deps.releasesSince = async () => [];
    deps.refState = async () => null;
  }
  return deps;
}

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Throws when this run's fetch failed and the last good one is too old to
 *  check against. */
function assertFetched(run: RunContext): void {
  if (run.fetched) return;
  const at = run.state.fetchedAt;
  if (!at) throw new Error("The code repository hasn't been fetched yet");
  if (run.now - Date.parse(at) >= STALE_FETCH_MS)
    throw new Error(
      `The code repository hasn't been fetched since ${utcDay(at)}`,
    );
}

// ── The run ────────────────────────────────────────────────────────────

/** The front matter of an indexed item, without the index's fields. */
export function frontMatterOf(item: KnowledgeItem): KnowledgeFrontMatter {
  const fm: KnowledgeFrontMatter = {
    title: item.title,
    kind: item.kind,
    trust: item.trust,
    status: item.status,
    origin: item.origin,
    topics: item.topics,
    sources: item.sources,
    dependsOn: item.dependsOn,
    validAsOf: item.validAsOf,
  };
  if (item.validAsOfCommit) fm.validAsOfCommit = item.validAsOfCommit;
  if (item.reviewBy) fm.reviewBy = item.reviewBy;
  if (item.check) fm.check = item.check;
  if (item.suggestedBy) fm.suggestedBy = item.suggestedBy;
  if (item.approvedBy) fm.approvedBy = item.approvedBy;
  if (item.answeredAt) fm.answeredAt = item.answeredAt;
  return fm;
}

/** `sources` with the entry for `prefix` (e.g. `repo:docs/a.md@`) replaced
 *  by `entry` (added when there was none). */
function replaceSource(
  sources: string[],
  matches: (source: string) => boolean,
  entry: string,
): string[] {
  const kept = sources.filter((s) => !matches(s));
  return kept.length === sources.length
    ? [...sources, entry]
    : [entry, ...kept];
}

/** Refuse a rewrite the repository would refuse, so one bad mirror can't
 *  sink the run's commit. */
function checkedPut(
  path: string,
  fm: KnowledgeFrontMatter,
  body: string,
): KnowledgeChange {
  if (new TextEncoder().encode(body).length > MAX_ARTICLE_BYTES - 4096)
    throw new Error("The new text is too large to store.");
  if (findSecrets(`${fm.title}\n${body}`).length)
    throw new Error("The new text looks like it holds a credential.");
  return { op: "put", path, fm, body };
}

/** Every item of the index at one head, by path. Restarts when the head
 *  moves between pages; reads until it has `total` items. */
async function listItems(
  project: string,
  today: string,
): Promise<KnowledgeItem[]> {
  for (let attempt = 0; attempt <= MAX_LIST_RESTARTS; attempt++) {
    const items = new Map<string, KnowledgeItem>();
    let head: string | null = null;
    let moved = false;
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await knowledgeRepo.call("index.list", project, "all", {
        today,
        limit: PAGE_SIZE,
        offset,
      });
      for (const item of page.items) {
        head ??= item.commit;
        if (item.commit !== head) moved = true;
        items.set(item.path, item);
      }
      if (moved) break;
      if (!page.items.length || items.size >= page.total)
        return [...items.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    }
  }
  throw new Error("The knowledge index kept changing while it was listed.");
}

interface Planned {
  changes: KnowledgeChange[];
  expected: Record<string, string>;
  /** Paths of the changes that are flips (not mirror refreshes). */
  flips: Set<string>;
  /** Whether any item read the code repository. */
  usedRepo: boolean;
  result: RevalidateResult;
}

/** The path in a mirror's own `repo:<path>@<sha>` (or `repo:<path>`)
 *  source; null when it has none. */
function mirrorRepoPath(item: KnowledgeItem): string | null {
  for (const source of item.sources) {
    if (!source.startsWith("repo:")) continue;
    const raw = source.slice("repo:".length);
    const at = raw.lastIndexOf("@");
    return at > 0 && SHA.test(raw.slice(at + 1)) ? raw.slice(0, at) : raw;
  }
  return null;
}

/** The URL in a mirror's own `url:<url>#sha256=<hex>` source. */
function mirrorUrl(item: KnowledgeItem): string | null {
  for (const source of item.sources) {
    if (!source.startsWith("url:")) continue;
    const mark = source.lastIndexOf("#sha256=");
    return source.slice("url:".length, mark < 0 ? undefined : mark);
  }
  return null;
}

/** The refresh for a stale mirror whose own source changed; null when the
 *  change is something else (the mirror then flips like an article). */
function mirrorRefresh(
  item: KnowledgeItem,
  source: string,
):
  | ((
      item: KnowledgeItem,
      body: string,
      source: string,
      d: RevalidateDeps,
    ) => Promise<KnowledgeChange>)
  | null {
  if (item.origin === "repo" && source.startsWith("repo:")) {
    const own = mirrorRepoPath(item);
    const at = source.lastIndexOf("@");
    const changed = source.slice("repo:".length, at < 0 ? undefined : at);
    return own !== null && own === changed ? refreshRepoMirror : null;
  }
  if (item.origin === "web" && source.startsWith("url:")) {
    const own = mirrorUrl(item);
    return own !== null && source.startsWith(`url:${own}#sha256=`)
      ? refreshWebMirror
      : null;
  }
  return null;
}

async function refreshRepoMirror(
  item: KnowledgeItem,
  body: string,
  source: string,
  d: RevalidateDeps,
): Promise<KnowledgeChange> {
  const path = source.slice("repo:".length, source.lastIndexOf("@"));
  const head = await d.head();
  if (!head) throw new Error("The code repository's head is unknown.");
  const text = await d.showAt(head, path);
  const fm = frontMatterOf(item);
  if (text === null) {
    // The file is gone: the mirror is retired, its text kept.
    const { check: _check, ...rest } = fm;
    return {
      op: "put",
      path: item.path,
      fm: { ...rest, status: "retired" },
      body,
    };
  }
  return checkedPut(
    item.path,
    {
      ...fm,
      validAsOf: d.today,
      validAsOfCommit: head,
      sources: replaceSource(
        fm.sources,
        (s) => s.startsWith(`repo:${path}@`) || s === `repo:${path}`,
        `repo:${path}@${head}`,
      ),
    },
    text,
  );
}

async function refreshWebMirror(
  item: KnowledgeItem,
  _body: string,
  source: string,
  d: RevalidateDeps,
): Promise<KnowledgeChange> {
  const url = source.slice("url:".length, source.lastIndexOf("#sha256="));
  const page = await d.fetchPage(url);
  if ("error" in page) throw new Error(page.error);
  const fm = frontMatterOf(item);
  return checkedPut(
    item.path,
    {
      ...fm,
      validAsOf: d.today,
      sources: replaceSource(
        fm.sources,
        (s) => s === `url:${url}` || s.startsWith(`url:${url}#sha256=`),
        `url:${url}#sha256=${page.hash}`,
      ),
    },
    page.text,
  );
}

async function plan(project: string, d: RevalidateDeps): Promise<Planned> {
  const result: RevalidateResult = {
    checked: 0,
    flipped: [],
    refreshed: 0,
    conflicts: [],
    errors: [],
  };
  const changes: KnowledgeChange[] = [];
  const expected: Record<string, string> = {};
  const flips = new Set<string>();
  let usedRepo = false;
  for (const item of await listItems(project, d.today)) {
    if (effectiveStatus(item, d.today) === "retired") continue;
    // Already waiting for a person: one note is enough. Mirrors still
    // refresh whatever their status.
    const mirror = item.origin === "repo" || item.origin === "web";
    if (item.status === "needs-check" && !mirror) continue;
    result.checked++;
    if (item.dependsOn.some((dep) => dep.startsWith("repo:"))) usedRepo = true;
    // The text as committed, never the index's copy of it.
    let body: string;
    try {
      const read = await knowledgeRepo.call(
        "readAt",
        project,
        item.path,
        item.commit,
      );
      if (!read || read.blob !== item.blob)
        throw new Error("The item couldn't be read as indexed.");
      body = read.body;
    } catch (error) {
      result.errors.push(`${item.path}: ${message(error)}`);
      continue;
    }
    const flip = (reason: string, source?: string): void => {
      if (item.status === "needs-check") return;
      changes.push({
        op: "put",
        path: item.path,
        fm: {
          ...frontMatterOf(item),
          status: "needs-check",
          check: { reason, since: d.today, ...(source ? { source } : {}) },
        },
        body,
      });
      expected[item.path] = item.blob;
      flips.add(item.path);
      result.flipped.push({ path: item.path, reason });
    };
    try {
      const verdict = await evaluateItem(item, body, d);
      if (!verdict.stale) continue;
      const refresh = mirrorRefresh(item, verdict.source ?? "");
      if (!refresh) {
        flip(verdict.reason, verdict.source);
        continue;
      }
      changes.push(await refresh(item, body, verdict.source!, d));
      expected[item.path] = item.blob;
      result.refreshed++;
    } catch (error) {
      // Can't tell is never "unchanged": a person looks.
      result.errors.push(`${item.path}: ${message(error)}`);
      flip(KNOWLEDGE_COPY.unchecked);
    }
  }
  return { changes, expected, flips, usedRepo, result };
}

/**
 * Re-validate one project's knowledge and commit what changed. `scope:
 * "repo"` (after a push to the default branch) only reads the code
 * repository; the daily run reads everything.
 */
export async function revalidateProject(
  project: string,
  opts: { scope?: "all" | "repo"; deps?: Partial<RevalidateDeps> } = {},
): Promise<RevalidateResult> {
  const today = opts.deps?.today ?? utcToday();
  const empty: RevalidateResult = {
    checked: 0,
    flipped: [],
    refreshed: 0,
    conflicts: [],
    errors: [],
  };
  if (!(await knowledgeRepo.call("hasRepo", project))) return empty;
  const scope = opts.scope ?? "all";
  const over = opts.deps ?? {};
  const store = over.state ?? runStateStore(project);
  const stateErrors: string[] = [];
  let stored: RevalidateState | null = null;
  try {
    stored = await store.load();
  } catch (error) {
    stateErrors.push(`Run state: ${message(error)}`);
  }
  const state: RevalidateState = stored ?? {
    unreadable: {},
    releaseClears: [],
  };
  const run: RunContext = {
    state,
    fetched: false,
    now: (over.now ?? Date.now)(),
    pagesSeen: new Set(),
    clears: new Set(state.releaseClears),
  };
  const d = bindDeps(project, today, { ...over, state: store }, scope, run);
  // A failed fetch leaves the last fetched state, which is still checked
  // until it is STALE_FETCH_MS old (assertFetched).
  run.fetched = await d.fetchRepo().catch(() => false);
  if (run.fetched) state.fetchedAt = new Date(run.now).toISOString();
  const result = await revalidateItems(project, d, empty, run);
  result.errors.unshift(...stateErrors);
  if (scope !== "repo") await runConflictCheck(project, d, result);

  if (scope === "all")
    // Pages no item asks about any more are forgotten.
    for (const url of Object.keys(state.unreadable))
      if (!run.pagesSeen.has(url)) delete state.unreadable[url];
  state.releaseClears = [...run.clears].slice(-MAX_RELEASE_CLEARS);
  try {
    await store.save(state);
  } catch (error) {
    result.errors.push(`Run state: ${message(error)}`);
  }
  return result;
}

/**
 * The conflict check of a daily run: trusted, not retired items written
 * since the last check started, plus what it left unfinished. Adds the
 * pairs to `result.conflicts` (and their flips to `result.flipped`); a
 * failure lands in `result.errors` and keeps every path for the next run.
 */
async function runConflictCheck(
  project: string,
  d: RevalidateDeps,
  result: RevalidateResult,
): Promise<void> {
  const start = new Date().toISOString();
  let mark: ConflictMark | null;
  try {
    mark = await d.conflictMarks.load();
  } catch (error) {
    result.errors.push(`Conflict check: ${message(error)}`);
    return;
  }
  const since = mark ? Date.parse(mark.at) : Number.NEGATIVE_INFINITY;
  const pending = new Set(mark?.pending ?? []);
  let paths: string[];
  const titles = new Map<string, string>();
  try {
    const items = await listItems(project, d.today);
    for (const item of items) titles.set(item.path, item.title);
    paths = items
      .filter(
        (item) =>
          item.trust === "trusted" &&
          effectiveStatus(item, d.today) !== "retired" &&
          (pending.has(item.path) || !(Date.parse(item.updatedAt) <= since)),
      )
      // Unfinished first, then the newest.
      .sort(
        (x, y) =>
          Number(pending.has(y.path)) - Number(pending.has(x.path)) ||
          (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0),
      )
      .map((item) => item.path);
  } catch (error) {
    result.errors.push(`Conflict check: ${message(error)}`);
    return;
  }
  const unchecked: string[] = [];
  if (paths.length) {
    const { checkConflicts } = await import("./conflicts");
    try {
      const pairs = await checkConflicts(project, paths, {
        classify: d.classifyConflict,
        today: d.today,
        onUnchecked: (path) => unchecked.push(path),
      });
      result.conflicts.push(...pairs);
      const flipped = new Set(result.flipped.map((f) => f.path));
      for (const { a, b } of pairs) {
        for (const [path, other] of [
          [a, b],
          [b, a],
        ] as const) {
          if (flipped.has(path)) continue;
          flipped.add(path);
          result.flipped.push({
            path,
            reason: `Disagrees with ${titles.get(other) ?? other}`,
          });
        }
      }
    } catch (error) {
      result.errors.push(`Conflict check: ${message(error)}`);
      unchecked.splice(0, unchecked.length, ...paths);
    }
  }
  try {
    await d.conflictMarks.save({ at: start, pending: unchecked });
  } catch (error) {
    result.errors.push(`Conflict check: ${message(error)}`);
  }
}

/** Evaluate every item and write the flips and refreshes as one commit.
 *  A conflict plans again; any other failure retries once with only the
 *  flips, so a bad mirror rewrite can't keep items from a person. */
async function revalidateItems(
  project: string,
  d: RevalidateDeps,
  empty: RevalidateResult,
  run: RunContext,
): Promise<RevalidateResult> {
  const write =
    d.write ??
    ((p: string, changes: KnowledgeChange[], opts: WriteOptions) =>
      knowledgeRepo.call("write", p, changes, opts));
  const commit = (
    changes: KnowledgeChange[],
    expected: Record<string, string>,
    flipped: number,
    refreshed: number,
  ) =>
    write(project, changes, {
      message: `Knowledge check: ${flipped} need a check, ${refreshed} refreshed`,
      author: PAT_AUTHOR,
      trailers: [PAT_TRAILER],
      expected,
    });
  for (let attempt = 1; ; attempt++) {
    const { changes, expected, flips, usedRepo, result } = await plan(
      project,
      d,
    );
    if (usedRepo && !run.fetched)
      result.errors.unshift(
        run.state.fetchedAt &&
          run.now - Date.parse(run.state.fetchedAt) < STALE_FETCH_MS
          ? `The code repository couldn't be fetched; checked against what was fetched on ${utcDay(run.state.fetchedAt)}`
          : "The code repository couldn't be fetched",
      );
    if (!changes.length) return result;
    try {
      await commit(changes, expected, result.flipped.length, result.refreshed);
      return result;
    } catch (error) {
      // Someone edited an item meanwhile: plan again from what is there now.
      const conflict =
        error instanceof Error && error.name === "KnowledgeConflictError";
      if (conflict && attempt < MAX_WRITE_ATTEMPTS) continue;
      const onlyFlips = changes.filter(
        (c) => c.op === "put" && flips.has(c.path),
      );
      if (!conflict && onlyFlips.length && onlyFlips.length < changes.length) {
        try {
          await commit(
            onlyFlips,
            Object.fromEntries(
              [...flips].map((path) => [path, expected[path]!]),
            ),
            result.flipped.length,
            0,
          );
          return {
            ...result,
            refreshed: 0,
            errors: [
              ...result.errors,
              `Writing the refreshed mirrors failed: ${message(error)}`,
            ],
          };
        } catch {
          // Fall through: nothing was written.
        }
      }
      return {
        ...empty,
        checked: result.checked,
        errors: [
          ...result.errors,
          `Writing the check failed: ${message(error)}`,
        ],
      };
    }
  }
}
