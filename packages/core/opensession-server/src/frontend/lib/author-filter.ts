/**
 * Whose pull requests or issues a list shows: anyone, one teammate, or the
 * people outside the team (the public and bots). The server classifies each
 * GitHub author (`authorKind`); this decides which rows a choice keeps, what
 * small marker a row carries, and remembers the choice per page on this
 * device, the way the sidebar remembers its filter.
 */
import type { AuthorKind } from "./api";
import { personLabel } from "./pr-rows";

export const ANYONE = "all";
// Not a person key: those are lowercased first names, which never start with
// a colon.
export const OUTSIDE_TEAM = ":outside";

export type AuthorFilterPage = "prs" | "issues";

interface AuthorRow {
  person: string | null;
  /** Absent on rows known only from a session, which are the team's. */
  authorKind?: AuthorKind;
}

export function isPersonFilter(filter: string): boolean {
  return filter !== ANYONE && filter !== OUTSIDE_TEAM;
}

export function matchesAuthorFilter(row: AuthorRow, filter: string): boolean {
  if (filter === ANYONE) return true;
  if (filter === OUTSIDE_TEAM)
    return row.authorKind === "outside" || row.authorKind === "bot";
  return row.person === filter;
}

/** The small label a row from outside the team carries, on every scope. */
export function authorMarker(
  kind: AuthorKind | undefined,
): "Outside" | "Bot" | null {
  if (kind === "outside") return "Outside";
  if (kind === "bot") return "Bot";
  return null;
}

export function authorFilterLabel(filter: string): string {
  if (filter === ANYONE) return "Anyone";
  if (filter === OUTSIDE_TEAM) return "Outside the team";
  return personLabel(filter);
}

function storageKey(page: AuthorFilterPage): string {
  return `opensession-${page}-author-filter`;
}

function valid(value: string | null): value is string {
  return !!value && value.length <= 64;
}

export function readAuthorFilter(page: AuthorFilterPage): string {
  try {
    const value = localStorage.getItem(storageKey(page));
    return valid(value) ? value : ANYONE;
  } catch {
    return ANYONE;
  }
}

export function writeAuthorFilter(page: AuthorFilterPage, value: string): void {
  try {
    // The default's absence is its stored form.
    if (value === ANYONE) localStorage.removeItem(storageKey(page));
    else localStorage.setItem(storageKey(page), value);
  } catch {
    // The choice still applies for this visit when storage is unavailable.
  }
}

/** A remembered teammate who has since left the roster reads as anyone. An
 *  empty roster has not loaded yet, so the choice stands until it does. */
export function resolveAuthorFilter(
  filter: string,
  rosterKeys: readonly string[],
): string {
  if (!isPersonFilter(filter) || rosterKeys.length === 0) return filter;
  return rosterKeys.includes(filter) ? filter : ANYONE;
}
