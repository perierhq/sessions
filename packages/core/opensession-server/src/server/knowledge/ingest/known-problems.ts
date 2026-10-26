/**
 * Known problems: the project's open `bug` issues as reference knowledge,
 * one `sources/issues/<n>.md` item per issue (`origin: issue`,
 * `trust: reference`, `kind: answer`, `dependsOn: issue:<n>`). The body is
 * `Known problem, open: <url>` and the first ISSUE_TEXT_CHARS characters of
 * the issue text. Reference only (owner decision): "known, we're on it"
 * needs a person unless an approved article depends on the issue, which B2
 * already watches through `dependsOn: issue:<n>`.
 *
 * Issue text is written by outsiders and can quote customers, so title and
 * body go through stripCustomerData (addresses, phone numbers, ids, links
 * off the Support websites, quoted lines, signatures); an issue whose text
 * holds anything credential-like is skipped, never redacted into knowledge.
 *
 * An item whose issue is no longer listed is retired only when GitHub says
 * so for that issue (issueStatus, read fresh): closed, gone (404 or 410),
 * or open without the `bug` label among its own labels. An issue still
 * labelled `bug` (past the page cap, or the list lagging) or an unreadable
 * state leaves the item as it is: absence alone is no proof. An item a person
 * edited or retired last is left alone (mirrors.ts lastWrittenByPat), so
 * only an item Pat retired comes back when its issue does. A list that can't be
 * read throws (the daily step retries, the import fails) and changes
 * nothing; a project without a GitHub repository has nothing to sync.
 * Unchanged items are not rewritten, so a rerun makes no commit; what
 * changed goes in one commit by Pat.
 *
 * Runs daily (maintenance.ts KNOWLEDGE_DAILY_STEPS) and as the
 * `known-problems` import. Reuses github.ts (openBugIssues, issueStatus),
 * strip.ts, mirrors.ts, jobs.ts and the website import's write-and-retry shape.
 * Nothing runs at import.
 */
import type {
  KnowledgeFrontMatter,
  KnowledgeImportJob,
  KnowledgeItem,
} from "../../../shared/knowledge";
import type { Author } from "../../memory-repo/git-store";
import { MemoryRepoError } from "../../memory-repo/git-store";
import { findSecrets } from "../../memory-repo/secrets";
import { knowledgeRepo } from "../client";
import {
  GithubReadError,
  type GithubReadOptions,
  issueStatus,
  openBugIssues,
  type KnownProblem,
} from "../freshness/github";
import {
  frontMatterOf,
  PAT_AUTHOR,
  PAT_TRAILER,
} from "../freshness/revalidate";
import { issueItemPath, knowledgeRepoName } from "../layout";
import type { KnowledgeChange } from "../service";
import { startJob } from "./jobs";
import { stripCustomerData } from "./strip";
import { lastWrittenByPat } from "./mirrors";
import { exactHosts } from "./website";

/** Characters of (stripped) issue text kept. */
export const ISSUE_TEXT_CHARS = 2000;
const MAX_TITLE = 200;
const LIST_PAGE = 200;
const WRITE_ATTEMPTS = 3;
const BUG_LABEL = "bug";
const ISSUE_PATH = /^sources\/issues\/([1-9]\d*)\.md$/;

export interface KnownProblemsDeps {
  /** YYYY-MM-DD, UTC. */
  today(): string;
  /** The project's Support websites (links to them stay). */
  hosts(project: string): Promise<string[]>;
  /** GitHub readers' deps (ghRepo, request); reads always skip the cache. */
  github: GithubReadOptions;
}

export interface KnownProblemsResult {
  /** Items written (new, changed or back from retired). */
  written: number;
  /** Items retired because their issue closed, went or lost the label. */
  retired: number;
  /** Open issues left out (credential-like text), and items a person
   *  edited or retired last, left alone. */
  skipped: number;
}

function bind(over: Partial<KnownProblemsDeps>): KnownProblemsDeps {
  return {
    today: over.today ?? (() => new Date().toISOString().slice(0, 10)),
    hosts:
      over.hosts ??
      (async (project) => {
        const { roleWebAccess } = await import("../../projects/effective");
        return (await roleWebAccess(project, "support")).websites;
      }),
    github: over.github ?? {},
  };
}

