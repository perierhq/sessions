/**
 * Boot repair for checkouts carried over from another install.
 *
 * A checkout outlives the install that cloned it (uninstall keeps
 * ~/checkouts; a move between users or prefixes copies it). It then keeps
 * that install's paths: a GitHub credential helper under another user's
 * home that this process can't run, and a warm template whose `.git`
 * names an admin dir in the other install's checkout. Every background
 * fetch then fails ("could not read Username", "not a git repository")
 * until someone edits .git/config by hand.
 *
 * On boot each registered checkout is checked once. The helper is
 * rewritten with the function registration uses
 * (`configureGithubCredentialHelper`), the template is dropped so the next
 * refresh rebuilds it, and each repair is logged once. A healthy checkout
 * is only read. The warm-template fetch does the same when its helper
 * fails at run time (warm-template.ts).
 *
 * Nothing runs at import.
 */
import { configuredRepos, type Repo } from "./config";
import { repairGithubCredentialHelper } from "./github-git-credential";
import { repairWarmTemplateLink } from "./warm-template";

export async function repairForeignCheckoutPaths(
  repos: Record<string, Repo> = configuredRepos(),
): Promise<void> {
  for (const repo of Object.values(repos)) {
    try {
      const stale = await repairGithubCredentialHelper(repo.repo);
      if (stale)
        console.warn(
          `[checkout-repair] ${repo.id}: credential helper ${stale} can't run here (another install's path); now ${repo.repo} uses this install's`,
        );
    } catch (e) {
      console.warn(
        `[checkout-repair] ${repo.id}: could not check the credential helper:`,
        e instanceof Error ? e.message : e,
      );
    }
    try {
      await repairWarmTemplateLink(repo);
    } catch (e) {
      console.warn(
        `[checkout-repair] ${repo.id}: could not check the warm template:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}
