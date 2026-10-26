/**
 * The time-aware trust rule for mail history (spec rule 4): a reply we sent
 * may back an automatic reply only when nothing it could depend on changed
 * after it was written.
 *
 * In order: a release published after the answer makes it reference; so
 * does a default-branch commit after the answer that touches what the pair
 * touches (an empty touch set counts as all of `docs/` and `README.md`, so a
 * vague question fails closed). Otherwise the answer is trusted as of its
 * day and the default-branch commit current then. Any signal that can't be
 * read, including a missing commit for `validAsOfCommit`, makes it
 * reference. Pure over the injected signals (freshness/github.ts
 * latestRelease, freshness/repo-changes.ts latestChange and commitAt).
 */
import type { KnowledgeTrust } from "../../../shared/knowledge";
import type { ReleaseInfo } from "../freshness/github";
import type { RepoCommit } from "../freshness/repo-changes";

/** What a pair with no recognisable touched paths is taken to touch. */
export const DOCS_FALLBACK = ["docs/", "README.md"];

export const HISTORY_UNREADABLE = "History couldn't be read";

export interface TrustInput {
  /** When our reply was sent, ISO 8601. */
  answeredAt: string;
  /** Repo paths the pair touches (extractPair); `dir/` is a folder. */
  touchedPaths: string[];
}

export interface TrustDeps {
  /** The newest published release; null when the project has no GitHub
   *  repository or no releases. Must THROW when the releases can't be read
   *  (freshness/github.ts latestRelease does), so an outage is reference
   *  ("History couldn't be read"), never "nothing released". */
  latestRelease(): Promise<ReleaseInfo | null>;
  /** The newest default-branch commit touching any of `paths`. */
  latestChange(paths: string[]): Promise<RepoCommit | null>;
  /** The default-branch commit current at `at`. */
  commitAt(at: string): Promise<string | null>;
}

export interface TrustDecision {
  trust: KnowledgeTrust;
  /** Why the item is reference only; null when trusted. */
  reason: string | null;
  dependsOn: string[];
  /** The answer's day, YYYY-MM-DD (UTC). */
  validAsOf: string;
  /** Set only when trusted. */
  validAsOfCommit?: string;
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export async function mailTrust(
  input: TrustInput,
  deps: TrustDeps,
): Promise<TrustDecision> {
  const answered = Date.parse(input.answeredAt);
  if (!Number.isFinite(answered))
    throw new Error(`Not a date: ${input.answeredAt.slice(0, 80)}`);
  const paths = input.touchedPaths.length
    ? [...new Set(input.touchedPaths)]
    : DOCS_FALLBACK;
  const base = {
    dependsOn: paths.map((p) => `repo:${p}`),
    validAsOf: day(input.answeredAt),
  };
  const reference = (reason: string): TrustDecision => ({
    trust: "reference",
    reason,
    ...base,
  });

  try {
    const release = await deps.latestRelease();
    if (release && Date.parse(release.at) > answered)
      return reference(
        `Answered before release ${release.tag} (${day(release.at)})`,
      );

    const change = await deps.latestChange(paths);
    if (change && Date.parse(change.at) > answered) {
      const path = change.paths[0] ?? paths[0];
      return reference(
        `Answered before ${path} changed in ${change.sha.slice(0, 7)} (${day(change.at)})`,
      );
    }

    const commit = await deps.commitAt(input.answeredAt);
    if (!commit || !FULL_SHA.test(commit)) return reference(HISTORY_UNREADABLE);
    return {
      trust: "trusted",
      reason: null,
      ...base,
      validAsOfCommit: commit.toLowerCase(),
    };
  } catch {
    return reference(HISTORY_UNREADABLE);
  }
}
