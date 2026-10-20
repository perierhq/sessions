/**
 * Repositories being removed right now (repo-removal.ts), so nothing starts
 * new work in one while its sessions are archived and its files deleted.
 *
 * Removal marks the id under the config mutation lock, then checks for live
 * sessions; session create, attach-repo, primary-repo switch, run admission
 * and worktree creation check the mark. A session that slipped in before the
 * mark is caught by removal's own re-check after the config entry is gone.
 *
 * In-process only, and deliberately import-light: the run and create paths
 * reach it on every turn.
 */

import { canonicalRepoId, configuredRepos, type Repo } from "./config";

const g = globalThis as unknown as { __reposBeingRemoved?: Set<string> };
const removing: Set<string> = (g.__reposBeingRemoved ??= new Set());

export class RepoBeingRemovedError extends Error {
  constructor(readonly repoId: string) {
    super(repoBeingRemovedMessage(repoId));
    this.name = "RepoBeingRemovedError";
  }
}

export function repoBeingRemovedMessage(repoId: string): string {
  return `The repository "${repoId}" is being removed from this server, so it can't start new work`;
}

/** Mark `repoId` as being removed. False when it already is. Call under the
 *  config mutation lock, so the mark and the registry agree. */
export function markRepoRemoving(repoId: string): boolean {
  if (removing.has(repoId)) return false;
  removing.add(repoId);
  return true;
}

export function unmarkRepoRemoving(repoId: string): void {
  removing.delete(repoId);
}

export function isRepoBeingRemoved(repoId: string | null | undefined): boolean {
  if (!repoId || !removing.size) return false;
  return removing.has(repoId) || removing.has(canonicalRepoId(repoId));
}

/** Throw RepoBeingRemovedError when `repoId` is being removed. */
export function assertRepoNotBeingRemoved(
  repoId: string | null | undefined,
): void {
  if (repoId && isRepoBeingRemoved(repoId))
    throw new RepoBeingRemovedError(repoId);
}

/** Shown when a session's repository has been removed from the registry. */
export function repoNotRegisteredMessage(repoId: string): string {
  return `This session's repository "${repoId}" is no longer on this server. Add it again in Settings → Repositories to continue.`;
}

/**
 * Why a session can't run or be brought back: its repository (or one it has
 * attached) is being removed, or its own repository is no longer
 * registered. Null when nothing stands in the way. Sessions that never
 * recorded a repository are left to the paths that resolve one.
 */
export function sessionRepoBlocker(session: {
  repo?: string;
  repoLess?: boolean;
  attachedRepos?: ReadonlyArray<{ repo: string }>;
}): string | null {
  for (const attached of session.attachedRepos ?? [])
    if (isRepoBeingRemoved(attached.repo))
      return repoBeingRemovedMessage(attached.repo);
  if (session.repoLess || !session.repo) return null;
  const id = session.repo;
  if (isRepoBeingRemoved(id)) return repoBeingRemovedMessage(id);
  const repos = configuredRepos();
  if (Object.hasOwn(repos, id) || Object.hasOwn(repos, canonicalRepoId(id)))
    return null;
  return repoNotRegisteredMessage(id);
}

/** The registered repository a session recorded, or a clear error when it
 *  is no longer registered (instead of worktree.ts getRepo's bare
 *  "Unknown repo"). */
export function sessionRepoOrThrow(repoId: string): Repo {
  const repos = configuredRepos();
  if (Object.hasOwn(repos, repoId)) return repos[repoId];
  const canonical = canonicalRepoId(repoId);
  if (Object.hasOwn(repos, canonical)) return repos[canonical];
  throw new Error(repoNotRegisteredMessage(repoId));
}
