// Whether the knowledge a support draft cites may back an automatic reply,
// decided when the draft is checked (support/verify.ts) and again at the
// moment of sending (support/reply.ts, veto end and retries included), so
// a draft whose knowledge went stale while it waited goes to a person.
//
// Each `knowledge:<path>@<commit>` citation passes, in order (the first
// that fails is its reason):
//  1. the ref parses, the path is an item at `commit`, and `commit` is the
//     knowledge repository's HEAD or an ancestor ("Not found in knowledge");
//  2. the item at HEAD is the same blob the agent read;
//  3. it is trusted and active today (shared/knowledge.ts isBacking);
//  4. nothing it depends on changed: no default-branch commit of the code
//     repository after its `validAsOfCommit` (or its `validAsOf` day)
//     touches a `repo:` dependency, read from the local
//     `origin/<default>` (no fetch here; the maintenance tick fetches), and
//     no `issue:`/`pr:` dependency closed or merged since, read fresh from
//     GitHub (freshness/evaluate.ts, with page and release checks left to
//     the daily run);
//  5. this session's own search_knowledge or read_knowledge printed it at
//     that commit (support/evidence.ts).
// Anything that throws (the worker, the index, git, GitHub) makes the
// whole verdict `failed`: the draft waits with "Knowledge couldn't be
// checked". Nothing runs at import.

import {
  KNOWLEDGE_COPY,
  type KnowledgeItem,
  type KnowledgeVerdict,
  effectiveStatus,
  isBacking,
  parseKnowledgeCitation,
} from "../../shared/knowledge";
import type { DraftSource } from "../../shared/support";
import { sessionSawKnowledge } from "../support/evidence";
import { knowledgeRepo } from "./client";
import { evaluateItem, type Signals } from "./freshness/evaluate";
import { type GithubReadOptions, refState } from "./freshness/github";
import {
  type RepoChangeDeps,
  type RepoCommit,
  commitAt,
  commitsSince,
  latestChange,
} from "./freshness/repo-changes";

export interface VerdictInput {
  project: string;
  /** The agent session that wrote the draft. */
  sessionId: string | null;
  sources: DraftSource[];
  text: string;
  now: number;
}

export interface BackingDeps {
  call: typeof knowledgeRepo.call;
  /** How the code repository is read (repo-changes.ts). */
  repo: Partial<RepoChangeDeps>;
  refState: (
    project: string,
    ref: { type: "issue" | "pr"; number: number },
    opts: GithubReadOptions,
  ) => ReturnType<typeof refState>;
  sawKnowledge: typeof sessionSawKnowledge;
}

export const NOT_FOUND = "Not found in knowledge";
export const RETIRED = "Retired";
export const NEEDS_CHECK = "Needs a check";

let override:
  | ((input: VerdictInput) => Promise<KnowledgeVerdict | null>)
  | undefined;

