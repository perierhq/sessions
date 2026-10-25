// The merge gate (spec 9.1): after the veto window Sessions merges the
// verified fix PR itself under the GitHub App identity. Sessions applies
// branch protection itself first, so an App that is a ruleset bypass actor
// still never bypasses: a required review, failing or missing required
// checks, conflicts, a strict up-to-date rule or unreadable rules all stop
// the merge. Only the verified head SHA is ever merged (pinned in the merge
// request, so GitHub refuses it if the head moves in between).
import type {
  MergeRecord,
  PrSnapshot,
} from "../../../shared/incident-response";
import {
  type GithubMergeResponse,
  githubForceMergeApi,
  parseGhApiError,
  pickMergeMethod,
} from "../../force-merge";
import {
  type GithubCredential,
  resolveGithubCredential,
  serviceGithubCredential,
} from "../../github-auth";
import type { MergeMethod } from "../../pr-contract";
import type {
  PrMergeVerdict,
  PrReadinessTarget,
} from "../../pr-merge-readiness";
import { getRepo } from "../../worktree";
import { incidentAudit } from "../audit-sink";
import type { PrFileEntry } from "./facts";

/** GitHub lists at most this many files of a pull request. */
export const MAX_PR_FILES = 3000;
const PR_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d{0,9})\/?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export function parsePrUrl(
  url: string,
): { ghRepo: string; number: number } | null {
  const match = PR_URL.exec(url.trim());
  if (!match) return null;
  return { ghRepo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

/** Paths of the PR's files; a rename counts its old and its new path. */
export function prFilePaths(files: PrFileEntry[] | null): string[] | null {
  if (files === null) return null;
  return files.flatMap((f) =>
    typeof f === "string"
      ? [f]
      : f.previous_filename !== undefined && f.previous_filename !== f.filename
        ? [f.previous_filename, f.filename]
        : [f.filename],
  );
}

export function snapshotFromVerdict(
  v: PrMergeVerdict,
  extra: { files: PrFileEntry[] | null; mergeCommitSha?: string; now: number },
): PrSnapshot {
  return {
    ghRepo: v.pr.ghRepo,
    number: v.pr.number,
    url: v.pr.url,
    headSha: v.pr.headSha,
    base: v.pr.base,
    state: v.state,
    draft: v.draft,
    mergeable: v.mergeable,
    mergeStateStatus: v.mergeStateStatus,
    reviewDecision: v.review.decision,
    requiredApprovals: Math.max(
      v.review.requiredApprovals,
      v.rules.requiredApprovals,
    ),
    strictUpToDate: v.rules.strictUpToDate,
    failingChecks: v.checks.failing.map((c) => c.name),
    pendingChecks: v.checks.pending.map((c) => c.name),
    missingRequired: [...v.checks.missingRequired],
    ...(extra.mergeCommitSha ? { mergeCommitSha: extra.mergeCommitSha } : {}),
    files: prFilePaths(extra.files),
    ...(v.rules.readable ? {} : { rulesUnreadable: true as const }),
    fetchedAt: new Date(extra.now).toISOString(),
  };
}

export type AutoMergeAssessment =
  | { kind: "ready" }
  | { kind: "merged" }
  | { kind: "wait"; detail: string }
  | { kind: "needs-you"; needsYou: "protection" | "merge"; reason: string }
  | { kind: "send-back"; reason: string };

/** First match wins; pure. */
export function assessAutoMerge(
  pr: PrSnapshot,
  verifiedSha: string,
): AutoMergeAssessment {
  const n = `PR #${pr.number}`;
  const needsYou = (
    kind: "protection" | "merge",
    reason: string,
  ): AutoMergeAssessment => ({ kind: "needs-you", needsYou: kind, reason });
  if (pr.state === "MERGED") return { kind: "merged" };
  if (pr.state === "CLOSED") return needsYou("merge", `${n} was closed`);
  if (pr.draft) return needsYou("merge", `${n} is a draft`);
  if (pr.headSha !== verifiedSha)
    return needsYou("merge", `${n} changed after verification`);
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return needsYou("protection", `Changes were requested on ${n}`);
  if (
    (pr.requiredApprovals > 0 || pr.reviewDecision === "REVIEW_REQUIRED") &&
    pr.reviewDecision !== "APPROVED"
  )
    return needsYou(
      "protection",
      `Branch protection requires a review on ${n}`,
    );
  // Without the rules, required checks and reviews are unknown.
  if (pr.rulesUnreadable)
    return needsYou(
      "protection",
      `Sessions could not read the branch rules for ${n}`,
    );
  if (pr.mergeable === "CONFLICTING")
    return needsYou("merge", `${n} has merge conflicts`);
  if (pr.failingChecks.length)
    return {
      kind: "send-back",
      reason: `Check ${pr.failingChecks[0]} failed on ${n}`,
    };
  const waiting = pr.pendingChecks.length + pr.missingRequired.length;
  if (waiting)
    return {
      kind: "wait",
      detail: `Waiting for ${waiting} ${waiting === 1 ? "check" : "checks"} on ${n}`,
    };
  if (pr.mergeStateStatus === "BEHIND" && pr.strictUpToDate)
    return needsYou("protection", `${n} must be updated with ${pr.base} first`);
  if (pr.mergeStateStatus === "BLOCKED")
    return needsYou("protection", `GitHub reports ${n} as blocked`);
  return { kind: "ready" };
}

export interface MergeGithub {
  verdict(t: PrReadinessTarget): Promise<PrMergeVerdict>;
  files(ghRepo: string, n: number): Promise<PrFileEntry[] | null>;
  mergeCommit(ghRepo: string, n: number): Promise<string | undefined>;
  mergeMethods(ghRepo: string): Promise<MergeMethod[]>;
  merge(
    ghRepo: string,
    n: number,
    o: { sha: string; method: MergeMethod; title: string },
    c: GithubCredential,
  ): Promise<GithubMergeResponse>;
  appCredential(ghRepo: string): Promise<GithubCredential>;
  /** POST /issues/:n/comments with `c`. */
  comment(
    ghRepo: string,
    n: number,
    body: string,
    c: GithubCredential,
  ): Promise<void>;
  /** Close an open pull request without merging it, with `c`. */
  close(ghRepo: string, n: number, c: GithubCredential): Promise<void>;
}

async function gh(args: string[], credential: GithubCredential) {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

function readCredential(ghRepo: string): Promise<GithubCredential> {
  return resolveGithubCredential(serviceGithubCredential, { repo: ghRepo });
}

function parseFileLine(line: string): PrFileEntry | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!Array.isArray(value) || typeof value[0] !== "string") return null;
    return typeof value[1] === "string"
      ? { filename: value[0], previous_filename: value[1] }
      : { filename: value[0] };
  } catch {
    return null;
  }
}

