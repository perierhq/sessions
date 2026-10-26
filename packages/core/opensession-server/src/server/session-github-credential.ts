// Which person's GitHub credential a session's server-side git uses: the
// auto-push after a turn (run-session.ts autoPushSessionBranches) and the
// worktree fetch when a session is created (session-control-wiring.ts).
//
// Automation-owned and support sessions use none, so their git runs with the
// GitHub App's identity only. A support session is credited to the assistant
// persona, and a persona that shares a teammate's name, first name, alias or
// GitHub login resolves to that teammate (shared/user-mappings.ts
// gitIdentityFor); looking up its creator would hand out the teammate's
// token. In simple mode any name resolves to the sole connected account, so
// the lookup is skipped outright rather than trusted to miss.
import {
  type GithubCredential,
  githubCredentialForLogin,
  githubCredentialForRun,
} from "./github-auth";
import { isSupportSession } from "./session-run-inputs";
import type { ExternalRef, UnifiedSession } from "./types";

type CredentialSession = Partial<
  Pick<
    UnifiedSession,
    | "automation"
    | "automationId"
    | "automationDescendantPolicy"
    | "externalRefs"
    | "createdByLogin"
    | "createdBy"
    | "startedBy"
  >
>;

/** The credential a session's branches are pushed with after a turn: the
 *  signed-in creator's, else whoever started it. Null for automation-owned
 *  and support sessions. */
export function sessionPushGithubCredential(
  session: CredentialSession,
): GithubCredential | null {
  if (
    session.automation ||
    session.automationId ||
    session.automationDescendantPolicy ||
    isSupportSession(session)
  )
    return null;
  return session.createdByLogin
    ? githubCredentialForLogin(session.createdByLogin)
    : githubCredentialForRun(session.createdBy || session.startedBy);
}

/** The credential a new session's worktree is fetched with: the parent's
 *  signed-in creator, else the person creating it. Null under an automation
 *  parent, and for a session in a support workspace or under a support
 *  session. */
export function createGithubCredential(input: {
  user?: string | null;
  parentSession?: Pick<
    UnifiedSession,
    "automation" | "externalRefs" | "createdByLogin" | "createdBy"
  > | null;
  /** The refs of the workspace the session joins or is created for. */
  workspaceRefs?: ExternalRef[];
}): GithubCredential | null {
  const parent = input.parentSession;
  if (
    parent?.automation ||
    isSupportSession({ externalRefs: input.workspaceRefs }) ||
    (parent && isSupportSession(parent))
  )
    return null;
  return parent?.createdByLogin
    ? githubCredentialForLogin(parent.createdByLogin)
    : githubCredentialForRun(input.user || parent?.createdBy);
}
