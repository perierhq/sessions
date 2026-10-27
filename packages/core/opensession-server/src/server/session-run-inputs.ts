/**
 * What a session's NEXT TURN is scoped to, engine-neutral: the MCP allowlist,
 * the tool denials, the identity the `allowedUsers` gate runs against, and
 * which in-process opensession-* server set the run carries.
 *
 * Extracted verbatim from `runSessionPromptInner` (run-session.ts) so that the
 * introspection endpoint (`GET /api/sessions/:id/effective-config`) and the
 * real turn cannot disagree: one decision, two readers. Every branch here is
 * security-relevant — resuming an automation-owned session must keep that
 * automation's scoping, and automation runs must pass no user so a
 * user-restricted MCP server stays invisible to them.
 *
 * Deliberately free of the in-process MCP builders: importing
 * interactive-mcp.ts starts the run-rpc listener as a module side effect, and
 * this module is read by a plain GET route and by tests. It names the BRANCH;
 * each caller constructs the servers it needs.
 */

import type { UnifiedSession } from "./types";
import {
  type Automation,
  automationDeniedTools,
  automationMcpServersByName,
} from "./automations";
import {
  humanPrompter,
  interactivePrompter,
  waitContinuationOwner,
} from "./session-actors";
import { type GitIdentity, commitAuthorFor } from "./shared/user-mappings";
import {
  plainDiscussionDeniedTools,
  supportDeniedTools,
} from "./automation-denied-tools";
import { INCIDENT_ACCESS_SERVER } from "../shared/incident-access";
import type { IncidentTurnScope } from "./incidents/access/session-policy";

/** Which config decided the run's MCP allowlist. */
export type McpScopeSource =
  /** The owning automation's `mcpServers` allowlist (automations store). */
  | "automation"
  /** The session file's own `mcpServers` (stamped at create time). */
  | "session"
  /** The feed project(s) this session's external refs belong to. */
  | "feed"
  /** No allowlist: every configured server the user may see. */
  | "all";

/** Which in-process opensession-* server set the run carries. */
export type InProcessMcpBranch =
  /** Automation-owned: the automation-bar set, plus the scoped spawn/self
   *  pair when the automation is `selfImprove`. Both automation branches add
   *  the approval server when the session reports into a Plain discussion
   *  (an auto-triage run's `plainDiscussionId`; see automationSessionMcp). */
  | "automation-self-improve"
  /** Automation-owned, prompted by a person themselves: the automation-bar
   *  set plus `opensession-sessions` in its spawn-only `humanResume` shape,
   *  so the session can start the work the person asked for. Never the
   *  automation's own ticks, a scheduled /loop tick sent in a person's name,
   *  or a sandboxed descendant. */
  | "automation+human-spawn"
  /** Automation-owned, woken by a background wait that a person's own turn
   *  registered (`waitActor` sender): the automation-bar set plus
   *  `opensession-sessions` in its `waitContinuation` shape (the waits and
   *  task_status, never spawning), so the turn can follow up on what the
   *  person asked it to watch. */
  | "automation+wait-continuation"
  /** Plain discussion session: only the approval server
   *  (opensession-plain-discussion), never the interactive siblings. */
  | "plain-discussion"
  /** Support session (an `externalRefs` entry of kind `support`): only
   *  opensession-support, never the interactive siblings. It reads
   *  untrusted customer mail and runs with no person at the keyboard. */
  | "support"
  /** Goal-driven session: the interactive set plus opensession-goal-self. */
  | "interactive+goal-self"
  /** The normal interactive self-management set. */
  | "interactive";

