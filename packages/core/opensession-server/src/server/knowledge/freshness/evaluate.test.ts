import { describe, expect, test } from "bun:test";
import type { KnowledgeItem } from "../../../shared/knowledge";
import { evaluateItem, type Signals } from "./evaluate";
import type { ReleaseInfo } from "./github";
import type { RepoCommit } from "./repo-changes";

const TODAY = "2026-10-26";
const C1 = "3f2a1b0c".padEnd(40, "1");
const C2 = "9c1d2e0".padEnd(40, "2");
const URL = "https://help.acme.example.test/export";

function item(over: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    project: "acme",
    path: "articles/export.md",
    blob: "b".repeat(40),
    commit: "c".repeat(40),
    updatedAt: "2026-10-20T00:00:00.000Z",
    effective: "active",
    excerpt: "",
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    topics: ["export", "csv"],
    sources: [],
    dependsOn: [],
    validAsOf: "2026-10-20",
    ...over,
  };
}

function signals(over: Partial<Signals> = {}): Signals & {
  asked: { repo: Array<[string[], string]>; release: string[] };
} {
  const asked = {
    repo: [] as Array<[string[], string]>,
    release: [] as string[],
  };
  return {
    asked,
    today: TODAY,
    repoCommits: async (paths, since) => {
      asked.repo.push([paths, since]);
      return [];
    },
    pageHash: async () => null,
    releasesSince: async () => [],
    releaseMentions: async (_item, _body, release) => {
      asked.release.push(release.tag);
      return true;
    },
    refState: async () => null,
    ...over,
  };
}

const BODY = "Open the project, choose Export, then CSV.";

