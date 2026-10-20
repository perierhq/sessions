import { describe, expect, test } from "bun:test";
import {
  answerHiddenRows,
  hiddenWorkspaceIds,
  MAX_HIDDEN_ROW_KEYS,
  resolveHiddenRows,
} from "./hidden-rows";
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
  test("names each kind of row key, in the order asked", () => {
    const answer = resolveHiddenRows(
      ["wt:/worktrees/fix", "solo", "workspace:ws-1"],
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
    expect(answer).toEqual({
      rows: [
        {
          key: "wt:/worktrees/fix",
          title: "Title c",
          repo: "acme/api",
          sessionId: "c",
        },
        { key: "solo", title: "Title solo", repo: null, sessionId: "solo" },
        {
          key: "workspace:ws-1",
          title: "Checkout flow",
          repo: "acme/shop",
          // The most recently active session is the one opening shows.
          sessionId: "b",
        },
      ],
      stale: [],
    });
  });

  test("reports keys whose work was archived or deleted as stale", () => {
    const answer = resolveHiddenRows(
      [
        "workspace:archived",
        "workspace:deleted",
        "archived-solo",
        "wt:/worktrees/gone",
      ],
      [
        session("a", { workspaceId: "archived", archived: true }),
        session("archived-solo", { archived: true }),
      ],
      new Map([["archived", { name: "Old work" }]]),
    );
    expect(answer).toEqual({
      rows: [],
      stale: [
        "workspace:archived",
        "workspace:deleted",
        "archived-solo",
        "wt:/worktrees/gone",
      ],
    });
  });

  test("falls back to the session's title and repo without a workspace record", () => {
    const {
      rows: [row],
    } = resolveHiddenRows(
      ["workspace:ws-1"],
      [session("a", { workspaceId: "ws-1" })],
      new Map(),
    );
    expect(row).toMatchObject({ title: "Title a", repo: "acme/web" });
  });

  // Repository hides share the map but are not rows; the client names them.
  test("skips repository keys, even one spelled like a session id", () => {
    expect(
      resolveHiddenRows(
        ["repo:acme/web"],
        [session("repo:acme/web")],
        new Map(),
      ),
    ).toEqual({ rows: [], stale: [] });
  });

  test("finds a session hidden under one of its alias ids", () => {
    const {
      rows: [row],
    } = resolveHiddenRows(
      ["old-id"],
      [session("new-id", { aliasIds: ["old-id"] })],
      new Map(),
    );
    expect(row).toMatchObject({ key: "old-id", sessionId: "new-id" });
  });
});

test("hiddenWorkspaceIds lists only workspace keys", () => {
  expect(
    hiddenWorkspaceIds(["workspace:ws-1", "solo", "wt:/worktrees/x"]),
  ).toEqual(["ws-1"]);
});

describe("POST /api/hides/rows", () => {
  function deps() {
    const asked: string[][] = [];
    return {
      asked,
      deps: {
        sessions: async () => [
          session("live", { workspaceId: "ws-1" }),
          session("solo"),
        ],
        workspaces: async (ids: readonly string[]) => {
          asked.push([...ids]);
          return new Map(
            ids.includes("ws-1") ? [["ws-1", { name: "Checkout flow" }]] : [],
          );
        },
      },
    };
  }

  // The race this route exists to avoid: the client's keys are the answer,
  // whatever the server has stored for that user so far.
  test("answers the keys sent, naming rows and listing stale keys", async () => {
    const { asked, deps: d } = deps();
    const response = await answerHiddenRows(
      { user: "Ada", keys: ["workspace:ws-1", "solo", "gone", "repo:acme"] },
      d,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      rows: [
        {
          key: "workspace:ws-1",
          title: "Checkout flow",
          repo: "acme/web",
          sessionId: "live",
        },
        {
          key: "solo",
          title: "Title solo",
          repo: "acme/web",
          sessionId: "solo",
        },
      ],
      stale: ["gone"],
    });
    // One batched workspace read for just the workspace keys.
    expect(asked).toEqual([["ws-1"]]);
  });

  test("requires a user, like every hides route", async () => {
    for (const body of [null, { keys: [] }, { user: 7, keys: [] }])
      expect((await answerHiddenRows(body, deps().deps)).status).toBe(400);
  });

  test("rejects too many keys, or a key the store would not keep", async () => {
    const tooMany = Array.from(
      { length: MAX_HIDDEN_ROW_KEYS + 1 },
      (_, i) => `s${i}`,
    );
    for (const keys of [tooMany, [""], ["x".repeat(129)], [42], "solo"]) {
      const { asked, deps: d } = deps();
      const response = await answerHiddenRows({ user: "Ada", keys }, d);
      expect(response.status).toBe(400);
      expect(asked).toEqual([]);
    }
    const atCap = Array.from(
      { length: MAX_HIDDEN_ROW_KEYS },
      (_, i) => `s${i}`,
    );
    expect(
      (await answerHiddenRows({ user: "Ada", keys: atCap }, deps().deps))
        .status,
    ).toBe(200);
    expect(
      (
        await answerHiddenRows(
          { user: "Ada", keys: ["x".repeat(128)] },
          deps().deps,
        )
      ).status,
    ).toBe(200);
  });
});