export interface SessionRunInputs {
  /** The session is owned by an automation — an interactive resume of one
   *  keeps the automation's scoping (allowlist + denials + no user). */
  isAutomationSession: boolean;
  /** MCP allowlist for the run; undefined means "all" (no allowlist). Kept as
   *  undefined rather than [] on purpose: an empty array is truthy, and
   *  `sharedPiEligible` reads any allowlist as "not shared", which once
   *  kicked every follow-up prompt onto a dedicated server whose empty shard
   *  DB could not resume the engine session (bks-019f818d, 2026-07-20). */
  mcpServers: string[] | undefined;
  mcpServersSource: McpScopeSource;
  /** Tool-permission denials, or undefined when the run carries none. */
  deniedTools: Record<string, string> | undefined;
  /** The hosts web_fetch is held to (pi-web-search.ts): an incident
   *  agent's egress hosts, or a support session's websites (global plus the
   *  project's ticked for Support); undefined for every other run. */
  webFetchHosts?: string[];
  /** The prompter, or undefined for automation-owned sessions (which must
   *  never clear a server's `allowedUsers` gate). */
  user: string | undefined;
  /** Session creator, whose OAuth grants take precedence for MCP calls. */
  mcpGrantUser: string | undefined;
  /** The person whose personal provider subscription may serve this turn:
   *  the human who sent the prompt, or undefined when a machine did (an
   *  automation tick, a review handoff, auto-continue). Unlike `user` it
   *  survives an automation-owned session, because a person who takes one
   *  over and presses send is spending their own subscription; the shared
   *  pool stays the backup. It reaches provider account selection only,
   *  never MCP, GitHub or trust policy. A scheduled /loop tick keeps the
   *  name of the person who set it here, because the turn is billed to them. */
  accountUser: string | undefined;
  /** The person who sent this turn themselves, or undefined: every machine
   *  actor and every scheduled tick (`"Kent (loop)"`) resolves to undefined
   *  even though `accountUser` keeps the name. This, not `accountUser`, is
   *  what an automation-owned session's `automation+human-spawn` branch and
   *  the run token's `humanPrompter` read: a capability a present person
   *  unlocks must not fire from scheduled prompt text. The one exception is
   *  a `waitActor` wake (`"<person> (wait)"`), kept here so
   *  automationSessionMcp can mount its narrower continuation shape. */
  humanPrompter: string | undefined;
  inProcessMcpBranch: InProcessMcpBranch;
  /** Whether the run gets the repos/memory/personal-prompt note. Automation
   *  runs get none: their prompts are untrusted text. */
  sessionNote: boolean;
  /** The in-process servers a bound incident agent's run proxies
   *  (`[INCIDENT_ACCESS_SERVER]`); empty for every other session. */
  incidentProxyMcpServers: string[];
  /** Why a bound incident agent's next turn would be refused; only set when
   *  resolved for a view (`audit: false`), where a refusal does not throw. */
  incidentRefusal?: string;
}

/** The session fields this module reads. Structural so callers (and tests)
 *  need not build a whole UnifiedSession. */
export type RunInputsSession = Pick<
  UnifiedSession,
  | "automation"
  | "automationDescendantPolicy"
  | "mcpServers"
  | "externalRefs"
  | "goalId"
  | "startedBy"
  | "createdByLogin"
  | "plainDiscussionId"
> &
  Partial<Pick<UnifiedSession, "id" | "mode" | "repo" | "runner">>;

/** A session that answers a support conversation: its workspace (and so
 *  the session) carries an `externalRefs` entry of kind `support`. */
export function isSupportSession(
  session: Pick<RunInputsSession, "externalRefs">,
): boolean {
  return !!session.externalRefs?.some((r) => r.kind === "support");
}

/** Whose git identity a turn's commits carry (shared/user-mappings.ts
 *  commitAuthorFor): the sender, else the session owner. A support session
 *  carries none, so it commits as the GitHub App's bot alone: its creator is
 *  the persona, and a persona named like a teammate would otherwise resolve
 *  to that teammate, their co-author trailer and their GitHub token
 *  (pi-run-authority.ts githubCredentialUser). */
export function runCommitAuthor(
  session: Pick<RunInputsSession, "externalRefs">,
  user?: string | null,
  owner?: string | null,
): GitIdentity | null {
  return isSupportSession(session) ? null : commitAuthorFor(user, owner);
}

/** One support turn's scope, read fresh from the project's access table so
 *  a settings change applies to the next turn of a running session: the
 *  connectors ticked for Support (never people-restricted ones), the
 *  support deny-set plus a web_search denial when Support's cell is off,
 *  and web_fetch held to the global websites plus the project's websites
 *  ticked for Support. Unreadable settings give no connectors and no web
 *  search. Used by every turn (resolveSessionRunInputs) and the opening
 *  turn (session-create.ts). */
export async function supportTurnScope(project: string | undefined): Promise<{
  mcpServers: string[];
  deniedTools: Record<string, string>;
  webFetchHosts: string[];
}> {
  const [effective, { globalWebsites }, { supportMcpServers }] =
    await Promise.all([
      import("./projects/effective"),
      import("./projects/global-defaults"),
      import("./support/session-policy"),
    ]);
  let mcpServers: string[] = [];
  let web: { deniedTools: Record<string, string>; websites: string[] } = {
    deniedTools: { web_search: effective.WEB_SEARCH_OFF },
    websites: [],
  };
  if (project) {
    try {
      mcpServers = await supportMcpServers(project);
    } catch (error) {
      console.warn(
        `[support] ${project} settings unreadable, the support turn gets no connectors:`,
        error instanceof Error ? error.message : error,
      );
    }
    web = await effective.roleWebAccess(project, "support");
  }
  return {
    mcpServers,
    deniedTools: { ...supportDeniedTools(), ...web.deniedTools },
    webFetchHosts: [...new Set([...globalWebsites(), ...web.websites])],
  };
}