/** `gh api --paginate .../files` lines as entries. Null when a line is not
 *  one, or when the list reaches GitHub's cap: a cut list could hide a file
 *  outside the deploy's scope, so it reads as unreadable (outside scope). */
export function parsePrFileList(out: string): PrFileEntry[] | null {
  const files: PrFileEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseFileLine(line);
    if (!entry) return null;
    files.push(entry);
    if (files.length >= MAX_PR_FILES) return null;
  }
  return files;
}

export function defaultMergeGithub(): MergeGithub {
  return {
    verdict: (t) => githubForceMergeApi.verdict(t),
    mergeMethods: (repo) => githubForceMergeApi.mergeMethods(repo),
    merge: (repo, n, o, c) => githubForceMergeApi.merge(repo, n, o, c),
    appCredential: (repo) =>
      resolveGithubCredential(serviceGithubCredential, { write: true, repo }),
    comment: (repo, n, body, c) =>
      githubForceMergeApi.comment(repo, n, body, c),
    async close(ghRepo, n, c) {
      const { err, code } = await gh(
        [
          "api",
          "-X",
          "PATCH",
          `repos/${ghRepo}/pulls/${n}`,
          "-f",
          "state=closed",
        ],
        c,
      );
      if (code !== 0) throw new Error(parseGhApiError(err).message);
    },
    async files(ghRepo, n) {
      const { out, code } = await gh(
        [
          "api",
          "--paginate",
          `repos/${ghRepo}/pulls/${n}/files?per_page=100`,
          "--jq",
          ".[] | [.filename, .previous_filename] | @json",
        ],
        await readCredential(ghRepo),
      );
      if (code !== 0) return null;
      return parsePrFileList(out);
    },
    async mergeCommit(ghRepo, n) {
      const { out, err, code } = await gh(
        [
          "api",
          `repos/${ghRepo}/pulls/${n}`,
          "--jq",
          '.merge_commit_sha // ""',
        ],
        await readCredential(ghRepo),
      );
      if (code !== 0) throw new Error(parseGhApiError(err).message);
      const sha = out.trim();
      return FULL_SHA.test(sha) ? sha : undefined;
    },
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)) || "Failed";
}

