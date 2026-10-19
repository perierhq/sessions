import {
  GITHUB_RUN_AUTH_FILE_ENV,
  githubUserRunEnv,
  projectedGithubRunEnv,
} from "./github-auth";
import type { MergeGuard } from "./command-policy";
import { gitIdentityEnv, type GitIdentity } from "./shared/user-mappings";

/** Fresh authority for an unattended GitHub code run. Host recovery resolves
 * the selected service credential from the registered cwd; remote runners can
 * consume only the private run-scoped file projected by their launcher. */
export async function githubCodeRunEnv(
  cwd: string,
  attachedRepos?: readonly string[],
): Promise<Record<string, string>> {
  if (process.env[GITHUB_RUN_AUTH_FILE_ENV]) return projectedGithubRunEnv();
  const { repoForPathOrNull } = await import("./worktree");
  const repo = repoForPathOrNull(cwd);
  if (!repo || repo.host === "codestorage" || !repo.ghRepo) return {};
  const { githubServiceCredentialEnv } = await import("./github-app");
  return githubServiceCredentialEnv(repo.ghRepo, attachedRepos);
}

/** Read-only authority for an unattended GitHub ask run (the review
 * workflows): they read PR threads, checks, and Actions logs through `gh`
 * while processing untrusted repository content, so their token is the
 * repository-scoped read set — visibility with no write capability. Same
 * fail-closed resolution as githubCodeRunEnv. */
export async function githubReadRunEnv(
  cwd: string,
  attachedRepos?: readonly string[],
): Promise<Record<string, string>> {
  if (process.env[GITHUB_RUN_AUTH_FILE_ENV]) return projectedGithubRunEnv();
  const { repoForPathOrNull } = await import("./worktree");
  const repo = repoForPathOrNull(cwd);
  if (!repo || repo.host === "codestorage" || !repo.ghRepo) return {};
  const { githubServiceReadOnlyEnv } = await import("./github-app");
  return githubServiceReadOnlyEnv(repo.ghRepo, attachedRepos);
}

/** The read-only sibling-repository token an automation run holds beside
 * its primary credential (Automation.readRepos): `GH_READ_TOKEN`, minted for
 * the run's own repository plus the listed ones with the read set. Empty when
 * nothing is listed, when the mint is refused (the App is not installed on
 * one of them; github-app.ts warns), or on a remote host, whose launcher
 * already projected it into the run-scoped auth file. */
export async function githubReadReposRunEnv(
  cwd: string,
  readRepos: string[] | undefined,
): Promise<Record<string, string>> {
  if (!readRepos?.length) return {};
  if (process.env[GITHUB_RUN_AUTH_FILE_ENV]) return {};
  const { repoForPathOrNull } = await import("./worktree");
  const repo = repoForPathOrNull(cwd);
  if (!repo || repo.host === "codestorage" || !repo.ghRepo) return {};
  const { githubServiceReadReposEnv } = await import("./github-app");
  return githubServiceReadReposEnv(repo.ghRepo, readRepos);
}

/** The GitHub credential one run's shell holds (docs/setup/github.md, "Who
 * holds which credential").
 *
 * - A code turn a connected person started (`ownerTurn`) acts as them: their
 *   token for gh and HTTPS git, so the push and the PR carry their identity.
 * - Every other code run, including an owner turn whose person is not
 *   connected, an automation, and a review handoff or worker report (a
 *   machine sender is nobody), holds the repository-scoped App code set. A
 *   launcher may hand a `github-*` code run its own token.
 * - Every ask run holds the App read set: the review workflows chew on
 *   untrusted PR content and can print their environment, so ask mode never
 *   sees a person's token and ignores any launcher-supplied one.
 *
 * A remote host never consults the person store: its launcher already
 * projected the run's credential (githubUserRunEnv is empty there).
 *
 * An App token covers the session's attached repositories (`attachedRepos`)
 * beside the checkout's own, with the same permission set: a machine-started
 * turn can work in every repository the session spans, exactly as an owner
 * turn can with the person's token.
 *
 * An automation that lists sibling repositories to read (`readRepos`) also
 * gets `GH_READ_TOKEN` (githubReadReposRunEnv) beside whichever primary
 * credential the rules above selected; the primary is never widened. */