function checkProject(project: string): void {
  try {
    knowledgeRepoName(project);
  } catch {
    throw new MemoryRepoError(`"${project}" isn't a project name.`);
  }
}

/** The project's GitHub `owner/name` as github.ts resolves it; null when it
 *  has none. */
async function ghRepoOf(
  project: string,
  github: GithubReadOptions,
): Promise<string | null> {
  if (github.ghRepo) return github.ghRepo(project);
  const { configuredRepos } = await import("../../config");
  const repo = configuredRepos()[project];
  if (!repo || (repo.host && repo.host !== "github")) return null;
  return repo.ghRepo || null;
}

/** The project's issue items that aren't retired, by issue number. */
async function issueItems(
  project: string,
  today: string,
): Promise<Map<number, KnowledgeItem>> {
  const items = new Map<number, KnowledgeItem>();
  for (let offset = 0; ; offset += LIST_PAGE) {
    const page = await knowledgeRepo.call("index.list", project, "all", {
      today,
      limit: LIST_PAGE,
      offset,
    });
    for (const item of page.items) {
      const m = ISSUE_PATH.exec(item.path);
      if (item.origin === "issue" && m) items.set(Number(m[1]), item);
    }
    if (page.items.length < LIST_PAGE || offset + LIST_PAGE >= page.total)
      return items;
  }
}

/** `text` cut to `max` characters at a word boundary, "…" when cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.search(/\s\S*$/);
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

interface Planned {
  title: string;
  body: string;
}

/** The item's title and body for `issue`; null when its text holds
 *  anything credential-like. */
