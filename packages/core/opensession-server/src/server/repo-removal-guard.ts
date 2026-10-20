/**
 * Repositories being removed right now (repo-removal.ts), so nothing starts
 * new work in one while its sessions are archived and its files deleted.
 *
 * Removal marks the id under the config mutation lock, then checks for live
 * sessions; every session create path, attach-repo, primary-repo switch, run
 * admission, automation runs, the ask checkout and worktree creation check
 * the mark, and registering the same id again is refused until it clears. A
 * session that slipped in before the mark is caught by removal's own
 * re-check after the config entry is gone. The folders a removal deletes are
 * recorded too, so no other registration can claim one meanwhile.
 *
 * In-process only, and deliberately import-light: the run and create paths
 * reach it on every turn.
 */

import { canonicalRepoId, configuredRepos, type Repo } from "./config";

const g = globalThis as unknown as {
  __reposBeingRemoved?: Set<string>;
  __repoPathsBeingDeleted?: Map<string, string[]>;
};
const removing: Set<string> = (g.__reposBeingRemoved ??= new Set());
/** The folders each removal is deleting, by repository id. */
const deleting: Map<string, string[]> = (g.__repoPathsBeingDeleted ??=
  new Map());

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
  deleting.delete(repoId);
}

/** Record the folders a removal of `repoId` is about to delete, so nothing
 *  registers one of them (under another id) until it is done. Cleared with
 *  the removal mark. */
export function markRepoPathsDeleting(repoId: string, paths: string[]): void {
  deleting.set(repoId, [...paths]);
}

/** One of `paths` (a folder and its real location) is, holds or sits inside a
 *  folder a removal is deleting. */
export function isPathBeingDeleted(paths: ReadonlyArray<string>): boolean {
  if (!deleting.size) return false;
  const inside = (a: string, b: string) =>
    a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
  for (const planned of deleting.values())
    for (const target of planned)
      for (const path of paths)
        if (inside(path, target) || inside(target, path)) return true;
  return false;
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

/**
 * Throw RepoBeingRemovedError when a session being created would work in a
 * repository that is being removed: its own (`repoId`, absent for a
 * repo-less create) or one it attaches.
 */
export function assertCreateReposNotBeingRemoved(spec: {
  repoId?: string;
  attachRepos?: { repos: ReadonlyArray<string> };
}): void {
  assertRepoNotBeingRemoved(spec.repoId);
  for (const id of spec.attachRepos?.repos ?? []) assertRepoNotBeingRemoved(id);
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
