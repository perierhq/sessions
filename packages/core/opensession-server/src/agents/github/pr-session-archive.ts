/**
 * Archive lifecycle for a PR's own automation sessions
 * (`bks-ghpr-<pr>-review`, `-autofix`, `-mention`, ...).
 *
 * These sessions exist only to serve one pull request, so once it merges or
 * closes they are done. The `pull_request` `closed` webhook archives them with
 * the automatic `auto` reason, and a reopen or new push brings back the ones
 * that close archived. A session someone archived by hand stays archived.
 *
 * A session a run still owns at close is left alone, and archived once that
 * run ends if the PR is still closed. Which PRs are closed is known only in
 * memory, so a session whose run ends after a restart is left to the backfill.
 *
 * `backfillClosedPrSessions` is the explicit, operator-run cleanup for
 * instances that accumulated these sessions before the webhook did this. It
 * is dry-run unless asked to apply and is never run automatically.
 */
import { configuredRepos, type Repo } from "../../server/config";
import type { ArchiveReason } from "../../server/archive";
import { audit } from "../../server/audit";
import type { UnifiedSession } from "../../server/types";
import { prKey } from "./constants";
import { bksIdFor, type GithubRunKind } from "./run";

// ── Per-PR ordering ──────────────────────────────────────────

interface LifecycleState {
  /** The tail of each PR's pending lifecycle work. An entry is dropped once
   * its last task settles, so the map holds only PRs with work in flight. */
  chains: Map<string, Promise<unknown>>;
  /** GitHub runs between runGithubAgent's start and end, per session id. */
  runsInFlight: Map<string, number>;
  /** PRs this process saw close and not reopen since, oldest first. */
  closedPrs: Set<string>;
  /** Sessions closing left alone because a run owned them, by session id. */
  watches: Map<string, RunEndWatch>;
}

interface RunEndWatch {
  prNumber: number;
  ghRepo?: string;
  key: string;
  deps: PrSessionArchiveDeps;
  stop: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Checks since the run last ended that still found it busy. */
  checks: number;
}

const g = globalThis as { __osPrSessionLifecycle?: LifecycleState };
const lifecycle: LifecycleState = (g.__osPrSessionLifecycle ??= {
  chains: new Map(),
  runsInFlight: new Map(),
  closedPrs: new Set(),
  watches: new Map(),
});
// A state object parked by an older build may predate later fields.
lifecycle.runsInFlight ??= new Map();
lifecycle.closedPrs ??= new Set();
lifecycle.watches ??= new Map();

/** Closed PRs remembered at most. Only sessions still owned by a run at
 * close consult this; the oldest falls off first. */
const CLOSED_PRS_MAX = 2000;
/** Sessions waiting for their run to end at most; past it, the backfill. */
const RUN_END_WATCHES_MAX = 500;
/** How long after a run ends its session is checked again. Teardown (engine
 * release, run state, journal clear) can finish after the turn-end event. */
export const PR_SESSION_RECHECK_DELAY_MS = 5_000;
/** Checks after one run end before waiting for the next one. */
const RECHECKS_PER_RUN_END = 3;

/** Forget all lifecycle state. Tests only. */
export function __resetPrSessionLifecycleForTest(): void {
  for (const id of [...lifecycle.watches.keys()]) dropWatch(id);
  lifecycle.chains.clear();
  lifecycle.runsInFlight.clear();
  lifecycle.closedPrs.clear();
}

function lifecycleKey(prNumber: number, ghRepo?: string): string {
  return prKey(prNumber, ghRepo);
}

/**
 * Run one PR's lifecycle steps in the order they arrived. Close and reopen
 * webhooks are handled fire-and-forget, so without this a reopen right after
 * a close checked the registry while the close was still archiving, found
 * nothing to restore, and the close then archived the sessions anyway.
 */
