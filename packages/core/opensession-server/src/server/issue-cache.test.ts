import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamMember } from "./config";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import {
  collectIssuePages,
  ISSUE_PAGE_LIMIT,
  servedIssues,
  type CachedIssueEntry,
} from "./issue-cache";

describe("collectIssuePages", () => {
  test("follows next pages up to the page limit", async () => {
    const asked: number[] = [];
    const items = await collectIssuePages(async (page) => {
      asked.push(page);
      return { items: [page], hasNext: true };
    });
    expect(asked).toEqual(
      Array.from({ length: ISSUE_PAGE_LIMIT }, (_, i) => i + 1),
    );
    expect(items).toHaveLength(ISSUE_PAGE_LIMIT);
  });

  test("stops at the last page", async () => {
    const asked: number[] = [];
    const items = await collectIssuePages(async (page) => {
      asked.push(page);
      return { items: [`p${page}`], hasNext: page < 2 };
    });
    expect(asked).toEqual([1, 2]);
    expect(items).toEqual(["p1", "p2"]);
  });

  test("a failed page keeps the previous snapshot rather than a partial one", async () => {
    const items = await collectIssuePages(async (page) =>
      page === 2 ? null : { items: [page], hasNext: true },
    );
    expect(items).toBeNull();
  });
});

describe("servedIssues", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = __setIdentitiesForTest([
      { name: "Alex Acme", github: "alex-acme", email: "alex@example.test" },
    ] as TeamMember[]);
  });
  afterAll(() => restore());

  const row = (
    number: number,
    author: string,
    updatedAt: string,
  ): CachedIssueEntry => ({
    repo: "acme-web",
    ghRepo: "acme/acme-web",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/acme-web/issues/${number}`,
    body: "",
    author,
    person: null,
    labels: [],
    assignees: [],
    comments: 0,
    createdAt: updatedAt,
    updatedAt,
    sessionId: `bks-ghpr-${number}-issue`,
    assigned: false,
  });

  test("classifies every author against the roster, newest first", () => {
    const issues = servedIssues([
      [row(1, "alex-acme", "2026-10-20T09:00:00Z")],
      [
        row(2, "octo-contributor", "2026-10-21T09:00:00Z"),
        row(3, "renovate[bot]", "2026-10-19T09:00:00Z"),
      ],
    ]);
    expect(issues.map((i) => [i.number, i.authorKind])).toEqual([
      [2, "outside"],
      [1, "team"],
      [3, "bot"],
    ]);
  });
});
