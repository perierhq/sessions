/**
 * Removing a registered repository (Settings → Repositories → Remove…).
 *
 * Removal takes the repository out of the registry, so it leaves the sidebar
 * and every new-session picker. Its live sessions are archived first through
 * the same path a manual archive takes (session-archive.ts), so their runs,
 * Portals, containers and units are torn down. Removal is refused (409)
 * while any of its sessions is running, or while a live session of another
 * repository has it attached: stopping someone's turn or pulling a repository
 * out from under their session is a decision for the person watching it, not
 * a side effect of tidying Settings.
 *
 * Per-repository state that would otherwise keep naming the removed id is
 * forgotten: the workspace's new-session default, sandbox overrides and
 * keep-ready targets, warm-template settings, each person's new-session
 * preference and repo band order, and the workspaces that default to it.
 * Automations that target it are turned off.
 *
 * Deleting files is opt-in and comes in tiers (planRepoFileDeletion):
 *
 *  - managed: the server cloned or created the folder (`addedFrom` github,
 *    codestorage or new). A checkbox is enough.
 *  - unverified: an entry from before `addedFrom` existed, or a clone whose
 *    folder was already there (`adopted`). The server can't tell whether it
 *    made the folder, so the person must type the repository id.
 *  - never: a folder registered from disk (`local`), anything outside the
 *    managed checkouts root, a symlink, the root itself, a path another
 *    registered repository uses, and the server's own folder.
 *
 * Every path is resolved to its real location before it is compared, so a
 * symlink cannot point the delete somewhere else. The preview hands out a
 * plan token (a hash of the tier and every path); a delete must send it back,
 * so what is deleted is exactly what the person reviewed.
 *
 * While a removal runs, the id is marked (repo-removal-guard.ts) so session
 * create, attach-repo and run admission refuse it. After the config entry is
 * gone, removal takes a fresh session snapshot and recomputes the plan; if a
 * session appeared or the plan changed, the files stay and the result says
 * so. Once the config entry is gone the removal has happened: later failures
 * are reported in the result (`kept`, `error`), never as a failed request.
 */

import { createHash } from "crypto";
import { lstat, readFile, realpath, stat, unlink } from "fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { auditAsync, auditDurable } from "./audit";
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
import {
  markRepoPathsDeleting,
  markRepoRemoving,
  unmarkRepoRemoving,
} from "./repo-removal-guard";
import type { UnifiedSession } from "./types";
import { removeTree } from "./workload-scope";

/** How far deleting a repository's files may go. See the file comment. */
export type RepoDeleteTier = "managed" | "unverified" | "never";

export interface RepoRemovalPreview {
  id: string;
  label: string;
  /** The checkout path as registered. */
  path: string;
  /** Live (not archived) sessions on the repository; removal archives them. */
  sessions: number;
  /** Of those, how many are running now. Removal is refused while any are. */
  running: number;
  /** Live sessions of other repositories that have this one attached.
   *  Removal is refused while any do. */
  attached: number;
  /** Those sessions, so the dialog can name them. */
  attachedSessions: Array<{ id: string; title: string }>;
  /** Enabled automations targeting it; removal turns them off. */
  automations: number;
  /** Whether "Also delete its files" may be chosen. */
  deletable: boolean;
  tier: RepoDeleteTier;
  /** Deleting needs the repository id typed in (`unverified`). */
  confirmRequired?: boolean;
  /** Why the files may not be deleted, or why deleting needs the typed id,
   *  in one line. */
  reason?: string;
  /** Everything deleting would remove: the checkout, a local origin beside
   *  it, its worktrees and its warm-template spares. */
  deletePaths?: string[];
  /** Worktrees deleting would remove with it. */
  worktrees?: number;
  /** Disk used by `deletePaths`, when it could be measured quickly. */
  sizeBytes?: number | null;
  /** Branches not on their upstream (never pushed, ahead or gone), whose
   *  commits deleting would lose; null when git could not answer. */
  unpushedBranches?: number | null;
  /** Send back with a delete, so it deletes exactly this plan. */
  planToken?: string;
}

