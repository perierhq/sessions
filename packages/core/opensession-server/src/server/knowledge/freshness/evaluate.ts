/**
 * Whether one knowledge item is still true, from the change signals of its
 * project (repo-changes.ts, web.ts, github.ts). Pure apart from the
 * signals it is handed: revalidate.ts binds them to a project and decides
 * what a stale verdict does (flip an article, refresh a mirror).
 *
 * Checks, in order; the first that finds a change is the reason:
 *  1. `repo:` dependencies: a default-branch commit after `validAsOfCommit`
 *     (or, without one, from the `validAsOf` day on) touched the path;
 *  2. `url:` dependencies: the page's hash differs from the `#sha256=`
 *     recorded in the matching `url:` source (an unreadable page is not a
 *     change);
 *  3. `issue:` / `pr:` dependencies closed or merged after `validAsOf`;
 *  4. a release published after `validAsOf` whose notes name one of the
 *     item's topics (or a title word) and that the small model says
 *     affects it; only items with topics are checked;
 *  5. a `reviewBy` date in the past.
 *
 * A signal that fails throws; the caller records it and leaves the item as
 * it is (the send-time check in backing.ts is the fail-closed gate).
 * Retired items are never evaluated.
 */

import {
  effectiveStatus,
  KNOWLEDGE_COPY,
  parseDependency,
  type KnowledgeItem,
} from "../../../shared/knowledge";
import type { ReleaseInfo } from "./github";
import type { RepoCommit } from "./repo-changes";

export interface Signals {
  /** YYYY-MM-DD. */
  today: string;
  /** Default-branch commits that touched `paths` after `since`, newest
   *  first. `since` is a commit sha, or a YYYY-MM-DD day (commits from that
   *  day on count). */
  repoCommits(paths: string[], since: string): Promise<RepoCommit[]>;
  /** The page's current hash; null = unreadable this run (not a change). */
  pageHash(url: string): Promise<string | null>;
  /** Releases published after `at` (YYYY-MM-DD), newest first. */
  releasesSince(at: string): Promise<ReleaseInfo[]>;
  /** Small model: does the release change what the item says? Fail closed:
   *  true when it can't tell. */
  releaseMentions(
    item: KnowledgeItem,
    body: string,
    release: ReleaseInfo,
  ): Promise<boolean>;
  refState(ref: {
    type: "issue" | "pr";
    number: number;
  }): Promise<{
    state: "open" | "closed" | "merged";
    at: string | null;
  } | null>;
}

export type Verdict =
  | { stale: false }
  | { stale: true; reason: string; source?: string };

const NOT_STALE: Verdict = { stale: false };
const HASH_MARK = "#sha256=";

/** Title words too common to say a release is about the item. */
const COMMON_WORDS = new Set([
  "about",
  "account",
  "after",
  "before",
  "could",
  "every",
  "other",
  "project",
  "should",
  "their",
  "there",
  "these",
  "those",
  "using",
  "where",
  "which",
  "while",
  "would",
]);

/** The hash recorded for `url` in the item's `url:<url>#sha256=<hex>`
 *  sources; null when none was recorded. */
export function recordedHash(sources: string[], url: string): string | null {
  for (const source of sources) {
    if (!source.startsWith("url:")) continue;
    const mark = source.lastIndexOf(HASH_MARK);
    if (mark < 0) continue;
    if (source.slice("url:".length, mark) !== url) continue;
    const hash = source.slice(mark + HASH_MARK.length).toLowerCase();
    if (/^[0-9a-f]{1,128}$/.test(hash)) return hash;
  }
  return null;
}

/** The first of the item's topics, then its longer title words, that the
 *  release notes name (case-insensitive); null when none. */
export function releaseTopic(
  item: Pick<KnowledgeItem, "topics" | "title">,
  release: Pick<ReleaseInfo, "body" | "name">,
): string | null {
  const text = `${release.name}\n${release.body}`.toLowerCase();
  for (const topic of item.topics) {
    const t = topic.trim().toLowerCase();
    if (t && text.includes(t)) return topic.trim();
  }
  for (const word of item.title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 5 || COMMON_WORDS.has(word)) continue;
    if (text.includes(word)) return word;
  }
  return null;
}

/** Whether `at` (ISO timestamp) is after `day` (YYYY-MM-DD): any time on
 *  the day itself counts, since a day can't order events within it. */
function after(at: string, day: string): boolean {
  return at > day;
}

async function repoVerdict(
  item: KnowledgeItem,
  paths: string[],
  s: Signals,
): Promise<Verdict> {
  if (!paths.length) return NOT_STALE;
  const commits = await s.repoCommits(
    paths,
    item.validAsOfCommit ?? item.validAsOf,
  );
  for (const commit of commits) {
    const path = commit.paths[0];
    if (!path) continue;
    return {
      stale: true,
      reason: `${path} changed in ${commit.sha.slice(0, 7)}`,
      source: `repo:${path}@${commit.sha}`,
    };
  }
  return NOT_STALE;
}

/** One item's verdict for today. */
export async function evaluateItem(
  item: KnowledgeItem,
  body: string,
  s: Signals,
): Promise<Verdict> {
  const effective = effectiveStatus(item, s.today);
  if (effective === "retired") return NOT_STALE;
  const deps = item.dependsOn
    .map((raw) => parseDependency(raw))
    .filter((d) => d !== null);

  const repoPaths = deps.flatMap((d) => (d.type === "repo" ? [d.path] : []));
  const repo = await repoVerdict(item, repoPaths, s);
  if (repo.stale) return repo;

  for (const dep of deps) {
    if (dep.type !== "url") continue;
    const recorded = recordedHash(item.sources, dep.url);
    if (!recorded) continue;
    const hash = await s.pageHash(dep.url);
    if (hash && hash.toLowerCase() !== recorded)
      return {
        stale: true,
        reason: `${dep.url} changed on ${s.today}`,
        source: `url:${dep.url}${HASH_MARK}${hash.toLowerCase()}`,
      };
  }

  for (const dep of deps) {
    if (dep.type !== "issue" && dep.type !== "pr") continue;
    const state = await s.refState({ type: dep.type, number: dep.number });
    if (!state || state.state === "open" || !state.at) continue;
    if (!after(state.at, item.validAsOf)) continue;
    const what =
      dep.type === "pr"
        ? `Pull request #${dep.number} was ${state.state}`
        : `Issue #${dep.number} was closed`;
    return {
      stale: true,
      reason: what,
      source: `${dep.type}:${dep.number}`,
    };
  }

  if (item.topics.length) {
    const releases = await s.releasesSince(item.validAsOf);
    // Oldest first: the first release that changed things is the reason.
    for (const release of [...releases].reverse()) {
      if (!after(release.at, item.validAsOf)) continue;
      const topic = releaseTopic(item, release);
      if (!topic) continue;
      if (!(await s.releaseMentions(item, body, release))) continue;
      return {
        stale: true,
        reason: `Release ${release.tag} mentions ${topic}`,
        source: `release:${release.tag}`,
      };
    }
  }

  if (item.status === "active" && effective === "needs-check")
    return {
      stale: true,
      reason: KNOWLEDGE_COPY.reviewPassed(item.reviewBy ?? ""),
    };
  return NOT_STALE;
}