export function serialisePrLifecycle<T>(
  prNumber: number,
  ghRepo: string | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const key = lifecycleKey(prNumber, ghRepo);
  const prior = lifecycle.chains.get(key) ?? Promise.resolve();
  const run = prior.then(task);
  const tail = run.then(
    () => {},
    () => {},
  );
  lifecycle.chains.set(key, tail);
  void tail.then(() => {
    if (lifecycle.chains.get(key) === tail) lifecycle.chains.delete(key);
  });
  return run;
}

/** Kinds whose session belongs to one open PR. Two kinds are excluded:
 *  - `issue`: its number is an issue's, and that session is a code session a
 *    person may keep using.
 *  - `followup`: a mention on a PR that is already closed starts it (see
 *    runConversationalMention), on a fresh branch that opens a new PR. Its
 *    PR is always closed, so closing or the backfill would archive it while
 *    it is still in use. */
export const PR_SESSION_KINDS = [
  "review",
  "autofix",
  "simplify",
  "mention",
  "adversarial",
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
  /** Call `onEnd` each time the session's run ends; returns the unsubscribe.
   * Without it a session busy at close is left to the backfill. */
  watchRunEnd?(sessionId: string, onEnd: () => void): () => void;
  /** Overrides PR_SESSION_RECHECK_DELAY_MS. */
  recheckDelayMs?: number;
}

