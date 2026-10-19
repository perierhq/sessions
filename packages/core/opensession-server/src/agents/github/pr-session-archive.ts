/**
 * Archive lifecycle for a PR's own automation sessions
 * (`bks-ghpr-<pr>-review`, `-autofix`, `-mention`, ...).
 *
 * These sessions exist only to serve one pull request, so once it merges or
 * closes they are done. The `pull_request` `closed` webhook archives them with
 * the automatic `auto` reason, and a reopen or new push brings back the ones
 * that close archived. A session someone archived by hand stays archived.
 *
 * `backfillClosedPrSessions` is the explicit, operator-run cleanup for
 * instances that accumulated these sessions before the webhook did this. It
 * is dry-run unless asked to apply and is never run automatically.
 */
import { configuredRepos, type Repo } from "../../server/config";
import type { ArchiveReason } from "../../server/archive";
import type { UnifiedSession } from "../../server/types";
import { prKey } from "./constants";
import { bksIdFor, type GithubRunKind } from "./run";

/** Kinds whose session belongs to one PR. `issue` is excluded: its number is
 *  an issue's, and that session is a code session a person may keep using. */
export const PR_SESSION_KINDS = [
  "review",
  "autofix",
  "simplify",
  "mention",
  "adversarial",
  "followup",
] as const satisfies readonly GithubRunKind[];

export type PrSessionKind = (typeof PR_SESSION_KINDS)[number];

const PR_SESSION_ID = new RegExp(
  `^bks-ghpr-(.+)-(${PR_SESSION_KINDS.join("|")})$`,
);

/** Every session id a PR's automation can own. */
export function prSessionIds(
  prNumber: number,
  ghRepo?: string,
  repos?: Record<string, Repo>,
): string[] {
  return PR_SESSION_KINDS.map((kind) =>
    bksIdFor(prNumber, kind, ghRepo, repos),
  );
}

export interface ParsedPrSessionId {
  prNumber: number;
  ghRepo: string;
  kind: PrSessionKind;
}

/**
 * The PR a `bks-ghpr-*` session id names, resolved against the configured
 * repositories. Null for other ids, issue sessions, and keys that no
 * configured repository produces (an id from a repo no longer registered).
 */