function planned(
  issue: KnownProblem,
  ghRepo: string,
  keepHosts: string[],
): Planned | null {
  // Nobody's name is known here: every address, phone number, id, foreign
  // link and quoted line goes.
  const party = { address: "" };
  const title = stripCustomerData(issue.title, party, {
    keepHosts,
    structure: false,
  });
  const text = stripCustomerData(issue.body, party, { keepHosts });
  if (!title.clean || !text.clean) return null;
  const url = /^https:\/\/github\.com\//.test(issue.url)
    ? issue.url
    : `https://github.com/${ghRepo}/issues/${issue.number}`;
  const titleText = title.text.replace(/\s+/g, " ").trim();
  const shown = cut(text.text.trim(), ISSUE_TEXT_CHARS);
  const plan: Planned = {
    title: cut(titleText || `Issue #${issue.number}`, MAX_TITLE),
    body: shown
      ? `Known problem, open: ${url}\n\n${shown}`
      : `Known problem, open: ${url}`,
  };
  if (findSecrets(`${plan.title}\n${plan.body}`).length) return null;
  return plan;
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Sync the project's open bug issues into its knowledge repository; see
 * the module comment. Resolves with what was written, retired and skipped.
 */
export async function syncKnownProblems(
  project: string,
  over: Partial<KnownProblemsDeps> = {},
): Promise<KnownProblemsResult> {
  checkProject(project);
  const deps = bind(over);
  const result: KnownProblemsResult = { written: 0, retired: 0, skipped: 0 };
  const ghRepo = await ghRepoOf(project, deps.github);
  if (!ghRepo) return result;
  const github: GithubReadOptions = {
    ...deps.github,
    ghRepo: () => ghRepo,
    fresh: true,
  };
  const open = await openBugIssues(project, github);
  if (!open)
    throw new GithubReadError(`${ghRepo}'s open bug issues couldn't be read`);
  const today = deps.today();
  const keepHosts = exactHosts(await deps.hosts(project));

  const listed = new Set(open.map((issue) => issue.number));
  const plans = new Map<number, Planned>();
  let skipped = 0;
  for (const issue of open) {
    const plan = planned(issue, ghRepo, keepHosts);
    if (plan) plans.set(issue.number, plan);
    else skipped++;
  }
  result.skipped = skipped;

  for (let attempt = 1; ; attempt++) {
    const items = await issueItems(project, today);
    const changes: KnowledgeChange[] = [];
    const expected: Record<string, string | null> = {};
    let written = 0;
    let retired = 0;
    let personal = 0;
    for (const [number, plan] of plans) {
      const path = issueItemPath(number);
      // Read directly: the "all" list leaves retired items out, and a
      // reopened issue's item is there all the same.
      const current = await knowledgeRepo.call("read", project, path, today);
      const dependsOn = [`issue:${number}`];
      if (
        current &&
        current.item.status !== "retired" &&
        current.item.title === plan.title &&
        current.item.kind === "answer" &&
        current.item.trust === "reference" &&
        same(current.item.sources, dependsOn) &&
        same(current.item.dependsOn, dependsOn) &&
        current.body.trim() === plan.body
      )
        continue;
      // A person's edit or retire wins over the issue: only what Pat
      // wrote last (a retire included) is rewritten or reopened.
      if (current && !(await lastWrittenByPat(project, path))) {
        personal++;
        continue;
      }
      const fm: KnowledgeFrontMatter = {
        title: plan.title,
        kind: "answer",
        trust: "reference",
        status: "active",
        origin: "issue",
        topics: [],
        sources: dependsOn,
        dependsOn,
        validAsOf: today,
      };
      // Waiting for a person stays waiting: new text, same question.
      if (current?.item.status === "needs-check" && current.item.check) {
        fm.status = "needs-check";
        fm.check = current.item.check;
      }
      changes.push({ op: "put", path, fm, body: plan.body });
      expected[path] = current?.item.blob ?? null;
      written++;
    }
    for (const [number, current] of items) {
      // Listed: open and a bug (a skipped one stays as it was).
      if (listed.has(number)) continue;
      // Retired only on GitHub's word for this issue: closed, gone (404 or
      // 410, the list just read proves access), or open without the label.
      const state = await issueStatus(project, number, github);
      if (!state) continue;
      // GitHub matches label names regardless of case.
      if (
        state.state === "open" &&
        state.labels.some((label) => label.toLowerCase() === BUG_LABEL)
      )
        continue;
      const read = await knowledgeRepo.call(
        "read",
        project,
        current.path,
        today,
      );
      if (!read) continue;
      if (!(await lastWrittenByPat(project, current.path))) {
        personal++;
        continue;
      }
      const { check: _check, ...fm } = frontMatterOf(read.item);
      changes.push({
        op: "put",
        path: current.path,
        fm: { ...fm, status: "retired" },
        body: read.body,
      });
      expected[current.path] = read.item.blob;
      retired++;
    }
    result.written = written;
    result.retired = retired;
    result.skipped = skipped + personal;
    if (!changes.length) return result;
    try {
      await knowledgeRepo.call("write", project, changes, {
        message: retired
          ? `Import known problems: ${written} open (${retired} retired)`
          : `Import known problems: ${written} open`,
        author: PAT_AUTHOR,
        trailers: [PAT_TRAILER],
        expected,
      });
      return result;
    } catch (error) {
      // Someone wrote meanwhile: plan again from what is there now.
      const conflict =
        error instanceof Error && error.name === "KnowledgeConflictError";
      if (!conflict || attempt >= WRITE_ATTEMPTS) throw error;
    }
  }
}

/**
 * Start the known-problems import for `project`; resolves with the job
 * (it runs in the background). Refused (409) while one runs.
 */
export async function startKnownProblemsImport(
  input: { project: string; by: Author },
  over: Partial<KnownProblemsDeps> = {},
): Promise<KnowledgeImportJob> {
  const { project } = input;
  checkProject(project);
  return startJob(
    project,
    "known-problems",
    { by: input.by.name },
    async (job) => {
      await knowledgeRepo.call("ensureRepo", project);
      job.signal.throwIfAborted();
      const result = await syncKnownProblems(project, over);
      await job.progress({
        reference: result.written,
        skipped: result.skipped,
        done: result.written + result.retired + result.skipped,
      });
    },
  );
}
