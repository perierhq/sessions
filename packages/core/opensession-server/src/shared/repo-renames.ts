/**
 * Repo ids that have been renamed: former id → the one it is registered under
 * now. Same idea as LEGACY_SESSIONS_DIR_NAMES in server/paths.ts, one level
 * up: a stored repo id is a foreign key into the registry, so a rename leaves
 * every record written before it pointing at a repo that no longer exists.
 * Those records do not fail loudly, they split off: the sidebar draws a second
 * band for the dangling id, under the same display name and without the
 * repo's icon, and `getRepo` throws for anything that tries to resolve a
 * checkout from it.
 *
 * Only Open Session's own rename is listed, because that is the one this
 * codebase performed. An instance that renames a repo in its own config adds
 * the old id here.
 *
 * Shared so the web client can read its own stored repo ids (sidebar repo
 * hides) the way the server reads persisted ones (server/config.ts
 * `canonicalRepoId`).
 */
export const RENAMED_REPO_IDS: Readonly<Record<string, string>> = {
  // Open Session was called Backstage until 2026-08-05.
  backstage: "opensession",
};

/**
 * The registered id a stored repo id means. The old name wins only while it is
 * genuinely gone: an instance that registers a repo under it again owns that
 * id, and its records are its own.
 */
export function canonicalRepoIdAmong(
  id: string,
  isRegistered: (id: string) => boolean,
): string {
  const renamed = RENAMED_REPO_IDS[id];
  return renamed && !isRegistered(id) ? renamed : id;
}
