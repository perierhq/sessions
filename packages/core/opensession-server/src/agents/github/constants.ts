/** Shared identifiers for the github PR agent. */

import {
  blobGithubPostingLogin,
  configuredIntegration,
  configuredRepos,
  defaultRepo,
  isGithubBotLogin,
  type Repo,
} from "../../server/config";

/**
 * The configured repo a webhook's `repository.full_name` belongs to, or null.
 * Events for unconfigured repos are dropped — the GitHub-side webhook config
 * is the outer gate, this is the inner one. Multi-repo: any repo in the
 * config registry participates once its GitHub webhook points here.
 */
export function repoForFullName(
  fullName: string | null | undefined,
): Repo | null {
  const lower = (fullName || "").trim().toLowerCase();
  if (!lower) return null;
  return (
    Object.values(configuredRepos()).find(
      (r) => r.ghRepo && r.ghRepo.toLowerCase() === lower,
    ) || null
  );
}

/**
 * Repo-qualified key for per-PR state files, locks, session ids, and
 * workspace keys. The DEFAULT repo keeps the bare PR number — back-compat
 * with every existing state file, `bks-ghpr-N-*` session, and `ghpr-N`
 * workspace — while other repos prefix their registry id.
 */
export function prKey(
  prNumber: number,
  ghRepo?: string | null,
  repos?: Record<string, Repo>,
): string {
  if (!ghRepo) return String(prNumber);
  repos ??= configuredRepos();
  if (ghRepo.toLowerCase() === defaultRepo(repos).ghRepo.toLowerCase()) {
    return String(prNumber);
  }
  const id =
    Object.values(repos).find(
      (repo) => repo.ghRepo.toLowerCase() === ghRepo.trim().toLowerCase(),
    )?.id || ghRepo.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${id}-${prNumber}`;
}

/** Internal/automation event key — the seeded automation subscribes to this. */
export const PR_EVENT_KEY = "github:pull_request";
/** Name of the seeded (disabled-by-default) review automation. */
export const REVIEW_AUTOMATION_NAME = "github-pr-review";

/** Internal event key published when a PR is merged into a registered repo. */
export const PR_MERGED_EVENT_KEY = "github:pr_merged";
/** Name of the seeded docs-sync automation (fires on PR merge). */
export const DOCS_SYNC_AUTOMATION_NAME = "docs-sync";
/** Branch prefix for docs-sync's own PRs — skipped on merge so it can't loop. */
export const DOCS_SYNC_BRANCH_PREFIX = "auto-docs-sync-";
/**
 * Slack channel where docs-sync announces the PRs it opens
 * (`integrations.github.docsSyncChannel`). Undefined when unconfigured — the
 * announcement is an optional courtesy, so docs-sync still runs without it.
 */
export function docsSyncChannel(): string | undefined {
  const configured = configuredIntegration("github").docsSyncChannel;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : undefined;
}

/** Slack channel where merged visual changes are shared with their walkthrough screenshot. */
export function shippedChangesChannel(): string | undefined {
  const configured = configuredIntegration("github").shippedChangesChannel;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : undefined;
}

/** PR trigger labels. */
export const LABEL_REVIEW = "os-review";
export const LABEL_AUTOFIX = "os-auto-fix";
export const LABEL_SIMPLIFY = "os-simplify";
export const LABEL_ADVERSARIAL = "os-adversarial";
/** Issue trigger label: starts a code session for a plain (non-PR) issue. */
export const LABEL_ISSUE = "os";
/** Every label that starts or steers an agent loop. */
export const TRIGGER_LABELS = [
  LABEL_REVIEW,
  LABEL_AUTOFIX,
  LABEL_SIMPLIFY,
  LABEL_ADVERSARIAL,
  LABEL_ISSUE,
] as const;

/** Ends every post by Blob on GitHub (server/github-blob.ts), from its
 *  machine user or from the owner's account. */
export const BLOB_MARKER = "<!-- os:blob -->";

/** Whether a GitHub comment is Blob's post: it carries the marker and its
 *  author is Blob's recorded login (`integrations.github.blob.login`, the
 *  owner's login when Blob posts as the owner's account) or one of our bot
 *  logins (the App's, Blob's machine user). Anyone can type the marker, so
 *  it alone proves nothing; a post by the owner without it stays a
 *  person's. */
export function isBlobPost(comment: {
  login?: string | null;
  body?: string | null;
}): boolean {
  if (!comment.body?.includes(BLOB_MARKER)) return false;
  const login = comment.login?.trim();
  if (!login) return false;
  const recorded = blobGithubPostingLogin();
  return (
    (!!recorded && login.toLowerCase() === recorded.toLowerCase()) ||
    isGithubBotLogin(login)
  );
}

export function labelMatches(name: string, expected: string): boolean {
  return name === expected;
}

export function labelAliases(label: string): string[] {
  return [label];
}
