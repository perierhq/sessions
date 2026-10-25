// GitHub issues in any registered repository, with the GitHub App's
// repository-scoped credential (needs `issues: write`): the Plain agent's
// feature requests (agents/plain/api.ts, in the default repository) and
// support bug reports (support/bugs.ts, in the conversation's project).
// Visibility comes from repo-visibility.ts, which fails closed. Nothing
// runs at import.
import { repoIsPrivate } from "./repo-visibility";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  const { githubAppRepositoryToken } = await import("./github-app");
  const token = await githubAppRepositoryToken(ghRepo);
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

/** Whether `ghRepo` is public; null when unknown. Callers treat null as
 *  public. */
export async function repoIsPublic(ghRepo: string): Promise<boolean | null> {
  if (!OWNER_NAME.test(ghRepo)) return null;
  const isPrivate = await repoIsPrivate(ghRepo);
  return isPrivate === null ? null : !isPrivate;
}

// The local part allows the RFC 5322 atom characters; the domain needs a dot.
const EMAIL_ADDRESS =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Every email address in `text` as "[email removed]". */
export function stripEmailAddresses(text: string): string {
  return text.replace(EMAIL_ADDRESS, "[email removed]");
}
