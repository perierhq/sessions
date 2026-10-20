/**
 * Per-user UI reading preferences (small string key→value map). Like pins.ts /
 * tab-colors.ts, each user (the self-selected `backstage-user` name from the
 * UserPicker — not an auth identity) gets one JSON file under
 * `~/.opensession-ui-prefs/` of shape `{ prefs: { [key]: value } }`.
 * These are cross-device view preferences (first user: the turn-activity fold
 * setting) — the localStorage copy on each browser is just a cache of this.
 * Filename, directory resolution and legacy-name fallback come from
 * shared/user-store.ts.
 *
 * Writes are PATCH-merge (not replace): each device only knows the prefs it
 * has touched, so a whole-map PUT from a stale device would clobber keys set
 * elsewhere. A key set to null in the patch is deleted.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomicAsync } from "./shared/atomic-write";
import { userStore } from "./shared/user-store";

// Guardrails on a free-form map: sane key shape, short string values, bounded
// entry count — this is a preferences file, not a datastore.
const KEY_RE = /^[a-z][a-zA-Z0-9-]{0,40}$/;
const MAX_VALUE_LEN = 200;
const LONG_VALUE_KEYS = new Set([
  "active-order",
  "repo-order",
  "session-checkouts",
  "shortcuts",
]);
const MAX_LONG_VALUE_LEN = 16_384;
const MAX_ENTRIES = 100;

export function maxValueLength(key: string): number {
  return LONG_VALUE_KEYS.has(key) ? MAX_LONG_VALUE_LEN : MAX_VALUE_LEN;
}

export type UiPrefs = Record<string, string>;

export function normalizedUiPrefValue(key: string, value: string): string {
  // Automatic repository selection was retired. An old preference now means
  // "use the workspace default", represented by the ordinary empty value.
  return key === "default-repo" && value === "auto" ? "" : value;
}

/** Keep only valid key → short-string entries. */
function clean(input: unknown): UiPrefs {
  const out: UiPrefs = {};
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (Object.keys(out).length >= MAX_ENTRIES) break;
      if (
        KEY_RE.test(key) &&
        typeof value === "string" &&
        value.length <= maxValueLength(key)
      ) {
        out[key] = normalizedUiPrefValue(key, value);
      }
    }
  }
  return out;
}

const store = userStore<UiPrefs>({ name: "ui-prefs", field: "prefs", clean });

export function getUiPrefs(user: string): UiPrefs {
  return store.get(user);
}

export function expectedUiPrefsMatch(
  current: UiPrefs,
  expected: unknown,
): boolean {
  if (!expected || typeof expected !== "object") return true;
  for (const [key, value] of Object.entries(
    expected as Record<string, unknown>,
  )) {
    if (!KEY_RE.test(key)) return false;
    if (value === null) {
      if (key in current) return false;
    } else if (typeof value !== "string" || current[key] !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Merge `patch` into a user's prefs (null value deletes the key). Returns the
 * stored map after the merge.
 */
export function patchUiPrefs(
  user: string,
  patch: unknown,
  expected?: unknown,
): UiPrefs {
  const current = getUiPrefs(user);
  if (!expectedUiPrefsMatch(current, expected)) return current;
  if (patch && typeof patch === "object") {
    for (const [key, value] of Object.entries(
      patch as Record<string, unknown>,
    )) {
      if (!KEY_RE.test(key)) continue;
      if (value === null) delete current[key];
      else if (typeof value === "string" && value.length <= maxValueLength(key))
        current[key] = normalizedUiPrefValue(key, value);
    }
  }
  return store.set(user, current);
}

/** Drop a repository from one prefs map: the personal new-session default
 *  that names it, and its slot in the sidebar's repo band order. */
export function prefsWithoutRepo(prefs: UiPrefs, repoId: string): UiPrefs {
  const next = { ...prefs };
  // "" rather than a deleted key: clients apply an explicit reset to their
  // cached copy, and "" already means "no preference".
  if (next["default-repo"] === repoId) next["default-repo"] = "";
  const order = next["repo-order"];
  if (order) {
    try {
      const parsed: unknown = JSON.parse(order);
      if (Array.isArray(parsed) && parsed.includes(repoId))
        next["repo-order"] = JSON.stringify(
          parsed.filter((key) => key !== repoId),
        );
    } catch {
      // Not ours to repair; the client normalizes an unreadable order.
    }
  }
  return next;
}

/**
 * Forget a removed repository in every person's UI prefs, so no one's
 * new-session default or band order keeps naming it. Rewrites only the files
 * that change, and keeps every other field in them. Returns how many changed.
 */
export async function forgetRepoInUiPrefs(repoId: string): Promise<number> {
  const root = store.dir();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let changed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(root, name);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      const doc = parsed as Record<string, unknown>;
      const prefs = clean(doc.prefs);
      const next = prefsWithoutRepo(prefs, repoId);
      if (JSON.stringify(next) === JSON.stringify(prefs)) continue;
      await writeJsonAtomicAsync(file, { ...doc, prefs: next });
      changed++;
    } catch {
      // One unreadable file must not stop the others from being cleaned.
    }
  }
  return changed;
}