export interface RepoRemovalResult {
  id: string;
  /** Sessions archived by the removal. */
  archived: number;
  /** Automations turned off because they targeted the repository. */
  automationsDisabled: number;
  /** Paths deleted from disk (checkout, origin, worktrees, spares). */
  deleted: string[];
  /** Paths deletion was asked for but which are still there. */
  kept: string[];
  /** What went wrong with deleting files, when something did. The
   *  repository itself was removed either way. */
  error?: string;
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
  /** Clean up the workspaces that name `repoId` (releaseRepoWorkspaces). */
  releaseWorkspaces(repoId: string, live: UnifiedSession[]): Promise<void>;
  /** Stop Portals and setup still running in a directory about to go. */
  stopWorkloadsInDir(dir: string): Promise<void>;
  /** Enabled automations targeting `repoId`. */
  countAutomations(repoId: string): Promise<number>;
  /** Turn those automations off; resolves how many were. */
  disableAutomations(repoId: string): Promise<number>;
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
    await releaseRepoWorkspaces(repoId, live);
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
  async countAutomations(repoId) {
    const { enabledAutomationsForRepo } = await import("./automations");
    return (await enabledAutomationsForRepo(repoId)).length;
  },
  async disableAutomations(repoId) {
    const { disableAutomationsForRepo } = await import("./automations");
    return disableAutomationsForRepo(repoId);
  },
};

let deps: RepoRemovalDeps = defaultDeps;

/** Test seam: stand in for the session layer. Pass null to restore it. */
export function __setRepoRemovalDepsForTest(
  override: Partial<RepoRemovalDeps> | null,
): void {
  deps = override ? { ...defaultDeps, ...override } : defaultDeps;
}

/**
 * Clean up the workspaces a removed repository leaves behind. A workspace
 * defaulting to it that no live session keeps alive loses its parked draft
 * and its pins, which is what keeps a sessionless workspace in the sidebar,
 * so it goes away with its archived sessions. Every workspace also stops
 * attaching the repository to the sessions it creates.
 */
export async function releaseRepoWorkspaces(
  repoId: string,
  live: UnifiedSession[],
): Promise<void> {
  const [{ listWorkspaces, updateWorkspace }, { unpinEverywhere }] =
    await Promise.all([import("./workspaces"), import("./pins")]);
  const all = await listWorkspaces();
  const idle = all.filter(
    (ws) =>
      ws.repo !== undefined &&
      canonicalRepoId(ws.repo) === repoId &&
      !live.some((s) => s.workspaceId === ws.id),
  );
  for (const ws of idle) {
    if (ws.draft) await updateWorkspace(ws.id, { draft: null });
  }
  if (idle.length)
    await unpinEverywhere(idle.map((ws) => `workspace:${ws.id}`));
  for (const ws of all) {
    const attached = ws.attachedRepos ?? [];
    const kept = attached.filter((a) => canonicalRepoId(a.repo) !== repoId);
    if (kept.length !== attached.length)
      await updateWorkspace(ws.id, { attachedRepos: kept });
  }
}

function registeredRepo(id: string): Repo | null {
  const repos = configuredRepos();
  return Object.hasOwn(repos, id) ? repos[id] : null;
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

async function isRealDir(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** `a` is `b` or sits inside it. */
function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

/**
 * Resolve which registered repository each session's own work is in. A
 * session that recorded `repo` belongs to it. One without (older sessions)
 * belongs to the checkout its worktree sits in, else to the repository its
 * worktree's `.git` pointer names, else to the repository whose worktree
 * prefix its directory carries (longest prefix wins), the same order as
 * worktree.ts sessionRepoId, with symlinks resolved asynchronously.
 * `repos` is passed in so the answer stays the same after the registry
 * entry is gone.
 */
async function sessionOwnerResolver(
  repos: Record<string, Repo>,
): Promise<(session: UnifiedSession) => Promise<string | undefined>> {
  let resolved:
    | {
        checkouts: Array<{ repo: Repo; paths: string[] }>;
        wtRoots: string[];
      }
    | undefined;
  const load = async () => {
    if (resolved) return resolved;
    const checkouts = await Promise.all(
      Object.values(repos).map(async (repo) => ({
        repo,
        paths: uniq([resolve(repo.repo), await realpathOrNull(repo.repo)]),
      })),
    );
    const raw = configuredPaths().worktreesDir;
    resolved = {
      checkouts,
      wtRoots: uniq([resolve(raw), await realpathOrNull(raw)]),
    };
    return resolved;
  };
  return async (session) => {
    if (session.repo) return canonicalRepoId(session.repo);
    const dir = session.worktreeDir;
    if (!dir) return undefined;
    const { checkouts, wtRoots } = await load();
    const dirs = uniq([resolve(dir), await realpathOrNull(dir)]);
    for (const { repo, paths } of checkouts)
      if (dirs.some((d) => paths.some((p) => within(d, p)))) return repo.id;
    for (const d of dirs) {
      const owner = await gitPointerOwner(d);
      if (!owner) continue;
      const hit = checkouts.find(({ paths }) => paths.includes(owner));
      if (hit) return hit.repo.id;
    }
    let best: Repo | undefined;
    for (const { repo } of checkouts) {
      const match = dirs.some((d) =>
        wtRoots.some((root) => d.startsWith(`${root}/${repo.wtPrefix}-`)),
      );
      if (match && (!best || repo.wtPrefix.length > best.wtPrefix.length))
        best = repo;
    }
    return best?.id;
  };
}

function uniq(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((p): p is string => !!p))];
}

