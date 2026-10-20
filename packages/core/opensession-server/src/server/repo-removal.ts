/**
 * Removing a registered repository (Settings → Repositories → Remove…).
 *
 * Removal takes the repository out of the registry, so it leaves the sidebar
 * and every new-session picker. Its live sessions are archived first through
 * the same path a manual archive takes (session-archive.ts), so their runs,
 * Portals, containers and units are torn down. A repository with a running
 * session is refused (409) instead: stopping someone's turn is a decision for
 * the person watching it, not a side effect of tidying Settings.
 *
 * Per-repository state that would otherwise keep naming the removed id is
 * forgotten: the workspace's new-session default, sandbox overrides and
 * keep-ready targets, warm-template settings, and each person's new-session
 * preference and repo band order.
 *
 * Deleting files is opt-in and narrow. Only a checkout the server itself made
 * qualifies: a clone or a repository started here, sitting directly inside the
 * managed checkouts root (paths.ts managedCheckoutsRoot). A folder registered
 * from disk (`addedFrom: "local"`), anything outside that root, a symlink, a
 * path another registered repository uses, and the root itself are never
 * deleted. Every path is resolved to its real location before it is compared,
 * so a symlink cannot point the delete somewhere else. With deletion, the
 * repository's worktrees (those inside the worktree root) go first, through
 * `git worktree remove --force`, then the checkout, then the bare origin a
 * repository started here keeps beside it.
 */

import { lstat, realpath, stat } from "fs/promises";
import { basename, dirname, isAbsolute } from "path";
import { audit } from "./audit";
import {
  canonicalRepoId,
  configuredPaths,
  configuredRepos,
  type Repo,
} from "./config";
import {
  persistRawConfigAsync,
  rawConfigAsync,
  reposForMutation,
  withConfigMutationLock,
} from "./config-mutation";
import { managedCheckoutsRoot } from "./paths";
import type { UnifiedSession } from "./types";
import { removeTree } from "./workload-scope";

export interface RepoRemovalPreview {
  id: string;
  label: string;
  /** The checkout path as registered. */
  path: string;
  /** Live (not archived) sessions on the repository; removal archives them. */
  sessions: number;
  /** Of those, how many are running now. Removal is refused while any are. */
  running: number;
  /** Whether "Also delete its files" may be chosen. */
  deletable: boolean;
  /** Why not, in one line, when it may not. */
  reason?: string;
  /** What deleting would remove: the checkout, and a local origin beside it. */
  deletePaths?: string[];
  /** Worktrees deleting would remove with it. */
  worktrees?: number;
  /** Disk used by `deletePaths`, when it could be measured quickly. */
  sizeBytes?: number | null;
}

export interface RepoRemovalResult {
  id: string;
  /** Sessions archived by the removal. */
  archived: number;
  /** Paths deleted from disk (checkout, origin, worktrees). */
  deleted: string[];
  /** Paths deletion was asked for but could not remove. */
  kept: string[];
}

export class RepoRemovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RepoRemovalError";
  }
}

/** The seams removal reaches the session layer through. The defaults load
 *  lazily: the session cache and the archive path pull in the run engine,
 *  which the setup routes otherwise never need. */
export interface RepoRemovalDeps {
  /** Every session that is not archived, with fresh run state. */
  liveSessions(): Promise<UnifiedSession[]>;
  /** Archive these sessions through the manual archive path. */
  archiveSessions(sessions: UnifiedSession[]): Promise<void>;
  /** Clear the parked draft and pin of each workspace defaulting to `repoId`
   *  that no live session keeps alive. */
  releaseWorkspaces(repoId: string, live: UnifiedSession[]): Promise<void>;
  /** Stop Portals and setup still running in a directory about to go. */
  stopWorkloadsInDir(dir: string): Promise<void>;
}

