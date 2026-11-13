// github_issues and github_issue: a project lead's read-only view of its
// repository's issues, through the GitHub App's installation credential
// (agents/github/github-rest.ts githubRequest, read token). Bounded: one
// page of at most ISSUE_PAGE issues, the latest ISSUE_COMMENTS comments,
// and text clipped. Cached in memory per request for ISSUES_TTL_MS, so a
// lead re-reading the queue in one wake costs nothing; while the App's
// REST quota is spent (github-limit.ts) a cached answer is served, marked
// with its age, or the read is refused. Only the lead's own project's
// repositories. Text other people wrote is quoted as data
// (overview.ts quoted, untrustedLabel). Nothing runs at import.
import { leadSources, quoted, untrustedLabel } from "./overview";

/** Issues one list returns. */
export const ISSUE_PAGE = 30;
/** Latest comments one issue shows. */
export const ISSUE_COMMENTS = 5;
/** How long a read is served from memory. */
export const ISSUES_TTL_MS = 5 * 60_000;
/** Entries the cache keeps. */
const CACHE_ENTRIES = 200;
const TITLE_CHARS = 160;
const BODY_CHARS = 2_000;
const COMMENT_CHARS = 800;

export type IssueState = "open" | "closed" | "all";

export interface GithubReadResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface GithubIssuesDeps {
  now(): number;
  /** A GET with the App's read token. */
  get(path: string): Promise<GithubReadResult>;
  /** When the App's REST quota for this repository comes back, or 0. */
  rateLimitedUntil(ghRepo: string): Promise<number>;
  /** The project's GitHub repositories, `owner/name`. */
  projectGhRepos(project: string): readonly string[];
  /** Whether a login is a teammate on the roster or one of our bots. */
  isTeamLogin(login: string): boolean;
}

const liveDeps: GithubIssuesDeps = {
  now: () => Date.now(),
  async get(path) {
    const { githubRequest } = await import("../../agents/github/github-rest");
    const r = await githubRequest("GET", path, undefined, { mint: "read" });
    return { ok: r.ok, status: r.status, data: r.data };
  },
  async rateLimitedUntil(ghRepo) {
    const { ghBackoffUntil } = await import("../github-limit");
    return ghBackoffUntil("rest", { repo: ghRepo });
  },
  projectGhRepos: (project) => leadSources().projectGhRepos(project),
  isTeamLogin: (login) => leadSources().isTeamLogin(login),
};

let override: Partial<GithubIssuesDeps> | undefined;

export function __setGithubIssuesDepsForTest(
  deps: Partial<GithubIssuesDeps> | undefined,
): void {
  override = deps;
  cache.clear();
}

function deps(): GithubIssuesDeps {
  return { ...liveDeps, ...override };
}

const cache = new Map<string, { at: number; value: unknown }>();

function remember(key: string, at: number, value: unknown): void {
  cache.delete(key);
  cache.set(key, { at, value });
  while (cache.size > CACHE_ENTRIES)
    cache.delete(cache.keys().next().value as string);
}

type Read =
  | { ok: true; data: unknown; ageMs: number }
  | { ok: false; error: string };

/** One cached GET: fresh from memory, else GitHub, else (rate limited or
 *  GitHub down) a stale copy with its age. */
async function cachedGet(
  d: GithubIssuesDeps,
  ghRepo: string,
  path: string,
): Promise<Read> {
  const now = d.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < ISSUES_TTL_MS)
    return { ok: true, data: hit.value, ageMs: now - hit.at };
  const until = await d.rateLimitedUntil(ghRepo);
  if (until > now) {
    if (hit) return { ok: true, data: hit.value, ageMs: now - hit.at };
    return {
      ok: false,
      error: `GitHub's rate limit for the App is spent until ${new Date(until).toISOString()}. Try again after that.`,
    };
  }
  const r = await d.get(path);
  if (r.ok) {
    remember(path, now, r.data);
    return { ok: true, data: r.data, ageMs: 0 };
  }
  if (hit) return { ok: true, data: hit.value, ageMs: now - hit.at };
  if (r.status === 404)
    return { ok: false, error: `GitHub has no such issue or repository.` };
  if (r.status === 0)
    return {
      ok: false,
      error: "Couldn't reach GitHub or the App has no credential.",
    };
  return { ok: false, error: `GitHub answered ${r.status}.` };
}

