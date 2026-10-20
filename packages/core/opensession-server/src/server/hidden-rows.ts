/**
 * Name the rows behind a user's sidebar hides (hides.ts), for the sidebar's
 * "Hidden" list. The sidebar's own session projection drops hidden rows
 * (sidebar-session-scope.ts), so the client has no title or repo for them;
 * this is the small read that names them.
 *
 * The client sends the keys it holds (`POST /api/hides/rows { user, keys }`)
 * instead of the server reading its stored map. A hide's PUT and this read
 * leave the client together, and a read of the stored map can land first: the
 * just-hidden row then resolved to nothing, the list stayed empty, and nothing
 * asked again. Answering the keys the client already has makes the order
 * irrelevant.
 *
 * Only keys that still point at live work come back as rows. A key whose
 * workspace or session was archived or deleted comes back in `stale`, so the
 * list never offers to restore something that is gone. The stored entry is
 * left alone: it is harmless, and a read is not the place to write.
 *
 * `repo:<id>` keys hide a whole repository band. They are not rows, so they are
 * skipped (neither a row nor stale); the client names them from its own
 * repository list.
 */

import type { UnifiedSession } from "./types";

const REPO_HIDE_PREFIX = "repo:";

/** The most keys one request may ask about. A person's hides stay far below. */
export const MAX_HIDDEN_ROW_KEYS = 200;
/** The longest key the hides store keeps (hides.ts `clean`). */
export const MAX_HIDE_KEY_LENGTH = 128;

export interface HiddenRow {
  /** The hide key, exactly as sent. */
  key: string;
  title: string;
  /** The repo the row files under, or null for repo-less work. */
  repo: string | null;
  /** The row's most recently active session, which opening the row shows. */
  sessionId: string;
}

export interface HiddenRowsAnswer {
  rows: HiddenRow[];
  /** Row keys that point at no live work: archived, deleted or unknown. */
  stale: string[];
}

type HiddenRowSession = Pick<
  UnifiedSession,
  | "id"
  | "title"
  | "lastActivity"
  | "repo"
  | "repoLess"
  | "workspaceId"
  | "worktreeDir"
  | "archived"
  | "aliasIds"
>;

export interface HiddenRowWorkspace {
  name: string;
  repo?: string;
}

export interface HiddenRowsRequest {
  user: string;
  keys: string[];
}

/**
 * Validate a `POST /api/hides/rows` body. The request is attributed to a user
 * like every other hides route; `keys` is capped and each key bounded the way
 * the store bounds them, so the request is rejected rather than truncated.
 */
export function parseHiddenRowsRequest(
  body: unknown,
): HiddenRowsRequest | { error: string } {
  if (!body || typeof body !== "object")
    return { error: "user (string) and keys (string[]) are required" };
  const { user, keys } = body as { user?: unknown; keys?: unknown };
  if (typeof user !== "string" || !Array.isArray(keys))
    return { error: "user (string) and keys (string[]) are required" };
  if (keys.length > MAX_HIDDEN_ROW_KEYS)
    return { error: `at most ${MAX_HIDDEN_ROW_KEYS} keys per request` };
  for (const key of keys)
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_HIDE_KEY_LENGTH
    )
      return {
        error: `each key must be a string of 1 to ${MAX_HIDE_KEY_LENGTH} characters`,
      };
  return { user, keys: [...new Set(keys as string[])] };
}

function latest<T extends HiddenRowSession>(sessions: T[]): T {
  return sessions.reduce((best, session) =>
    (Date.parse(session.lastActivity) || 0) >
    (Date.parse(best.lastActivity) || 0)
      ? session
      : best,
  );
}

function sessionRepo(session: HiddenRowSession): string | null {
  return session.repoLess ? null : session.repo || null;
}

/**
 * Pure: keys × live sessions × the hidden workspaces' records → the rows they
 * name, in the order asked, and the keys that name nothing. `workspaces` only
 * needs the workspaces named by `workspace:<id>` keys.
 */
export function resolveHiddenRows(
  keys: readonly string[],
  sessions: readonly HiddenRowSession[],
  workspaces: ReadonlyMap<string, HiddenRowWorkspace>,
): HiddenRowsAnswer {
  const byWorkspace = new Map<string, HiddenRowSession[]>();
  const byWorktree = new Map<string, HiddenRowSession[]>();
  const byId = new Map<string, HiddenRowSession>();
  for (const session of sessions) {
    if (session.archived) continue;
    if (session.workspaceId) {
      const list = byWorkspace.get(session.workspaceId) ?? [];
      list.push(session);
      byWorkspace.set(session.workspaceId, list);
    } else if (session.worktreeDir) {
      const list = byWorktree.get(session.worktreeDir) ?? [];
      list.push(session);
      byWorktree.set(session.worktreeDir, list);
    }
    for (const id of [session.id, ...(session.aliasIds ?? [])])
      if (!byId.has(id)) byId.set(id, session);
  }

  const rows: HiddenRow[] = [];
  const stale: string[] = [];
  for (const key of keys) {
    if (key.startsWith(REPO_HIDE_PREFIX)) continue;
    if (key.startsWith("workspace:")) {
      const id = key.slice("workspace:".length);
      const members = byWorkspace.get(id);
      if (!members?.length) {
        stale.push(key);
        continue;
      }
      const head = latest(members);
      const workspace = workspaces.get(id);
      rows.push({
        key,
        title: workspace?.name || head.title,
        repo: workspace?.repo || sessionRepo(head),
        sessionId: head.id,
      });
      continue;
    }
    if (key.startsWith("wt:")) {
      const members = byWorktree.get(key.slice("wt:".length));
      if (!members?.length) {
        stale.push(key);
        continue;
      }
      const head = latest(members);
      rows.push({
        key,
        title: head.title,
        repo: sessionRepo(head),
        sessionId: head.id,
      });
      continue;
    }
    const session = byId.get(key);
    if (!session) {
      stale.push(key);
      continue;
    }
    rows.push({
      key,
      title: session.title,
      repo: sessionRepo(session),
      sessionId: session.id,
    });
  }
  return { rows, stale };
}

/** The workspace ids a list of hide keys names, for reading just those. */
export function hiddenWorkspaceIds(keys: readonly string[]): string[] {
  return keys
    .filter((key) => key.startsWith("workspace:"))
    .map((key) => key.slice("workspace:".length));
}

export interface HiddenRowsDeps {
  /** The live session list (the cached one the sidebar is built from). */
  sessions: () => Promise<readonly HiddenRowSession[]>;
  /**
   * Workspace records by id, read in one batch. The route answers from the
   * in-memory workspace projection, so a request costs no per-key reads.
   */
  workspaces: (
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, HiddenRowWorkspace>>;
}

/** The whole route: validate, then resolve. A Response for every outcome. */
export async function answerHiddenRows(
  body: unknown,
  deps: HiddenRowsDeps,
): Promise<Response> {
  const parsed = parseHiddenRowsRequest(body);
  if ("error" in parsed)
    return Response.json({ error: parsed.error }, { status: 400 });
  const [sessions, workspaces] = await Promise.all([
    deps.sessions(),
    deps.workspaces(hiddenWorkspaceIds(parsed.keys)),
  ]);
  return Response.json(resolveHiddenRows(parsed.keys, sessions, workspaces), {
    // The answer is about one person's keys; no shared cache may reuse it.
    headers: { "Cache-Control": "private, no-store" },
  });
}