const defaultDeps: RepoRemovalDeps = {
  async liveSessions() {
    const [{ getSessionListSnapshotAsync, enrichSessionRuntime }, archive] =
      await Promise.all([import("./session-cache"), import("./archive")]);
    const sessions = await getSessionListSnapshotAsync("exclude");
    return enrichSessionRuntime(
      sessions.filter((s) => !s.archived && !archive.isArchivedId(s.id)),
    );
  },
  async archiveSessions(sessions) {
    const { archiveSessions } = await import("./session-archive");
    await archiveSessions(sessions);
  },
  async releaseWorkspaces(repoId, live) {
    const [{ listWorkspaces, updateWorkspace }, { unpinEverywhere }] =
      await Promise.all([import("./workspaces"), import("./pins")]);
    const workspaces = (await listWorkspaces()).filter(
      (ws) => ws.repo === repoId && !live.some((s) => s.workspaceId === ws.id),
    );
    for (const ws of workspaces) {
      if (ws.draft) await updateWorkspace(ws.id, { draft: null });
    }
    if (workspaces.length)
      await unpinEverywhere(workspaces.map((ws) => `workspace:${ws.id}`));
  },
  async stopWorkloadsInDir(dir) {
    const [{ stopAllPortalServices }, { stopSessionResourcesInDir }] =
      await Promise.all([
        import("./portal-supervisor"),
        import("./session-resources"),
      ]);
    await stopAllPortalServices({
      sessionId: "repo-removal",
      worktreeDir: dir,
    }).catch(() => {});
    await stopSessionResourcesInDir(dir).catch(() => {});
  },
};

let deps: RepoRemovalDeps = defaultDeps;

/** Test seam: stand in for the session layer. Pass null to restore it. */
export function __setRepoRemovalDepsForTest(
  override: Partial<RepoRemovalDeps> | null,
): void {
  deps = override ? { ...defaultDeps, ...override } : defaultDeps;
}

/** Ids being removed right now, so a double click cannot run two removals. */
const removing = new Set<string>();

function registeredRepo(id: string): Repo | null {
  const repos = configuredRepos();
  return Object.hasOwn(repos, id) ? repos[id] : null;
}

/**
 * The repository a session's own work is in, decided from the record alone.
 * `worktree.ts` sessionRepoId answers the same question but may read the
 * disk (realpath, the worktree's .git pointer), which the gateway thread must
 * not do once per session. A session without a recorded `repo` belongs to
 * the registered checkout its worktree sits in, or to the repository whose
 * worktree prefix its directory carries (longest prefix wins, as there).
 */
function recordedRepoId(
  session: UnifiedSession,
  repos: Record<string, Repo>,
  worktreesDir: string,
): string | undefined {
  if (session.repo) return canonicalRepoId(session.repo);
  const dir = session.worktreeDir;
  if (!dir) return undefined;
  for (const repo of Object.values(repos))
    if (within(dir, repo.repo)) return repo.id;
  let best: Repo | undefined;
  for (const repo of Object.values(repos)) {
    if (!dir.startsWith(`${worktreesDir}/${repo.wtPrefix}-`)) continue;
    if (!best || repo.wtPrefix.length > best.wtPrefix.length) best = repo;
  }
  return best?.id;
}

/** The live sessions whose own work is in `repoId`. Attached (secondary)
 *  repositories do not count: the session belongs to its primary repo. */
export function sessionsOfRepo(
  sessions: UnifiedSession[],
  repoId: string,
): UnifiedSession[] {
  const repos = configuredRepos();
  const worktreesDir = configuredPaths().worktreesDir;
  return sessions.filter(
    (session) =>
      !session.archived &&
      !session.repoLess &&
      recordedRepoId(session, repos, worktreesDir) === repoId,
  );
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `a` is `b` or sits inside it. */
function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

async function git(
  argv: string[],
  timeoutMs = 30_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timer)),
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr: stderr.trim() };
}

/** One line on why a repository's files stay, shown under the checkbox. */
const KEEP_REASON = {
  local: "Added from an existing folder, so its files stay",
  outside: "Not in ~/checkouts, so its files stay",
  shared: "Another repository uses this folder",
  server: "This server runs from this folder",
  missing: "Its folder is no longer on this machine",
} as const;

interface FilePlan {
  deletable: boolean;
  reason?: string;
  checkout?: string;
  origin?: string;
  worktrees: string[];
}

/**
 * Decide what deleting `repo`'s files would remove, or why nothing may be.
 * Every comparison runs on real paths. The checkout must be a real directory
 * (not a symlink) whose real parent IS the managed root's real path, so a
 * nested, escaped or root path can never qualify.
 */