/** Which in-process server set the next turn carries. Pure — mirrors the
 *  `inProcessMcp` ternary at the runAgent call site. `humanPrompter` is the
 *  person who sent this turn themselves (`interactivePrompter(user)`), if
 *  any; a scheduled tick or machine actor passes undefined. */
export function sessionInProcessMcpBranch(
  session: RunInputsSession,
  humanPrompter?: string | null,
): InProcessMcpBranch {
  if (session.automationDescendantPolicy) return "automation-self-improve";
  if (session.automation)
    return humanPrompter
      ? waitContinuationOwner(humanPrompter)
        ? "automation+wait-continuation"
        : "automation+human-spawn"
      : "automation-self-improve";
  if (isSupportSession(session)) return "support";
  if (session.plainDiscussionId) return "plain-discussion";
  return session.goalId ? "interactive+goal-self" : "interactive";
}

/** Which config supplies the MCP allowlist. Pure; the `feed` branch still has
 *  to be resolved asynchronously to learn the server NAMES. */
export function sessionMcpScopeSource(
  session: RunInputsSession,
): McpScopeSource {
  if (session.automation || session.automationDescendantPolicy)
    return "automation";
  if (session.mcpServers && session.mcpServers.length) return "session";
  if (session.externalRefs?.length) return "feed";
  return "all";
}

/**
 * The per-turn run inputs for a session. `user` is the prompter (the WS/HTTP
 * caller); it is dropped for automation-owned sessions. `accountUser` keeps
 * the prompter for provider account selection when they are a person.
 *
 * Async because a feed-workspace session's allowlist comes from its feed
 * providers' descriptors (`feedMcpServersForRefs`), which registers feeds on
 * first call.
 */