function clip(text: unknown, chars: number): string {
  const s = typeof text === "string" ? text.trim() : "";
  return s.length > chars ? `${s.slice(0, chars - 1)}…` : s;
}

const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : null;

/** An issue as the tools show it. */
export interface IssueRow {
  number: number;
  title: string;
  author: string;
  /** Not a teammate and not a bot. */
  outside: boolean;
  /** GitHub's author_association (OWNER, MEMBER, CONTRIBUTOR, NONE, ...). */
  association: string;
  labels: string[];
  comments: number;
  state: string;
  pullRequest: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
}

function issueRow(raw: unknown, d: GithubIssuesDeps): IssueRow | null {
  const i = obj(raw);
  if (!i || typeof i.number !== "number") return null;
  const author = String(obj(i.user)?.login ?? "");
  return {
    number: i.number,
    title: clip(i.title, TITLE_CHARS),
    author,
    outside: !!author && !d.isTeamLogin(author),
    association: String(i.author_association ?? "NONE"),
    labels: Array.isArray(i.labels)
      ? i.labels
          .map((l: unknown) =>
            typeof l === "string" ? l : String(obj(l)?.name ?? ""),
          )
          .filter(Boolean)
          .slice(0, 10)
      : [],
    comments: typeof i.comments === "number" ? i.comments : 0,
    state: String(i.state ?? ""),
    pullRequest: !!i.pull_request,
    createdAt: String(i.created_at ?? ""),
    updatedAt: String(i.updated_at ?? ""),
    url: String(i.html_url ?? ""),
  };
}

function repoFor(
  d: GithubIssuesDeps,
  project: string,
  bound: string,
): { ghRepo: string } | { error: string } {
  if (project !== bound)
    return {
      error: `You read ${bound}'s repository only, not ${project}.`,
    };
  const repo = d.projectGhRepos(project)[0];
  if (!repo) return { error: `${project} has no GitHub repository.` };
  return { ghRepo: repo };
}

const SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/;

function age(ms: number): string {
  return ms > 0 ? ` (cached ${Math.round(ms / 60_000)} min ago)` : "";
}

function rowLine(r: IssueRow): string {
  return `- #${r.number} ${quoted(r.title)} by ${r.author || "unknown"}${r.outside ? " (outside the team)" : ""}; ${r.comments} comments; labels ${r.labels.length ? r.labels.join(", ") : "none"}; opened ${r.createdAt}, last activity ${r.updatedAt}${r.state === "closed" ? "; closed" : ""}`;
}

/** The repository's issues (pull requests left out), least recently
 *  active first: the ones waiting longest lead. */
export async function githubIssues(
  bound: string,
  input: { project: string; state?: IssueState; since?: string },
): Promise<{ ok: boolean; text: string }> {
  const d = deps();
  const repo = repoFor(d, input.project, bound);
  if ("error" in repo) return { ok: false, text: repo.error };
  const state = input.state ?? "open";
  if (input.since !== undefined && !SINCE.test(input.since))
    return {
      ok: false,
      text: "since must be an ISO date or time, like 2026-11-01 or 2026-11-01T09:00:00Z.",
    };
  const params = new URLSearchParams({
    state,
    sort: "updated",
    direction: "asc",
    per_page: String(ISSUE_PAGE),
  });
  if (input.since) params.set("since", input.since);
  const read = await cachedGet(
    d,
    repo.ghRepo,
    `/repos/${repo.ghRepo}/issues?${params}`,
  );
  if (!read.ok) return { ok: false, text: read.error };
  const rows = (Array.isArray(read.data) ? read.data : [])
    .map((raw) => issueRow(raw, d))
    .filter((r): r is IssueRow => !!r && !r.pullRequest);
  const head = `# ${state} issues in ${repo.ghRepo}, least recently active first${input.since ? `, active since ${input.since}` : ""}${age(read.ageMs)}`;
  if (!rows.length) return { ok: true, text: `${head}\n\nNone.` };
  return {
    ok: true,
    text: [
      head,
      `${rows.length} shown (at most ${ISSUE_PAGE}; pull requests are in project_overview).`,
      "",
      untrustedLabel("issue titles"),
      ...rows.map(rowLine),
    ].join("\n"),
  };
}

