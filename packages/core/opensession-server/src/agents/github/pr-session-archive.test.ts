/**
 * A PR's own automation sessions (`bks-ghpr-<pr>-review`, `-mention`,
 * `-autofix`, ...) were never archived when the PR merged or closed, so they
 * piled up in the active list. Closing archives them with the automatic
 * reason, a reopen or push restores what closing archived, and an explicit
 * backfill cleans up sessions whose PR closed before this existed.
 */
import { describe, expect, test } from "bun:test";
import type { Repo } from "../../server/config";
import type { ArchiveReason } from "../../server/archive";
import type { UnifiedSession } from "../../server/types";
import {
  archiveClosedPrSessions,
  backfillClosedPrSessions,
  parsePrSessionId,
  prSessionIds,
  prSessionLifecycleAction,
  unarchiveReopenedPrSessions,
  type PrSessionBackfillDeps,
  type PullRequestState,
} from "./pr-session-archive";

const repos: Record<string, Repo> = {
  app: {
    id: "app",
    label: "App",
    repo: "/srv/app",
    wtPrefix: "app",
    defaultBranch: "main",
    ghRepo: "acme/app",
    default: true,
  },
  docs: {
    id: "docs",
    label: "Docs",
    repo: "/srv/docs",
    wtPrefix: "docs",
    defaultBranch: "main",
    ghRepo: "acme/docs",
  },
};

function session(
  id: string,
  patch: Partial<UnifiedSession> = {},
): UnifiedSession {
  return {
    id,
    source: "opensession",
    branch: "feature",
    worktreeDir: null,
    createdBy: "GitHub (automation)",
    title: id,
    lastActivity: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    isRunning: false,
    transcriptPath: null,
    automation: "github-pr-review",
    ...patch,
  } as UnifiedSession;
}

/** In-memory sessions, archive registry, and run ownership. */
function fakeDeps(
  sessions: UnifiedSession[],
  options: {
    busy?: string[];
    archived?: Record<string, ArchiveReason>;
    states?: Record<string, PullRequestState | null>;
  } = {},
) {
  const byId = new Map(sessions.map((s) => [s.id, { ...s }]));
  const registry = new Map(Object.entries(options.archived ?? {}));
  const busy = new Set(options.busy ?? []);
  const calls = {
    archived: [] as string[],
    unarchived: [] as string[],
    settled: [] as string[][],
    lookups: [] as string[],
  };
  const deps: PrSessionBackfillDeps = {
    findSession: async (id) => {
      const found = byId.get(id);
      return found
        ? { ...found, archived: found.archived || registry.has(id) }
        : undefined;
    },
    isRunBusy: (s) => busy.has(s.id),
    isArchivedId: (id) => registry.has(id),
    getArchiveReason: (id) => registry.get(id) ?? null,
    archive: async (s) => {
      registry.set(s.id, "auto");
      calls.archived.push(s.id);
    },
    unarchive: async (s) => {
      if (!registry.delete(s.id)) return false;
      calls.unarchived.push(s.id);
      return true;
    },
    afterArchive: async (batch) => {
      calls.settled.push(batch.map((s) => s.id));
    },
    liveSessions: async () =>
      [...byId.values()].filter((s) => !s.archived && !registry.has(s.id)),
    pullRequestState: async (prNumber, ghRepo) => {
      const key = `${ghRepo}#${prNumber}`;
      calls.lookups.push(key);
      return options.states?.[key] ?? null;
    },
  };
  return { deps, registry, calls };
}

describe("PR session ids", () => {
  test("covers every PR-owned kind and leaves the issue session out", () => {
    expect(prSessionIds(12)).toEqual([
      "bks-ghpr-12-review",
      "bks-ghpr-12-autofix",
      "bks-ghpr-12-simplify",
      "bks-ghpr-12-mention",
      "bks-ghpr-12-adversarial",
      "bks-ghpr-12-followup",
    ]);
    expect(prSessionIds(12, "acme/docs", repos)[0]).toBe(
      "bks-ghpr-docs-12-review",
    );
  });

  test("parses ids back to the PR and repository that own them", () => {
    expect(parsePrSessionId("bks-ghpr-12-review", repos)).toEqual({
      prNumber: 12,
      ghRepo: "acme/app",
      kind: "review",
    });
    expect(parsePrSessionId("bks-ghpr-docs-7-mention", repos)).toEqual({
      prNumber: 7,
      ghRepo: "acme/docs",
      kind: "mention",
    });
    expect(parsePrSessionId("bks-ghpr-12-issue", repos)).toBeNull();
    expect(parsePrSessionId("bks-ghpr-gone-3-review", repos)).toBeNull();
    expect(parsePrSessionId("os-12-review", repos)).toBeNull();
  });

  test("maps pull_request actions onto the session lifecycle", () => {
    expect(prSessionLifecycleAction("closed")).toBe("archive");
    expect(prSessionLifecycleAction("reopened")).toBe("unarchive");
    expect(prSessionLifecycleAction("synchronize")).toBe("unarchive");
    expect(prSessionLifecycleAction("opened")).toBeNull();
    expect(prSessionLifecycleAction("labeled")).toBeNull();
  });
});

