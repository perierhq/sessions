/**
 * Live fields for board refs: each kind from its store, the owner's
 * projects only (anything else reads exactly like a missing object),
 * bounded and cached. Fake sources; no stores.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Incident } from "../shared/incidents";
import type { SupportConversation } from "../shared/support";
import {
  CACHE_TTL_MS,
  MAX_REFS,
  __setBoardRefDepsForTest,
  resolveBoardRefs,
} from "./blob-board-refs";
import type { PrInfo } from "./pr-cache";

const NOW = Date.parse("2026-11-13T09:41:00Z");

function pr(number: number, extra: Partial<PrInfo> = {}): PrInfo {
  return {
    url: `https://example.test/acme/pull/${number}`,
    state: "OPEN",
    number,
    title: `search-service 1.19.0`,
    isDraft: false,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: "",
    author: "ada",
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-12T00:00:00Z",
    checks: { total: 4, passed: 3, failed: 1, pending: 0 },
    mergeable: "MERGEABLE",
    reviewRequested: [],
    reviewedBy: [],
    assignees: [],
    ...extra,
  };
}

let reads: string[] = [];
let roster = [
  {
    project: "acme",
    label: "Acme",
    enabled: true,
    stage: "act" as const,
    owner: "Ada",
  },
  {
    project: "globex",
    label: "Globex",
    enabled: true,
    stage: "watch" as const,
    owner: "Bob",
  },
];

function fake(now = NOW) {
  reads = [];
  __setBoardRefDepsForTest({
    now: () => now,
    roster: async () => {
      reads.push("roster");
      return roster;
    },
    prs: async () =>
      new Map([
        [
          "acme",
          new Map([
            ["release", pr(533)],
            [
              "old",
              pr(500, { state: "MERGED", title: "search-service 1.18.0" }),
            ],
          ]),
        ],
        ["globex", new Map([["main", pr(7)]])],
      ]),
    incident: async (id) => {
      reads.push(`incident:${id}`);
      if (id === "boom") throw new Error("store down");
      if (id !== "status-page" && id !== "theirs") return null;
      return {
        id,
        project: id === "theirs" ? "globex" : "acme",
        title: "Status page incident",
        state: "investigating",
        severity: "major",
        openedAt: "2026-11-11T02:41:00Z",
        updatedAt: "2026-11-13T09:00:00Z",
      } as Incident;
    },
    conversation: async (id) =>
      id === "sc_1"
        ? ({
            id,
            project: "acme",
            subject: "Refund please",
            status: "open",
            createdAt: "2026-11-13T08:41:00Z",
            lastMessageAt: "2026-11-13T09:00:00Z",
          } as SupportConversation)
        : null,
  });
}

afterEach(() => __setBoardRefDepsForTest(undefined));

describe("board refs", () => {
  test("resolves every kind to its live fields", async () => {
    fake();
    const refs = await resolveBoardRefs("Ada", [
      "pr:acme#533",
      "check:acme#533/ci-success",
      "incident:acme/status-page",
      "thread:acme/sc_1",
      "release:acme@1.19.0",
      "project:acme",
    ]);
    expect(refs["pr:acme#533"]).toMatchObject({
      ok: true,
      title: "#533 search-service 1.19.0",
      status: "checks failing",
      statusTone: "red",
      url: "https://example.test/acme/pull/533",
      fields: { number: "533", checks: "3/4 passed, 1 failed" },
    });
    expect(refs["check:acme#533/ci-success"]).toMatchObject({
      ok: true,
      title: "ci-success",
      status: "failing",
      fields: { scope: "all checks on the pull request" },
    });
    expect(refs["incident:acme/status-page"]).toMatchObject({
      ok: true,
      status: "investigating",
      statusTone: "red",
      fields: { openFor: "2 days", severity: "major" },
    });
    expect(refs["thread:acme/sc_1"]).toMatchObject({
      ok: true,
      title: "Refund please",
      status: "open",
    });
    expect(refs["release:acme@1.19.0"]).toMatchObject({
      ok: true,
      title: "Acme 1.19.0",
      status: "#533 checks failing",
    });
    expect(refs["project:acme"]).toMatchObject({
      ok: true,
      title: "Acme",
      status: "lead on, act",
    });
  });

  test("another owner's object reads like a missing one", async () => {
    fake();
    const refs = await resolveBoardRefs("Ada", [
      "pr:globex#7",
      "project:globex",
      // The id exists, but in another project.
      "incident:acme/theirs",
      "pr:acme#999",
      "release:acme@9.9.9",
      "thread:acme/sc_2",
    ]);
    for (const value of Object.values(refs))
      expect(value).toEqual({ ok: false, reason: "not-found" });
    // Bob sees his own project.
    expect(
      (await resolveBoardRefs("bob", ["pr:globex#7"]))["pr:globex#7"]?.ok,
    ).toBe(true);
  });

  test("a failing store is unavailable and not cached", async () => {
    fake();
    roster = [...roster];
    const first = await resolveBoardRefs("Ada", ["incident:acme/boom"]);
    expect(first["incident:acme/boom"]).toEqual({
      ok: false,
      reason: "unavailable",
    });
    await resolveBoardRefs("Ada", ["incident:acme/boom"]);
    expect(reads.filter((r) => r === "incident:boom")).toHaveLength(2);
  });

  test("answers are cached per owner for a while", async () => {
    fake();
    await resolveBoardRefs("Ada", ["incident:acme/status-page"]);
    await resolveBoardRefs("Ada", ["incident:acme/status-page"]);
    expect(reads.filter((r) => r.startsWith("incident:"))).toHaveLength(1);
    // Another owner has their own answers, and never reads Ada's project.
    expect(
      (await resolveBoardRefs("Bob", ["incident:acme/status-page"]))[
        "incident:acme/status-page"
      ],
    ).toEqual({ ok: false, reason: "not-found" });
    await resolveBoardRefs("Bob", ["incident:globex/theirs"]);
    expect(reads.filter((r) => r.startsWith("incident:"))).toEqual([
      "incident:status-page",
      "incident:theirs",
    ]);
    // Later, read again.
    let now = NOW;
    __setBoardRefDepsForTest({
      now: () => now,
      roster: async () => roster,
      incident: async (id) => {
        reads.push(`incident:${id}`);
        return null;
      },
    });
    reads = [];
    await resolveBoardRefs("Ada", ["incident:acme/status-page"]);
    now += CACHE_TTL_MS + 1;
    await resolveBoardRefs("Ada", ["incident:acme/status-page"]);
    expect(reads).toHaveLength(2);
  });

  test("is bounded", async () => {
    fake();
    const many = Array.from(
      { length: MAX_REFS + 5 },
      (_, i) => `pr:acme#${i + 1}`,
    );
    const refs = await resolveBoardRefs("Ada", many);
    expect(
      Object.values(refs).filter((r) => !r.ok && r.reason === "limit"),
    ).toHaveLength(5);
    expect(reads.filter((r) => r === "roster")).toHaveLength(1);
  });
});
