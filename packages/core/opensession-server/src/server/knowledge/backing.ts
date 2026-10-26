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
//  5. this session's own read_knowledge showed it at that commit
//     (support/evidence.ts); search_knowledge listing it is not enough.
//     The items read when the draft was checked are stored with its
//     verdict (`read`, server-written) and passed back at send time
//     (`input.read`), so a restart that forgot the evidence doesn't hold
//     every draft in a veto window; the live evidence still counts too.
// Used but not cited: every item the session read (stored and live) and
// the draft doesn't cite must pass 1–4 at the commit it was read at, or it
// holds the draft too (`uncited`), since the reply may rest on it whatever
// else it cites. Past MAX_READ_CHECKED such items the verdict fails with
// that reason.
// Quoted internal text: whenever the project has a knowledge repository,
// cited or not, a draft holding INTERNAL_QUOTE_WORDS consecutive words of
// an `internal` article body sets `internalQuoted` (quote-check.ts); the
// shingled bodies are cached per project by knowledge HEAD.
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
import { sessionReadKnowledge, sessionSawKnowledge } from "../support/evidence";
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
import {
  type InternalWindows,
  type QuotedNote,
  findQuote,
  internalWindows,
} from "./quote-check";

export { quotesInternal } from "./quote-check";

export interface VerdictInput {
  project: string;
  /** The agent session that wrote the draft. */
  sessionId: string | null;
  sources: DraftSource[];
  text: string;
  now: number;
  /** The read proof stored with the draft's verdict when it was checked
   *  (`check.knowledge.read`). Server-written, never the agent's. */
  read?: KnowledgeRead[];
}

type KnowledgeRead = NonNullable<KnowledgeVerdict["read"]>[number];

export interface BackingDeps {
  call: typeof knowledgeRepo.call;
  /** Whether the project has a knowledge repository (a "no" is reused
   *  for a minute, client.ts). */
  hasRepo: (project: string) => Promise<boolean>;
  /** How the code repository is read (repo-changes.ts). */
  repo: Partial<RepoChangeDeps>;
  refState: (
    project: string,
    ref: { type: "issue" | "pr"; number: number },
    opts: GithubReadOptions,
  ) => ReturnType<typeof refState>;
  sawKnowledge: typeof sessionSawKnowledge;
  readKnowledge: typeof sessionReadKnowledge;
}

export const NOT_FOUND = "Not found in knowledge";
export const RETIRED = "Retired";
export const NEEDS_CHECK = "Needs a check";
/** Items a session read and the draft doesn't cite that are checked;
 *  past it the check fails closed (KNOWLEDGE_COPY.readTooMuch). */
export const MAX_READ_CHECKED = 20;

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

/** Whether `read` holds `path` at `commit`: either commit may be a prefix
 *  of the other (search prints seven hex), as evidence.ts compares them. */
function readAt(read: KnowledgeRead[], path: string, commit: string): boolean {
  const sha = commit.toLowerCase();
  return read.some(
    (r) =>
      r.path === path && (r.commit.startsWith(sha) || sha.startsWith(r.commit)),
  );
}

/** A check that fails with a reason people see instead of "Knowledge
 *  couldn't be checked". */
class VerdictFailure extends Error {}

/** One citation: null when it backs, else why not. `read` is the read
 *  proof (stored and live) step 5 checks; null skips step 5 (an item the
 *  session read, checked at the commit it read). */
async function checkCitation(
  input: VerdictInput,
  ref: string,
  today: string,
  d: BackingDeps,
  read: KnowledgeRead[] | null,
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
  const blob = await d.call("blobAt", project, path, commit);
  if (!blob) return blocked(NOT_FOUND);
  if (!item || item.blob !== blob)
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
      // Closed or merged at a time GitHub didn't give: can't tell whether
      // that was before the item was valid, so it can't be checked.
      if (!state || (state.state !== "open" && !state.at))
        throw new Error(
          `${dep.type === "pr" ? "Pull request" : "Issue"} #${dep.number} couldn't be read`,
        );
      return state;
    },
  };
  const verdict = await evaluateItem(item, "", signals);
  if (verdict.stale) return blocked(verdict.reason);

  if (
    read &&
    !readAt(read, path, commit) &&
    !(
      input.sessionId &&
      d.sawKnowledge(input.sessionId, project, path, commit, "read")
    )
  )
    return blocked(KNOWLEDGE_COPY.notRead);
  return null;
}

