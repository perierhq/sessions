// The sidebar's Hidden list: what you took off your sidebar, with a way to put
// each one back. See lib/hides.ts for what a hide is.
//
// The server names hidden rows (`/api/hides/rows`), because the sidebar's own
// session list leaves them out. It only returns rows whose work still exists,
// so an archived or deleted session never shows up here. This module filters
// that answer against the live hides map, so a Restore drops its row at once
// instead of waiting for the next fetch.
import type { HiddenRow } from "./api";
import { repoFromHideKey } from "./hides";

interface HiddenListEntryBase {
  /** The hide key; Restore clears exactly this. */
  key: string;
  hiddenAt: string;
}

/** A hidden sidebar row: a workspace or a session. */
export interface HiddenRowEntry extends HiddenListEntryBase {
  kind: "row";
  title: string;
  /** The repo the row files under, or null for repo-less work. */
  repo: string | null;
  /** The session opening the entry shows. */
  sessionId: string;
}

/** A hidden repository band. */
export interface HiddenRepoEntry extends HiddenListEntryBase {
  kind: "repo";
  repo: string;
}

export type HiddenListEntry = HiddenRowEntry | HiddenRepoEntry;

/**
 * The entries to list, most recently hidden first. A row the server named but
 * whose hide has since been cleared (restored here, on another device, or
 * consumed because it was blocked on a question) is left out.
 *
 * Hidden repositories come from the hides map itself, named against
 * `knownRepos` (the sidebar's repository list). A repo no longer in it was
 * removed, so its hide is stale and left out like an archived row's.
 */
export function hiddenListEntries(
  rows: readonly HiddenRow[],
  hides: Record<string, string>,
  knownRepos: readonly string[] = [],
): HiddenListEntry[] {
  const entries: HiddenListEntry[] = [];
  for (const row of rows) {
    const hiddenAt = hides[row.key];
    if (!hiddenAt) continue;
    entries.push({
      kind: "row",
      key: row.key,
      hiddenAt,
      title: row.title,
      repo: row.repo,
      sessionId: row.sessionId,
    });
  }
  const known = new Set(knownRepos);
  for (const [key, hiddenAt] of Object.entries(hides)) {
    const repo = repoFromHideKey(key);
    if (repo && known.has(repo))
      entries.push({ kind: "repo", key, hiddenAt, repo });
  }
  return entries.sort(
    (a, b) => (Date.parse(b.hiddenAt) || 0) - (Date.parse(a.hiddenAt) || 0),
  );
}

/**
 * A key for the set of hidden rows the server should name. The list is
 * refetched when it changes, not on every hides write that leaves it alone.
 * Repository keys are left out: the server has nothing to say about them.
 */
export function hiddenRowsSignature(hides: Record<string, string>): string {
  return Object.keys(hides)
    .filter((key) => !repoFromHideKey(key))
    .sort()
    .join("\n");
}
