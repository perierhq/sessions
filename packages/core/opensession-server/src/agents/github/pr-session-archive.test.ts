/**
 * A PR's own automation sessions (`bks-ghpr-<pr>-review`, `-mention`,
 * `-autofix`, ...) were never archived when the PR merged or closed, so they
 * piled up in the active list. Closing archives them with the automatic
 * reason, a reopen or push restores what closing archived, and an explicit
 * backfill cleans up sessions whose PR closed before this existed.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Repo } from "../../server/config";
import type { ArchiveReason } from "../../server/archive";
import type { UnifiedSession } from "../../server/types";
import {
  __resetPrSessionLifecycleForTest,
  archiveClosedPrSessions,
  backfillClosedPrSessions,
  backfillLimit,
  lookUpPullRequestState,
  PR_SESSION_BACKFILL_DEFAULT_LIMIT,
  PR_SESSION_BACKFILL_MAX_LIMIT,
  beginPrSessionRun,
  parsePrSessionId,
  prSessionIds,
  prSessionLifecycleAction,
  unarchiveReopenedPrSessions,
  type PrSessionBackfillDeps,
  type PullRequestLookup,
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
    states?: Record<string, PullRequestLookup>;
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
  return { deps, registry, calls, busy };
}

/** fakeDeps plus run-end events the test fires by hand, rechecked at once. */
function watchedDeps(...args: Parameters<typeof fakeDeps>) {
  const fake = fakeDeps(...args);
  const listeners = new Map<string, Set<() => void>>();
  fake.deps.recheckDelayMs = 0;
  fake.deps.watchRunEnd = (id, onEnd) => {
    const set = listeners.get(id) ?? new Set();
    set.add(onEnd);
    listeners.set(id, set);
    return () => set.delete(onEnd);
  };
  return {
    ...fake,
    endRun: (id: string) => {
      fake.busy.delete(id);
      for (const onEnd of listeners.get(id) ?? []) onEnd();
    },
    watching: (id: string) => listeners.get(id)?.size ?? 0,
  };
}

/** Let rechecks scheduled with a zero delay run. */
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 1));
};

beforeEach(() => __resetPrSessionLifecycleForTest());