/** Shingled internal bodies per project, at the knowledge HEAD they were
 *  read at. */
const shingledByProject = new Map<
  string,
  { head: string; shingled: InternalWindows }
>();

/** The first internal note the draft quotes. The bodies come from the
 *  index after its freshness check; they are cached only when HEAD didn't
 *  move while they were read, so a cached set is exactly that HEAD's. */
async function internalQuote(
  project: string,
  text: string,
  d: BackingDeps,
): Promise<QuotedNote | null> {
  const head = await d.call("head", project);
  const cached = shingledByProject.get(project);
  if (head && cached?.head === head) return findQuote(text, cached.shingled);
  const shingled = internalWindows(
    await d.call("index.internalBodies", project),
  );
  if (head && (await d.call("head", project)) === head)
    shingledByProject.set(project, { head, shingled });
  return findQuote(text, shingled);
}

/** Read items without repeats, each path at every commit read (a short
 *  commit and the full one it abbreviates are one). Malformed entries of
 *  a stored verdict are dropped. */
function readSet(entries: KnowledgeRead[]): KnowledgeRead[] {
  const out: KnowledgeRead[] = [];
  for (const r of entries) {
    if (typeof r?.path !== "string" || typeof r.commit !== "string") continue;
    const commit = r.commit.toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(commit) || !r.path) continue;
    const same = out.findIndex(
      (o) =>
        o.path === r.path &&
        (o.commit.startsWith(commit) || commit.startsWith(o.commit)),
    );
    if (same < 0) out.push({ path: r.path, commit });
    else if (commit.length > out[same]!.commit.length)
      out[same] = { path: r.path, commit };
  }
  return out;
}

function deps(over: Partial<BackingDeps>): BackingDeps {
  return {
    call: over.call ?? knowledgeRepo.call,
    hasRepo:
      over.hasRepo ??
      (over.call
        ? (project) => over.call!("hasRepo", project)
        : (project) => knowledgeRepo.hasRepo(project)),
    repo: over.repo ?? {},
    refState:
      over.refState ?? ((project, ref, opts) => refState(project, ref, opts)),
    sawKnowledge: over.sawKnowledge ?? sessionSawKnowledge,
    readKnowledge: over.readKnowledge ?? sessionReadKnowledge,
  };
}

/** The draft's knowledge verdict (see the header). Null when the project
 *  has no knowledge repository and the draft cites no knowledge. Never
 *  throws: a check that fails is `failed`. */
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
    if (!(await d.hasRepo(input.project))) {
      if (!cited.length) return null;
      for (const ref of cited) {
        const path = parseKnowledgeCitation(ref)?.path ?? ref;
        verdict.blocked.push({ ref, path, title: path, reason: NOT_FOUND });
      }
      return verdict;
    }
    // What the session read: the proof stored with the draft and the
    // live evidence, each path at every commit either knows.
    const read = readSet([
      ...(input.read ?? []),
      ...(input.sessionId
        ? d.readKnowledge(input.sessionId, input.project)
        : []),
    ]);
    const citedPaths = new Set(
      cited.map((ref) => parseKnowledgeCitation(ref)?.path),
    );
    const uncited = read.filter((r) => !citedPaths.has(r.path));
    if (uncited.length > MAX_READ_CHECKED)
      throw new VerdictFailure(KNOWLEDGE_COPY.readTooMuch(MAX_READ_CHECKED));
    verdict.internalQuoted = await internalQuote(input.project, input.text, d);
    for (const ref of cited) {
      const blocked = await checkCitation(input, ref, today, d, read);
      if (blocked) verdict.blocked.push(blocked);
      else verdict.backing.push({ kind: "knowledge", ref });
    }
    for (const r of uncited) {
      const ref = `${r.path}@${r.commit}`;
      const blocked = await checkCitation(input, ref, today, d, null);
      if (blocked) verdict.blocked.push({ ...blocked, uncited: true });
    }
    if (read.length) verdict.read = read;
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
      ...(error instanceof VerdictFailure ? { reason: error.message } : {}),
      at,
    };
  }
}
