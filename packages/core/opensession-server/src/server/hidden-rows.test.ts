import { describe, expect, test } from "bun:test";
import { hiddenWorkspaceIds, resolveHiddenRows } from "./hidden-rows";
import type { UnifiedSession } from "./types";

function session(
  id: string,
  overrides: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    claudeSessionId: "",
    source: "opensession",
    branch: `branch-${id}`,
    worktreeDir: null,
    startedBy: "Ada",
    title: `Title ${id}`,
    lastActivity: "2026-08-18T12:00:00.000Z",
    createdAt: "2026-08-18T11:00:00.000Z",
    isRunning: false,
    transcriptPath: "",
    repo: "acme/web",
    ...overrides,
  };
}

describe("resolveHiddenRows", () => {
  test("names each kind of row key, most recently hidden first", () => {
    const rows = resolveHiddenRows(
      {
        "workspace:ws-1": "2026-08-18T10:00:00.000Z",
        "wt:/worktrees/fix": "2026-08-18T12:00:00.000Z",
        solo: "2026-08-18T11:00:00.000Z",
      },
      [
        session("a", {
          workspaceId: "ws-1",
          lastActivity: "2026-08-18T09:00:00.000Z",
        }),
        session("b", {
          workspaceId: "ws-1",
          lastActivity: "2026-08-18T13:00:00.000Z",
        }),
        session("c", { worktreeDir: "/worktrees/fix", repo: "acme/api" }),
        session("solo", { repoLess: true }),
      ],
      new Map([["ws-1", { name: "Checkout flow", repo: "acme/shop" }]]),
    );
    expect(rows).toEqual([
      {
        key: "wt:/worktrees/fix",
        hiddenAt: "2026-08-18T12:00:00.000Z",
        title: "Title c",
        repo: "acme/api",
        sessionId: "c",
      },
      {
        key: "solo",
        hiddenAt: "2026-08-18T11:00:00.000Z",
        title: "Title solo",
        repo: null,
        sessionId: "solo",
      },
      {
        key: "workspace:ws-1",
        hiddenAt: "2026-08-18T10:00:00.000Z",
        title: "Checkout flow",
        repo: "acme/shop",
        // The most recently active session is the one opening shows.
        sessionId: "b",
      },
    ]);
  });

  test("leaves out hides whose work was archived or deleted", () => {
    const rows = resolveHiddenRows(
      {
        "workspace:archived": "2026-08-18T10:00:00.000Z",
        "workspace:deleted": "2026-08-18T10:00:00.000Z",
        "archived-solo": "2026-08-18T10:00:00.000Z",
        "wt:/worktrees/gone": "2026-08-18T10:00:00.000Z",
      },
      [
        session("a", { workspaceId: "archived", archived: true }),
        session("archived-solo", { archived: true }),
      ],
      new Map([["archived", { name: "Old work" }]]),
    );
    expect(rows).toEqual([]);
  });

  test("falls back to the session's title and repo without a workspace record", () => {
    const [row] = resolveHiddenRows(
      { "workspace:ws-1": "2026-08-18T10:00:00.000Z" },
      [session("a", { workspaceId: "ws-1" })],
      new Map(),
    );
    expect(row).toMatchObject({ title: "Title a", repo: "acme/web" });
  });

  // Repository hides share the map but are not rows; the client names them.
  test("skips repository keys, even one spelled like a session id", () => {
    expect(
      resolveHiddenRows(
        { "repo:acme/web": "2026-08-18T10:00:00.000Z" },
        [session("repo:acme/web")],
        new Map(),
      ),
    ).toEqual([]);
  });

  test("finds a session hidden under one of its alias ids", () => {
    const [row] = resolveHiddenRows(
      { "old-id": "2026-08-18T10:00:00.000Z" },
      [session("new-id", { aliasIds: ["old-id"] })],
      new Map(),
    );
    expect(row).toMatchObject({ key: "old-id", sessionId: "new-id" });
  });
});

test("hiddenWorkspaceIds lists only workspace keys", () => {
  expect(
    hiddenWorkspaceIds({
      "workspace:ws-1": "2026-08-18T10:00:00.000Z",
      solo: "2026-08-18T10:00:00.000Z",
      "wt:/worktrees/x": "2026-08-18T10:00:00.000Z",
    }),
  ).toEqual(["ws-1"]);
});