describe("evaluateItem", () => {
  test("a commit touching a repo dependency makes the item stale", async () => {
    const commits: RepoCommit[] = [
      { sha: C2, at: "2026-10-25T10:00:00Z", paths: ["docs/export.md"] },
    ];
    const s = signals({ repoCommits: async () => commits });
    const verdict = await evaluateItem(
      item({ dependsOn: ["repo:docs/export.md"], validAsOfCommit: C1 }),
      BODY,
      s,
    );
    expect(verdict).toEqual({
      stale: true,
      reason: "docs/export.md changed in 9c1d2e0",
      source: `repo:docs/export.md@${C2}`,
    });
  });

  test("no commits since validAsOfCommit: not stale", async () => {
    const s = signals();
    const verdict = await evaluateItem(
      item({ dependsOn: ["repo:docs/export.md"], validAsOfCommit: C1 }),
      BODY,
      s,
    );
    expect(verdict).toEqual({ stale: false });
    expect(s.asked.repo).toEqual([[["docs/export.md"], C1]]);
  });

  test("without validAsOfCommit the repo check runs from validAsOf", async () => {
    const s = signals();
    await evaluateItem(item({ dependsOn: ["repo:docs/"] }), BODY, s);
    expect(s.asked.repo).toEqual([[["docs/"], "2026-10-20"]]);
  });

  test("a page whose hash changed makes the item stale", async () => {
    const s = signals({ pageHash: async () => "bb" });
    const verdict = await evaluateItem(
      item({ dependsOn: [`url:${URL}`], sources: [`url:${URL}#sha256=aa`] }),
      BODY,
      s,
    );
    expect(verdict).toEqual({
      stale: true,
      reason: `${URL} changed on ${TODAY}`,
      source: `url:${URL}#sha256=bb`,
    });
  });

  test("an unreadable page is not a change", async () => {
    const verdict = await evaluateItem(
      item({ dependsOn: [`url:${URL}`], sources: [`url:${URL}#sha256=aa`] }),
      BODY,
      signals({ pageHash: async () => null }),
    );
    expect(verdict).toEqual({ stale: false });
  });

  test("the same hash is not a change", async () => {
    const verdict = await evaluateItem(
      item({ dependsOn: [`url:${URL}`], sources: [`url:${URL}#sha256=aa`] }),
      BODY,
      signals({ pageHash: async () => "aa" }),
    );
    expect(verdict).toEqual({ stale: false });
  });

  const v140: ReleaseInfo = {
    tag: "v1.4.0",
    name: "v1.4.0",
    at: "2026-10-22T09:00:00Z",
    body: "Export now includes archived rows.",
  };

  test("a newer release that mentions a topic makes the item stale", async () => {
    const s = signals({ releasesSince: async () => [v140] });
    const verdict = await evaluateItem(item(), BODY, s);
    expect(verdict).toEqual({
      stale: true,
      reason: "Release v1.4.0 mentions export",
      source: "release:v1.4.0",
    });
    expect(s.asked.release).toEqual(["v1.4.0"]);
  });

  test("the model saying a release is unrelated keeps the item", async () => {
    const verdict = await evaluateItem(
      item(),
      BODY,
      signals({
        releasesSince: async () => [v140],
        releaseMentions: async () => false,
      }),
    );
    expect(verdict).toEqual({ stale: false });
  });

  test("a release before validAsOf is not asked about", async () => {
    const s = signals({
      releasesSince: async () => [{ ...v140, at: "2026-10-01T09:00:00Z" }],
    });
    expect(await evaluateItem(item(), BODY, s)).toEqual({ stale: false });
    expect(s.asked.release).toEqual([]);
  });

  test("a release that never names the topics is not asked about", async () => {
    const s = signals({
      releasesSince: async () => [{ ...v140, body: "Faster login." }],
    });
    expect(await evaluateItem(item(), BODY, s)).toEqual({ stale: false });
    expect(s.asked.release).toEqual([]);
  });

  test("items without topics skip the release check", async () => {
    const s = signals({ releasesSince: async () => [v140] });
    expect(await evaluateItem(item({ topics: [] }), BODY, s)).toEqual({
      stale: false,
    });
    expect(s.asked.release).toEqual([]);
  });

  test("a pull request merged after validAsOf makes the item stale", async () => {
    const verdict = await evaluateItem(
      item({ dependsOn: ["pr:57"] }),
      BODY,
      signals({
        refState: async () => ({ state: "merged", at: "2026-10-24T12:00:00Z" }),
      }),
    );
    expect(verdict).toEqual({
      stale: true,
      reason: "Pull request #57 was merged",
      source: "pr:57",
    });
  });

  test("an issue closed after validAsOf makes the item stale", async () => {
    const verdict = await evaluateItem(
      item({ dependsOn: ["issue:42"] }),
      BODY,
      signals({
        refState: async () => ({ state: "closed", at: "2026-10-24T12:00:00Z" }),
      }),
    );
    expect(verdict).toEqual({
      stale: true,
      reason: "Issue #42 was closed",
      source: "issue:42",
    });
  });

  test("a ref closed before validAsOf, open or unreadable keeps the item", async () => {
    for (const state of [
      { state: "closed" as const, at: "2026-10-01T12:00:00Z" },
      { state: "open" as const, at: null },
      null,
    ]) {
      const verdict = await evaluateItem(
        item({ dependsOn: ["issue:42", "pr:57"] }),
        BODY,
        signals({ refState: async () => state }),
      );
      expect(verdict).toEqual({ stale: false });
    }
  });

  test("a passed review date makes the item stale", async () => {
    const verdict = await evaluateItem(
      item({ reviewBy: "2026-10-01" }),
      BODY,
      signals(),
    );
    expect(verdict).toEqual({
      stale: true,
      reason: "Review date passed (2026-10-01)",
    });
  });

  test("the review date itself still counts as active", async () => {
    expect(
      await evaluateItem(item({ reviewBy: TODAY }), BODY, signals()),
    ).toEqual({ stale: false });
  });

  test("a reference item is evaluated the same way", async () => {
    const verdict = await evaluateItem(
      item({
        trust: "reference",
        origin: "mail",
        path: "sources/mail/2026-10/m1@example.test.md",
        dependsOn: ["repo:docs/export.md"],
        validAsOfCommit: C1,
      }),
      BODY,
      signals({
        repoCommits: async () => [
          { sha: C2, at: "2026-10-25T10:00:00Z", paths: ["docs/export.md"] },
        ],
      }),
    );
    expect(verdict.stale).toBe(true);
  });

  test("retired items are not evaluated", async () => {
    const s = signals({
      repoCommits: async () => [
        { sha: C2, at: "2026-10-25T10:00:00Z", paths: ["docs/export.md"] },
      ],
    });
    expect(
      await evaluateItem(
        item({ status: "retired", dependsOn: ["repo:docs/export.md"] }),
        BODY,
        s,
      ),
    ).toEqual({ stale: false });
    expect(s.asked.repo).toEqual([]);
  });

  test("a failing signal throws instead of reading as no change", async () => {
    await expect(
      evaluateItem(
        item({ dependsOn: ["repo:docs/export.md"], validAsOfCommit: C1 }),
        BODY,
        signals({
          repoCommits: async () => {
            throw new Error("git failed");
          },
        }),
      ),
    ).rejects.toThrow("git failed");
  });
});