/** The checkout a worktree's `.git` file points back to, resolved. */
async function gitPointerOwner(dir: string): Promise<string | null> {
  let pointer: string;
  try {
    pointer = await readFile(`${dir}/.git`, "utf8");
  } catch {
    return null;
  }
  const gitdir = pointer.replace(/^gitdir:\s*/, "").trim();
  const owner = gitdir.split("/.git/worktrees/")[0];
  if (!owner || owner === gitdir) return null;
  return (await realpathOrNull(owner)) ?? resolve(owner);
}

/** The live sessions a removal touches: those whose own work is in
 *  `repoId`, and those of other repositories that have it attached. */
export async function repoSessions(
  sessions: UnifiedSession[],
  repoId: string,
  repos: Record<string, Repo> = configuredRepos(),
): Promise<{ owned: UnifiedSession[]; attached: UnifiedSession[] }> {
  const ownerOf = await sessionOwnerResolver(repos);
  const owned: UnifiedSession[] = [];
  const attached: UnifiedSession[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    if (!session.repoLess && (await ownerOf(session)) === repoId) {
      owned.push(session);
    } else if (
      session.attachedRepos?.some((a) => canonicalRepoId(a.repo) === repoId)
    ) {
      attached.push(session);
    }
  }
  return { owned, attached };
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

/** Shown when deleting needs the typed id. */
export const UNVERIFIED_NOTICE =
  "This server can't tell whether it created this folder.";

/** Registrations whose folder the server itself cloned or created. */
const MANAGED_SOURCES = new Set(["github", "codestorage", "new"]);

/** Ids and prefixes that are safe as a single path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface FilePlan {
  tier: RepoDeleteTier;
  reason?: string;
  checkout?: string;
  origin?: string;
  worktrees: string[];
  /** The repository's warm-template spare pool, when deleting includes it. */
  spares?: string;
  /** Warm-template state, manifest and lock files to drop with the files. */
  warmFiles: string[];
}

/** Every directory a plan deletes, in the order it deletes them. */
export function planPaths(plan: FilePlan): string[] {
  if (plan.tier === "never" || !plan.checkout) return [];
  return [
    ...plan.worktrees,
    plan.checkout,
    ...(plan.origin ? [plan.origin] : []),
    ...(plan.spares ? [plan.spares] : []),
  ];
}

/** A hash of every directory a plan would delete and how it was allowed.
 *  The preview hands it out and a delete must send it back. The warm-template
 *  bookkeeping files are left out: a refresh writes them at any time, and
 *  they are deleted by exact name either way. */
