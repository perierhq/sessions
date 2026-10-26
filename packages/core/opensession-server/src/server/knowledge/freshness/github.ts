/**
 * The GitHub signals of knowledge freshness: the project's releases (a new
 * release makes older mail history reference, a release note is a source),
 * whether an issue or pull request an item depends on is still open, and
 * the open `bug` issues imported as known problems.
 *
 * Read through the GitHub App (agents/github/github-rest.ts githubRequest,
 * `mint: "read"`) in the project's `ghRepo`. Answers are kept in memory for
 * 10 minutes per request, so a re-validation run over many items costs one
 * request per release list or issue. `{ fresh: true }` skips the cached
 * answer (and stores the new one). The cache holds at most
 * GITHUB_SIGNAL_CACHE_SIZE answers and drops the least recently used.
 * Failures are not cached.
 *
 * Releases fail closed: listReleases and latestRelease THROW
 * GithubReadError when the project has a GitHub repository but the list
 * couldn't be read (GitHub down, the App not installed, an odd answer).
 * null means only "no GitHub repository", and [] / null-latest only "no
 * releases", so a caller can never mistake an outage for "nothing was
 * released". refState and openBugIssues still read a failure as null
 * ("couldn't tell"); their callers decide what null means. Nothing runs at
 * import: the cache is an empty Map and the request is imported lazily.
 */

export interface ReleaseInfo {
  tag: string;
  name: string;
  /** Published (or, failing that, created) time, ISO 8601. */
  at: string;
  body: string;
}