async function defaultDeps(): Promise<PrSessionArchiveDeps> {
  const [
    archiveModule,
    { findSessionAsync, publishSessionChange },
    { indexedWorkspaceMembers },
    { isAgentSessionBusy },
    { executeArchiveOverrideProjection },
    { unarchiveForHumanTurn },
    { onSessionStateChange },
  ] = await Promise.all([
    import("../../server/archive"),
    import("../../server/session-cache"),
    import("../../server/session-list-store"),
    import("../../server/agent-runner"),
    import("../../server/session-projection-executor"),
    import("../../server/session-unarchive"),
    import("../../server/session-state-events"),
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
    watchRunEnd: (sessionId, onEnd) =>
      onSessionStateChange((event) => {
        if (event.sessionId === sessionId && !event.isRunning) onEnd();
      }),
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
    if (lifecycle.runsInFlight.has(session.id) || deps.isRunBusy(session)) {
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
  const resolved = deps ?? (await defaultDeps());
  return serialisePrLifecycle(prNumber, ghRepo, async () => {
    markPrClosed(lifecycleKey(prNumber, ghRepo));
    const result = await archiveIdleSessions(
      prSessionIds(prNumber, ghRepo),
      resolved,
    );
    for (const id of result.skippedRunning)
      watchUntilRunEnds(id, prNumber, ghRepo, resolved);
    return result;
  });
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
  return serialisePrLifecycle(prNumber, ghRepo, async () => {
    markPrOpen(lifecycleKey(prNumber, ghRepo));
    const restored: string[] = [];
    for (const id of prSessionIds(prNumber, ghRepo)) {
      if (
        !resolved.isArchivedId(id) ||
        resolved.getArchiveReason(id) !== "auto"
      )
        continue;
      const session = await resolved.findSession(id);
      if (session && (await resolved.unarchive(session))) restored.push(id);
    }
    return restored;
  });
}

// ── Sessions a run owned at close ────────────────────────────

function markPrClosed(key: string): void {
  const closed = lifecycle.closedPrs;
  closed.delete(key);
  closed.add(key);
  if (closed.size > CLOSED_PRS_MAX)
    closed.delete(closed.values().next().value!);
}

function markPrOpen(key: string): void {
  lifecycle.closedPrs.delete(key);
  for (const [id, watch] of lifecycle.watches)
    if (watch.key === key) dropWatch(id);
}

function dropWatch(id: string): void {
  const watch = lifecycle.watches.get(id);
  if (!watch) return;
  lifecycle.watches.delete(id);
  if (watch.timer) clearTimeout(watch.timer);
  watch.stop();
}

/** Archive the session once its run ends, if the PR is still closed then. */
function watchUntilRunEnds(
  id: string,
  prNumber: number,
  ghRepo: string | undefined,
  deps: PrSessionArchiveDeps,
): void {
  if (lifecycle.watches.has(id) || !deps.watchRunEnd) return;
  if (lifecycle.watches.size >= RUN_END_WATCHES_MAX) return;
  const watch: RunEndWatch = {
    prNumber,
    ghRepo,
    key: lifecycleKey(prNumber, ghRepo),
    deps,
    stop: () => {},
    checks: 0,
  };
  lifecycle.watches.set(id, watch);
  watch.stop = deps.watchRunEnd(id, () => runEnded(id));
}

function runEnded(id: string): void {
  const watch = lifecycle.watches.get(id);
  if (!watch) return;
  watch.checks = 0;
  scheduleRecheck(id, watch);
}

function scheduleRecheck(id: string, watch: RunEndWatch): void {
  if (watch.timer) clearTimeout(watch.timer);
  const timer = setTimeout(() => {
    watch.timer = undefined;
    void serialisePrLifecycle(watch.prNumber, watch.ghRepo, async () => {
      if (lifecycle.watches.get(id) !== watch) return;
      if (!lifecycle.closedPrs.has(watch.key)) return dropWatch(id);
      const result = await archiveIdleSessions([id], watch.deps);
      if (result.skippedRunning.length) {
        // Still tearing down, or a new run started. Look again a few times,
        // then wait for the next run end.
        if (++watch.checks < RECHECKS_PER_RUN_END) scheduleRecheck(id, watch);
        return;
      }
      dropWatch(id);
      if (!result.archived.length) return;
      console.log(
        `[github] PR #${watch.prNumber} is closed: archived ${id} after its run ended`,
      );
      audit({
        msg: "github_pr_sessions_archived",
        pr_number: watch.prNumber,
        repo: watch.ghRepo,
        session_ids: result.archived,
      });
    }).catch((e) =>
      console.warn(`[github] archiving ${id} after its run failed:`, e),
    );
  }, watch.deps.recheckDelayMs ?? PR_SESSION_RECHECK_DELAY_MS);
  (timer as { unref?: () => void }).unref?.();
  watch.timer = timer;
}

// ── GitHub runs ──────────────────────────────────────────────

/**
 * A GitHub run for this PR session is starting. Marks it in flight until the
 * returned function is called, so closing the PR leaves it alone: the run
 * journal only sees a GitHub run once its engine starts, after the
 * credential, worktree and workspace steps. A session that closing already
 * archived is restored first, the way a human turn restores one, so the run
 * never happens out of sight. Only `auto` archives are restored.
 */
export async function beginPrSessionRun(
  prNumber: number,
  kind: GithubRunKind,
  ghRepo?: string,
  deps?: PrSessionArchiveDeps,
): Promise<() => void> {
  if (!(PR_SESSION_KINDS as readonly GithubRunKind[]).includes(kind))
    return () => {};
  const id = bksIdFor(prNumber, kind, ghRepo);
  const runs = lifecycle.runsInFlight;
  runs.set(id, (runs.get(id) ?? 0) + 1);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    const left = (runs.get(id) ?? 1) - 1;
    if (left > 0) runs.set(id, left);
    else runs.delete(id);
    runEnded(id);
  };
  try {
    const resolved = deps ?? (await defaultDeps());
    // On the PR's chain, so an archive still being written is seen.
    await serialisePrLifecycle(prNumber, ghRepo, async () => {
      if (resolved.getArchiveReason(id) !== "auto") return;
      const session = await resolved.findSession(id);
      if (!session || !(await resolved.unarchive(session))) return;
      console.log(`[github] ${id} is running again: unarchived it`);
      // Still closed: archive it again once this run is done.
      if (lifecycle.closedPrs.has(lifecycleKey(prNumber, ghRepo)))
        watchUntilRunEnds(id, prNumber, ghRepo, resolved);
    });
  } catch (e) {
    console.warn(`[github] restoring ${id} for its run failed:`, e);
  }
  return end;
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
