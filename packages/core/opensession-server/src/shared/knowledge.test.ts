import { describe, expect, test } from "bun:test";
import {
  KNOWLEDGE_COPY,
  LITERAL_PATHSPECS,
  effectiveStatus,
  formatDependency,
  formatKnowledgeCitation,
  isBacking,
  parseDependency,
  parseKnowledgeCitation,
} from "./knowledge";

const SHA = "3f2a1b0c3f2a1b0c3f2a1b0c3f2a1b0c3f2a1b0c";

describe("parseKnowledgeCitation", () => {
  test("reads <path>@<commit> and the display form", () => {
    expect(parseKnowledgeCitation("articles/export.md@3f2a1b0")).toEqual({
      path: "articles/export.md",
      commit: "3f2a1b0",
    });
    expect(
      parseKnowledgeCitation("knowledge:articles/export.md@3f2a1b0"),
    ).toEqual({ path: "articles/export.md", commit: "3f2a1b0" });
    expect(parseKnowledgeCitation(`sources/repo/docs/a.md@${SHA}`)).toEqual({
      path: "sources/repo/docs/a.md",
      commit: SHA,
    });
  });

  test("rejects escapes, missing or bad commits and other folders", () => {
    for (const ref of [
      "../x.md@3f2a1b0",
      "articles/x.md",
      "articles/x.md@zz",
      "/articles/x.md@3f2a1b0",
      "KNOWLEDGE.md@3f2a1b0",
      "articles/../KNOWLEDGE.md@3f2a1b0",
      "articles/x.md@3f2a1b",
      "articles/@3f2a1b0",
      "articles/.git/config@3f2a1b0",
      "sources/.git@3f2a1b0",
      "",
    ])
      expect(parseKnowledgeCitation(ref)).toBeNull();
  });

  test("formats the display form", () => {
    expect(formatKnowledgeCitation("articles/export.md", "3f2a1b0")).toBe(
      "knowledge:articles/export.md@3f2a1b0",
    );
  });
});

describe("dependencies", () => {
  test("parses each kind", () => {
    expect(parseDependency("repo:docs/")).toEqual({
      type: "repo",
      path: "docs/",
      prefix: true,
    });
    expect(parseDependency("repo:docs/export.md")).toEqual({
      type: "repo",
      path: "docs/export.md",
      prefix: false,
    });
    expect(parseDependency("pr:57")).toEqual({ type: "pr", number: 57 });
    expect(parseDependency("issue:42")).toEqual({ type: "issue", number: 42 });
    expect(parseDependency("release:v1.4.0")).toEqual({
      type: "release",
      tag: "v1.4.0",
    });
    expect(parseDependency("url:https://help.acme.example.test/x")).toEqual({
      type: "url",
      url: "https://help.acme.example.test/x",
    });
  });

  test("rejects what it can't use", () => {
    for (const raw of [
      "url:ftp://x",
      "url:not a url",
      "repo:",
      "repo:/etc/passwd",
      "repo:docs/../x",
      "pr:abc",
      "issue:0",
      "release:",
      "nope:1",
      "docs/export.md",
    ])
      expect(parseDependency(raw)).toBeNull();
  });

  test("repo paths can't carry git pathspec magic or wildcards", () => {
    for (const raw of [
      "repo::(exclude)docs",
      "repo::/docs",
      "repo:docs/*.md",
      "repo:docs/?.md",
      "repo:docs/[ab].md",
      "repo:docs/a].md",
      "repo:.git/config",
      "repo:docs/.git/",
    ])
      expect(parseDependency(raw)).toBeNull();
    expect(parseDependency("repo:docs/a:b.md")).toEqual({
      type: "repo",
      path: "docs/a:b.md",
      prefix: false,
    });
    expect(LITERAL_PATHSPECS).toBe("--literal-pathspecs");
  });

  test("release tags are plain git tag names", () => {
    for (const tag of ["v1.4.0", "1.0", "release/2026-10", "v2.0.0+build.1"])
      expect(parseDependency(`release:${tag}`)).toEqual({
        type: "release",
        tag,
      });
    for (const raw of [
      "release:-v1",
      "release:.v1",
      "release:v1..2",
      "release:v1 2",
      "release:v1~1",
      "release:v1^",
      "release:v1:x",
      "release:v1@{0}",
      `release:v${"1".repeat(128)}`,
    ])
      expect(parseDependency(raw)).toBeNull();
    expect(parseDependency(`release:v${"1".repeat(127)}`)).not.toBeNull();
  });

  test("urls with credentials are refused", () => {
    for (const raw of [
      "url:https://user@help.acme.example.test/x",
      "url:https://user:pass@help.acme.example.test/x",
      "url:https://:pass@help.acme.example.test/x",
    ])
      expect(parseDependency(raw)).toBeNull();
  });

  test("round-trips the front-matter examples", () => {
    for (const s of [
      "repo:docs/export.md",
      "repo:docs/",
      "url:https://help.acme.example.test/export",
      "issue:42",
      "pr:57",
      "release:v1.4.0",
    ])
      expect(formatDependency(parseDependency(s)!)).toBe(s);
  });
});

describe("effectiveStatus", () => {
  test("a passed review date needs a check", () => {
    expect(
      effectiveStatus(
        { status: "active", reviewBy: "2026-10-25" },
        "2026-10-26",
      ),
    ).toBe("needs-check");
  });
  test("review date today is still active", () => {
    expect(
      effectiveStatus(
        { status: "active", reviewBy: "2026-10-26" },
        "2026-10-26",
      ),
    ).toBe("active");
  });
  test("retired stays retired", () => {
    expect(
      effectiveStatus(
        { status: "retired", reviewBy: "2026-01-01" },
        "2026-10-26",
      ),
    ).toBe("retired");
    expect(effectiveStatus({ status: "needs-check" }, "2026-10-26")).toBe(
      "needs-check",
    );
  });
});

describe("effectiveStatus dates", () => {
  test("a malformed review date needs a check", () => {
    for (const reviewBy of ["2026-1-01", "next week", "2026-10-26T00:00", "9"])
      expect(
        effectiveStatus({ status: "active", reviewBy }, "2026-10-26"),
      ).toBe("needs-check");
  });
  test("today must be YYYY-MM-DD", () => {
    expect(() =>
      effectiveStatus({ status: "active" }, "2026-10-26T10:00:00Z"),
    ).toThrow();
    expect(() => effectiveStatus({ status: "active" }, "")).toThrow();
  });
});

describe("isBacking", () => {
  const today = "2026-10-26";
  test("only trusted, active, not overdue", () => {
    expect(isBacking({ trust: "trusted", status: "active" }, today)).toBe(true);
    expect(isBacking({ trust: "reference", status: "active" }, today)).toBe(
      false,
    );
    expect(isBacking({ trust: "trusted", status: "needs-check" }, today)).toBe(
      false,
    );
    expect(
      isBacking(
        { trust: "trusted", status: "active", reviewBy: "2026-10-01" },
        today,
      ),
    ).toBe(false);
    expect(isBacking({ trust: "trusted", status: "retired" }, today)).toBe(
      false,
    );
  });
});

describe("KNOWLEDGE_COPY", () => {
  test("stale names the article", () => {
    expect(KNOWLEDGE_COPY.stale("Export")).toBe(
      "Knowledge may be out of date: Export",
    );
    expect(KNOWLEDGE_COPY.reviewPassed("2026-10-01")).toBe(
      "Review date passed (2026-10-01)",
    );
  });
});
