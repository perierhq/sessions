/**
 * Git access health: background fetches that cannot sign in back off, and
 * the instance owner hears about it once.
 *
 * The server fetches every project's default branch on timers (the warm
 * template sweep every five minutes, the worktree reaper, knowledge
 * freshness). When a project's GitHub credential breaks, each of those kept
 * failing on its own cadence, nobody was told, and the only trace was a
 * journal line per attempt. Now a background fetch asks `gitAccessDue`
 * first and reports what happened:
 *
 *  - `recordGitAccessFailure` with git's stderr and whether the fetch was
 *    handed a token. A sign-in failure (bad token, no credential, a
 *    credential helper that cannot run) opens an issue for the project and
 *    backs off exponentially (5 min doubling to 6 h). A fetch that had no
 *    token to offer is its own kind: the GitHub App isn't installed for the
 *    repository, which no amount of retrying fixes. The first failure of an issue notifies the instance owner through
 *    the inbox (notifications.ts, the path incident alerts take), keyed so
 *    a restart or a repeat never alerts twice. Any other failure (network,
 *    a missing branch) is not this module's business and changes nothing.
 *  - `recordGitAccessOk` after a fetch that worked: the issue closes, and
 *    the inbox row, if there is one, updates quietly to say so.
 *
 * Fetches a person starts (opening a session, "Refresh now") never wait for
 * the backoff; they report too, so a fixed credential clears the issue at
 * once. The project page shows the open issue (`gitAccessIssue`).
 *
 * State is one small JSON file, so the backoff and the "already told"
 * mark survive a restart. Nothing runs at import.
 */
import { existsSync, readFileSync } from "fs";
import { gitAccessTitle } from "../shared/project-settings";
import type { NotificationEvent } from "./notification-threads";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";

export const GIT_ACCESS_BASE_BACKOFF_MS = 5 * 60_000;
export const GIT_ACCESS_MAX_BACKOFF_MS = 6 * 60 * 60_000;

/** `auth`: the remote refused the credential or none was available.
 *  `helper`: the configured credential helper could not run at all.
 *  `not-installed`: the server had no token for the repository, so it had
 *  nothing to offer: the GitHub App isn't installed for its owner, or not
 *  with access to it. */
export type GitAccessFailureKind = "auth" | "helper" | "not-installed";

export interface GitAccessIssue {
  repoId: string;
  kind: GitAccessFailureKind;
  /** `owner/name` on GitHub, when the project has one. */
  ghRepo?: string;
  /** First failure of this issue (ISO). */
  since: string;
  /** Last failure (ISO). */
  lastFailureAt: string;
  /** The line of git's output that says what went wrong. */
  lastError: string;
  failures: number;
  /** When a background fetch may try again (ISO). */
  nextAttemptAt: string;
  /** The owner was told about this issue. */
  notified?: boolean;
}

interface GitAccessState {
  issues: Record<string, GitAccessIssue>;
}

const HELPER_FAILURE =
  /credential[- ]helper|github-credential|gh-credential|cs-credential/i;
const HELPER_CANNOT_RUN =
  /Permission denied|No such file or directory|not found|cannot run|not executable/i;
const AUTH_FAILURE = [
  /Authentication failed for/i,
  /could not read (Username|Password) for/i,
  /Invalid username or (token|password)/i,
  /terminal prompts disabled/i,
  /The requested URL returned error: 40[13]/i,
  /Permission denied \(publickey/i,
  /HTTP Basic: Access denied/i,
];

/** Whether git's stderr from a fetch says it could not sign in, and how.
 *  Only stderr: `not-installed` needs to know the fetch had no token
 *  (recordGitAccessFailure). */
export function classifyGitFetchFailure(
  stderr: string,
): "auth" | "helper" | null {
  for (const line of stderr.split("\n"))
    if (HELPER_FAILURE.test(line) && HELPER_CANNOT_RUN.test(line))
      return "helper";
  return AUTH_FAILURE.some((re) => re.test(stderr)) ? "auth" : null;
}

/** The most telling line of git's stderr, for a log line or the page. */
export function gitErrorLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const pick =
    lines.find((l) => HELPER_FAILURE.test(l) && HELPER_CANNOT_RUN.test(l)) ??
    lines.find((l) => /^remote:/i.test(l)) ??
    lines.find((l) => /^fatal:/i.test(l)) ??
    lines[0] ??
    "git fetch failed";
  return pick.slice(0, 240);
}

/** The wait after `failures` consecutive sign-in failures. */
export function gitAccessBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(
    GIT_ACCESS_MAX_BACKOFF_MS,
    GIT_ACCESS_BASE_BACKOFF_MS * 2 ** Math.min(n - 1, 20),
  );
}

// ── Seams ──────────────────────────────────────────────────────────────────

export type GitAccessNotify = (event: NotificationEvent) => Promise<unknown>;

let clock: () => number = Date.now;
let notifyOverride: GitAccessNotify | undefined;

/** Replace the clock and the owner notifier (tests); undefined restores. */
export function __setGitAccessSeamsForTest(seams?: {
  now?: () => number;
  notify?: GitAccessNotify;
}): void {
  clock = seams?.now ?? Date.now;
  notifyOverride = seams?.notify;
}

