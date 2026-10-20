import { describe, expect, test } from "bun:test";
import type { OpenPr } from "./api";
import type { FilterState } from "./sidebar-filter";
import type { WsRow } from "./sidebar-types";
import type { UnifiedSession, Workspace } from "./types";
import {
  automationActivityKey,
  buildAutomationGroups,
  completeSidebarRepoOrder,
  deriveSidebarPrRows,
  deriveSidebarProjectBands,
  deriveWorkspacePlacement,
  discoverSidebarRepos,
  filterSidebarSessions,
  latestSupportSessionsByThread,
  personLensName,
  projectBandOf,
  type ProjectBandDeps,
  pinnedWorkspaceRows,
  sortSidebarSessions,
  supportThreadFromFeedItem,
} from "./sidebar-derived";
import { hiddenRepos, partitionHiddenRepos } from "./hides";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: null,
    worktreeDir: null,
    startedBy: "Jaap",
    title: id,
    lastActivity: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T11:00:00.000Z",
    isRunning: false,
    ...overrides,
  };
}

function row(id: string, owner: string): WsRow {
  return {
    key: id,
    workspace: null,
    name: id,
    sessions: [session(id, { startedBy: owner })],
    status: "pending",
    lastActivity: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T11:00:00.000Z",
    unread: false,
    running: false,
    owner,
  };
}

function pr(number: number): OpenPr {
  return {
    repo: "tellahq/opensession",
    branch: `change-${number}`,
    url: `https://github.com/tellahq/opensession/pull/${number}`,
    number,
    title: `PR ${number}`,
    isDraft: false,
    reviewDecision: "",
    author: "jaap",
    person: "jaap",
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T12:00:00.000Z",
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  };
}

function filter(overrides: Partial<FilterState> = {}): FilterState {
  return {
    groupBy: "inbox",
    byProject: true,
    repo: "all",
    person: "me",
    sort: "updated",
    prs: "none",
    autoCreated: "hide",
    emptyProjects: "show",
    ...overrides,
  };
}

