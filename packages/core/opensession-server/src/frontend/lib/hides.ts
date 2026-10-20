// Sidebar hides, stored server-side per user (keyed on the UserPicker name)
// like pins and snoozes, so they follow you across devices.
//
// Hiding is the personal counterpart to archiving: archiving is global, so it
// removes a session for the whole team — wrong when a teammate is still working
// in it. A hide is an overlay on a sidebar row key (`workspace:<id>`,
// `wt:<dir>` or a solo session id) that only ever affects you; the session keeps
// running and stays in everyone else's sidebar.
//
// A hidden row is off your sidebar, not filed into a band among the others.
// The way back is a quiet "Hidden" row at the foot of the sidebar, shown only
// while something is hidden: it opens a list of what you hid (name, repo, when),
// each with Restore (`clearHides`), and clicking a name opens that session
// without unhiding it. The server names those rows (`/api/hides/rows`), because
// the sidebar's own session list leaves hidden rows out, and it skips any whose
// work has since been archived or deleted. A hidden session also stays findable
// in the ⌘K palette (which ignores hides). Opening one keeps its row hidden; the
// viewer offers "Keep in sidebar" instead. Prompting in a session clears its
// hide outright (`unhideForSession`): you can't be done with work you're
// actively doing.
//
// A whole repository band can be hidden too, under `repo:<id>` in the same
// map (row menu on the band header, or the switch in Customize sidebar). Its
// rows leave your sidebar like hidden rows do, with the same guarantees: the
// open session's row stays, and a row blocked on a question still shows, in
// its band with only those rows. Unlike a row hide, a blocked row does NOT
// consume the repo hide; the rest of the repo stays hidden. Starting a new
// session in a hidden repo restores it (`unhideRepo`), since you are clearly
// working there again. The Hidden list offers repos too; opening one filters
// the sidebar to that repo, which shows its band without restoring it.
//
// A hide is otherwise sticky (unlike a snooze, it has no expiry), with one
// exception the Sidebar applies: a hidden row resurfaces while any of its sessions
// is blocked on a question, and the entry is consumed when that happens — so a
// hide can never swallow work that needs you. The public API stays synchronous
// (an in-memory cache) mirroring snoozes.ts: the store is a lib/user-map
// instance, which owns hydration and ordered per-key delta writes.
import { fetchHides, saveHidesApi } from "./api";
import * as userMap from "./user-map";

const CHANGE_EVENT = "opensession-hides-changed";

// The lifecycle (hydration, pending write intents, and stale-response guards)
// lives in makeUserMap; it also keeps the module
// importable outside a browser, which `partitionHidden` below is unit-tested
// through.
const store = userMap.makeUserMap<string>({
  changeEvent: CHANGE_EVENT,
  name: "hides",
  fetchMap: fetchHides,
  saveDelta: saveHidesApi,
});

export function getHides(): Record<string, string> {
  return store.get();
}

export function isHiddenForSession(
  session: {
    id: string;
    workspaceId?: string | null;
    worktreeDir?: string | null;
  },
  hides = store.get(),
): boolean {
  return [
    session.id,
    ...(session.workspaceId ? [`workspace:${session.workspaceId}`] : []),
    ...(session.worktreeDir ? [`wt:${session.worktreeDir}`] : []),
  ].some((key) => key in hides);
}

export function setHide(key: string): void {
  store.update((hides) =>
    key in hides ? null : { ...hides, [key]: new Date().toISOString() },
  );
}

/**
 * Drop hide entries. Takes a list so the Sidebar can consume several resurfaced
 * rows in one write; idempotent, since multiple tabs race to clear the same key.
 */
export function clearHides(keys: string[]): void {
  store.update((hides) => {
    const doomed = keys.filter((k) => k in hides);
    if (!doomed.length) return null;
    const next = { ...hides };
    for (const k of doomed) delete next[k];
    return next;
  });
}

/**
 * Clear the hide covering a session, whichever row key its row uses (a session can
 * sit under `workspace:<id>`, `wt:<dir>` or its own id — the Sidebar picks).
 * Called when the user PROMPTS in a session: you can't be done with a session you're
 * actively working in, and "I replied but it's still gone from my sidebar"
 * reads as a bug. Opening a hidden session deliberately does NOT unhide it.
 */
