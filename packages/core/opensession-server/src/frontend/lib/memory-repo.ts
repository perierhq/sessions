import { request } from "./api/request";

/** A memory repository (git, Agent Memory Repo format) as Settings sees it. */
export interface MemoryRepoDto {
  name: string;
  label: string;
  head: string | null;
  remote: MemoryRemoteStatus;
}

export interface MemoryRemoteStatus {
  url?: string;
  lastSyncAt?: string;
  ok?: boolean;
  error?: string;
  conflict?: { files: string[]; at: string };
}

export interface MemoryCommitDto {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ status: string; path: string }>;
  sessionId?: string;
  pushedBy?: string;
}

export function fetchMemoryRepos(): Promise<{ repos: MemoryRepoDto[] }> {
  return request("/memory/repos", {
    label: "Failed to load memory repositories",
  });
}

export function fetchMemoryHistory(
  repo: string,
  opts: { limit?: number; entry?: string } = {},
): Promise<{ commits: MemoryCommitDto[] }> {
  const params = new URLSearchParams({ repo });
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.entry) params.set("entry", opts.entry);
  return request(`/memory/history?${params.toString()}`, {
    label: "Failed to load memory history",
  });
}

export function fetchMemoryCommit(
  repo: string,
  sha: string,
): Promise<{ diff: string }> {
  const params = new URLSearchParams({ repo, sha });
  return request(`/memory/commit?${params.toString()}`, {
    label: "Failed to load the change",
  });
}

export function revertMemoryCommit(
  repo: string,
  sha: string,
): Promise<{ ok: boolean }> {
  return request("/memory/revert", {
    method: "POST",
    body: { repo, sha },
    label: "Failed to revert the change",
  });
}

export function fetchMemoryFiles(repo: string): Promise<{ files: string[] }> {
  return request(`/memory/files?${new URLSearchParams({ repo }).toString()}`, {
    label: "Failed to load memory files",
  });
}

export function fetchMemoryFile(
  repo: string,
  path: string,
): Promise<{ content: string }> {
  return request(
    `/memory/file?${new URLSearchParams({ repo, path }).toString()}`,
    {
      label: "Failed to load the file",
    },
  );
}

export function saveMemoryRemote(
  repo: string,
  url: string,
): Promise<{ remote: MemoryRemoteStatus }> {
  return request("/memory/remote", {
    method: "PUT",
    body: { repo, url },
    label: "Failed to save the remote",
  });
}

export function syncMemoryRemote(
  repo: string,
): Promise<{ remote: MemoryRemoteStatus }> {
  return request("/memory/remote/sync", {
    method: "POST",
    body: { repo },
    label: "Failed to sync the remote",
  });
}

/** Moved to lib/commit-diff with the diff block it colours; kept here for
 *  the callers that import it from this module. */
export { diffLineTone } from "./commit-diff";
