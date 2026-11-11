// Repository visibility, for the parts of a run that publish text where the
// whole internet can read it: PR bodies, commit messages, branch names, PR
// comments, images. A public repository must never receive private
// organization information, so every decision here fails closed: when the
// visibility cannot be confirmed, the repository is treated as public.

import type { Repo } from "./config";

// Capability URLs and PR text are unlisted, not access-controlled: once
// posted on a PUBLIC repo, anyone reading the thread sees them. The registry
// can contain PUBLIC repos, and the instance credential can post to them, so
// callers MUST gate on visibility. Cached per ghRepo for the process lifetime,
// unless a caller passes `maxAgeMs`: Blob's own posts (github-blob.ts) ask
// again after 10 minutes, so a repository made public is noticed soon.
const repoVisibilityCache = new Map<
  string,
  { isPrivate: boolean; at: number }
>();

interface VisibilityDeps {
  now(): number;
  token(ghRepo: string): Promise<string | null | undefined>;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

const defaultVisibilityDeps: VisibilityDeps = {
  now: Date.now,
  token: async (ghRepo) =>
    (await import("./github-limit")).botGhToken({ repo: ghRepo }),
  fetch: (url, init) => fetch(url, init),
};
let visibilityDeps = defaultVisibilityDeps;

/** Swap the clock, token and network in tests; clears the cache. Returns a
 *  restore function. */
export function __setRepoVisibilityDepsForTest(
  overrides: Partial<VisibilityDeps>,
): () => void {
  const previous = visibilityDeps;
  visibilityDeps = { ...defaultVisibilityDeps, ...overrides };
  repoVisibilityCache.clear();
  return () => {
    visibilityDeps = previous;
    repoVisibilityCache.clear();
  };
}

/** True = private, false = public, null = could not determine (treat as
 *  public / refuse). An answer older than `maxAgeMs` is asked again. */
export async function repoIsPrivate(
  ghRepo: string,
  options: { maxAgeMs?: number } = {},
): Promise<boolean | null> {
  const cached = repoVisibilityCache.get(ghRepo);
  if (
    cached &&
    (options.maxAgeMs === undefined ||
      visibilityDeps.now() - cached.at < options.maxAgeMs)
  )
    return cached.isPrivate;
  const token = await visibilityDeps.token(ghRepo);
  if (!token) return null;
  try {
    const res = await visibilityDeps.fetch(
      `https://api.github.com/repos/${ghRepo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "opensession",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    if (typeof data?.private !== "boolean") return null;
    repoVisibilityCache.set(ghRepo, {
      isPrivate: data.private,
      at: visibilityDeps.now(),
    });
    return data.private;
  } catch {
    return null;
  }
}

/**
 * Whether a run in this repo must treat everything it publishes as public.
 *
 * An explicit `repos.<id>.public` in config.json is authoritative. Otherwise
 * a GitHub repo is asked for its visibility; code.storage repos are private
 * to the instance. Anything unconfirmed (no token, API failure, no GitHub
 * remote) counts as public, because the cost of the rule on a private repo
 * is a paragraph of prompt, and the cost of missing it on a public repo is a
 * leak.
 */
export async function treatRepoAsPublic(
  repo: Pick<Repo, "ghRepo" | "host" | "public"> | undefined,
  lookup: (ghRepo: string) => Promise<boolean | null> = repoIsPrivate,
): Promise<boolean> {
  if (!repo) return false;
  if (typeof repo.public === "boolean") return repo.public;
  if (repo.host === "codestorage") return false;
  if (!repo.ghRepo) return true;
  const isPrivate = await lookup(repo.ghRepo);
  return isPrivate !== true;
}