export async function fetchPrSnapshot(
  input: { prUrl: string; repoId: string; now: number },
  github: MergeGithub,
  deps: { ghRepoOf: (repoId: string) => string | undefined } = {
    ghRepoOf: (id) => getRepo(id).ghRepo,
  },
): Promise<PrSnapshot | { error: string }> {
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed) return { error: "Not a GitHub pull request URL" };
  let own: string | undefined;
  try {
    own = deps.ghRepoOf(input.repoId);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  if (!own || own.toLowerCase() !== parsed.ghRepo.toLowerCase())
    return { error: "PR belongs to another repository" };
  try {
    const v = await github.verdict({
      repoId: input.repoId,
      ghRepo: parsed.ghRepo,
      number: parsed.number,
    });
    const files = await github
      .files(parsed.ghRepo, parsed.number)
      .catch(() => null);
    const mergeCommitSha =
      v.state === "MERGED"
        ? await github
            .mergeCommit(parsed.ghRepo, parsed.number)
            .catch(() => undefined)
        : undefined;
    return snapshotFromVerdict(v, { files, mergeCommitSha, now: input.now });
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/** Merges the verified SHA as the App, or says why not. Never throws. */
export async function mergeIncidentPr(
  input: {
    incidentId: string;
    pr: PrSnapshot;
    verifiedSha: string;
    title: string;
    now: number;
  },
  github: MergeGithub,
): Promise<MergeRecord> {
  const { pr, verifiedSha } = input;
  const base = {
    ghRepo: pr.ghRepo,
    number: pr.number,
    sha: verifiedSha,
    at: new Date(input.now).toISOString(),
  };
  let record: MergeRecord;
  const assessment = assessAutoMerge(pr, verifiedSha);
  if (assessment.kind !== "ready") {
    // Defence in depth: no merge call is ever made unless ready.
    record = {
      ...base,
      status: "refused",
      detail:
        assessment.kind === "needs-you" || assessment.kind === "send-back"
          ? assessment.reason
          : assessment.kind === "wait"
            ? assessment.detail
            : `PR #${pr.number} is already merged`,
    };
  } else {
    let method: MergeMethod | undefined;
    try {
      method = pickMergeMethod(await github.mergeMethods(pr.ghRepo));
      const response = await github.merge(
        pr.ghRepo,
        pr.number,
        {
          sha: verifiedSha,
          method,
          title: `${input.title} (#${pr.number})`,
        },
        await github.appCredential(pr.ghRepo),
      );
      if (response.ok) {
        record = {
          ...base,
          status: "merged",
          ...(response.sha ? { mergedSha: response.sha } : {}),
          method,
        };
      } else {
        const message =
          response.message.trim().replace(/\.$/, "") ||
          `HTTP ${response.status}`;
        record = {
          ...base,
          status: "refused",
          method,
          detail: `GitHub refused the merge: ${message}. Sessions never bypasses branch protection, so this needs you.`,
        };
      }
    } catch (error) {
      record = {
        ...base,
        status: "refused",
        ...(method ? { method } : {}),
        detail: errorMessage(error),
      };
    }
  }
  incidentAudit({
    kind: "incident_merge",
    incidentId: input.incidentId,
    ghRepo: pr.ghRepo,
    number: pr.number,
    sha: verifiedSha,
    method: record.method,
    status: record.status,
  });
  return record;
}
