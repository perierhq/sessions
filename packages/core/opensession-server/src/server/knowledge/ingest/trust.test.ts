import { describe, expect, test } from "bun:test";
import type { RepoCommit } from "../freshness/repo-changes";
import {
  __clearGithubSignalCacheForTest,
  latestRelease,
  type ReleaseInfo,
} from "../freshness/github";
import { DOCS_FALLBACK, mailTrust, type TrustDeps } from "./trust";

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);

/** Default-branch history, oldest first. */
const HISTORY: RepoCommit[] = [
  { sha: C1, at: "2026-08-01T10:00:00Z", paths: ["docs/export.md"] },
  { sha: C2, at: "2026-09-20T10:00:00Z", paths: ["src/app.ts"] },
  { sha: C3, at: "2026-10-06T10:00:00Z", paths: ["docs/export.md"] },
];

const V130: ReleaseInfo = {
  tag: "v1.3.0",
  name: "v1.3.0",
  at: "2026-07-01T09:00:00Z",
  body: "",
};

function touches(path: string, asked: string[]): boolean {
  return asked.some((a) => (a.endsWith("/") ? path.startsWith(a) : path === a));
}

function fakeDeps(over: Partial<TrustDeps> = {}): TrustDeps {
  return {
    latestRelease: async () => V130,
    latestChange: async (paths) => {
      const hits = HISTORY.filter(
        (c) => !paths.length || c.paths.some((p) => touches(p, paths)),
      ).map((c) => ({
        ...c,
        paths: c.paths.filter((p) => !paths.length || touches(p, paths)),
      }));
      return hits.at(-1) ?? null;
    },
    commitAt: async (at) =>
      HISTORY.filter((c) => Date.parse(c.at) <= Date.parse(at)).at(-1)?.sha ??
      null,
    ...over,
  };
}

describe("mailTrust", () => {
  test("an answer from before the touched doc changed is reference", async () => {
    const decision = await mailTrust(
      { answeredAt: "2026-09-10T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps(),
    );
    expect(decision.trust).toBe("reference");
    expect(decision.reason).toBe(
      "Answered before docs/export.md changed in 3333333 (2026-10-06)",
    );
    expect(decision.dependsOn).toEqual(["repo:docs/export.md"]);
    expect(decision.validAsOf).toBe("2026-09-10");
  });

  test("an answer after the latest change is trusted at the commit then current", async () => {
    const decision = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps(),
    );
    expect(decision).toEqual({
      trust: "trusted",
      reason: null,
      dependsOn: ["repo:docs/export.md"],
      validAsOf: "2026-10-20",
      validAsOfCommit: C3,
    });
  });

  test("empty touch set falls back to docs and README", async () => {
    expect(DOCS_FALLBACK).toEqual(["docs/", "README.md"]);
    const decision = await mailTrust(
      { answeredAt: "2026-09-10T08:00:00Z", touchedPaths: [] },
      fakeDeps(),
    );
    expect(decision.trust).toBe("reference");
    expect(decision.dependsOn).toEqual(["repo:docs/", "repo:README.md"]);
    expect(decision.reason).toBe(
      "Answered before docs/export.md changed in 3333333 (2026-10-06)",
    );
  });

  test("a release after the answer makes it reference", async () => {
    const decision = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps({
        latestRelease: async () => ({
          tag: "v1.4.0",
          name: "v1.4.0",
          at: "2026-10-25T12:00:00Z",
          body: "",
        }),
      }),
    );
    expect(decision.trust).toBe("reference");
    expect(decision.reason).toBe("Answered before release v1.4.0 (2026-10-25)");
    expect(decision.dependsOn).toEqual(["repo:docs/export.md"]);
    expect(decision.validAsOfCommit).toBeUndefined();
  });

  test("no GitHub repository skips the release step", async () => {
    const decision = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps({ latestRelease: async () => null }),
    );
    expect(decision.trust).toBe("trusted");
    expect(decision.validAsOfCommit).toBe(C3);
  });

  test("history that can't be read makes the answer reference", async () => {
    const decision = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps({
        latestChange: async () => {
          throw new Error("git failed");
        },
      }),
    );
    expect(decision.trust).toBe("reference");
    expect(decision.reason).toBe("History couldn't be read");
    expect(decision.dependsOn).toEqual(["repo:docs/export.md"]);
    expect(decision.validAsOf).toBe("2026-10-20");
  });

  test("a failing release lookup or missing commit fails closed too", async () => {
    const releaseFails = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps({
        latestRelease: async () => {
          throw new Error("GitHub down");
        },
      }),
    );
    expect(releaseFails.trust).toBe("reference");
    expect(releaseFails.reason).toBe("History couldn't be read");

    const noCommit = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps({ commitAt: async () => null }),
    );
    expect(noCommit.trust).toBe("reference");
    expect(noCommit.reason).toBe("History couldn't be read");
  });

  test("a GitHub outage is history that can't be read, never 'no release'", async () => {
    __clearGithubSignalCacheForTest();
    const github = {
      ghRepo: () => "acme/app",
      request: async () => ({ ok: false, status: 502, data: null }),
    };
    const decision = await mailTrust(
      { answeredAt: "2026-10-20T08:00:00Z", touchedPaths: ["docs/export.md"] },
      fakeDeps({ latestRelease: () => latestRelease("acme", github) }),
    );
    expect(decision.trust).toBe("reference");
    expect(decision.reason).toBe("History couldn't be read");
    expect(decision.validAsOfCommit).toBeUndefined();
  });

  test("an unreadable answer time is refused", async () => {
    await expect(
      mailTrust({ answeredAt: "yesterday", touchedPaths: [] }, fakeDeps()),
    ).rejects.toThrow("Not a date");
  });
});