export function planToken(plan: FilePlan): string | undefined {
  if (plan.tier === "never") return undefined;
  const body = JSON.stringify({
    tier: plan.tier,
    checkout: plan.checkout,
    origin: plan.origin ?? null,
    worktrees: [...plan.worktrees].sort(),
    spares: plan.spares ?? null,
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

/** Every path another registered repository uses, real and as written, so a
 *  repository whose folder is gone (realpath fails) still counts. */
async function otherRepoPaths(others: Repo[]): Promise<string[]> {
  const paths = await Promise.all(
    others.map(async (r) => [resolve(r.repo), await realpathOrNull(r.repo)]),
  );
  return uniq(paths.flat());
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
  opts: {
    /** Every entry in `registered` is another repository, even one under
     *  `repo`'s id: after the config entry is gone, an entry with that id is
     *  a new registration, not the one being removed. */
    allOthers?: boolean;
  } = {},
): Promise<FilePlan> {
  const keep = (reason: string): FilePlan => ({
    tier: "never",
    reason,
    worktrees: [],
    warmFiles: [],
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

  const others = opts.allOthers
    ? Object.values(registered)
    : Object.values(registered).filter((r) => r.id !== repo.id);
  const otherPaths = await otherRepoPaths(others);
  const ownPaths = uniq([checkout, resolve(repo.repo)]);
  if (
    otherPaths.some((p) =>
      ownPaths.some((own) => within(p, own) || within(own, p)),
    )
  )
    return keep(KEEP_REASON.shared);
  const serverDir = await realpathOrNull(import.meta.dir);
  const cwd = await realpathOrNull(process.cwd());
  if (
    (serverDir && within(serverDir, checkout)) ||
    (cwd && within(cwd, checkout))
  )
    return keep(KEEP_REASON.server);

  const tier: RepoDeleteTier =
    repo.addedFrom && MANAGED_SOURCES.has(repo.addedFrom)
      ? "managed"
      : "unverified";
  const warm = await warmTemplateLeftovers(repo, others);
  return {
    tier,
    ...(tier === "unverified" ? { reason: UNVERIFIED_NOTICE } : {}),
    checkout,
    // A bare origin is deleted only beside a repository started here; for
    // anything else the server can't know who else uses it.
    origin:
      tier === "managed" && repo.addedFrom === "new"
        ? await localOriginToDelete(checkout, root, others)
        : undefined,
    worktrees: await worktreesToDelete(repo, checkout, otherPaths),
    ...(warm.spares ? { spares: warm.spares } : {}),
    warmFiles: warm.files,
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
  checkout: string,
  root: string,
  others: Repo[],
): Promise<string | undefined> {
  const url = await git(["-C", checkout, "remote", "get-url", "origin"]);
  const raw = url.stdout.trim();
  if (url.exitCode !== 0 || !isAbsolute(raw)) return;
  if (await isSymlink(raw)) return;
  const origin = await realpathOrNull(raw);
  if (!origin || dirname(origin) !== root || !basename(origin).endsWith(".git"))
    return;
  if (!(await stat(origin)).isDirectory()) return;
  for (const other of others) {
    if (within(resolve(other.repo), origin)) return;
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

/**
 * The checkout's linked worktrees that deleting may remove. Each one listed
 * by `git worktree list` must be a real directory directly in the worktree
 * root, named with this repository's prefix (`<wtPrefix>-…`), and its `.git`
 * file must point into this checkout's `.git/worktrees/`. Anything else (a
 * worktree made by hand elsewhere, or an entry whose admin files were edited
 * to name another repository's worktree) is left alone.
 */
async function worktreesToDelete(
  repo: Repo,
  checkout: string,
  otherPaths: string[],
): Promise<string[]> {
  const wtRoot = await realpathOrNull(configuredPaths().worktreesDir);
  if (!wtRoot || wtRoot === "/") return [];
  if (!SAFE_SEGMENT.test(repo.wtPrefix)) return [];
  const gitDir = join(checkout, ".git");
  if (!(await isRealDir(gitDir))) return [];
  const adminRoot = join(gitDir, "worktrees");
  const listed = await git(["-C", checkout, "worktree", "list", "--porcelain"]);
  if (listed.exitCode !== 0) return [];
  const out: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (await isSymlink(path)) continue;
    const real = await realpathOrNull(path);
    if (!real || real === checkout || dirname(real) !== wtRoot) continue;
    if (!basename(real).startsWith(`${repo.wtPrefix}-`)) continue;
    if (!(await isRealDir(real))) continue;
    if (!(await pointsInto(real, adminRoot))) continue;
    if (otherPaths.some((p) => within(p, real) || within(real, p))) continue;
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** The worktree's `.git` is a file naming a directory inside `adminRoot`. */
async function pointsInto(
  worktree: string,
  adminRoot: string,
): Promise<boolean> {
  const dotGit = join(worktree, ".git");
  try {
    const info = await lstat(dotGit);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  let pointer: string;
  try {
    pointer = await readFile(dotGit, "utf8");
  } catch {
    return false;
  }
  const match = pointer.match(/^gitdir:\s*(.+)$/m);
  if (!match) return false;
  const target = resolve(worktree, match[1].trim());
  const realTarget = await realpathOrNull(target);
  const realAdmin = await realpathOrNull(adminRoot);
  if (!realTarget || !realAdmin) return false;
  return realTarget !== realAdmin && within(realTarget, realAdmin);
}

/**
 * The warm-template files a repository leaves outside its worktrees: its
 * spare pool under `<worktree root>/.warm-spares/<wtPrefix>`, kept only when
 * it is a real directory there and no other repository shares the prefix,
 * and its state, manifest and lock files when they exist.
 */
async function warmTemplateLeftovers(
  repo: Repo,
  others: Repo[],
): Promise<{ spares?: string; files: string[] }> {
  const { warmTemplatePaths } = await import("./warm-template");
  const paths = warmTemplatePaths(repo);
  let spares: string | undefined;
  if (
    SAFE_SEGMENT.test(repo.wtPrefix) &&
    !others.some((r) => r.wtPrefix === repo.wtPrefix) &&
    (await isRealDir(paths.spares)) &&
    (await isRealDir(paths.sparesRoot))
  ) {
    const real = await realpathOrNull(paths.spares);
    const realRoot = await realpathOrNull(paths.sparesRoot);
    if (real && realRoot && dirname(real) === realRoot) spares = real;
  }
  const files: string[] = [];
  if (SAFE_SEGMENT.test(repo.id)) {
    for (const file of paths.files) {
      try {
        if ((await lstat(file)).isFile()) files.push(file);
      } catch {}
    }
  }
  return { ...(spares ? { spares } : {}), files };
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

/**
 * Local branches whose commits exist nowhere else: no upstream, an upstream
 * that is gone, or ahead of it. One `for-each-ref` over the checkout (its
 * worktrees share the refs), bounded in time and count; null when git can't
 * answer quickly.
 */
async function unpushedBranchCount(checkout: string): Promise<number | null> {
  const listed = await git(
    [
      "-C",
      checkout,
      "for-each-ref",
      "--count=5000",
      "--format=%(upstream)%09%(upstream:track)",
      "refs/heads",
    ],
    5_000,
  );
  if (listed.exitCode !== 0) return null;
  let count = 0;
  for (const line of listed.stdout.split("\n")) {
    if (!line.length) continue;
    const [upstream, track = ""] = line.split("\t");
    if (!upstream || /\b(ahead|gone)\b/.test(track)) count += 1;
  }
  return count;
}

/** What removing `id` would do, for the confirmation dialog. Null when no
 *  repository is registered under it. */
export async function repoRemovalPreview(
  id: string,
): Promise<RepoRemovalPreview | null> {
  const repo = registeredRepo(id);
  if (!repo) return null;
  const [live, plan, automations] = await Promise.all([
    deps.liveSessions(),
    planRepoFileDeletion(repo),
    deps.countAutomations(id).catch(() => 0),
  ]);
  const { owned, attached } = await repoSessions(live, id);
  const deletable = plan.tier !== "never";
  const deletePaths = deletable ? planPaths(plan) : undefined;
  const [sizeBytes, unpushedBranches] = deletePaths
    ? await Promise.all([
        diskUsageBytes(deletePaths),
        unpushedBranchCount(plan.checkout!),
      ])
    : [undefined, undefined];
  return {
    id,
    label: repo.label,
    path: repo.repo,
    sessions: owned.length,
    running: owned.filter((s) => s.isRunning).length,
    attached: attached.length,
    attachedSessions: attached.map((s) => ({
      id: s.id,
      title: s.title || s.id,
    })),
    automations,
    deletable,
    tier: plan.tier,
    ...(plan.tier === "unverified" ? { confirmRequired: true } : {}),
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(deletePaths
      ? {
          deletePaths,
          worktrees: plan.worktrees.length,
          sizeBytes,
          unpushedBranches,
          planToken: planToken(plan),
        }
      : {}),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What stands in the way of removing, as one line. */
export function blockingMessage(running: number, attached: number): string {
  const parts: string[] = [];
  if (running)
    parts.push(
      `stop ${plural(running, "running session", "running sessions")}`,
    );
  if (attached)
    parts.push(
      `archive ${plural(attached, "session", "sessions")} that also ${attached === 1 ? "uses" : "use"} it`,
    );
  const line = `${parts.join(" and ")} first`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export const PLAN_CHANGED = "The repository changed; review again.";

/**
 * Delete a plan's files, recording each path in `files` as it settles so a
 * throw part-way still reports what happened. A worktree goes only through
 * `git worktree remove`; when that fails it stays, and so do the checkout
 * and origin it hangs off.
 */
async function deletePlannedFiles(
  plan: FilePlan,
  repo: Repo,
  files: { deleted: string[]; kept: string[] },
): Promise<void> {
  const settle = async (path: string) => {
    if (await exists(path)) files.kept.push(path);
    else files.deleted.push(path);
  };
  const { retireWarmTemplate, unretireWarmTemplate } =
    await import("./warm-template");
  const warmQuiet = await retireWarmTemplate(repo.id).catch(() => false);
  try {
    await deleteInOrder(plan, repo, files, warmQuiet, settle);
  } finally {
    // Nothing is in flight any more, so a later registration under the same
    // id may warm again. A refresh still running past the wait stays retired
    // until restart, so it can't write into a removed repository's state.
    if (warmQuiet) unretireWarmTemplate(repo.id);
  }
}

async function deleteInOrder(
  plan: FilePlan,
  repo: Repo,
  files: { deleted: string[]; kept: string[] },
  warmQuiet: boolean,
  settle: (path: string) => Promise<void>,
): Promise<void> {
  const checkout = plan.checkout!;
  const template = `${repo.wtPrefix}-warm-template`;
  for (const wt of plan.worktrees) {
    if (!warmQuiet && basename(wt) === template) {
      files.kept.push(wt);
      continue;
    }
    await deps.stopWorkloadsInDir(wt);
    const removed = await git(
      ["-C", checkout, "worktree", "remove", "--force", wt],
      120_000,
    );
    if (removed.exitCode !== 0) {
      console.warn(
        `[repo-removal] git worktree remove ${wt} failed: ${removed.stderr}`,
      );
      files.kept.push(wt);
      continue;
    }
    await settle(wt);
  }
  const rest = [checkout, ...(plan.origin ? [plan.origin] : [])];
  if (files.kept.length) {
    // A worktree still on disk points into the checkout's .git; keep both.
    files.kept.push(...rest, ...(plan.spares ? [plan.spares] : []));
    return;
  }
  await deps.stopWorkloadsInDir(checkout);
  await removeTree(checkout);
  await settle(checkout);
  if (plan.origin) {
    await removeTree(plan.origin);
    await settle(plan.origin);
  }
  if (plan.spares) {
    if (warmQuiet) {
      await removeTree(plan.spares);
      await settle(plan.spares);
    } else {
      files.kept.push(plan.spares);
    }
  }
  if (warmQuiet) {
    for (const file of plan.warmFiles) await unlink(file).catch(() => {});
  }
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

export interface RemoveRepoOptions {
  deleteFiles: boolean;
  /** The preview's planToken; required with deleteFiles. */
  planToken?: string;
  /** The repository id typed in; required to delete an `unverified` tier. */
  confirm?: string;
  by?: string | null;
}

/**
 * Remove a registered repository. Throws RepoRemovalError with the HTTP
 * status to answer, always before the config entry is removed: 404 unknown,
 * 409 a blocking session, a removal already under way or a plan that no
 * longer matches the preview, 400 a refused file deletion. After the entry
 * is removed it never throws; what happened to the files is in the result.
 */
export async function removeRepo(
  id: string,
  opts: RemoveRepoOptions,
): Promise<RepoRemovalResult> {
  if (!registeredRepo(id))
    throw new RepoRemovalError(`Unknown repository: ${id}`, 404);
  await withConfigMutationLock(async () => {
    const repo = registeredRepo(id);
    if (!repo) throw new RepoRemovalError(`Unknown repository: ${id}`, 404);
    if (!markRepoRemoving(id))
      throw new RepoRemovalError(`${repo.label} is already being removed`, 409);
  });
  try {
    const repo = registeredRepo(id);
    if (!repo) throw new RepoRemovalError(`Unknown repository: ${id}`, 404);
    // The registry as it was, so sessions recorded only by worktree path
    // still resolve to this repository after its entry is gone.
    const repos = { ...configuredRepos() };
    const { owned, attached } = await repoSessions(
      await deps.liveSessions(),
      id,
      repos,
    );
    const running = owned.filter((s) => s.isRunning).length;
    if (running || attached.length)
      throw new RepoRemovalError(
        blockingMessage(running, attached.length),
        409,
        { running, attached: attached.length },
      );

    let plan: FilePlan | null = null;
    if (opts.deleteFiles) {
      plan = await planRepoFileDeletion(repo, repos);
      if (plan.tier === "never")
        throw new RepoRemovalError(
          plan.reason || "These files cannot be deleted",
          400,
        );
      if (!opts.planToken || opts.planToken !== planToken(plan))
        throw new RepoRemovalError(PLAN_CHANGED, 409);
      if (plan.tier === "unverified" && opts.confirm !== id)
        throw new RepoRemovalError(
          `Type ${id} to confirm deleting its files`,
          400,
        );
    }

    await deps.archiveSessions(owned);
    await deps.releaseWorkspaces(id, await deps.liveSessions());
    let automationsDisabled = 0;
    try {
      automationsDisabled = await deps.disableAutomations(id);
    } catch (error) {
      console.warn(
        `[repo-removal] could not turn off automations for ${id}:`,
        error,
      );
    }

    const removed = await withConfigMutationLock(async () => {
      if (!registeredRepo(id)) return false;
      // From the moment the entry goes, nothing may register a folder this
      // removal is about to delete, under any id (setup-repos.ts).
      if (plan) markRepoPathsDeleting(id, planPaths(plan));
      const config = await rawConfigAsync();
      const reposConfig = reposForMutation(config);
      delete reposConfig[id];
      if (config.newSessionRepo === id) delete config.newSessionRepo;
      await persistRawConfigAsync(config);
      return true;
    });
    if (!removed) throw new RepoRemovalError(`Unknown repository: ${id}`, 404);

    return await finishRemoval({
      id,
      repo,
      repos,
      plan,
      archived: owned.length,
      automationsDisabled,
      by: opts.by || null,
    });
  } finally {
    unmarkRepoRemoving(id);
  }
}

/** Everything after the config entry is gone. Never throws: the repository
 *  has been removed, so failures land in the result. */
async function finishRemoval(input: {
  id: string;
  repo: Repo;
  repos: Record<string, Repo>;
  plan: FilePlan | null;
  archived: number;
  automationsDisabled: number;
  by: string | null;
}): Promise<RepoRemovalResult> {
  const { id, repo, repos, plan } = input;
  const files = { deleted: [] as string[], kept: [] as string[] };
  let error: string | undefined;
  await forgetRepoState(id);
  if (plan) {
    const planned = planPaths(plan);
    try {
      // A session may have slipped in before the removal mark was set, and
      // the folder may have changed since it was reviewed. Look again now
      // that nothing new can resolve the repository.
      const again = await repoSessions(await deps.liveSessions(), id, repos);
      // Whatever is registered now is another repository, including one
      // added again under this id since the entry went.
      const replanned = await planRepoFileDeletion(repo, configuredRepos(), {
        allOthers: true,
      });
      if (again.owned.length || again.attached.length) {
        files.kept.push(...planned);
        error =
          "A session started in this repository while it was being removed, so its files were kept.";
      } else if (planToken(replanned) !== planToken(plan)) {
        files.kept.push(...planned);
        error =
          "The repository changed while it was being removed, so its files were kept.";
      } else {
        await auditDurable({
          kind: "setup_repo_remove_started",
          id,
          path: repo.repo,
          tier: plan.tier,
          planned,
          by: input.by,
        });
        await deletePlannedFiles(plan, repo, files);
        if (files.kept.length) error = "Some of its files couldn't be deleted.";
      }
    } catch (cause) {
      const settled = new Set([...files.deleted, ...files.kept]);
      files.kept.push(...planned.filter((p) => !settled.has(p)));
      error = `Deleting its files failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      console.error(`[repo-removal] deleting files for ${id} failed:`, cause);
    }
  }
  auditAsync({
    kind: "setup_repo_remove",
    id,
    path: repo.repo,
    archived: input.archived,
    automationsDisabled: input.automationsDisabled,
    deleteFiles: !!plan,
    ...(plan ? { tier: plan.tier } : {}),
    ...(files.deleted.length ? { deleted: files.deleted } : {}),
    ...(files.kept.length ? { kept: files.kept } : {}),
    ...(error ? { error } : {}),
    by: input.by,
  });
  return {
    id,
    archived: input.archived,
    automationsDisabled: input.automationsDisabled,
    ...files,
    ...(error ? { error } : {}),
  };
}