export interface KnownProblem {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

/** openBugIssues' answer. `truncated`: the last page read (page
 *  OPEN_BUG_PAGES) was full, so there may be more that were not read. */
export type KnownProblems = KnownProblem[] & { truncated: boolean };

export interface GithubSignalDeps {
  /** The project's GitHub `owner/name`; null when it has none. */
  ghRepo(project: string): string | null;
  /** GET `path` from the GitHub REST API with a read token. */
  request(
    path: string,
  ): Promise<{ ok: boolean; status: number; data: unknown }>;
  now(): number;
}

/** Deps, plus `fresh: true` to skip the cached answer. */
export type GithubReadOptions = Partial<GithubSignalDeps> & {
  fresh?: boolean;
};

export const GITHUB_SIGNAL_TTL_MS = 10 * 60_000;
/** Most answers kept; past it the least recently used goes. */
export const GITHUB_SIGNAL_CACHE_SIZE = 500;
/** Most pages of 100 open bug issues read. */
export const OPEN_BUG_PAGES = 10;
const PER_PAGE = 100;

/** A GitHub read failed for a project that has a GitHub repository. */
export class GithubReadError extends Error {
  override name = "GithubReadError";
}
/** `owner/name`, neither part only dots (`..` would climb the API path). */
const OWNER_NAME = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/** Insertion order is recency order: a hit is moved to the end. */
const cache = new Map<string, { at: number; data: unknown }>();

/** Forget every cached answer (tests). */
export function __clearGithubSignalCacheForTest(): void {
  cache.clear();
}

async function defaultGhRepo(project: string): Promise<string | null> {
  const { configuredRepos } = await import("../../config");
  const repo = configuredRepos()[project];
  if (!repo || (repo.host && repo.host !== "github")) return null;
  return repo.ghRepo || null;
}

async function defaultRequest(
  path: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const { githubRequest } = await import("../../../agents/github/github-rest");
  return githubRequest("GET", path, undefined, { mint: "read" });
}

async function ghRepoOf(
  project: string,
  deps: GithubReadOptions,
): Promise<string | null> {
  const ghRepo = deps.ghRepo
    ? deps.ghRepo(project)
    : await defaultGhRepo(project);
  if (!ghRepo) return null;
  // A configured name that isn't `owner/name` is a repository we can't
  // read, not "no repository".
  if (!OWNER_NAME.test(ghRepo))
    throw new GithubReadError(`${project}'s GitHub repository name is invalid`);
  return ghRepo;
}

/** ghRepoOf, with an invalid name read as null (refState, openBugIssues:
 *  their null already means "couldn't tell"). */
async function ghRepoOrNull(
  project: string,
  deps: GithubReadOptions,
): Promise<string | null> {
  try {
    return await ghRepoOf(project, deps);
  } catch {
    return null;
  }
}

/** The answer to `GET path`, from the cache when it is fresh (and not
 *  `fresh`); throws GithubReadError when GitHub didn't answer with
 *  success. */
async function cachedGetOrThrow(
  path: string,
  what: string,
  deps: GithubReadOptions,
): Promise<unknown> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(path);
  if (hit && !deps.fresh && now - hit.at < GITHUB_SIGNAL_TTL_MS) {
    cache.delete(path);
    cache.set(path, hit);
    return hit.data;
  }
  let result: { ok: boolean; status: number; data: unknown };
  try {
    result = await (deps.request ?? defaultRequest)(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[knowledge] GitHub read failed: ${detail}`);
    throw new GithubReadError(`${what} couldn't be read: ${detail}`);
  }
  if (!result.ok || result.data === null || result.data === undefined)
    throw new GithubReadError(`${what} couldn't be read (${result.status})`);
  cache.delete(path);
  if (cache.size >= GITHUB_SIGNAL_CACHE_SIZE)
    for (const [key, entry] of cache)
      if (now - entry.at >= GITHUB_SIGNAL_TTL_MS) cache.delete(key);
  while (cache.size >= GITHUB_SIGNAL_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(path, { at: now, data: result.data });
  return result.data;
}

/** cachedGetOrThrow, with a failure read as null ("couldn't tell"). */
async function cachedGet(
  path: string,
  deps: GithubReadOptions,
): Promise<unknown> {
  try {
    return await cachedGetOrThrow(path, path, deps);
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isoTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** The project's releases, newest first, drafts left out; null only when
 *  it has no GitHub repository, [] when it has no releases. Throws
 *  GithubReadError when the repository's list can't be read. */
export async function listReleases(
  project: string,
  deps: GithubReadOptions = {},
): Promise<ReleaseInfo[] | null> {
  const ghRepo = await ghRepoOf(project, deps);
  if (!ghRepo) return null;
  const what = `${ghRepo}'s releases`;
  const data = await cachedGetOrThrow(
    `/repos/${ghRepo}/releases?per_page=100`,
    what,
    deps,
  );
  if (!Array.isArray(data))
    throw new GithubReadError(`${what} couldn't be read (not a list)`);
  const releases: ReleaseInfo[] = [];
  for (const entry of data as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object" || entry.draft !== false) continue;
    const tag = text(entry.tag_name);
    const at = isoTime(entry.published_at) ?? isoTime(entry.created_at);
    if (!tag || !at) continue;
    releases.push({
      tag,
      name: text(entry.name) || tag,
      at,
      body: text(entry.body),
    });
  }
  return releases.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The newest published release; null when the project has no GitHub
 *  repository or no releases. Throws GithubReadError when the list can't
 *  be read. */
export async function latestRelease(
  project: string,
  deps: GithubReadOptions = {},
): Promise<ReleaseInfo | null> {
  return (await listReleases(project, deps))?.[0] ?? null;
}

/** Whether issue or pull request `number` is open, closed or (a pull
 *  request) merged, and when it closed or merged; null when unreadable. */
export async function refState(
  project: string,
  ref: { type: "issue" | "pr"; number: number },
  deps: GithubReadOptions = {},
): Promise<{ state: "open" | "closed" | "merged"; at: string | null } | null> {
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) return null;
  const ghRepo = await ghRepoOrNull(project, deps);
  if (!ghRepo) return null;
  const kind = ref.type === "pr" ? "pulls" : "issues";
  const data = (await cachedGet(
    `/repos/${ghRepo}/${kind}/${ref.number}`,
    deps,
  )) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  if (data.state === "open") return { state: "open", at: null };
  if (data.state !== "closed") return null;
  const merged = ref.type === "pr" ? isoTime(data.merged_at) : null;
  if (merged) return { state: "merged", at: merged };
  return { state: "closed", at: isoTime(data.closed_at) };
}

/**
 * Open issues labelled `bug` (pull requests left out); null when the
 * project has no GitHub repository or any page can't be read. Pages of 100
 * are read until a short one, at most OPEN_BUG_PAGES; `truncated` says
 * there were more. (githubRequest doesn't hand back the Link header, so
 * pages are asked for by number, which walks the same rel="next" chain.)
 *
 * An issue missing from the list is NOT proof it closed: it may sit past
 * the page cap, have lost its label, or the list may have changed between
 * pages. Ask refState for one issue's state.
 */
export async function openBugIssues(
  project: string,
  deps: GithubReadOptions = {},
): Promise<KnownProblems | null> {
  const ghRepo = await ghRepoOrNull(project, deps);
  if (!ghRepo) return null;
  const entries: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const data = await cachedGet(
      `/repos/${ghRepo}/issues?state=open&labels=bug&per_page=${PER_PAGE}&page=${page}`,
      deps,
    );
    if (!Array.isArray(data)) return null;
    entries.push(...(data as Array<Record<string, unknown>>));
    if (data.length < PER_PAGE) break;
    if (page >= OPEN_BUG_PAGES) {
      truncated = true;
      break;
    }
  }
  const issues: KnownProblem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || entry.pull_request) continue;
    if (typeof entry.number !== "number" || entry.state === "closed") continue;
    const labels = Array.isArray(entry.labels)
      ? (entry.labels as unknown[])
          .map((l) =>
            typeof l === "string"
              ? l
              : text((l as { name?: unknown } | null)?.name),
          )
          .filter(Boolean)
      : [];
    issues.push({
      number: entry.number,
      title: text(entry.title),
      body: text(entry.body),
      url: text(entry.html_url),
      labels,
      updatedAt: isoTime(entry.updated_at) ?? "",
    });
  }
  return Object.assign(issues, { truncated });
}
