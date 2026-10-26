import { describe, expect, test } from "bun:test";
import type { KnowledgeFrontMatter } from "../../shared/knowledge";
import { parseArticle, renderArticle } from "./format";

const SHA = "3f2a1b0c9d8e7f60514233445566778899aabbcc";

const SAMPLE: KnowledgeFrontMatter = {
  title: "Exporting a project as CSV",
  kind: "answer",
  trust: "trusted",
  status: "needs-check",
  origin: "article",
  topics: ["export", "csv"],
  sources: [
    "mail:sm_0192ab",
    `repo:docs/export.md@${SHA}`,
    "url:https://help.acme.example.test/export#sha256=ab12",
    "issue:42",
    "release:v1.4.0",
    "file:handbook.pdf",
  ],
  dependsOn: [
    "repo:docs/export.md",
    "repo:docs/",
    "url:https://help.acme.example.test/export",
    "issue:42",
    "pr:57",
  ],
  validAsOf: "2026-10-20",
  validAsOfCommit: SHA,
  reviewBy: "2027-01-31",
  check: {
    reason: "docs/export.md changed in 9c1d2e0",
    since: "2026-10-26",
    source: `repo:docs/export.md@${SHA}`,
    conflictWith: "articles/export-old.md",
  },
  suggestedBy: "Pat",
  approvedBy: "Ada",
};

const MINIMAL: KnowledgeFrontMatter = {
  title: "Resetting a password",
  kind: "answer",
  trust: "trusted",
  status: "active",
  origin: "article",
  topics: [],
  sources: [],
  dependsOn: [],
  validAsOf: "2026-10-20",
};

function withFrontMatter(lines: string[], body = "Body"): string {
  return ["---", ...lines, "---", "", body, ""].join("\n");
}

function minimalLines(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    title: "Resetting a password",
    kind: "answer",
    trust: "trusted",
    status: "active",
    origin: "article",
    validAsOf: "2026-10-20",
  };
  const merged: Record<string, string | null> = { ...base, ...overrides };
  return Object.entries(merged)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}: ${value}`);
}

describe("knowledge article format", () => {
  test("render then parse round-trips every front matter field", () => {
    const text = renderArticle(SAMPLE, "Body");
    const parsed = parseArticle("articles/export.md", text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.fm).toEqual(SAMPLE);
    expect(parsed.body).toBe("Body");
    expect(renderArticle(parsed.fm!, parsed.body)).toBe(text);
  });

  test("renders keys in a fixed order, omits empty optional keys, ends with one newline", () => {
    const text = renderArticle(MINIMAL, "Line one\n\n\n");
    expect(text).toBe(
      [
        "---",
        "title: Resetting a password",
        "kind: answer",
        "trust: trusted",
        "status: active",
        "origin: article",
        "validAsOf: 2026-10-20",
        "---",
        "",
        "Line one",
        "",
      ].join("\n"),
    );
    expect(parseArticle("articles/reset.md", text).fm).toEqual(MINIMAL);
  });

  test("quotes strings YAML would read as something else", () => {
    const fm: KnowledgeFrontMatter = {
      ...MINIMAL,
      title: "Why: exports #2 [beta]",
      topics: ["true", "1234567", "null", '"quoted"'],
      validAsOfCommit: "1234567890123456789012345678901234567890",
      suggestedBy: "- Pat",
    };
    const parsed = parseArticle("articles/x.md", renderArticle(fm, "Body"));
    expect(parsed.problems).toEqual([]);
    expect(parsed.fm).toEqual(fm);
  });

  test("a missing title names the key", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(minimalLines({ title: null })),
    );
    expect(parsed.fm).toBeNull();
    expect(parsed.problems.map((p) => p.message).join("\n")).toContain("title");
  });

  test("a missing validAsOf names the key", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(minimalLines({ validAsOf: null })),
    );
    expect(parsed.fm).toBeNull();
    expect(parsed.problems.map((p) => p.message).join("\n")).toContain(
      "validAsOf",
    );
  });

  test("an unknown kind lists the allowed ones on its line", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(minimalLines({ kind: "faq" })),
    );
    expect(parsed.problems).toEqual([
      { line: 3, message: 'Unknown kind "faq". Use one of: answer, internal.' },
    ]);
  });

  test("a validAsOf that is not a date", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(minimalLines({ validAsOf: "yesterday" })),
    );
    expect(parsed.problems).toEqual([
      {
        line: 7,
        message: "`validAsOf: yesterday` is not a date. Use YYYY-MM-DD.",
      },
    ]);
  });

  test("needs-check without check.reason is a problem", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(minimalLines({ status: "needs-check" })),
    );
    expect(parsed.fm).toBeNull();
    expect(parsed.problems.map((p) => p.message).join("\n")).toContain(
      "check.reason",
    );
  });

  test("unparseable YAML is one problem on line 1", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(["title: [unclosed", "kind: answer: oops"]),
    );
    expect(parsed.fm).toBeNull();
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0].line).toBe(1);
  });

  test("a file without front matter has no fm and a problem", () => {
    const parsed = parseArticle("articles/x.md", "# Just a heading\n\nText\n");
    expect(parsed.fm).toBeNull();
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.body).toBe("# Just a heading\n\nText");
  });

  test("dependsOn entries must be followable", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([...minimalLines(), "dependsOn: [repo:../x, docs]"]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual([
      'Unknown dependency "repo:../x". Use repo:<path>, url:<http(s) URL>, issue:<n>, pr:<n> or release:<tag>.',
      'Unknown dependency "docs". Use repo:<path>, url:<http(s) URL>, issue:<n>, pr:<n> or release:<tag>.',
    ]);
  });

  test("origin must match the folder", () => {
    const parsed = parseArticle(
      "sources/mail/2026-10/abc.md",
      withFrontMatter(minimalLines()),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual([
      "`origin: article` doesn't match the folder; items under sources/mail/ use `origin: mail`.",
    ]);
  });

  test("unknown keys and a check on an active item are problems", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines(),
        "owner: Ada",
        "check: {reason: old, since: 2026-10-26}",
      ]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual([
      'Unknown key "owner".',
      "`check` is only allowed with `status: needs-check`.",
    ]);
  });

  test("Windows line endings parse", () => {
    const text = renderArticle(MINIMAL, "Body").replace(/\n/g, "\r\n");
    expect(parseArticle("articles/reset.md", text).fm).toEqual(MINIMAL);
  });
});