describe("PR session ids", () => {
  test("covers every PR-owned kind and leaves issue and follow-up sessions out", () => {
    expect(prSessionIds(12)).toEqual([
      "bks-ghpr-12-review",
      "bks-ghpr-12-autofix",
      "bks-ghpr-12-simplify",
      "bks-ghpr-12-mention",
      "bks-ghpr-12-adversarial",
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
    expect(parsePrSessionId("bks-ghpr-12-followup", repos)).toBeNull();
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

  test("leaves the follow-up session alone: its PR is always closed", async () => {
    const { deps, registry } = fakeDeps([
      session("bks-ghpr-12-review"),
      session("bks-ghpr-12-followup"),
    ]);

    const result = await archiveClosedPrSessions(12, undefined, deps);

    expect(result.archived).toEqual(["bks-ghpr-12-review"]);
    expect(registry.has("bks-ghpr-12-followup")).toBe(false);
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

  test("a reopen fired right after a close waits for it and restores", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-review")]);
    // The close is still writing its archive when the reopen arrives. Both
    // webhooks are handled fire-and-forget, so neither awaits the other.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const archive = deps.archive;
    deps.archive = async (s) => {
      await gate;
      await archive(s);
    };

    const closing = archiveClosedPrSessions(12, undefined, deps);
    const reopening = unarchiveReopenedPrSessions(12, undefined, deps);
    release();

    expect((await closing).archived).toEqual(["bks-ghpr-12-review"]);
    expect(await reopening).toEqual(["bks-ghpr-12-review"]);
    expect(registry.has("bks-ghpr-12-review")).toBe(false);
  });

  test("a failed step does not stall the PR's later steps", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-review")], {
      archived: { "bks-ghpr-12-review": "auto" },
    });
    const failing = {
      ...deps,
      findSession: async () => {
        throw new Error("index unavailable");
      },
    };

    await expect(
      unarchiveReopenedPrSessions(12, undefined, failing),
    ).rejects.toThrow("index unavailable");
    expect(await unarchiveReopenedPrSessions(12, undefined, deps)).toEqual([
      "bks-ghpr-12-review",
    ]);
    expect(registry.size).toBe(0);
  });

  test("a close then reopen round-trips", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-review")]);
    await archiveClosedPrSessions(12, undefined, deps);
    expect(registry.get("bks-ghpr-12-review")).toBe("auto");
    await unarchiveReopenedPrSessions(12, undefined, deps);
    expect(registry.has("bks-ghpr-12-review")).toBe(false);
  });
});

describe("a session a run owned at close", () => {
  test("is archived once its run ends", async () => {
    const { deps, registry, endRun, watching } = watchedDeps(
      [session("bks-ghpr-12-autofix")],
      { busy: ["bks-ghpr-12-autofix"] },
    );

    await archiveClosedPrSessions(12, undefined, deps);
    expect(registry.has("bks-ghpr-12-autofix")).toBe(false);

    endRun("bks-ghpr-12-autofix");
    await settle();

    expect(registry.get("bks-ghpr-12-autofix")).toBe("auto");
    expect(watching("bks-ghpr-12-autofix")).toBe(0);
  });

  test("stays live when the PR reopened before its run ended", async () => {
    const { deps, registry, endRun, watching } = watchedDeps(
      [session("bks-ghpr-12-autofix")],
      { busy: ["bks-ghpr-12-autofix"] },
    );

    await archiveClosedPrSessions(12, undefined, deps);
    await unarchiveReopenedPrSessions(12, undefined, deps);
    expect(watching("bks-ghpr-12-autofix")).toBe(0);

    endRun("bks-ghpr-12-autofix");
    await settle();

    expect(registry.has("bks-ghpr-12-autofix")).toBe(false);
  });

  test("keeps waiting while a new run owns it", async () => {
    const { deps, registry, busy, endRun, watching } = watchedDeps(
      [session("bks-ghpr-12-autofix")],
      { busy: ["bks-ghpr-12-autofix"] },
    );

    await archiveClosedPrSessions(12, undefined, deps);
    // The run-end event arrives, but the session is busy again.
    endRun("bks-ghpr-12-autofix");
    busy.add("bks-ghpr-12-autofix");
    await settle();
    expect(registry.has("bks-ghpr-12-autofix")).toBe(false);
    expect(watching("bks-ghpr-12-autofix")).toBe(1);

    endRun("bks-ghpr-12-autofix");
    await settle();
    expect(registry.get("bks-ghpr-12-autofix")).toBe("auto");
  });

  test("a GitHub run's own end triggers the check", async () => {
    const { deps, registry } = watchedDeps([session("bks-ghpr-12-review")]);

    const end = await beginPrSessionRun(12, "review", undefined, deps);
    await archiveClosedPrSessions(12, undefined, deps);
    expect(registry.has("bks-ghpr-12-review")).toBe(false);

    end();
    await settle();

    expect(registry.get("bks-ghpr-12-review")).toBe("auto");
  });

  test("a run restored on a closed PR is archived again after it", async () => {
    const { deps, registry } = watchedDeps([session("bks-ghpr-12-review")]);
    await archiveClosedPrSessions(12, undefined, deps);
    expect(registry.get("bks-ghpr-12-review")).toBe("auto");

    const end = await beginPrSessionRun(12, "review", undefined, deps);
    expect(registry.has("bks-ghpr-12-review")).toBe(false);
    end();
    await settle();

    expect(registry.get("bks-ghpr-12-review")).toBe("auto");
  });
});

describe("a GitHub run starting", () => {
  test("restores a session closing archived before the run shows up", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-mention")], {
      archived: { "bks-ghpr-12-mention": "auto" },
    });

    const end = await beginPrSessionRun(12, "mention", undefined, deps);
    end();

    expect(registry.has("bks-ghpr-12-mention")).toBe(false);
  });

  test("leaves a manual archive alone", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-review")], {
      archived: { "bks-ghpr-12-review": "manual" },
    });

    (await beginPrSessionRun(12, "review", undefined, deps))();

    expect(registry.get("bks-ghpr-12-review")).toBe("manual");
  });

  test("keeps closing away from the session until the run ends", async () => {
    // The journal does not see the run yet: it is still minting credentials
    // and preparing its worktree.
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-review")]);

    const end = await beginPrSessionRun(12, "review", undefined, deps);
    const during = await archiveClosedPrSessions(12, undefined, deps);
    end();
    const after = await archiveClosedPrSessions(12, undefined, deps);

    expect(during).toEqual({
      archived: [],
      skippedRunning: ["bks-ghpr-12-review"],
    });
    expect(after.archived).toEqual(["bks-ghpr-12-review"]);
    expect(registry.get("bks-ghpr-12-review")).toBe("auto");
  });

  test("ignores kinds the archive never touches", async () => {
    const { deps, registry } = fakeDeps([session("bks-ghpr-12-followup")], {
      archived: { "bks-ghpr-12-followup": "auto" },
    });

    (await beginPrSessionRun(12, "followup", undefined, deps))();

    expect(registry.get("bks-ghpr-12-followup")).toBe("auto");
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
    session("bks-ghpr-1-followup"),
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

  test("clamps the limit", () => {
    expect(backfillLimit(undefined)).toBe(PR_SESSION_BACKFILL_DEFAULT_LIMIT);
    expect(backfillLimit(0)).toBe(PR_SESSION_BACKFILL_DEFAULT_LIMIT);
    expect(backfillLimit(-3)).toBe(PR_SESSION_BACKFILL_DEFAULT_LIMIT);
    expect(backfillLimit(Number.NaN)).toBe(PR_SESSION_BACKFILL_DEFAULT_LIMIT);
    expect(backfillLimit(2.7)).toBe(2);
    expect(backfillLimit(0.5)).toBe(1);
    expect(backfillLimit(10_000)).toBe(PR_SESSION_BACKFILL_MAX_LIMIT);
    expect(PR_SESSION_BACKFILL_MAX_LIMIT).toBe(500);
  });

  /** One review session on each of PRs 1..count, all closed. */
  function manyPrs(count: number) {
    const sessions = Array.from({ length: count }, (_, i) =>
      session(`bks-ghpr-${i + 1}-review`),
    );
    const states: Record<string, PullRequestLookup> = {};
    for (let i = 1; i <= count; i++) states[`acme/app#${i}`] = "closed";
    return { sessions, states };
  }

  test("looks PRs up four at a time", async () => {
    const { sessions, states } = manyPrs(10);
    const { deps } = fakeDeps(sessions, { states });
    let inFlight = 0;
    let peak = 0;
    const lookup = deps.pullRequestState;
    deps.pullRequestState = async (prNumber, ghRepo) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return lookup(prNumber, ghRepo);
    };

    const report = await backfillClosedPrSessions({}, deps, repos);

    expect(peak).toBe(4);
    expect(report.checkedPrs).toBe(10);
    // Reported in PR order whatever order the lookups finished in.
    expect(report.candidates.map((c) => c.prNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  test("stops at the first rate-limited lookup and reports the rest", async () => {
    const { sessions, states } = manyPrs(12);
    states["acme/app#2"] = "rate_limited";
    const { deps, calls, registry } = fakeDeps(sessions, { states });

    const report = await backfillClosedPrSessions({ apply: true }, deps, repos);

    expect(report.rateLimited).toBe(true);
    expect(calls.lookups.length).toBeLessThan(12);
    expect(calls.lookups).toContain("acme/app#2");
    // Every PR is either checked or left for a later run, the throttled one too.
    expect(report.checkedPrs + report.remainingPrs).toBe(12);
    expect(report.remainingPrs).toBe(12 - calls.lookups.length + 1);
    expect(report.unknownPrs).toEqual([]);
    expect(report.candidates.map((c) => c.prNumber)).not.toContain(2);
    expect(registry.has("bks-ghpr-2-review")).toBe(false);
    expect(report.archived.length).toBe(report.checkedPrs);
  });
});

describe("PR state lookup", () => {
  type Request = NonNullable<Parameters<typeof lookUpPullRequestState>[2]>;
  function request(result: {
    ok: boolean;
    status: number;
    data?: unknown;
    error?: string;
  }) {
    const seen: unknown[][] = [];
    const fn = (async (...args: unknown[]) => {
      seen.push(args);
      return { data: null, ...result };
    }) as unknown as Request;
    return { fn, seen };
  }

  test("reads the pull with a read-only token", async () => {
    const { fn, seen } = request({
      ok: true,
      status: 200,
      data: { state: "closed" },
    });

    expect(await lookUpPullRequestState(7, "acme/docs", fn)).toBe("closed");
    expect(seen).toEqual([
      ["GET", "/repos/acme/docs/pulls/7", undefined, { mint: "read" }],
    ]);
  });

  test("tells a rate limit apart from an unreadable PR", async () => {
    const limited = request({
      ok: false,
      status: 403,
      error: "API rate limit exceeded for installation",
    });
    const tooMany = request({ ok: false, status: 429, error: "slow down" });
    const forbidden = request({
      ok: false,
      status: 403,
      error: "Resource not accessible by integration",
    });
    const missing = request({ ok: false, status: 404, error: "Not Found" });

    expect(await lookUpPullRequestState(7, "acme/app", limited.fn)).toBe(
      "rate_limited",
    );
    expect(await lookUpPullRequestState(7, "acme/app", tooMany.fn)).toBe(
      "rate_limited",
    );
    expect(
      await lookUpPullRequestState(7, "acme/app", forbidden.fn),
    ).toBeNull();
    expect(await lookUpPullRequestState(7, "acme/app", missing.fn)).toBeNull();
  });
});