export async function runGithubEnv(input: {
  isCode: boolean;
  ownerTurn: boolean;
  /** The person the turn acts for (githubCredentialUser). */
  user?: string | null;
  githubKindRun: boolean;
  launcherEnv?: Record<string, string>;
  cwd: string;
  /** Automation.readRepos; only automation runs carry it. */
  readRepos?: string[];
  /** `owner/name` of the session's attached repositories: the App token
   *  reaches them too (githubAppRepositoryToken). */
  attachedRepos?: string[];
  /** No GitHub App is configured and the run shares the host's HOME (see
   *  usesHostGithubLogin): inject no credential so gh and git use the
   *  host's own login. */
  hostLogin?: boolean;
}): Promise<Record<string, string>> {
  const primary = await runPrimaryGithubEnv(input);
  if (!input.readRepos?.length) return primary;
  return {
    ...primary,
    ...(await githubReadReposRunEnv(input.cwd, input.readRepos)),
  };
}

async function runPrimaryGithubEnv(input: {
  isCode: boolean;
  ownerTurn: boolean;
  user?: string | null;
  githubKindRun: boolean;
  launcherEnv?: Record<string, string>;
  cwd: string;
  attachedRepos?: string[];
  hostLogin?: boolean;
}): Promise<Record<string, string>> {
  if (!input.isCode)
    return input.hostLogin
      ? {}
      : githubReadRunEnv(input.cwd, input.attachedRepos);
  const person = input.ownerTurn ? githubUserRunEnv(input.user) : {};
  if (person.GH_TOKEN) return person;
  if (input.githubKindRun && input.launcherEnv?.GH_TOKEN)
    return input.launcherEnv;
  if (input.hostLogin) return {};
  return githubCodeRunEnv(input.cwd, input.attachedRepos);
}

/** Whether a run's `gh` and git use the host's own GitHub login instead of
 * an injected credential. Only when no GitHub App is configured: without one
 * there is no App token to inject, so the run-scoped empty credential would
 * leave gh "not logged in" even for the operator's own sessions. Remote,
 * unattended, and automation runs never qualify; they stay fail-closed. */
export async function usesHostGithubLogin(input: {
  remote: boolean;
  unattended: boolean;
  isolatedHome: boolean;
}): Promise<boolean> {
  if (input.remote || input.unattended || input.isolatedHome) return false;
  if (process.env[GITHUB_RUN_AUTH_FILE_ENV]) return false;
  const { githubAppConfigured } = await import("./github-app");
  return !githubAppConfigured();
}

/** Person-started code turns follow the repository's publication workflow:
 * they may push the base branch and merge PRs in either checkout mode, and
 * GitHub rulesets bound what lands. Without personal GitHub authority they
 * still cannot approve PRs. Ask, unattended, and machine-authored runs retain
 * the full guard. */
export function runGithubMergeGuard(input: {
  isCode: boolean;
  ownerTurn: boolean;
  ownerLogin: string | null;
  baseBranch: string;
}): MergeGuard | undefined {
  if (input.isCode && input.ownerTurn)
    return input.ownerLogin ? undefined : { allowMerge: true };
  return { baseBranch: input.baseBranch };
}

/** Child-env name carrying the `Co-authored-by` trailer an agent run must put
 * on every commit. The value is `Name <email>`, the person behind the run. */
export const GIT_COAUTHOR_ENV = "OPENSESSION_GIT_COAUTHOR";

/** Git identity for an agent run: the App's bot user as author and
 * committer, with the person behind the run as `Co-authored-by`. No run
 * carries a person's git identity, so nothing an agent commits can be taken
 * for something the person typed (docs/github-authority.md, "Attribution").
 * Without a configured App, git's own config decides the author. */
export async function agentGitIdentityEnv(
  author?: GitIdentity | null,
): Promise<Record<string, string>> {
  const bot = await import("./github-app")
    .then((m) => m.githubBotGitIdentity())
    .catch(() => null);
  const coauthor =
    author?.name && author.email ? `${author.name} <${author.email}>` : "";
  return {
    ...(bot ? gitIdentityEnv(bot) : {}),
    ...(coauthor ? { [GIT_COAUTHOR_ENV]: coauthor } : {}),
  };
}