export function parsePrSessionId(
  id: string,
  repos: Record<string, Repo> = configuredRepos(),
): ParsedPrSessionId | null {
  const match = PR_SESSION_ID.exec(id);
  if (!match) return null;
  const key = match[1]!;
  const kind = match[2] as PrSessionKind;
  const digits = /(?:^|-)(\d+)$/.exec(key);
  if (!digits) return null;
  const prNumber = Number(digits[1]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  for (const repo of Object.values(repos)) {
    if (!repo.ghRepo) continue;
    if (prKey(prNumber, repo.ghRepo, repos) === key)
      return { prNumber, ghRepo: repo.ghRepo, kind };
  }
  return null;
}

/** What a `pull_request` action means for the PR's own sessions. */
export function prSessionLifecycleAction(
  action: string,
): "archive" | "unarchive" | null {
  if (action === "closed") return "archive";
  if (action === "reopened" || action === "synchronize") return "unarchive";
  return null;
}

export interface PrSessionArchiveDeps {
  findSession(id: string): Promise<UnifiedSession | undefined>;
  /** An in-flight run owns the session (journal, engine, or run state). */
  isRunBusy(session: UnifiedSession): boolean;
  isArchivedId(id: string): boolean;
  getArchiveReason(id: string): ArchiveReason | null;
  /** Archive with the automatic reason and publish the row. */
  archive(session: UnifiedSession): Promise<void>;
  /** Restore the session the way a human turn does. */
  unarchive(session: UnifiedSession): Promise<boolean>;
  /** Drop pins made stale by a batch that was just archived. */
  afterArchive(sessions: UnifiedSession[]): Promise<void>;
}

async function defaultDeps(): Promise<PrSessionArchiveDeps> {
  const [
    archiveModule,
    { findSessionAsync, publishSessionChange },
    { indexedWorkspaceMembers },
    { isAgentSessionBusy },
    { executeArchiveOverrideProjection },
    { unarchiveForHumanTurn },
  ] = await Promise.all([
    import("../../server/archive"),
    import("../../server/session-cache"),
    import("../../server/session-list-store"),
    import("../../server/agent-runner"),
    import("../../server/session-projection-executor"),
    import("../../server/session-unarchive"),
  ]);
  return {
    findSession: findSessionAsync,
    // Runtime state, not the row's `isRunning`: a stale row must not keep a
    // finished session from being archived.
    isRunBusy: (session) =>
      isAgentSessionBusy(
        session.claudeSessionId,
        session.codexThreadId,
        session.id,
      ),
    isArchivedId: archiveModule.isArchivedId,
    getArchiveReason: archiveModule.getArchiveReason,
    archive: async (session) => {
      await executeArchiveOverrideProjection(session.id, () =>
        archiveModule.setArchived(session.id, true, "auto"),
      );
      await publishSessionChange(session.id);
    },
    unarchive: (session) => unarchiveForHumanTurn(session),
    // Workspace pins need the workspace's other members only, so read just
    // those rows instead of the whole session list.
    afterArchive: async (sessions) => {
      const workspaceIds = [
        ...new Set(
          sessions
            .map((session) => session.workspaceId)
            .filter((id): id is string => !!id),
        ),
      ];
      const members = (
        await Promise.all(workspaceIds.map((id) => indexedWorkspaceMembers(id)))
      ).flat();
      await archiveModule.unpinArchivedSessions(sessions, members);
    },
  };
}

export interface PrSessionArchiveResult {
  archived: string[];
  /** Live sessions left alone because a run still owns them. */
  skippedRunning: string[];
}

/** Archive the given PR sessions that are live and idle. */
async function archiveIdleSessions(
  ids: string[],
  deps: PrSessionArchiveDeps,
  justArchived: UnifiedSession[] = [],
  settle = true,
): Promise<PrSessionArchiveResult> {
  const result: PrSessionArchiveResult = { archived: [], skippedRunning: [] };
  for (const id of ids) {
    const session = await deps.findSession(id);
    if (!session || session.archived || deps.isArchivedId(session.id)) continue;
    if (deps.isRunBusy(session)) {
      result.skippedRunning.push(session.id);
      continue;
    }
    await deps.archive(session);
    result.archived.push(session.id);
    justArchived.push(session);
  }
  if (settle && justArchived.length) await deps.afterArchive(justArchived);
  return result;
}

/** The PR merged or closed: archive its idle automation sessions. */
export async function archiveClosedPrSessions(
  prNumber: number,
  ghRepo?: string,
  deps?: PrSessionArchiveDeps,
): Promise<PrSessionArchiveResult> {
  return archiveIdleSessions(
    prSessionIds(prNumber, ghRepo),
    deps ?? (await defaultDeps()),
  );
}

/**
 * The PR reopened or moved: bring back the sessions that closing it archived.
 * Only `auto` archives are restored, so a manual archive stays put. The
 * registry is in memory, so a push to a PR with nothing archived costs no
 * session lookups.
 */
export async function unarchiveReopenedPrSessions(
  prNumber: number,
  ghRepo?: string,
  deps?: PrSessionArchiveDeps,
): Promise<string[]> {
  const resolved = deps ?? (await defaultDeps());
  const restored: string[] = [];
  for (const id of prSessionIds(prNumber, ghRepo)) {
    if (!resolved.isArchivedId(id) || resolved.getArchiveReason(id) !== "auto")
      continue;
    const session = await resolved.findSession(id);
    if (session && (await resolved.unarchive(session))) restored.push(id);
  }
  return restored;
}

// ── Backfill ─────────────────────────────────────────────────

export type PullRequestState = "open" | "closed";

export interface BackfillPrSession {
  id: string;
  prNumber: number;
  ghRepo: string;
}

export interface PrSessionBackfillDeps extends PrSessionArchiveDeps {
  /** Live `bks-ghpr-*` rows from the session list projection. */
  liveSessions(): Promise<UnifiedSession[]>;
  /** The PR's state on GitHub, or null when it could not be read. */
  pullRequestState(
    prNumber: number,
    ghRepo: string,
  ): Promise<PullRequestState | null>;
}

export interface PrSessionBackfillOptions {
  /** Archive for real. Without it the backfill only reports. */
  apply?: boolean;
  /** At most this many distinct PRs are looked up on GitHub. */
  limit?: number;
}

export interface PrSessionBackfillReport {
  dryRun: boolean;
  /** Distinct PRs whose state was looked up. */
  checkedPrs: number;
  /** PRs past the limit, left for a later run. */
  remainingPrs: number;
  /** Sessions whose PR is closed or merged. A dry run would archive these. */
  candidates: BackfillPrSession[];
  archived: string[];
  skippedRunning: string[];
  /** PRs whose state GitHub did not return; their sessions are untouched. */
  unknownPrs: Array<{ prNumber: number; ghRepo: string }>;
}

export const PR_SESSION_BACKFILL_DEFAULT_LIMIT = 200;

async function defaultBackfillDeps(): Promise<PrSessionBackfillDeps> {
  const [base, { getSessionListSnapshotAsync }, { getIssue }] =
    await Promise.all([
      defaultDeps(),
      import("../../server/session-cache"),
      import("./github-rest"),
    ]);
  return {
    ...base,
    liveSessions: () => getSessionListSnapshotAsync("exclude"),
    pullRequestState: async (prNumber, ghRepo) => {
      const issue = await getIssue(prNumber, ghRepo);
      if (!issue || !issue.isPullRequest) return null;
      return issue.state;
    },
  };
}

/**
 * Archive live PR automation sessions whose PR is no longer open. One GitHub
 * read per distinct PR; a PR whose state cannot be read is left alone.
 */
export async function backfillClosedPrSessions(
  options: PrSessionBackfillOptions = {},
  deps?: PrSessionBackfillDeps,
  repos?: Record<string, Repo>,
): Promise<PrSessionBackfillReport> {
  const resolved = deps ?? (await defaultBackfillDeps());
  const limit =
    options.limit && options.limit > 0
      ? Math.floor(options.limit)
      : PR_SESSION_BACKFILL_DEFAULT_LIMIT;
  const byPr = new Map<string, BackfillPrSession[]>();
  for (const session of await resolved.liveSessions()) {
    if (session.archived || !session.id.startsWith("bks-ghpr-")) continue;
    const parsed = parsePrSessionId(session.id, repos);
    if (!parsed) continue;
    const key = `${parsed.ghRepo.toLowerCase()}#${parsed.prNumber}`;
    const group = byPr.get(key) ?? [];
    group.push({
      id: session.id,
      prNumber: parsed.prNumber,
      ghRepo: parsed.ghRepo,
    });
    byPr.set(key, group);
  }
  const groups = [...byPr.values()];
  const report: PrSessionBackfillReport = {
    dryRun: !options.apply,
    checkedPrs: 0,
    remainingPrs: Math.max(0, groups.length - limit),
    candidates: [],
    archived: [],
    skippedRunning: [],
    unknownPrs: [],
  };
  const justArchived: UnifiedSession[] = [];
  for (const group of groups.slice(0, limit)) {
    const { prNumber, ghRepo } = group[0]!;
    report.checkedPrs++;
    const state = await resolved.pullRequestState(prNumber, ghRepo);
    if (state === null) {
      report.unknownPrs.push({ prNumber, ghRepo });
      continue;
    }
    if (state === "open") continue;
    report.candidates.push(...group);
    if (!options.apply) continue;
    const result = await archiveIdleSessions(
      group.map((session) => session.id),
      resolved,
      justArchived,
      false,
    );
    report.archived.push(...result.archived);
    report.skippedRunning.push(...result.skippedRunning);
  }
  if (justArchived.length) await resolved.afterArchive(justArchived);
  return report;
}
