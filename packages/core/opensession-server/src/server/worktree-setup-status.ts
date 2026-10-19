/**
 * Setup outcomes per worktree, for the sessions that work in it.
 *
 * Fresh-worktree setup runs in the background after the worktree exists,
 * often before the session that will use it is recorded, so the outcome is
 * kept by directory. A failure stays until the next setup attempt for that
 * directory starts, or the worktree is removed. Session payloads read it as
 * `setupFailure` (see sessionSetupFailure).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { statePath } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

export type WorktreeSetupFailure = {
  reason: "timed_out" | "failed";
  message: string;
  at: string;
};

type Store = Record<string, WorktreeSetupFailure>;

let cache: { path: string; store: Store } | null = null;

function storePath(): string {
  return statePath(".opensession-worktree-setup-status.json");
}

function load(): Store {
  const path = storePath();
  if (cache?.path === path) return cache.store;
  let store: Store = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        store = parsed as Store;
    }
  } catch {}
  cache = { path, store };
  return store;
}

function save(store: Store): void {
  const path = storePath();
  cache = { path, store };
  writeJsonAtomic(path, store);
}

function key(dir: string): string {
  return resolve(dir);
}

export function recordWorktreeSetupFailure(
  dir: string,
  failure: WorktreeSetupFailure,
): void {
  save({ ...load(), [key(dir)]: failure });
}

/** Forget a directory's outcome. Returns whether one was recorded. */
export function clearWorktreeSetupFailure(dir: string): boolean {
  const store = load();
  if (!(key(dir) in store)) return false;
  const next = { ...store };
  delete next[key(dir)];
  save(next);
  return true;
}

export function worktreeSetupFailure(
  dir: string | null | undefined,
): WorktreeSetupFailure | undefined {
  return dir ? load()[key(dir)] : undefined;
}

/** The setup failure, if any, of the session's worktree or attached repos. */
export function sessionSetupFailure(session: {
  worktreeDir?: string | null;
  attachedRepos?: ReadonlyArray<{ dir?: string | null }>;
}): WorktreeSetupFailure | undefined {
  for (const dir of [
    session.worktreeDir,
    ...(session.attachedRepos ?? []).map((repo) => repo.dir),
  ]) {
    const failure = worktreeSetupFailure(dir);
    if (failure) return failure;
  }
  return undefined;
}

/** Drop outcomes for directories that no longer exist. */
export function pruneWorktreeSetupFailures(): number {
  const store = load();
  const gone = Object.keys(store).filter((dir) => !existsSync(dir));
  if (!gone.length) return 0;
  const next = { ...store };
  for (const dir of gone) delete next[dir];
  save(next);
  return gone.length;
}