/** One issue or pull request with its latest comments; for an open pull
 *  request also the workflow runs waiting for approval at its head. */
export async function githubIssue(
  bound: string,
  input: { project: string; number: number },
): Promise<{ ok: boolean; text: string }> {
  const d = deps();
  const repo = repoFor(d, input.project, bound);
  if ("error" in repo) return { ok: false, text: repo.error };
  const base = `/repos/${repo.ghRepo}`;
  const read = await cachedGet(
    d,
    repo.ghRepo,
    `${base}/issues/${input.number}`,
  );
  if (!read.ok) return { ok: false, text: read.error };
  const row = issueRow(read.data, d);
  if (!row) return { ok: false, text: "GitHub sent no issue." };
  const body = clip(obj(read.data)?.body, BODY_CHARS);
  const comments: Array<{ author: string; at: string; body: string }> = [];
  if (row.comments > 0) {
    const last = Math.ceil(row.comments / ISSUE_COMMENTS);
    const pages =
      last > 1 && row.comments % ISSUE_COMMENTS ? [last - 1, last] : [last];
    for (const page of pages) {
      const c = await cachedGet(
        d,
        repo.ghRepo,
        `${base}/issues/${input.number}/comments?per_page=${ISSUE_COMMENTS}&page=${page}`,
      );
      if (!c.ok || !Array.isArray(c.data)) continue;
      for (const raw of c.data) {
        const x = obj(raw);
        if (!x) continue;
        comments.push({
          author: String(obj(x.user)?.login ?? ""),
          at: String(x.created_at ?? ""),
          body: clip(x.body, COMMENT_CHARS),
        });
      }
    }
  }
  const latest = comments.slice(-ISSUE_COMMENTS);
  const lines = [
    `# ${row.pullRequest ? "Pull request" : "Issue"} #${row.number} in ${repo.ghRepo}${age(read.ageMs)}`,
    `By ${row.author || "unknown"}${row.outside ? " (outside the team)" : ""}, ${row.association}; ${row.state}; ${row.comments} comments; labels ${row.labels.length ? row.labels.join(", ") : "none"}; opened ${row.createdAt}, last activity ${row.updatedAt}. ${row.url}`,
    "",
    untrustedLabel("the title, body and comments"),
    `Title: ${quoted(row.title)}`,
    `Body: ${quoted(body || "(empty)")}`,
  ];
  if (latest.length)
    lines.push(
      "",
      `Latest ${latest.length} of ${row.comments} comments, oldest first:`,
      ...latest.map(
        (c) =>
          `- ${c.author || "unknown"}${c.author && !d.isTeamLogin(c.author) ? " (outside)" : ""} at ${c.at}: ${quoted(c.body)}`,
      ),
    );
  if (row.pullRequest && row.state === "open") {
    const pr = await cachedGet(d, repo.ghRepo, `${base}/pulls/${input.number}`);
    const head = pr.ok ? String(obj(obj(pr.data)?.head)?.sha ?? "") : "";
    if (/^[0-9a-f]{40}$/.test(head)) {
      const runs = await cachedGet(
        d,
        repo.ghRepo,
        `${base}/actions/runs?status=action_required&head_sha=${head}&per_page=10`,
      );
      const list = runs.ok
        ? ((obj(runs.data)?.workflow_runs as unknown[] | undefined) ?? [])
        : null;
      lines.push(
        "",
        `Head: ${head}`,
        list === null
          ? "Workflow runs waiting for approval: couldn't read them."
          : list.length
            ? `Workflow runs waiting for approval at this head (approve one with an approve-run step, category contributor-ci):\n${list
                .map((raw) => {
                  const w = obj(raw);
                  return `- run ${w?.id}: ${quoted(clip(w?.name, 80))}`;
                })
                .join("\n")}`
            : "Workflow runs waiting for approval: none.",
      );
    }
  }
  return { ok: true, text: lines.join("\n") };
}
