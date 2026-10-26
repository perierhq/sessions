/** Refresh ownership for ONE session at its turn boundary. Cross-session
 * consumers query the maintained catalog, never probe checkouts themselves. */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { configuredRepos, getConfigAsync, type Repo } from "./config";
import { statePath } from "./paths";

/** Classify catalog-recorded paths without probing a fleet of checkouts.
 * Only registered isolated-worktree locations establish ownership. Unknown
 * paths (including remote Runner paths and legacy aliases) fail closed: they
 * may get independent workspaces, never be grouped by a guessed shared HEAD. */
export function catalogWorktreeOwnership(
  repos: Record<string, Repo>,
  worktreesDir: string,
): (dir: string | null | undefined) => string | null {
  const root = resolve(worktreesDir);
  const shared = new Set<string>();
  const prefixes: string[] = [];
  for (const repo of Object.values(repos)) {
    shared.add(resolve(repo.repo));
    shared.add(resolve(root, `${repo.wtPrefix}-ask-checkout`));
    prefixes.push(`${repo.wtPrefix}-`);
  }
  return (dir) => {
    if (!dir) return null;
    const path = resolve(dir);
    if (shared.has(path) || dirname(path) !== root) return null;
    return prefixes.some((prefix) => basename(path).startsWith(prefix))
      ? dir
      : null;
  };
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function ownedWorktreeHeadBranch(
  dir: string | null | undefined,
): Promise<string | null> {
  if (!dir) return null;
  const config = await getConfigAsync();
  const repos = configuredRepos(config);
  const worktreesDir =
    process.env.OPENSESSION_WORKTREES_DIR ||
    config.paths?.worktreesDir ||
    statePath(".opensession/worktrees");
  const current = await canonical(dir);
  for (const repo of Object.values(repos)) {
    if (
      current === (await canonical(repo.repo)) ||
      current ===
        (await canonical(`${worktreesDir}/${repo.wtPrefix}-ask-checkout`))
    )
      return null; // shared HEAD is not any one session's ownership
  }
  try {
    let gitDir = `${dir}/.git`;
    if ((await stat(gitDir)).isFile()) {
      const pointer = (await readFile(gitDir, "utf-8")).match(
        /^gitdir: (.+)$/m,
      );
      if (!pointer) return null;
      gitDir = resolve(dir, pointer[1].trim());
    }
    return (
      (await readFile(`${gitDir}/HEAD`, "utf-8"))
        .match(/^ref: refs\/heads\/(.+)$/m)?.[1]
        .trim() || null
    );
  } catch {
    return null;
  }
}

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [code, out] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

/** The default branch of the registered repo whose worktree `dir` is. */
async function defaultBranchFor(dir: string): Promise<string> {
  const config = await getConfigAsync();
  const name = basename(resolve(dir));
  const repo = Object.values(configuredRepos(config)).find((candidate) =>
    name.startsWith(`${candidate.wtPrefix}-`),
  );
  return repo?.defaultBranch || "main";
}

/**
 * Another origin branch this worktree's work was published on, or null.
 * A sub-task session made on its own branch is often told to reset to an
 * integration branch and push there (`git push origin HEAD:<x>`): its own
 * branch never reaches origin, and the commit it is on is the tip of `<x>`.
 * Only then: the own branch is not on origin, HEAD moved since the branch
 * was created (a stacked session that has not started is still its own),
 * and exactly one origin branch other than the default has HEAD as its tip.
 */
async function publishedElsewhere(
  dir: string,
  head: string,
): Promise<string | null> {
  if (
    (await git(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${head}`,
    ])) !== null
  )
    return null;
  const commit = (await git(dir, ["rev-parse", "HEAD"]))?.trim();
  if (!commit) return null;
  const created = (
    await git(dir, ["reflog", "show", "--format=%H", `refs/heads/${head}`])
  )
    ?.trim()
    .split("\n")
    .at(-1);
  if (!created || created === commit) return null;
  const defaultBranch = await defaultBranchFor(dir);
  const tips = (
    (await git(dir, [
      "for-each-ref",
      "--points-at",
      commit,
      "--format=%(refname)",
      "refs/remotes/origin/",
    ])) ?? ""
  )
    .split("\n")
    .map((ref) => ref.trim().replace(/^refs\/remotes\/origin\//, ""))
    .filter((name) => name && name !== "HEAD" && name !== defaultBranch);
  return tips.length === 1 ? tips[0]! : null;
}

/** The branch an owned worktree's work is on: the origin branch it was
 *  published on when that is not its own (publishedElsewhere), else its
 *  HEAD branch. Null for shared checkouts and detached HEADs. */
export async function ownedWorktreeWorkBranch(
  dir: string | null | undefined,
): Promise<string | null> {
  const head = await ownedWorktreeHeadBranch(dir);
  if (!head || !dir) return head;
  return (await publishedElsewhere(dir, head)) ?? head;
}