async function notifyOwner(event: NotificationEvent): Promise<void> {
  if (notifyOverride) {
    await notifyOverride(event);
    return;
  }
  const [{ instanceOwner }, { deliverNotification }] = await Promise.all([
    import("./incidents/owner"),
    import("./notifications"),
  ]);
  const owner = instanceOwner();
  if (!owner) {
    console.warn(
      `[git-access] nobody to tell: no instance owner (integrations.incidents.notifyUser)`,
    );
    return;
  }
  await deliverNotification(owner, event);
}

// ── State ──────────────────────────────────────────────────────────────────

function stateFile(): string {
  return stateDir("git-access-health.json");
}

function readState(): GitAccessState {
  try {
    const file = stateFile();
    if (!existsSync(file)) return { issues: {} };
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const issues =
      parsed?.issues && typeof parsed.issues === "object" ? parsed.issues : {};
    return { issues };
  } catch {
    return { issues: {} };
  }
}

function writeState(state: GitAccessState): void {
  try {
    writeJsonAtomic(stateFile(), state);
  } catch (e) {
    console.warn("[git-access] could not save state:", e);
  }
}

/** The open sign-in issue for a project, or null. */
export function gitAccessIssue(repoId: string): GitAccessIssue | null {
  return readState().issues[repoId] ?? null;
}

/** Whether a background fetch for `repoId` may run now: true unless an
 *  open issue's backoff has not run out. */
export function gitAccessDue(repoId: string): boolean {
  const issue = gitAccessIssue(repoId);
  if (!issue) return true;
  const next = Date.parse(issue.nextAttemptAt);
  return !Number.isFinite(next) || clock() >= next;
}

function settingsUrl(repoId: string): string {
  return `/settings/projects/${encodeURIComponent(repoId)}`;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`;
}

/**
 * Report a failed fetch for `repo`. Returns the open issue when git's
 * stderr says it could not sign in, null for any other failure (nothing is
 * recorded then). `token: false` says the fetch was handed no token (the
 * server could not mint one for the repository); a sign-in failure is then
 * `not-installed` rather than a refused credential. A change of kind is a
 * new issue, and the owner hears about it.
 */
export async function recordGitAccessFailure(
  repo: { id: string; label?: string; ghRepo?: string },
  stderr: string,
  opts: { token?: boolean } = {},
): Promise<GitAccessIssue | null> {
  const seen = classifyGitFetchFailure(stderr);
  if (!seen) return null;
  const kind: GitAccessFailureKind =
    seen === "auth" && opts.token === false ? "not-installed" : seen;
  const now = clock();
  const state = readState();
  const open = state.issues[repo.id];
  const prev = open?.kind === kind ? open : undefined;
  const failures = (prev?.failures ?? 0) + 1;
  const wait = gitAccessBackoffMs(failures);
  const issue: GitAccessIssue = {
    repoId: repo.id,
    kind,
    ...(repo.ghRepo ? { ghRepo: repo.ghRepo } : {}),
    since: prev?.since ?? new Date(now).toISOString(),
    lastFailureAt: new Date(now).toISOString(),
    lastError: gitErrorLine(stderr),
    failures,
    nextAttemptAt: new Date(now + wait).toISOString(),
    ...(prev?.notified ? { notified: true } : {}),
  };
  state.issues[repo.id] = issue;
  writeState(state);
  console.warn(
    `[git-access] ${repo.id}: fetch could not sign in${kind === "not-installed" ? ` (${gitAccessTitle(issue)})` : ""} (${failures} in a row since ${issue.since}); next background try in ${minutes(wait)}: ${issue.lastError}`,
  );
  if (!issue.notified) {
    try {
      await notifyOwner({
        kind: "access_failing",
        subject: { type: "repo", id: repo.id, title: repo.label || repo.id },
        reason: gitAccessTitle(issue),
        body:
          kind === "not-installed"
            ? `The server has no GitHub token for this repository. Install the GitHub App on ${repo.ghRepo?.split("/")[0] || "its owner"} with access to it; background fetches back off until then. ${issue.lastError}`
            : `Background fetches back off until this is fixed. ${issue.lastError}`,
        url: settingsUrl(repo.id),
        eventKey: `git-access:${repo.id}:${issue.since}`,
        at: now,
      });
      // Re-read: another fetch may have closed or changed the issue while
      // the notification was being recorded.
      const latest = readState();
      const current = latest.issues[repo.id];
      if (current && current.since === issue.since) {
        current.notified = true;
        writeState(latest);
      }
      issue.notified = true;
    } catch (e) {
      // Not marked: the next failure tries to tell the owner again.
      console.warn(
        `[git-access] ${repo.id}: could not notify the owner:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return issue;
}

/** Report a fetch for `repoId` that worked: closes an open issue. */
export async function recordGitAccessOk(repo: {
  id: string;
  label?: string;
}): Promise<void> {
  const state = readState();
  const issue = state.issues[repo.id];
  if (!issue) return;
  delete state.issues[repo.id];
  writeState(state);
  console.log(
    `[git-access] ${repo.id}: fetch signs in again (after ${issue.failures} failures since ${issue.since})`,
  );
  if (!issue.notified) return;
  try {
    await notifyOwner({
      kind: "access_failing",
      subject: { type: "repo", id: repo.id, title: repo.label || repo.id },
      reason: "Git signs in to GitHub again",
      body: "Background fetches are back to their usual schedule.",
      url: settingsUrl(repo.id),
      eventKey: `git-access:${repo.id}:${issue.since}:ok`,
      at: clock(),
      delivery: "quiet",
      existingOnly: true,
    });
  } catch {
    // The row keeps saying it failed; the project page is already clear.
  }
}