describe("sidebar derived data", () => {
  test("decodes support feed metadata at the runtime boundary", () => {
    const thread = supportThreadFromFeedItem({
      id: "feed-item",
      title: "Fallback title",
      meta: {
        id: "thread-1",
        title: "Help needed",
        previewText: "The latest reply",
        status: "todo",
        statusChangedAt: null,
        createdAt: "2026-08-18T10:00:00.000Z",
        priority: 1,
        customer: { name: "Ada", email: "ada@example.com" },
        assignee: { id: "user-1", name: "Jaap", isBot: false },
      },
    });

    expect(thread).toMatchObject({
      id: "thread-1",
      customer: { name: "Ada", email: "ada@example.com" },
      assignee: { id: "user-1", name: "Jaap", isBot: false },
    });
    expect(
      supportThreadFromFeedItem({
        id: "broken",
        title: "Broken",
        meta: { id: "thread-2" },
      }),
    ).toBeNull();
  });

  test("keeps only the newest live session for each support thread", () => {
    const latest = latestSupportSessionsByThread([
      session("older", {
        plainThreadId: "thread-1",
        lastActivity: "2026-08-18T10:00:00.000Z",
      }),
      session("newer", {
        plainThreadId: "thread-1",
        lastActivity: "2026-08-18T12:00:00.000Z",
      }),
      session("archived", { plainThreadId: "thread-2", archived: true }),
    ]);

    expect([...latest.keys()]).toEqual(["thread-1"]);
    expect(latest.get("thread-1")?.id).toBe("newer");
  });

  test("orders repositories by activity and completes saved order", () => {
    const discovered = discoverSidebarRepos(
      ["unused", "busy"],
      [
        session("one", { repo: "busy" }),
        session("two", { repo: "busy" }),
        session("three", { repo: "other" }),
        session("repo-less", { repoLess: true }),
      ],
      [],
    );

    expect(discovered).toEqual(["busy", "other", "unused"]);
    expect(completeSidebarRepoOrder(["unused"], discovered)).toEqual([
      "unused",
      "busy",
      "other",
    ]);
  });

  test("derives ordered project bands while keeping scratch work loose", () => {
    const repoA = {
      ...row("repo-a-row", "jaap"),
      status: "needsinput" as const,
    };
    const repoB = row("repo-b-row", "jaap");
    const ask = row("ask-row", "jaap");
    const scratch = row("scratch-row", "jaap");
    const snoozed = row("repo-a-snoozed", "jaap");
    const projects = deriveSidebarProjectBands({
      activeRows: [repoA, repoB, ask, scratch],
      snoozedRows: [snoozed],
      needsReviewRows: [],
      approvedRows: [],
      awaitingReviewRows: [],
      lanePrItems: [],
      requestedPrItems: [],
      registeredRepos: [],
      repos: ["repo-b", "repo-a"],
      savedRepoOrder: ["repo-b", "repo-a"],
      filter: filter(),
      search: "",
      isPhone: false,
      askBand: "__ask__",
      rowIsFeedOnly: () => false,
      rowIsScratch: (candidate) => candidate.key === scratch.key,
      rowIsAsk: (candidate) => candidate.key === ask.key,
      workspaceRepo: (candidate) =>
        candidate.key.startsWith("repo-b") ? "repo-b" : "repo-a",
    });

    expect(projects.scratchRows.map(({ key }) => key)).toEqual(["scratch-row"]);
    expect(projects.bands.map(({ repo }) => repo)).toEqual([
      "__ask__",
      "repo-b",
      "repo-a",
    ]);
    expect(projects.bands.at(-1)).toMatchObject({
      repo: "repo-a",
      urgent: 1,
      snoozedRows: [{ key: "repo-a-snoozed" }],
    });
    expect(projects.canReorder).toBe(true);
  });

  // A hidden repository's band goes, except for what a hide must never
  // swallow: the open session's row and rows blocked on a question. The band
  // then shows with only those rows.
  test("hidden repositories leave the bands, keeping blocked and open rows", () => {
    const repoOf = (candidate: WsRow) => candidate.key.split("/")[0]!;
    const blocked = {
      ...row("repo-a/blocked", "jaap"),
      status: "needsinput" as const,
    };
    const open = row("repo-a/open", "jaap");
    const idle = row("repo-a/idle", "jaap");
    const quiet = row("repo-c/quiet", "jaap");
    const other = row("repo-b/other", "jaap");
    const all = [blocked, open, idle, quiet, other];
    const hidden = hiddenRepos({
      "repo:repo-a": "2026-08-18T10:00:00.000Z",
      "repo:repo-c": "2026-08-18T10:00:00.000Z",
      "repo:repo-d": "2026-08-18T10:00:00.000Z",
    });
    const hiddenKeys = partitionHiddenRepos(
      all,
      hidden,
      repoOf,
      (candidate) => candidate.key === open.key,
    );
    expect([...hiddenKeys].sort()).toEqual(["repo-a/idle", "repo-c/quiet"]);

    const projects = deriveSidebarProjectBands({
      activeRows: all.filter((candidate) => !hiddenKeys.has(candidate.key)),
      snoozedRows: [],
      needsReviewRows: [],
      approvedRows: [],
      awaitingReviewRows: [],
      lanePrItems: [],
      requestedPrItems: [],
      // repo-d is registered but empty; hidden, it earns no empty band.
      registeredRepos: ["repo-a", "repo-b", "repo-c", "repo-d"],
      repos: ["repo-a", "repo-b", "repo-c", "repo-d"],
      savedRepoOrder: [],
      filter: filter(),
      search: "",
      isPhone: false,
      askBand: "__ask__",
      rowIsFeedOnly: () => false,
      rowIsScratch: () => false,
      rowIsAsk: () => false,
      workspaceRepo: repoOf,
      hiddenRepos: hidden,
    });
    expect(
      projects.bands.map((band) => [
        band.repo,
        band.rows.map(({ key }) => key),
      ]),
    ).toEqual([
      ["repo-a", ["repo-a/blocked", "repo-a/open"]],
      ["repo-b", ["repo-b/other"]],
    ]);
    expect(projects.bands[0]?.urgent).toBe(1);
  });

  // A repo hide must take exactly the rows the band would show. A workspace
  // whose sessions run in another repo files under the workspace's own repo,
  // and so does its hide: hiding the other repo leaves it alone.
  test("a repo hide follows the band a row files under", () => {
    const spanning: WsRow = {
      ...row("ws-span", "jaap"),
      workspace: {
        id: "span",
        name: "Span",
        repo: "repo-a",
        createdBy: "jaap",
        createdAt: "2026-08-18T11:00:00.000Z",
      } satisfies Workspace,
      sessions: [
        session("in-b", { repo: "repo-b" }),
        session("in-a", { repo: "repo-a" }),
      ],
    };
    const scratch = row("scratch", "jaap");
    const ask = row("ask", "jaap");
    const deps: ProjectBandDeps = {
      askBand: "__ask__",
      rowIsFeedOnly: () => false,
      rowIsScratch: (candidate) => candidate.key === "scratch",
      rowIsAsk: (candidate) => candidate.key === "ask",
      // Sidebar's wsRowRepo: the workspace's repo wins over a session's.
      workspaceRepo: (candidate) =>
        candidate.workspace?.repo || candidate.sessions[0]?.repo || "default",
    };
    expect(projectBandOf(spanning, deps)).toBe("repo-a");
    expect(projectBandOf(scratch, deps)).toBeNull();
    expect(projectBandOf(ask, deps)).toBe("__ask__");

    const bandOf = (candidate: WsRow) => projectBandOf(candidate, deps);
    const all = [spanning, scratch, ask];
    const hideB = partitionHiddenRepos(
      all,
      new Set(["repo-b"]),
      bandOf,
      () => false,
    );
    expect([...hideB]).toEqual([]);
    const hideA = partitionHiddenRepos(
      all,
      new Set(["repo-a"]),
      bandOf,
      () => false,
    );
    expect([...hideA]).toEqual(["ws-span"]);

    // The bands file the same row under the same repo.
    const projects = deriveSidebarProjectBands({
      activeRows: all.filter((candidate) => !hideB.has(candidate.key)),
      snoozedRows: [],
      needsReviewRows: [],
      approvedRows: [],
      awaitingReviewRows: [],
      lanePrItems: [],
      requestedPrItems: [],
      registeredRepos: [],
      repos: ["repo-a", "repo-b"],
      savedRepoOrder: [],
      filter: filter(),
      search: "",
      isPhone: false,
      ...deps,
      hiddenRepos: new Set(["repo-b"]),
    });
    expect(
      projects.bands.map((band) => [
        band.repo,
        band.rows.map(({ key }) => key),
      ]),
    ).toEqual([
      ["__ask__", ["ask"]],
      ["repo-a", ["ws-span"]],
    ]);
    expect(projects.scratchRows.map(({ key }) => key)).toEqual(["scratch"]);
  });

  // Sidebar.tsx hands one ProjectBandDeps to both the bands and the repo-hide
  // partition. A hand-copied band rule there drifted from this module once.
  test("Sidebar decides bands and repo hides with the same projectBandOf", async () => {
    const source = await Bun.file(
      new URL("../components/Sidebar.tsx", import.meta.url),
    ).text();
    expect(source).toContain("(row) => projectBandOf(row, bandDeps)");
    expect(source).toMatch(
      /deriveSidebarProjectBands\(\{[^}]*\.\.\.bandDeps,/s,
    );
    expect(source).not.toContain("bandRepoOf");
  });

  test("keeps the selected session visible through repo and search filters", () => {
    const selected = session("selected", {
      repo: "repo-a",
      workspaceId: "workspace-a",
      title: "Selected work",
    });
    const visible = filterSidebarSessions({
      sessions: [
        selected,
        session("match", { repo: "repo-b", title: "Matching result" }),
        session("hidden", { repo: "repo-a", title: "Other work" }),
      ],
      workspaces: [
        {
          id: "workspace-a",
          name: "Selected",
          repo: "repo-a",
          createdBy: "Jaap",
          createdAt: "2026-08-18T10:00:00.000Z",
        } satisfies Workspace,
      ],
      filter: filter({ repo: "repo-b" }),
      search: "matching",
      canonicalNames: new Map(),
      selectedSession: selected,
      selectedWorkspaceId: "workspace-a",
    });

    expect(visible.map(({ id }) => id)).toEqual(["selected", "match"]);
  });

  test("keeps a collaborator's workspace in their named-person lens", () => {
    const workspace = (id: string, collaborators: string[]): Workspace => ({
      id,
      name: id,
      repo: "repo-a",
      createdBy: "Grace",
      createdAt: "2026-08-18T10:00:00.000Z",
      collaborators: collaborators.map((name) => ({
        name,
        by: "Grace",
        at: "2026-08-18T10:00:00.000Z",
      })),
    });
    const visible = filterSidebarSessions({
      sessions: [
        session("shared", { workspaceId: "ws-shared", startedBy: "Grace" }),
        session("private", { workspaceId: "ws-private", startedBy: "Grace" }),
        session("own", { startedBy: "Ada" }),
      ],
      workspaces: [
        workspace("ws-shared", ["Ada"]),
        workspace("ws-private", []),
      ],
      filter: filter({ person: "ada" }),
      search: "",
      canonicalNames: new Map(),
      selectedSession: null,
    });

    expect(visible.map(({ id }) => id)).toEqual(["shared", "own"]);
  });

  test("groups automations by name in case-insensitive display order", () => {
    const groups = buildAutomationGroups({
      sessions: [
        session("weekly", {
          automation: "Weekly check",
          automationRunCount: 4,
        }),
        session("daily", { automation: "daily check" }),
        session("claimed", { automation: "Claimed" }),
      ],
      nestedSubagentIds: new Set(),
      automationOverview: new Map(),
      filter: filter(),
      currentUser: "Jaap",
      isClaimed: (item) => item.id === "claimed",
    });

    expect(groups.map(({ label }) => label)).toEqual([
      "daily check",
      "Weekly check",
    ]);
    expect(groups[1]?.totalItems).toBe(4);
    expect(groups[0]?.dotColor).toBe("var(--yellow)");
  });

  test("places only in-scope workspaces and preserves explicit pin order", () => {
    const mine = row("mine", "jaap");
    const theirs = row("theirs", "kent");
    const placement = deriveWorkspacePlacement({
      rows: [mine, theirs],
      filter: filter({ autoCreated: "show" }),
      currentUser: "Jaap",
      activeSnoozeKeys: new Set(),
      feedRefKinds: new Set(),
      ownsSelection: () => false,
      isClaimed: () => false,
      hasPersonalLane: () => false,
    });

    expect(
      placement.placedWsRows.map(({ row: item, placement: lane }) => [
        item.key,
        lane,
      ]),
    ).toEqual([
      ["mine", "status"],
      ["theirs", "outside"],
    ]);
    expect(
      pinnedWorkspaceRows([mine, theirs], ["theirs", "mine"], new Set()),
    ).toEqual([theirs, mine]);
  });

  test("files a teammate's workspace for its collaborators", () => {
    const shared: WsRow = {
      ...row("shared", "kent"),
      workspace: {
        id: "shared",
        name: "Shared",
        createdBy: "Kent",
        createdAt: "2026-08-18T11:00:00.000Z",
        collaborators: [
          { name: "Jaap", by: "Kent", at: "2026-08-18T11:30:00.000Z" },
        ],
      },
    };
    const placement = deriveWorkspacePlacement({
      rows: [shared, row("theirs", "kent")],
      filter: filter(),
      currentUser: "Jaap",
      activeSnoozeKeys: new Set(),
      feedRefKinds: new Set(),
      ownsSelection: () => false,
      isClaimed: () => false,
      hasPersonalLane: () => false,
    });

    expect(
      placement.placedWsRows.map(({ row: item, placement: lane }) => [
        item.key,
        lane,
      ]),
    ).toEqual([
      ["shared", "status"],
      ["theirs", "outside"],
    ]);
  });

  test("removes pull requests already represented by a workspace", () => {
    const covered = pr(1);
    const visible = pr(2);
    const result = deriveSidebarPrRows({
      openPrs: [covered, visible],
      sessions: [],
      currentUser: "Jaap",
      githubLogin: "jaap",
      workspaceRows: [
        {
          key: "workspace-1",
          workspace: {
            id: "workspace-1",
            name: "PR work",
            createdBy: "Jaap",
            createdAt: "2026-08-18T10:00:00.000Z",
            repo: covered.repo,
            prNumber: covered.number,
          },
          name: "PR work",
          sessions: [],
          status: "pending",
          lastActivity: "",
          createdAt: "2026-08-18T10:00:00.000Z",
          unread: false,
          running: false,
          owner: "jaap",
        },
      ],
      workspaceDataReady: true,
      filter: filter({ prs: "all" }),
      search: "",
    });

    expect(result.workspaceCoveredPrUrls).toEqual(new Set([covered.url]));
    expect(result.prRowItems.map(({ pr }) => pr.url)).toEqual([visible.url]);
  });

  test("derives stable activity and display ordering", () => {
    const sessions = [
      session("older", {
        automation: "Check",
        lastActivity: "2026-08-18T10:00:00.000Z",
      }),
      session("newer", {
        automation: "Check",
        lastActivity: "2026-08-18T12:00:00.000Z",
      }),
    ];

    expect(automationActivityKey(sessions)).toBe("2:2026-08-18T12:00:00.000Z");
    expect(
      sortSidebarSessions(sessions, "updated").map(({ id }) => id),
    ).toEqual(["newer", "older"]);
    expect(personLensName("kent", [], [{ key: "kent", label: "Kent" }])).toBe(
      "Kent",
    );
  });
});
