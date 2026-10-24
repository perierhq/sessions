import { expect, test } from "bun:test";
import type { RecentPr } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { buildWorktreeRows } from "../lib/pr-rows";
import { matchesAuthorFilter, OUTSIDE_TEAM } from "../lib/author-filter";

test("keeps GitHub merged state authoritative over stale archived session data", () => {
  const url = "https://github.com/tellahq/backstage/pull/59";
  const recentPr = {
    url,
    repo: "opensession",
    branch: "os1-review-sidebar-open",
    state: "MERGED",
    number: 59,
    title: "Review view-tab",
    additions: 10,
    deletions: 2,
    isDraft: false,
    reviewDecision: "",
    createdAt: "2026-07-16T13:00:00Z",
    updatedAt: "2026-07-16T14:00:00Z",
    person: "kent",
    author: "tella-butler",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  } satisfies RecentPr;
  const session = {
    id: "bks-review",
    source: "opensession",
    title: "Review view-tab",
    repo: "opensession",
    branch: "os1-review-sidebar-open",
    worktreeDir: null,
    prUrl: url,
    prState: "OPEN",
    lastActivity: "2026-07-16T13:00:00Z",
    createdAt: "2026-07-16T13:00:00Z",
    isRunning: false,
    archived: true,
    startedBy: "Kent",
  } satisfies UnifiedSession;

  const rows = buildWorktreeRows([recentPr], [session]);

  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe("MERGED");
  expect(rows[0].archived).toBe(false);
  expect(rows[0].session).toBe(session);
});

test("keeps line stats for every projected session PR", () => {
  const session = {
    id: "bks-cross-repo",
    source: "opensession",
    title: "Cross-repo change",
    branch: null,
    worktreeDir: null,
    lastActivity: "2026-07-16T13:00:00Z",
    createdAt: "2026-07-16T13:00:00Z",
    isRunning: false,
    startedBy: "Kent",
    prs: [
      {
        repo: "opensession",
        branch: "feature",
        source: "primary",
        url: "https://github.com/tellahq/opensession/pull/59",
        additions: 10,
        deletions: 2,
      },
      {
        repo: "shared-infra",
        branch: "feature",
        source: "attached",
        url: "https://github.com/tellahq/shared-infra/pull/126",
        additions: 25,
        deletions: 4,
      },
    ],
  } satisfies UnifiedSession;

  const rows = buildWorktreeRows([], [session]);
  const stats = rows.map(({ repo, additions, deletions }) => ({
    repo,
    additions,
    deletions,
  }));

  expect(stats).toEqual([
    { repo: "opensession", additions: 10, deletions: 2 },
    { repo: "shared-infra", additions: 25, deletions: 4 },
  ]);
});

test("an outsider's PR stays outside the team once a teammate's session adopts it", () => {
  const url = "https://github.com/acme/acme-web/pull/12";
  const recentPr = {
    url,
    repo: "acme-web",
    branch: "patch-1",
    state: "OPEN",
    number: 12,
    title: "Fix typo",
    additions: 1,
    deletions: 1,
    isDraft: false,
    reviewDecision: "",
    createdAt: "2026-10-20T09:00:00Z",
    updatedAt: "2026-10-20T10:00:00Z",
    person: null,
    author: "octo-contributor",
    authorKind: "outside",
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  } satisfies RecentPr;
  const session = {
    id: "bks-adopted",
    source: "opensession",
    title: "Fix typo",
    repo: "acme-web",
    branch: "patch-1",
    worktreeDir: null,
    prUrl: url,
    prState: "OPEN",
    lastActivity: "2026-10-20T11:00:00Z",
    createdAt: "2026-10-20T11:00:00Z",
    isRunning: false,
    startedBy: "Alex",
  } satisfies UnifiedSession;

  const [row] = buildWorktreeRows([recentPr], [session]);

  expect(row.person).toBe("alex");
  expect(row.authorKind).toBe("outside");
  expect(matchesAuthorFilter(row, OUTSIDE_TEAM)).toBe(true);
  expect(matchesAuthorFilter(row, "alex")).toBe(true);
});