export function unhideForSession(session: {
  id: string;
  workspaceId?: string | null;
  worktreeDir?: string | null;
}): void {
  clearHides([
    session.id,
    ...(session.workspaceId ? [`workspace:${session.workspaceId}`] : []),
    ...(session.worktreeDir ? [`wt:${session.worktreeDir}`] : []),
  ]);
}

export function onHidesChanged(handler: () => void): () => void {
  return store.onChanged(handler);
}

/**
 * Split rows into "stays hidden" and "resurfaced", applying the one exception
 * to a hide: a row blocked on a question comes back, so hiding can never
 * swallow work that is waiting on a human. The caller consumes `resurfaced`
 * (clear the entries, mark them unread), which is what makes the rule
 * one-shot — the row then stays visible until it's hidden again, instead of
 * flickering as questions get asked and answered.
 */
type HiddenPartition<T> = {
  hiddenKeys: Set<string>;
  resurfaced: T[];
};

export function partitionHidden<T extends { key: string; status: string }>(
  rows: T[],
  hides: Record<string, string>,
): HiddenPartition<T> {
  const hiddenKeys = new Set<string>();
  const resurfaced: T[] = [];
  for (const row of rows) {
    if (!(row.key in hides)) continue;
    if (row.status === "needsinput") resurfaced.push(row);
    else hiddenKeys.add(row.key);
  }
  return { hiddenKeys, resurfaced };
}

// ── Repository hides ─────────────────────────────────────────────────────

const REPO_HIDE_PREFIX = "repo:";

/** The hides key that hides a whole repository band. */
export function repoHideKey(repo: string): string {
  return `${REPO_HIDE_PREFIX}${repo}`;
}

/** The repo a `repo:<id>` key hides, or null for a row key. */
export function repoFromHideKey(key: string): string | null {
  return key.startsWith(REPO_HIDE_PREFIX)
    ? key.slice(REPO_HIDE_PREFIX.length) || null
    : null;
}

/**
 * The repositories hidden in a hides map. `shown` is a repo to leave out of
 * the set: the sidebar's own repo filter, because a filter that names a hidden
 * repo is the person asking to see it.
 */
export function hiddenRepos(
  hides: Record<string, string>,
  shown: string | null = null,
): Set<string> {
  const repos = new Set<string>();
  for (const key of Object.keys(hides)) {
    const repo = repoFromHideKey(key);
    if (repo && repo !== shown) repos.add(repo);
  }
  return repos;
}

export function hideRepo(repo: string): void {
  setHide(repoHideKey(repo));
}

/**
 * Restore a hidden repository. Also called when you start a session in one:
 * the new session would otherwise land somewhere you cannot see it, which is
 * the repo-level version of `unhideForSession`.
 */
export function unhideRepo(repo: string): void {
  clearHides([repoHideKey(repo)]);
}

/**
 * The keys of rows a hidden repository takes off the sidebar. Two rows stay
 * whatever their repo: the one holding the open session, and any blocked on a
 * question, so a repo hide can never swallow work that needs you. Neither
 * consumes the hide (unlike `partitionHidden`): the rest of the repo stays
 * hidden, and the band shows with only those rows.
 *
 * `repoOf` returns null for rows that file under no repository band (scratch
 * and feed rows), which a repo hide never touches.
 */
export function partitionHiddenRepos<T extends { key: string; status: string }>(
  rows: T[],
  repos: ReadonlySet<string>,
  repoOf: (row: T) => string | null,
  isOpen: (row: T) => boolean,
): Set<string> {
  const hiddenKeys = new Set<string>();
  if (repos.size === 0) return hiddenKeys;
  for (const row of rows) {
    const repo = repoOf(row);
    if (!repo || !repos.has(repo)) continue;
    if (row.status === "needsinput" || isOpen(row)) continue;
    hiddenKeys.add(row.key);
  }
  return hiddenKeys;
}
