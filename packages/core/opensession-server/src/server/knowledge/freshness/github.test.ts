import { beforeEach, describe, expect, test } from "bun:test";
import {
  __clearGithubSignalCacheForTest,
  GITHUB_SIGNAL_CACHE_SIZE,
  OPEN_BUG_PAGES,
  type GithubSignalDeps,
  latestRelease,
  listReleases,
  openBugIssues,
  refState,
} from "./github";

type Answer = { ok: boolean; status: number; data: unknown };

function stub(
  answers: Record<string, Answer>,
  repo: string | null = "acme/app",
) {
  const calls: string[] = [];
  let clock = Date.parse("2026-10-26T09:00:00Z");
  const deps: GithubSignalDeps = {
    ghRepo: (project) => (project === "acme" ? repo : null),
    request: async (path) => {
      calls.push(path);
      return answers[path] ?? { ok: false, status: 404, data: null };
    },
    now: () => clock,
  };
  return {
    deps,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const RELEASES = "/repos/acme/app/releases?per_page=100";
const BUGS = "/repos/acme/app/issues?state=open&labels=bug&per_page=100&page=1";
const bugsPage = (n: number) =>
  `/repos/acme/app/issues?state=open&labels=bug&per_page=100&page=${n}`;

function bug(number: number) {
  return {
    number,
    title: `Bug ${number}`,
    body: "",
    html_url: `https://github.com/acme/app/issues/${number}`,
    labels: [{ name: "bug" }],
    updated_at: "2026-10-20T00:00:00Z",
  };
}

beforeEach(() => __clearGithubSignalCacheForTest());

describe("releases", () => {
  const data = [
    {
      tag_name: "v1.3.0",
      name: "1.3",
      published_at: "2026-09-01T00:00:00Z",
      draft: false,
      body: "older",
    },
    {
      tag_name: "v1.5.0",
      name: "1.5",
      published_at: null,
      created_at: "2026-10-20T00:00:00Z",
      draft: true,
      body: "draft",
    },
    {
      tag_name: "v1.4.0",
      name: "",
      published_at: "2026-10-01T00:00:00Z",
      draft: false,
      body: null,
    },
  ];

  test("newest first, drafts dropped", async () => {
    const { deps } = stub({ [RELEASES]: { ok: true, status: 200, data } });
    expect(await listReleases("acme", deps)).toEqual([
      { tag: "v1.4.0", name: "v1.4.0", at: "2026-10-01T00:00:00Z", body: "" },
      { tag: "v1.3.0", name: "1.3", at: "2026-09-01T00:00:00Z", body: "older" },
    ]);
    expect((await latestRelease("acme", deps))?.tag).toBe("v1.4.0");
  });

  test("a second call within 10 minutes issues no request", async () => {
    const { deps, calls, advance } = stub({
      [RELEASES]: { ok: true, status: 200, data },
    });
    await listReleases("acme", deps);
    advance(9 * 60_000);
    await latestRelease("acme", deps);
    expect(calls).toEqual([RELEASES]);
    advance(2 * 60_000);
    await listReleases("acme", deps);
    expect(calls).toEqual([RELEASES, RELEASES]);
  });

  test("no ghRepo or an unreadable answer is null, and failures are not cached", async () => {
    const none = stub({}, null);
    expect(await listReleases("acme", none.deps)).toBeNull();
    expect(none.calls).toEqual([]);
    const failing = stub({});
    expect(await listReleases("acme", failing.deps)).toBeNull();
    expect(await latestRelease("acme", failing.deps)).toBeNull();
    expect(failing.calls).toEqual([RELEASES, RELEASES]);
  });

  test("no releases at all is an empty list, not null", async () => {
    const { deps } = stub({ [RELEASES]: { ok: true, status: 200, data: [] } });
    expect(await listReleases("acme", deps)).toEqual([]);
    expect(await latestRelease("acme", deps)).toBeNull();
  });
});

describe("issue and PR state", () => {
  test("a merged PR is merged at merged_at", async () => {
    const { deps } = stub({
      "/repos/acme/app/pulls/57": {
        ok: true,
        status: 200,
        data: {
          state: "closed",
          merged_at: "2026-10-10T12:00:00Z",
          closed_at: "2026-10-10T12:00:00Z",
        },
      },
    });
    expect(await refState("acme", { type: "pr", number: 57 }, deps)).toEqual({
      state: "merged",
      at: "2026-10-10T12:00:00Z",
    });
  });

  test("a closed unmerged PR is closed; an open issue has no date", async () => {
    const { deps } = stub({
      "/repos/acme/app/pulls/58": {
        ok: true,
        status: 200,
        data: {
          state: "closed",
          merged_at: null,
          closed_at: "2026-10-11T00:00:00Z",
        },
      },
      "/repos/acme/app/issues/42": {
        ok: true,
        status: 200,
        data: { state: "open", closed_at: null },
      },
      "/repos/acme/app/issues/43": {
        ok: true,
        status: 200,
        data: { state: "closed", closed_at: "2026-10-12T00:00:00Z" },
      },
    });
    expect(await refState("acme", { type: "pr", number: 58 }, deps)).toEqual({
      state: "closed",
      at: "2026-10-11T00:00:00Z",
    });
    expect(await refState("acme", { type: "issue", number: 42 }, deps)).toEqual(
      {
        state: "open",
        at: null,
      },
    );
    expect(await refState("acme", { type: "issue", number: 43 }, deps)).toEqual(
      {
        state: "closed",
        at: "2026-10-12T00:00:00Z",
      },
    );
  });

  test("unreadable, invalid or unknown project is null", async () => {
    const { deps, calls } = stub({});
    expect(
      await refState("acme", { type: "issue", number: 9 }, deps),
    ).toBeNull();
    expect(
      await refState("acme", { type: "issue", number: 0 }, deps),
    ).toBeNull();
    expect(await refState("other", { type: "pr", number: 1 }, deps)).toBeNull();
    expect(calls).toEqual(["/repos/acme/app/issues/9"]);
  });
});

describe("open bug issues", () => {
  test("pull requests are dropped", async () => {
    const { deps } = stub({
      [BUGS]: {
        ok: true,
        status: 200,
        data: [
          {
            number: 42,
            title: "Export fails",
            body: "CSV is empty",
            html_url: "https://github.com/acme/app/issues/42",
            labels: [{ name: "bug" }, "p1"],
            updated_at: "2026-10-20T00:00:00Z",
          },
          {
            number: 43,
            title: "Fix export",
            body: null,
            html_url: "https://github.com/acme/app/pull/43",
            labels: [{ name: "bug" }],
            updated_at: "2026-10-21T00:00:00Z",
            pull_request: { url: "x" },
          },
        ],
      },
    });
    const issues = await openBugIssues("acme", deps);
    expect(issues?.truncated).toBe(false);
    expect(issues ? [...issues] : null).toEqual([
      {
        number: 42,
        title: "Export fails",
        body: "CSV is empty",
        url: "https://github.com/acme/app/issues/42",
        labels: ["bug", "p1"],
        updatedAt: "2026-10-20T00:00:00Z",
      },
    ]);
  });

  test("no ghRepo is null", async () => {
    const { deps } = stub({}, null);
    expect(await openBugIssues("acme", deps)).toBeNull();
  });
});

describe("open bug issues across pages", () => {
  test("follows pages until a short one", async () => {
    const { deps, calls } = stub({
      [bugsPage(1)]: {
        ok: true,
        status: 200,
        data: Array.from({ length: 100 }, (_, i) => bug(i + 1)),
      },
      [bugsPage(2)]: { ok: true, status: 200, data: [bug(101)] },
    });
    const issues = await openBugIssues("acme", deps);
    expect(issues).toHaveLength(101);
    expect(issues?.truncated).toBe(false);
    expect(calls).toEqual([bugsPage(1), bugsPage(2)]);
  });

  test("stops at the page cap and says it truncated", async () => {
    const answers: Record<string, Answer> = {};
    for (let n = 1; n <= 20; n++)
      answers[bugsPage(n)] = {
        ok: true,
        status: 200,
        data: Array.from({ length: 100 }, (_, i) => bug((n - 1) * 100 + i + 1)),
      };
    const { deps, calls } = stub(answers);
    const issues = await openBugIssues("acme", deps);
    expect(issues?.truncated).toBe(true);
    expect(calls).toHaveLength(OPEN_BUG_PAGES);
    expect(issues).toHaveLength(OPEN_BUG_PAGES * 100);
  });

  test("an unreadable later page makes the whole list unreadable", async () => {
    const { deps } = stub({
      [bugsPage(1)]: {
        ok: true,
        status: 200,
        data: Array.from({ length: 100 }, (_, i) => bug(i + 1)),
      },
    });
    expect(await openBugIssues("acme", deps)).toBeNull();
  });
});

describe("cache", () => {
  const issue = (n: number) => `/repos/acme/app/issues/${n}`;
  const open = { ok: true, status: 200, data: { state: "open" } };

  test("{ fresh: true } skips the cache and refreshes it", async () => {
    const { deps, calls } = stub({
      [issue(7)]: open,
      [RELEASES]: { ok: true, status: 200, data: [] },
    });
    await refState("acme", { type: "issue", number: 7 }, deps);
    await refState(
      "acme",
      { type: "issue", number: 7 },
      { ...deps, fresh: true },
    );
    await refState("acme", { type: "issue", number: 7 }, deps);
    expect(calls).toEqual([issue(7), issue(7)]);
    await latestRelease("acme", deps);
    await latestRelease("acme", { ...deps, fresh: true });
    expect(calls.filter((c) => c === RELEASES)).toHaveLength(2);
  });

  test("a full cache evicts the least recently used answer", async () => {
    const answers: Record<string, Answer> = {};
    for (let n = 1; n <= GITHUB_SIGNAL_CACHE_SIZE + 1; n++)
      answers[issue(n)] = open;
    const { deps, calls } = stub(answers);
    for (let n = 1; n <= GITHUB_SIGNAL_CACHE_SIZE; n++)
      await refState("acme", { type: "issue", number: n }, deps);
    await refState("acme", { type: "issue", number: 1 }, deps); // a hit
    await refState(
      "acme",
      { type: "issue", number: GITHUB_SIGNAL_CACHE_SIZE + 1 },
      deps,
    );
    calls.length = 0;
    await refState("acme", { type: "issue", number: 1 }, deps);
    expect(calls).toEqual([]);
    await refState("acme", { type: "issue", number: 2 }, deps);
    expect(calls).toEqual([issue(2)]);
  });
});

describe("repository names", () => {
  test("dot-only owner or name is refused", async () => {
    for (const repo of ["../app", "./app", "acme/..", "acme/.", "../.."]) {
      const { deps, calls } = stub({}, repo);
      expect(await listReleases("acme", deps)).toBeNull();
      expect(calls).toEqual([]);
    }
    const { deps, calls } = stub({}, "acme.io/app.js");
    await listReleases("acme", deps);
    expect(calls).toEqual(["/repos/acme.io/app.js/releases?per_page=100"]);
  });
});