export async function resolveSessionRunInputs(
  session: RunInputsSession,
  opts: {
    user?: string;
    /** Off for a read-only view of the next turn: an incident agent's
     *  access is resolved without audit lines, and a refusal empties its
     *  scope and sets incidentRefusal instead of throwing. */
    audit?: boolean;
  } = {},
): Promise<SessionRunInputs> {
  const isAutomationSession = !!(
    session.automation || session.automationDescendantPolicy
  );
  // A discussion session answers a trusted teammate but reads untrusted
  // ticket text, so its turns get the triage automation's policy: the
  // automation deny-set plus the customer-facing Plain writes and the Stripe
  // money movers (both go through the opensession-plain-discussion approval
  // card instead), and no user, so an allowedUsers-gated server stays
  // invisible to it. An automation-owned session that reports into a
  // discussion keeps its automation branch and takes the same wider deny-set.
  const isPlainDiscussionSession = !!session.plainDiscussionId;
  // A support session reads untrusted customer mail with no person at the
  // keyboard: per turn, the project's Support row decides its connectors
  // and web reach, it carries the support deny-set and no user.
  const supportScope =
    !isAutomationSession && isSupportSession(session)
      ? await supportTurnScope(session.repo)
      : null;
  const source = supportScope ? "session" : sessionMcpScopeSource(session);
  // An incident agent re-resolves its access before every turn; a refusal
  // throws so the turn never starts, and the scope is never wider than the
  // spawn snapshot (incidents/access/session-policy.ts). A view resolves it
  // without audit and shows a refusal as an empty scope.
  const bound = !!session.automationDescendantPolicy?.incident;
  let incidentRefusal: string | undefined;
  let incidentScope: IncidentTurnScope | null = null;
  if (bound) {
    const policy = await import("./incidents/access/session-policy");
    if (opts.audit === false) {
      const viewed = await policy.viewIncidentTurnScope(session);
      if (viewed && "refused" in viewed) incidentRefusal = viewed.refused;
      else incidentScope = viewed;
    } else incidentScope = await policy.incidentTurnScope(session);
    if (!incidentScope && incidentRefusal === undefined)
      throw new Error("Incident agent access could not be resolved");
  }
  const mcpServers = incidentScope
    ? [...incidentScope.mcpServers]
    : supportScope
      ? supportScope.mcpServers
      : incidentRefusal !== undefined
        ? []
        : session.automationDescendantPolicy
          ? [...session.automationDescendantPolicy.mcpServers]
          : isAutomationSession
            ? await automationMcpServersByName(session.automation!)
            : source === "session"
              ? session.mcpServers
              : source === "feed"
                ? // Feed-workspace sessions are scoped to their feed's declared MCP
                  // servers even when the session file predates the stamping (least
                  // privilege — the feeds design).
                  await (
                    await import("./feeds")
                  ).feedMcpServersForRefs(session.externalRefs!)
                : undefined;
  // A support turn acts for nobody, whoever it is sent as: a sender that
  // reads as a person (a persona named like a teammate, a stray turn sent
  // under a teammate's name) must not pick that person's provider account
  // or make the session theirs.
  const accountUser = supportScope
    ? undefined
    : (humanPrompter(opts.user) ?? undefined);
  // A wait's wake sent in a person's name rides the same field, so every
  // launch path hands it to automationSessionMcp, which tells the two apart.
  const prompter = supportScope
    ? undefined
    : (interactivePrompter(opts.user) ??
      (waitContinuationOwner(opts.user) ? opts.user!.trim() : undefined));
  return {
    isAutomationSession,
    mcpServers,
    // An automation whose record is gone (or that names no allowlist) resolves
    // to undefined, i.e. no allowlist — report the source honestly.
    mcpServersSource: mcpServers === undefined ? "all" : source,
    deniedTools: incidentScope
      ? // The automation deny-set always stays; access can only add to it.
        { ...automationDeniedTools(), ...incidentScope.deniedTools }
      : supportScope
        ? supportScope.deniedTools
        : isPlainDiscussionSession
          ? plainDiscussionDeniedTools()
          : isAutomationSession
            ? automationDeniedTools()
            : undefined,
    user:
      isAutomationSession || isPlainDiscussionSession || supportScope
        ? undefined
        : opts.user,
    mcpGrantUser: supportScope
      ? undefined
      : session.createdByLogin || undefined,
    accountUser,
    humanPrompter: prompter,
    inProcessMcpBranch: sessionInProcessMcpBranch(session, prompter),
    sessionNote: !isAutomationSession && !supportScope,
    incidentProxyMcpServers: incidentScope ? [INCIDENT_ACCESS_SERVER] : [],
    ...(incidentScope?.access.egress?.hosts.length
      ? { webFetchHosts: [...incidentScope.access.egress.hosts] }
      : supportScope
        ? { webFetchHosts: supportScope.webFetchHosts }
        : {}),
    ...(incidentRefusal !== undefined ? { incidentRefusal } : {}),
  };
}

/**
 * Provider account routing for one turn, shared by every launch path: the
 * in-process runAgent, the detached pi host (also for a Sandbox session) and a
 * Runner. Account selection tries a pin before personal accounts
 * (resolveAccount), so
 * a person who takes over an automation-owned session pays with their own
 * subscription only if their turn carries no pin at all: personal accounts
 * first, the shared pool as backup. The automation's own turns keep their
 * pin. A disposable sandbox resume passes the owning automation for its hard
 * pin and credit policy (its cost ceiling); every other machine turn keeps the
 * session's soft pin. The automation's MCP and GitHub restrictions are
 * unaffected: they read `user`, which stays dropped. Interactive sessions
 * always keep their own soft pin, except a fixed-subscription session: its
 * pin is hard on every turn, with no usage credits, whoever prompts.
 */
export function runAccountSpec(
  session: Pick<UnifiedSession, "accountId" | "subscriptionPolicy">,
  turn: Pick<SessionRunInputs, "isAutomationSession"> & {
    accountUser?: string | undefined;
  },
  pinnedAutomation: Pick<
    Automation,
    "accountId" | "usageCredits"
  > | null = null,
): {
  accountId: string | undefined;
  accountStrict: boolean | undefined;
  usageCredits: boolean | undefined;
} {
  if (session.subscriptionPolicy === "fixed") {
    return {
      accountId: session.accountId,
      accountStrict: true,
      usageCredits: false,
    };
  }
  if (turn.isAutomationSession && turn.accountUser) {
    return {
      accountId: undefined,
      accountStrict: undefined,
      usageCredits: undefined,
    };
  }
  if (pinnedAutomation) {
    return {
      accountId: pinnedAutomation.accountId,
      accountStrict: true,
      usageCredits: pinnedAutomation.usageCredits,
    };
  }
  return {
    accountId: session.accountId,
    accountStrict: undefined,
    usageCredits: undefined,
  };
}