describe("closing a PR", () => {
  test("archives its idle sessions and leaves one with a run in flight", async () => {
    const { deps, registry, calls } = fakeDeps(
      [
        session("bks-ghpr-12-review"),
        session("bks-ghpr-12-mention"),
        session("bks-ghpr-12-autofix"),
        session("bks-ghpr-13-review"),
      ],
      { busy: ["bks-ghpr-12-autofix"] },
    );

    const result = await archiveClosedPrSessions(12, undefined, deps);

    expect(result).toEqual({
      archived: ["bks-ghpr-12-review", "bks-ghpr-12-mention"],
      skippedRunning: ["bks-ghpr-12-autofix"],
    });
    expect(registry.get("bks-ghpr-12-review")).toBe("auto");
    expect(registry.has("bks-ghpr-12-autofix")).toBe(false);
    expect(registry.has("bks-ghpr-13-review")).toBe(false);
    expect(calls.settled).toEqual([
      ["bks-ghpr-12-review", "bks-ghpr-12-mention"],
    ]);
  });

  test("leaves an already archived session and its reason alone", async () => {
    const { deps, registry, calls } = fakeDeps(
      [session("bks-ghpr-12-review")],
      { archived: { "bks-ghpr-12-review": "manual" } },
    );

    const result = await archiveClosedPrSessions(12, undefined, deps);

    expect(result.archived).toEqual([]);
    expect(registry.get("bks-ghpr-12-review")).toBe("manual");
    expect(calls.settled).toEqual([]);
  });
});

describe("reopening or pushing to a PR", () => {
  test("restores only the sessions closing archived", async () => {
    const { deps, registry } = fakeDeps(
      [session("bks-ghpr-12-review"), session("bks-ghpr-12-mention")],
      {
        archived: {
          "bks-ghpr-12-review": "auto",
          "bks-ghpr-12-mention": "manual",
        },
      },
    );

    expect(await unarchiveReopenedPrSessions(12, undefined, deps)).toEqual([
      "bks-ghpr-12-review",
    ]);
    expect(registry.has("bks-ghpr-12-review")).toBe(false);
    expect(registry.get("bks-ghpr-12-mention")).toBe("manual");
  });

  test("looks nothing up when none of the PR's sessions is archived", async () => {
    const { deps } = fakeDeps([session("bks-ghpr-12-review")]);
    let lookups = 0;
    deps.findSession = async () => {
      lookups++;
      return undefined;
    };

    expect(await unarchiveReopenedPrSessions(12, undefined, deps)).toEqual([]);
    expect(lookups).toBe(0);
  });

  test("a close then reopen round-trips", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-review")]);
    await archiveClosedPrSessions(12, undefined, deps);
    expect(registry.get("bks-ghpr-12-review")).toBe("auto");
    await unarchiveReopenedPrSessions(12, undefined, deps);
    expect(registry.has("bks-ghpr-12-review")).toBe(false);
  });
});

describe("backfill", () => {
  const live = () => [
    session("bks-ghpr-1-review"),
    session("bks-ghpr-1-mention"),
    session("bks-ghpr-2-review"),
    session("bks-ghpr-3-review"),
    session("bks-ghpr-docs-4-autofix"),
    session("bks-ghpr-5-issue"),
    session("os-human"),
  ];
  const states = {
    "acme/app#1": "closed",
    "acme/app#2": "open",
    "acme/app#3": null,
    "acme/docs#4": "closed",
  } as const;

  test("a dry run reports what it would archive and changes nothing", async () => {
    const { deps, registry, calls } = fakeDeps(live(), { states });

    const report = await backfillClosedPrSessions({}, deps, repos);

    expect(report.dryRun).toBe(true);
    expect(report.checkedPrs).toBe(4);
    expect(report.candidates.map((c) => c.id)).toEqual([
      "bks-ghpr-1-review",
      "bks-ghpr-1-mention",
      "bks-ghpr-docs-4-autofix",
    ]);
    expect(report.unknownPrs).toEqual([{ prNumber: 3, ghRepo: "acme/app" }]);
    expect(report.archived).toEqual([]);
    expect(registry.size).toBe(0);
    // One GitHub read per PR, never per session.
    expect(calls.lookups).toEqual([
      "acme/app#1",
      "acme/app#2",
      "acme/app#3",
      "acme/docs#4",
    ]);
  });

  test("applying archives closed PRs' idle sessions in one settle", async () => {
    const { deps, registry, calls } = fakeDeps(live(), {
      states,
      busy: ["bks-ghpr-1-mention"],
    });

    const report = await backfillClosedPrSessions({ apply: true }, deps, repos);

    expect(report.dryRun).toBe(false);
    expect(report.archived).toEqual([
      "bks-ghpr-1-review",
      "bks-ghpr-docs-4-autofix",
    ]);
    expect(report.skippedRunning).toEqual(["bks-ghpr-1-mention"]);
    expect([...registry.keys()].sort()).toEqual([
      "bks-ghpr-1-review",
      "bks-ghpr-docs-4-autofix",
    ]);
    expect(registry.get("bks-ghpr-1-review")).toBe("auto");
    expect(calls.settled).toEqual([
      ["bks-ghpr-1-review", "bks-ghpr-docs-4-autofix"],
    ]);
  });

  test("looks up at most `limit` PRs and reports the rest", async () => {
    const { deps, calls } = fakeDeps(live(), { states });

    const report = await backfillClosedPrSessions({ limit: 2 }, deps, repos);

    expect(report.checkedPrs).toBe(2);
    expect(report.remainingPrs).toBe(2);
    expect(calls.lookups).toEqual(["acme/app#1", "acme/app#2"]);
  });
});
