import type { PrivateTermsGuard } from "./command-policy";
import type { RunAgentOpts } from "./agent-runner";
import {
  INTERACTIVE_KINDS,
  isUnattendedKind,
  baseJournalKind,
  runToolPolicy,
  type RunToolPolicy,
} from "./run-policy";
import { stripeApprovalsEnforced } from "./stripe-approvals";
import { githubCredentialUser } from "./auto-continue";
import { privateTerms, type Repo } from "./config";
import { treatRepoAsPublic } from "./repo-visibility";
import { humanPrompter } from "./session-actors";
import { githubRunOwnerLogin } from "./github-auth";
import type { RemoteWorkspace } from "./remote-workspace";
import {
  agentGitIdentityEnv,
  runGithubEnv,
  runGithubMergeGuard,
  usesHostGithubLogin,
} from "./pi-github-env";

/** What a pi run may do and with whose credentials: its tool policy, the
 *  repository it runs in, and the GitHub identity and environment it holds. */
export interface PiRunAuthority {
  stripeApprovals: boolean;
  policy: RunToolPolicy;
  bashGated: boolean;
  cwdRepo: Repo | undefined;
  publicRepo: boolean;
  privateTermsGuard: PrivateTermsGuard | undefined;
  githubUser: string | undefined;
  ownerTurn: boolean;
  githubUserLogin: string | null;
  githubKindRun: boolean;
  hostGithubLogin: boolean;
  githubEnv: Awaited<ReturnType<typeof runGithubEnv>>;
  agentGitEnv: Awaited<ReturnType<typeof agentGitIdentityEnv>>;
  mergeGuard: ReturnType<typeof runGithubMergeGuard>;
}

export async function resolvePiRunAuthority(
  opts: RunAgentOpts,
  remote: RemoteWorkspace | undefined,
): Promise<PiRunAuthority> {
  const { cwd, mode, mcpServers, confirmTools, journal, user, author } = opts;
  const isAsk = mode === "ask";
  const isScratch = mode === "scratch";

  // Stripe two-party approvals hold refunds and cancellations, so every
  // run keeps those tools; guardStripeApprovalCall narrows the raw writer.
  const stripeApprovals =
    stripeApprovalsEnforced() &&
    (!Array.isArray(mcpServers) || mcpServers.includes("stripe"));
  const policy = runToolPolicy({
    deniedTools: opts.deniedTools,
    confirmTools,
    journalKind: journal?.kind,
    stripeApprovals,
  });
  // Command-policy gate: kind-based like previous runner (NOT policy.unattended) —
  // the trusted-human loops carry deniedTools but shouldn't trip the gate.
  const bashGated = isUnattendedKind(baseJournalKind(journal?.kind)) && !isAsk;
  // The repo owning this run's cwd, or undefined for a repo-less one (a
  // scratch dir, a repo-less ask session). Dynamic import to avoid a static
  // module-init cycle through "./worktree".
  const cwdRepo = await (async () => {
    try {
      const { getRepo, repoForPathOrNull } = await import("./worktree");
      // A Sandbox checkout's path means nothing on this machine: the
      // launcher names its repository instead.
      if (remote)
        return opts.remoteWorkspace?.repo
          ? getRepo(opts.remoteWorkspace.repo)
          : undefined;
      return repoForPathOrNull(cwd);
    } catch {
      return undefined;
    }
  })();
  // A run that can publish must know when the whole internet reads what it
  // publishes. Fails closed: unconfirmed visibility counts as public.
  const publicRepo = !isAsk && !isScratch && (await treatRepoAsPublic(cwdRepo));
  const configuredPrivateTerms = privateTerms();
  const privateTermsGuard: PrivateTermsGuard | undefined =
    publicRepo && configuredPrivateTerms.length > 0
      ? { terms: configuredPrivateTerms }
      : undefined;
  // The person this turn acts for, if any: the sender, unless it is the
  // synthetic auto-continue driver, in which case the author fallback
  // names the session owner (#322). A machine sender (a review handoff, a
  // worker report, an automation) is nobody. In code mode an owner turn
  // puts their connected token in the shell (runGithubEnv) and describes
  // PR authorship as theirs; every other run holds an App token.
  const githubUser = githubCredentialUser(user, author?.name);
  const ownerTurn =
    !policy.unattended &&
    INTERACTIVE_KINDS.has(baseJournalKind(journal?.kind)) &&
    humanPrompter(githubUser) !== null;
  // On a remote host this reads the launcher's projected marker, not the
  // person store, so a sandboxed owner turn drops the guard exactly when
  // a host run would.
  const githubUserLogin = ownerTurn ? githubRunOwnerLogin(githubUser) : null;
  // GitHub permissions and repository rulesets bound the chosen credential.
  // Ask, unattended, and publication-policy command gates still apply.
  const githubKindRun = baseJournalKind(journal?.kind).startsWith("github-");
  const hostGithubLogin = await usesHostGithubLogin({
    remote: Boolean(remote),
    unattended: Boolean(policy.unattended),
    isolatedHome: Boolean(opts.publicationPolicy),
  });
  const githubEnv = await runGithubEnv({
    isCode: mode === "code",
    ownerTurn,
    user: githubUser,
    githubKindRun,
    launcherEnv: opts.githubEnv,
    // Credentials are looked up by checkout; a Sandbox run's repository is
    // found through its registered checkout on this machine.
    cwd: remote ? cwdRepo?.repo || "" : cwd,
    readRepos: opts.readRepos,
    attachedRepos: opts.attachedRepos,
    hostLogin: hostGithubLogin,
  });
  const agentGitEnv = await agentGitIdentityEnv(author);
  const mergeGuard = runGithubMergeGuard({
    isCode: mode === "code",
    ownerTurn,
    ownerLogin: githubUserLogin,
    baseBranch: cwdRepo?.defaultBranch || "main",
  });
  return {
    stripeApprovals,
    policy,
    bashGated,
    cwdRepo,
    publicRepo,
    privateTermsGuard,
    githubUser,
    ownerTurn,
    githubUserLogin,
    githubKindRun,
    hostGithubLogin,
    githubEnv,
    agentGitEnv,
    mergeGuard,
  };
}