export async function planRepoFileDeletion(
  repo: Repo,
  registered: Record<string, Repo> = configuredRepos(),
): Promise<FilePlan> {
  const keep = (reason: string): FilePlan => ({
    deletable: false,
    reason,
    worktrees: [],
  });
  if (repo.addedFrom === "local") return keep(KEEP_REASON.local);
  if (!(await exists(repo.repo))) return keep(KEEP_REASON.missing);
  const root = await realpathOrNull(managedCheckoutsRoot());
  if (!root || root === "/") return keep(KEEP_REASON.outside);
  if (await isSymlink(repo.repo)) return keep(KEEP_REASON.outside);
  const checkout = await realpathOrNull(repo.repo);
  if (!checkout || checkout === root || dirname(checkout) !== root)
    return keep(KEEP_REASON.outside);
  if (!(await stat(checkout)).isDirectory()) return keep(KEEP_REASON.outside);

  const others = Object.values(registered).filter((r) => r.id !== repo.id);
  const otherPaths = (
    await Promise.all(others.map((r) => realpathOrNull(r.repo)))
  ).filter((p): p is string => !!p);
  if (otherPaths.some((p) => within(p, checkout) || within(checkout, p)))
    return keep(KEEP_REASON.shared);
  const serverDir = await realpathOrNull(import.meta.dir);
  const cwd = await realpathOrNull(process.cwd());
  if (
    (serverDir && within(serverDir, checkout)) ||
    (cwd && within(cwd, checkout))
  )
    return keep(KEEP_REASON.server);

  return {
    deletable: true,
    checkout,
    origin: await localOriginToDelete(repo, checkout, root, others),
    worktrees: await worktreesToDelete(checkout, otherPaths),
  };
}

/**
 * The bare origin a repository started here keeps beside its checkout
 * (`~/checkouts/<id>.git`). Deleted with the checkout, since it is the same
 * project's history and nothing else points at it. Only a real, non-symlink
 * `.git` directory directly in the managed root that no other registered
 * repository uses as its origin or checkout qualifies.
 */
async function localOriginToDelete(
  repo: Repo,
  checkout: string,
  root: string,
  others: Repo[],
): Promise<string | undefined> {
  if (repo.addedFrom !== undefined && repo.addedFrom !== "new") return;
  const url = await git(["-C", checkout, "remote", "get-url", "origin"]);
  const raw = url.stdout.trim();
  if (url.exitCode !== 0 || !isAbsolute(raw)) return;
  if (await isSymlink(raw)) return;
  const origin = await realpathOrNull(raw);
  if (!origin || dirname(origin) !== root || !basename(origin).endsWith(".git"))
    return;
  if (!(await stat(origin)).isDirectory()) return;
  for (const other of others) {
    const otherCheckout = await realpathOrNull(other.repo);
    if (otherCheckout && within(otherCheckout, origin)) return;
    if (!otherCheckout) continue;
    const otherUrl = await git([
      "-C",
      otherCheckout,
      "remote",
      "get-url",
      "origin",
    ]);
    const otherOrigin = otherUrl.stdout.trim();
    if (
      otherUrl.exitCode === 0 &&
      isAbsolute(otherOrigin) &&
      (await realpathOrNull(otherOrigin)) === origin
    )
      return;
  }
  return origin;
}

/** The checkout's linked worktrees that live directly in the worktree root.
 *  One somewhere else (made by hand) is left alone. */
async function worktreesToDelete(
  checkout: string,
  otherPaths: string[],
): Promise<string[]> {
  const wtRoot = await realpathOrNull(configuredPaths().worktreesDir);
  if (!wtRoot || wtRoot === "/") return [];
  const listed = await git(["-C", checkout, "worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) return [];
  const out: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (await isSymlink(path)) continue;
    const real = await realpathOrNull(path);
    if (!real || real === checkout || dirname(real) !== wtRoot) continue;
    if (otherPaths.some((p) => within(p, real) || within(real, p))) continue;
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** Kilobytes used under `paths`, or null when `du` cannot answer in time.
 *  A preview must stay quick; a huge tree just shows no size. */
async function diskUsageBytes(paths: string[]): Promise<number | null> {
  if (!paths.length) return null;
  const proc = Bun.spawn(["du", "-sk", "--", ...paths], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(9), 2_000);
  const [exitCode, stdout] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timer)),
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) return null;
  let kb = 0;
  for (const line of stdout.split("\n")) {
    const n = Number.parseInt(line, 10);
    if (Number.isFinite(n)) kb += n;
  }
  return kb * 1024;
}

/** What removing `id` would do, for the confirmation dialog. Null when no
 *  repository is registered under it. */