/** Replace the verdict (tests of the reply path); undefined restores it. */
export function __setKnowledgeVerdictForTest(
  fn?: (input: VerdictInput) => Promise<KnowledgeVerdict | null>,
): void {
  override = fn;
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Default-branch commits touching `paths` after `since`: a commit sha, or
 *  a YYYY-MM-DD day from which on every commit counts (as revalidate.ts
 *  reads it). */
async function repoCommits(
  project: string,
  paths: string[],
  since: string,
  repo: Partial<RepoChangeDeps>,
): Promise<RepoCommit[]> {
  if (FULL_SHA.test(since)) return commitsSince(project, since, paths, repo);
  const base = await commitAt(project, `${since}T00:00:00Z`, repo);
  if (base) return commitsSince(project, base, paths, repo);
  const latest = await latestChange(project, paths, repo);
  return latest ? [latest] : [];
}

/** Why an item that isn't backing today isn't. */
function notBackingReason(item: KnowledgeItem, today: string): string {
  if (item.status === "retired") return RETIRED;
  if (item.check?.reason) return item.check.reason;
  if (item.status === "active" && effectiveStatus(item, today) !== "active")
    return KNOWLEDGE_COPY.reviewPassed(item.reviewBy ?? "");
  if (item.trust !== "trusted") return KNOWLEDGE_COPY.notTrusted;
  return NEEDS_CHECK;
}

type Blocked = KnowledgeVerdict["blocked"][number];

/** One citation: null when it backs, else why not. */
async function checkCitation(
  input: VerdictInput,
  ref: string,
  today: string,
  d: BackingDeps,
): Promise<Blocked | null> {
  const parsed = parseKnowledgeCitation(ref);
  if (!parsed) {
    const at = ref.lastIndexOf("@");
    const path = at > 0 ? ref.slice(0, at) : ref;
    return { ref, path, title: path, reason: NOT_FOUND };
  }
  const { path, commit } = parsed;
  const { project } = input;
  const item = await d.call("index.get", project, path, today);
  const blocked = (reason: string): Blocked => ({
    ref,
    path,
    title: item?.title ?? path,
    reason,
  });
  // The index answers at the repository's HEAD.
  const head = item?.commit ?? (await d.call("head", project));
  if (!head) return blocked(NOT_FOUND);
  let ancestor: boolean;
  try {
    ancestor = await d.call("isAncestor", project, commit, head);
  } catch (error) {
    // An unknown commit; anything else couldn't be checked.
    if ((error as { status?: unknown })?.status === 404)
      return blocked(NOT_FOUND);
    throw error;
  }
  if (!ancestor) return blocked(NOT_FOUND);
  const read = await d.call("blobAt", project, path, commit);
  if (!read) return blocked(NOT_FOUND);
  if (!item || item.blob !== read)
    return blocked(KNOWLEDGE_COPY.changedSinceRead);
  if (!isBacking(item, today)) return blocked(notBackingReason(item, today));

  const signals: Signals = {
    today,
    repoCommits: (paths, since) => repoCommits(project, paths, since, d.repo),
    // Pages and releases are the daily run's (freshness/revalidate.ts):
    // a fetch or a model call has no place in a send.
    pageHash: async () => null,
    releasesSince: async () => [],
    releaseMentions: async () => true,
    refState: async (dep) => {
      const state = await d.refState(project, dep, { fresh: true });
      if (!state)
        throw new Error(
          `${dep.type === "pr" ? "Pull request" : "Issue"} #${dep.number} couldn't be read`,
        );
      return state;
    },
  };
  const verdict = await evaluateItem(item, "", signals);
  if (verdict.stale) return blocked(verdict.reason);

  if (!input.sessionId || !d.sawKnowledge(input.sessionId, path, commit))
    return blocked(KNOWLEDGE_COPY.notRead);
  return null;
}

function deps(over: Partial<BackingDeps>): BackingDeps {
  return {
    call: over.call ?? knowledgeRepo.call,
    repo: over.repo ?? {},
    refState:
      over.refState ?? ((project, ref, opts) => refState(project, ref, opts)),
    sawKnowledge: over.sawKnowledge ?? sessionSawKnowledge,
  };
}

/** The draft's knowledge verdict (see the header). Null when the project
 *  has no knowledge repository and the draft cites no knowledge. Never
 *  throws: a check that fails is `failed`. `internalQuoted` stays null
 *  here (the internal-quote check is its own). */
export async function knowledgeVerdict(
  input: VerdictInput,
  over: Partial<BackingDeps> = {},
): Promise<KnowledgeVerdict | null> {
  if (override) return override(input);
  const d = deps(over);
  const at = new Date(input.now).toISOString();
  const today = at.slice(0, 10);
  const cited = input.sources
    .filter((s) => s?.kind === "knowledge" && typeof s.ref === "string")
    .map((s) => s.ref);
  try {
    const verdict: KnowledgeVerdict = {
      backing: [],
      blocked: [],
      internalQuoted: null,
      failed: false,
      at,
    };
    if (!(await d.call("hasRepo", input.project))) {
      if (!cited.length) return null;
      for (const ref of cited) {
        const path = parseKnowledgeCitation(ref)?.path ?? ref;
        verdict.blocked.push({ ref, path, title: path, reason: NOT_FOUND });
      }
      return verdict;
    }
    for (const ref of cited) {
      const blocked = await checkCitation(input, ref, today, d);
      if (blocked) verdict.blocked.push(blocked);
      else verdict.backing.push({ kind: "knowledge", ref });
    }
    return verdict;
  } catch (error) {
    console.warn(
      `[knowledge] Couldn't check the knowledge of a ${input.project} draft: ${error instanceof Error ? error.message : error}`,
    );
    return {
      backing: [],
      blocked: [],
      internalQuoted: null,
      failed: true,
      at,
    };
  }
}
