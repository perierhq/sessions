import { describe, expect, test } from "bun:test";
import type { KnowledgeItem } from "../../../shared/knowledge";
import {
  changePane,
  checkNowLine,
  confirmGroupRequest,
  groupByReason,
  rowBadges,
  rowLine,
} from "./needs-check-model";

const NEW = "9c1d2e0f".padEnd(40, "a");

function item(over: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    project: "acme",
    path: "articles/export.md",
    blob: "b".repeat(40),
    commit: "c".repeat(40),
    updatedAt: "2026-10-25T08:00:00Z",
    effective: "needs-check",
    excerpt: "",
    title: "Exporting a project as CSV",
    kind: "answer",
    trust: "trusted",
    status: "needs-check",
    origin: "article",
    topics: [],
    sources: [],
    dependsOn: ["repo:docs/export.md"],
    validAsOf: "2026-10-20",
    check: {
      reason: "docs/export.md changed in 9c1d2e0",
      since: "2026-10-25",
      source: `repo:docs/export.md@${NEW}`,
    },
    ...over,
  };
}

describe("groupByReason", () => {
  test("items with the same check source are one group", () => {
    const groups = groupByReason([
      item({ path: "articles/a.md" }),
      item({
        path: "articles/b.md",
        check: {
          reason: "Disagrees with Exporting (old)",
          since: "2026-10-25",
          conflictWith: "articles/old.md",
        },
      }),
      item({ path: "articles/c.md" }),
      item({ path: "articles/d.md" }),
      item({ path: "articles/e.md" }),
    ]);
    expect(groups.map((g) => g.line)).toEqual([
      "docs/export.md changed in 9c1d2e0 · 4 articles",
      "Disagrees with Exporting (old) · 1 article",
    ]);
    expect(groups[0]!.items.map((i) => i.path)).toEqual([
      "articles/a.md",
      "articles/c.md",
      "articles/d.md",
      "articles/e.md",
    ]);
  });

  test("anything but articles is counted as items", () => {
    const [group] = groupByReason([
      item({ path: "articles/a.md" }),
      item({ path: "sources/mail/2026-10/m1.md", origin: "mail" }),
    ]);
    expect(group!.line).toBe("docs/export.md changed in 9c1d2e0 · 2 items");
  });

  test("passed review dates are one group, with or without a check note", () => {
    const groups = groupByReason([
      item({ path: "articles/a.md", check: undefined, reviewBy: "2026-10-01" }),
      item({ path: "articles/b.md", check: undefined, reviewBy: "2026-09-01" }),
    ]);
    expect(groups.map((g) => g.line)).toEqual([
      "Review date passed · 2 articles",
    ]);
  });

  test("a person's mark groups by its reason", () => {
    const groups = groupByReason([
      item({
        path: "articles/a.md",
        check: { reason: "Marked by a person", since: "2026-10-25" },
      }),
      item({
        path: "articles/b.md",
        check: { reason: "Marked by a person", since: "2026-10-24" },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(2);
  });
});

describe("changePane", () => {
  const body = "Export from the menu.\n";

  test("repo: the article beside the patch, toned per line", () => {
    const pane = changePane(
      {
        kind: "repo",
        title: "docs/export.md changed in 9c1d2e0",
        patch: [
          "diff --git a/docs/export.md b/docs/export.md",
          "index 1..2 100644",
          "--- a/docs/export.md",
          "+++ b/docs/export.md",
          "@@ -1 +1 @@",
          "-Export from the menu.",
          "+Export from Settings.",
          "",
        ].join("\n"),
      },
      body,
    );
    expect(pane.title).toBe("docs/export.md changed in 9c1d2e0");
    expect(pane.left).toEqual({ label: "Article", text: body });
    expect(pane.right.label).toBe("What changed");
    expect(pane.right.patchLines).toEqual([
      { text: "@@ -1 +1 @@", tone: "meta" },
      { text: "-Export from the menu.", tone: "remove" },
      { text: "+Export from Settings.", tone: "add" },
    ]);
    expect(pane.right.text).toBeUndefined();
  });

  test("repo without a patch shows the file as it is now", () => {
    const pane = changePane(
      { kind: "repo", title: "t", after: "Export from Settings.\n" },
      body,
    );
    expect(pane.right.patchLines).toBeUndefined();
    expect(pane.right.text).toBe("Export from Settings.\n");
  });

  test("url: the page as it is now, with its link", () => {
    const pane = changePane(
      {
        kind: "url",
        title: "The page changed",
        before: body,
        after: "Export from Settings.",
        link: "https://help.example.test/export",
      },
      body,
    );
    expect(pane.right).toEqual({
      label: "The page now",
      text: "Export from Settings.",
      link: "https://help.example.test/export",
    });
  });

  test("url that couldn't be fetched says so", () => {
    const pane = changePane({ kind: "url", title: "t", before: body }, body);
    expect(pane.right.text).toBe("The page couldn't be read right now");
    expect(pane.right.missing).toBe(true);
  });

  test("conflict: the other article, linked", () => {
    const pane = changePane(
      {
        kind: "conflict",
        title: "Disagrees with Exporting (old)",
        before: body,
        after: "Export from Settings.\n",
        link: "articles/old.md",
      },
      body,
    );
    expect(pane.right).toEqual({
      label: "The other article",
      text: "Export from Settings.\n",
      link: "articles/old.md",
    });
  });

  test("review: nothing it depends on changed", () => {
    const pane = changePane(
      { kind: "review", title: "Review date passed (2026-10-01)" },
      body,
    );
    expect(pane.right.label).toBe("What changed");
    expect(pane.right.text).toBe(
      "Nothing it depends on changed. Read it again and confirm it's still right",
    );
  });

  test("release: the release notes", () => {
    const pane = changePane(
      { kind: "release", title: "v1.4.0 may change this", after: "Notes" },
      body,
    );
    expect(pane.right).toEqual({ label: "Release notes", text: "Notes" });
  });
});

describe("confirmGroupRequest", () => {
  test("confirms every path in the group, and only once asked", async () => {
    const [group] = groupByReason([
      item({ path: "articles/a.md" }),
      item({ path: "articles/b.md" }),
    ]);
    const calls: Array<[string, string[]]> = [];
    const request = confirmGroupRequest("acme", group!, async (p, paths) => {
      calls.push([p, paths]);
      return { commit: "d".repeat(40) };
    });
    expect(request.title).toBe("Mark 2 articles still true?");
    expect(request.confirmLabel).toBe("Still true for all (2)");
    expect(calls).toEqual([]);
    await request.onConfirm();
    expect(calls).toEqual([["acme", ["articles/a.md", "articles/b.md"]]]);
  });
});

test("checkNowLine counts what was checked and what flipped", () => {
  expect(
    checkNowLine({
      checked: 12,
      flipped: [
        { path: "articles/a.md", reason: "r" },
        { path: "articles/b.md", reason: "r" },
      ],
      refreshed: 0,
      conflicts: [],
      errors: [],
    }),
  ).toEqual({ text: "Checked 12, 2 need a check", failed: false });
  expect(
    checkNowLine({
      checked: 3,
      flipped: [],
      refreshed: 0,
      conflicts: [],
      errors: ["docs: fetch failed"],
    }),
  ).toEqual({
    text: "Checked 3, 0 need a check. Some sources couldn't be read",
    failed: true,
  });
});

describe("rows", () => {
  test("a row says since when, not the reason its group already says", () => {
    expect(rowLine(item())).toBe("Since 25 Oct 2026");
    expect(rowLine(item({ check: undefined, reviewBy: "2026-10-01" }))).toBe(
      "Review date passed (1 Oct 2026)",
    );
    expect(
      rowLine(item({ path: "sources/mail/2026-10/m.md", origin: "mail" })),
    ).toBe("Since 25 Oct 2026 · From the mailbox");
  });

  test("badges leave out what the tab already says", () => {
    expect(
      rowBadges(item({ trust: "reference", kind: "internal" })).map(
        (b) => b.label,
      ),
    ).toEqual(["Internal", "Reference"]);
    expect(
      rowBadges(
        item({ status: "active", check: undefined, reviewBy: "2026-10-01" }),
      ),
    ).toEqual([]);
  });
});
