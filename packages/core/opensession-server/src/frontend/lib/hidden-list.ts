// The sidebar's Hidden list: what you took off your sidebar, with a way to put
// each one back. See lib/hides.ts for what a hide is.
//
// The server names hidden rows (`/api/hides/rows`), because the sidebar's own
// session list leaves them out. It only returns rows whose work still exists,
// so an archived or deleted session never shows up here. This module filters
// that answer against the live hides map, so a Restore drops its row at once
// instead of waiting for the next fetch.
import type { HiddenRow } from "./api";

export interface HiddenListEntry {
  /** The hide key; Restore clears exactly this. */
  key: string;
  hiddenAt: string;
  title: string;
  /** The repo the row files under, or null for repo-less work. */
  repo: string | null;
  /** The session opening the entry shows. */
  sessionId: string;
}

/**
 * The entries to list, most recently hidden first. A row the server named but
 * whose hide has since been cleared (restored here, on another device, or
 * consumed because it was blocked on a question) is left out.
 */
export function hiddenListEntries(
  rows: readonly HiddenRow[],
  hides: Record<string, string>,
): HiddenListEntry[] {
  const entries: HiddenListEntry[] = [];
  for (const row of rows) {
    const hiddenAt = hides[row.key];
    if (!hiddenAt) continue;
    entries.push({
      key: row.key,
      hiddenAt,
      title: row.title,
      repo: row.repo,
      sessionId: row.sessionId,
    });
  }
  return entries.sort(
    (a, b) => (Date.parse(b.hiddenAt) || 0) - (Date.parse(a.hiddenAt) || 0),
  );
}

/**
 * A key for the set of hidden rows the server should name. The list is
 * refetched when it changes, not on every hides write that leaves it alone.
 */
export function hiddenRowsSignature(hides: Record<string, string>): string {
  return Object.keys(hides).sort().join("\n");
}