export async function repoRemovalPreview(
  id: string,
): Promise<RepoRemovalPreview | null> {
  const repo = registeredRepo(id);
  if (!repo) return null;
  const [live, plan] = await Promise.all([
    deps.liveSessions(),
    planRepoFileDeletion(repo),
  ]);
  const sessions = sessionsOfRepo(live, id);
  const deletePaths = plan.deletable
    ? [plan.checkout!, ...(plan.origin ? [plan.origin] : [])]
    : undefined;
  return {
    id,
    label: repo.label,
    path: repo.repo,
    sessions: sessions.length,
    running: sessions.filter((s) => s.isRunning).length,
    deletable: plan.deletable,
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(deletePaths
      ? {
          deletePaths,
          worktrees: plan.worktrees.length,
          sizeBytes: await diskUsageBytes(deletePaths),
        }
      : {}),
  };
}

function runningMessage(count: number): string {
  return `Stop ${count} running ${count === 1 ? "session" : "sessions"} first`;
}

async function deleteWorktree(checkout: string, path: string): Promise<void> {
  await deps.stopWorkloadsInDir(path);
  await git(["-C", checkout, "worktree", "remove", "--force", path], 120_000);
  if (await exists(path)) await removeTree(path);
}

async function deleteFiles(plan: FilePlan): Promise<{
  deleted: string[];
  kept: string[];
}> {
  const deleted: string[] = [];
  const kept: string[] = [];
  const settle = async (path: string) => {
    if (await exists(path)) kept.push(path);
    else deleted.push(path);
  };
  for (const wt of plan.worktrees) {
    await deleteWorktree(plan.checkout!, wt);
    await settle(wt);
  }
  await deps.stopWorkloadsInDir(plan.checkout!);
  await removeTree(plan.checkout!);
  await settle(plan.checkout!);
  if (plan.origin) {
    await removeTree(plan.origin);
    await settle(plan.origin);
  }
  return { deleted, kept };
}

/** Forget what other stores keep under the removed id. Each step is
 *  best-effort: the registry change has already landed, and a leftover entry
 *  is inert (nothing resolves a repository that is not registered). */
async function forgetRepoState(id: string): Promise<void> {
  const steps: Array<() => unknown> = [
    async () => (await import("./sandbox/config")).forgetRepoSandboxConfig(id),
    async () => (await import("./warm-template")).forgetWarmTemplateConfig(id),
    async () => (await import("./ui-prefs")).forgetRepoInUiPrefs(id),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.warn(`[repo-removal] could not forget state for ${id}:`, error);
    }
  }
}

/**
 * Remove a registered repository. Throws RepoRemovalError with the HTTP
 * status to answer: 404 unknown, 409 running sessions or a removal already
 * under way, 400 a refused file deletion. Nothing is changed when it throws
 * before archiving begins.
 */
export async function removeRepo(
  id: string,
  opts: { deleteFiles: boolean; by?: string | null },
): Promise<RepoRemovalResult> {
  const repo = registeredRepo(id);
  if (!repo) throw new RepoRemovalError(`Unknown repository: ${id}`, 404);
  if (removing.has(id))
    throw new RepoRemovalError(`${repo.label} is already being removed`, 409);
  removing.add(id);
  try {
    const sessions = sessionsOfRepo(await deps.liveSessions(), id);
    const running = sessions.filter((s) => s.isRunning).length;
    if (running)
      throw new RepoRemovalError(runningMessage(running), 409, { running });
    const plan = opts.deleteFiles ? await planRepoFileDeletion(repo) : null;
    if (plan && !plan.deletable)
      throw new RepoRemovalError(
        plan.reason || "These files cannot be deleted",
        400,
      );

    await deps.archiveSessions(sessions);
    await deps.releaseWorkspaces(id, await deps.liveSessions());

    const removed = await withConfigMutationLock(async () => {
      if (!registeredRepo(id)) return false;
      const config = await rawConfigAsync();
      const repos = reposForMutation(config);
      delete repos[id];
      if (config.newSessionRepo === id) delete config.newSessionRepo;
      await persistRawConfigAsync(config);
      return true;
    });
    if (!removed) throw new RepoRemovalError(`Unknown repository: ${id}`, 404);

    await forgetRepoState(id);
    const files = plan ? await deleteFiles(plan) : { deleted: [], kept: [] };
    audit({
      kind: "setup_repo_remove",
      id,
      path: repo.repo,
      archived: sessions.length,
      deleteFiles: opts.deleteFiles,
      ...(files.deleted.length ? { deleted: files.deleted } : {}),
      ...(files.kept.length ? { kept: files.kept } : {}),
      by: opts.by || null,
    });
    return { id, archived: sessions.length, ...files };
  } finally {
    removing.delete(id);
  }
}
