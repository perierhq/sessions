// GitHub issues in any registered repository, with the GitHub App's
// repository-scoped credential (needs `issues: write`): the Plain agent's
// feature requests (agents/plain/api.ts, in the default repository) and
// support bug reports (support/bugs.ts, in the conversation's project).
// Visibility is asked of GitHub as repo-visibility.ts does (fail closed:
// unknown counts as public), but cached for a few minutes only, so a
// repository made public is noticed before the next issue. Nothing runs at
// import.
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** How long a visibility answer is trusted. */
export const VISIBILITY_TTL_MS = 5 * 60_000;

export interface GithubIssueDeps {
  /** The GitHub App's repository-scoped token for `ghRepo` (issues: write). */
  repositoryToken: (ghRepo: string) => Promise<string | null>;
  /** Any token that may read `ghRepo`'s metadata. */
  readToken: (ghRepo: string) => Promise<string | null>;
  now: () => number;
}

let override: Partial<GithubIssueDeps> | undefined;

/** Replace the tokens and clock (tests; fetch is stubbed on globalThis);
 *  undefined restores them. Also clears the visibility cache. */
export function __setGithubIssueDepsForTest(
  deps?: Partial<GithubIssueDeps>,
): void {
  override = deps;
  visibility.clear();
}

function deps(): GithubIssueDeps {
  return {
    repositoryToken:
      override?.repositoryToken ??
      (async (ghRepo) =>
        (await import("./github-app")).githubAppRepositoryToken(ghRepo)),
    readToken:
      override?.readToken ??
      (async (ghRepo) =>
        (await import("./github-limit")).botGhToken({ repo: ghRepo })),
    now: override?.now ?? Date.now,
  };
}

/** Creates an issue in `ghRepo` (`owner/name`); null when no App
 *  credential is configured or GitHub refuses it. */
export async function createRepoIssue(
  ghRepo: string,
  issue: { title: string; body: string; labels?: string[] },
): Promise<{ number: number; url: string; repo: string } | null> {
  if (!OWNER_NAME.test(ghRepo)) {
    console.error(
      "[github-issues] No GitHub repository to create the issue in",
    );
    return null;
  }
  const token = await deps().repositoryToken(ghRepo);
  if (!token) {
    console.error(`[github-issues] No GitHub App credential for ${ghRepo}`);
    return null;
  }
  try {
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${ghRepo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          ...(issue.labels ? { labels: issue.labels } : {}),
        }),
      },
    );
    if (!response.ok) {
      console.error(
        `[github-issues] Issue creation in ${ghRepo} failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
      return null;
    }
    const data = (await response.json()) as {
      number?: unknown;
      html_url?: unknown;
    };
    if (typeof data.number !== "number" || typeof data.html_url !== "string")
      return null;
    return { number: data.number, url: data.html_url, repo: ghRepo };
  } catch (error) {
    console.error(
      `[github-issues] Error creating an issue in ${ghRepo}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const visibility = new Map<string, { isPrivate: boolean; at: number }>();

/** True private, false public, null unknown; known answers are kept for
 *  VISIBILITY_TTL_MS. */
async function lookupPrivate(ghRepo: string): Promise<boolean | null> {
  const d = deps();
  const cached = visibility.get(ghRepo);
  if (cached && d.now() - cached.at < VISIBILITY_TTL_MS)
    return cached.isPrivate;
  const token = await d.readToken(ghRepo);
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${ghRepo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opensession",
        },
      },
      10_000,
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      private?: unknown;
    } | null;
    if (typeof data?.private !== "boolean") return null;
    visibility.set(ghRepo, { isPrivate: data.private, at: d.now() });
    return data.private;
  } catch {
    return null;
  }
}

/** Whether issue `number` of `ghRepo` is open or closed; null when it
 *  can't be read. */
export async function repoIssueState(
  ghRepo: string,
  number: number,
): Promise<"open" | "closed" | "completed" | null> {
  if (!OWNER_NAME.test(ghRepo) || !Number.isInteger(number) || number <= 0)
    return null;
  const token = await deps().readToken(ghRepo);
  if (!token) return null;
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${ghRepo}/issues/${number}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opensession",
        },
      },
      10_000,
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      state?: unknown;
      state_reason?: unknown;
    } | null;
    if (data?.state === "open") return "open";
    if (data?.state !== "closed") return null;
    // Closed as done, versus not planned, a duplicate or no reason given.
    return data.state_reason === "completed" ? "completed" : "closed";
  } catch {
    return null;
  }
}

/** Whether `ghRepo` is public; null when unknown. Callers treat null as
 *  public. */
export async function repoIsPublic(ghRepo: string): Promise<boolean | null> {
  if (!OWNER_NAME.test(ghRepo)) return null;
  const isPrivate = await lookupPrivate(ghRepo);
  return isPrivate === null ? null : !isPrivate;
}

// GitHub turns @name into a notification and #12, owner/name#12, GH-12 and
// issue or pull request URLs into cross-references (a backlink on the other
// issue). Inside a code span it does neither.
const GITHUB_REFS = new RegExp(
  [
    String.raw`https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull|discussions)\/\d+\S*`,
    String.raw`(?<![\w\`])[\w.-]+\/[\w.-]+#\d+\b`,
    String.raw`(?<![\w\`/])@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]+)?`,
    String.raw`(?<![\w\`&])#\d+\b`,
    String.raw`(?<![\w\`])GH-\d+\b`,
  ].join("|"),
  "g",
);

/** Every @mention and issue reference in `text` inside a code span, so an
 *  issue posted from it notifies nobody and links nowhere. */
export function neutralizeGithubRefs(text: string): string {
  return text.replace(GITHUB_REFS, (ref) => `\`${ref}\``);
}

// The local part allows the RFC 5322 atom characters; the domain needs a dot.
const EMAIL_ADDRESS =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Every email address in `text` as "[email removed]". */
export function stripEmailAddresses(text: string): string {
  return text.replace(EMAIL_ADDRESS, "[email removed]");
}
