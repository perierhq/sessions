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
      withFrontMatter([...minimalLines(), "answeredAt: 2026-10-19T08:12:00Z"]),
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

  test("keys with regex characters don't crash or hang the line lookup", () => {
    const evil = "(a+)+c";
    const started = performance.now();
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines(),
        `"${evil}${"a".repeat(30)}": 1`,
        '"[": 2',
      ]),
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(parsed.fm).toBeNull();
    expect(parsed.problems.map((p) => p.message)).toContain(
      "Keys can't be quoted; write `key: value`.",
    );
  });

  test("unknown keys that look like regex are reported on their line", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([...minimalLines(), "a_b: 1"]),
    );
    expect(parsed.problems).toEqual([
      { line: 8, message: 'Unknown key "a_b".' },
    ]);
  });

  test("duplicate top-level keys are refused", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([...minimalLines(), "trust: reference"]),
    );
    expect(parsed.fm).toBeNull();
    expect(parsed.problems).toEqual([
      { line: 8, message: "`trust` appears more than once." },
    ]);
  });

  test("merge keys, anchors, aliases and tags are refused before parsing", () => {
    for (const line of [
      "<<: {trust: trusted}",
      "check: {<<: {reason: x}, since: 2026-10-26}",
      "topics: &t [a]",
      "sources: *t",
      "topics: [*t]",
      "suggestedBy: !!str Pat",
      "approvedBy: !custom Ada",
    ]) {
      const parsed = parseArticle(
        "articles/x.md",
        withFrontMatter([...minimalLines(), line]),
      );
      expect(parsed.fm).toBeNull();
      expect(parsed.problems).toHaveLength(1);
      expect(parsed.problems[0].line).toBe(8);
    }
  });

  test("ampersands and stars inside text are fine", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines({ title: '"Q&A: *all* !important"' }),
        "topics: [q&a, a*b]",
      ]),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.fm?.title).toBe("Q&A: *all* !important");
  });

  test("non-text values for enum, date and check fields are refused", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(
        minimalLines({
          kind: "[answer]",
          validAsOf: "20261020",
          status: "needs-check",
        }).concat(["check: {reason: 5, since: 2026-10-26, source: [x]}"]),
      ),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual([
      "`kind` must be text.",
      "`validAsOf` must be text.",
      "`check.reason` must be text.",
      "`check.source` must be text.",
    ]);
  });

  test("[trusted] is not a trust value", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter(minimalLines({ trust: "[trusted]" })),
    );
    expect(parsed.fm).toBeNull();
    expect(parsed.problems.map((p) => p.message)).toEqual([
      "`trust` must be text.",
    ]);
  });

  test("suggestions, issues and files are reference until approved", () => {
    for (const [path, origin, folder] of [
      ["suggestions/x.md", "suggestion", "suggestions"],
      ["sources/issues/42.md", "issue", "sources/issues"],
      ["sources/files/handbook.md", "file", "sources/files"],
    ]) {
      const parsed = parseArticle(
        path,
        withFrontMatter(minimalLines({ origin })),
      );
      expect(parsed.problems).toEqual([
        {
          line: 4,
          message: `Items under ${folder}/ are reference until approved.`,
        },
      ]);
      expect(
        parseArticle(
          path,
          withFrontMatter(minimalLines({ origin, trust: "reference" })),
        ).problems,
      ).toEqual([]);
    }
  });

  test("text fields refuse line breaks and control characters", () => {
    const cases: Array<[string, string, string]> = [
      ["title", '"Line\\nTwo"', "`title`"],
      ["title", '"Tab\\there"', "`title`"],
      ["title", '"Sep\\u2028x"', "`title`"],
      ["topics", '["a\\u0007"]', "`topics`"],
    ];
    for (const [key, value, name] of cases) {
      const parsed = parseArticle(
        "articles/x.md",
        withFrontMatter(minimalLines({ [key]: value })),
      );
      expect(parsed.fm).toBeNull();
      expect(parsed.problems.map((p) => p.message)).toEqual([
        `${name} can't hold line breaks or control characters.`,
      ]);
    }
    const reason = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines({ status: "needs-check" }),
        'check: {reason: "a\\rb", since: 2026-10-26}',
      ]),
    );
    expect(reason.problems.map((p) => p.message)).toEqual([
      "`check.reason` can't hold line breaks or control characters.",
    ]);
  });

  test("check.conflictWith must be an item path and check.source followable", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines({ status: "needs-check" }),
        "check: {reason: old, since: 2026-10-26, source: repo:../x, conflictWith: notes.md}",
      ]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual([
      'Unknown source "repo:../x". Use mail:, repo:, url:, issue:, release:, file: followed by the reference.',
      "`check.conflictWith` must be an item path, like articles/<slug>.md.",
    ]);
  });

  test("repo and url sources are checked like dependencies", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines(),
        `sources: ["repo:docs/a.md@${SHA}", "repo:../a.md", "url:javascript:alert(1)", "url:https://u:p@example.test/", "url:https://example.test/a#sha256=${"ab".repeat(32)}", "repo:docs/a.md@zz", "issue:x"]`,
      ]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual(
      [
        "repo:../a.md",
        "url:javascript:alert(1)",
        "url:https://u:p@example.test/",
        "repo:docs/a.md@zz",
        "issue:x",
      ].map(
        (s) =>
          `Unknown source "${s}". Use mail:, repo:, url:, issue:, release:, file: followed by the reference.`,
      ),
    );
  });

  test("a conversation source is a conversation id", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines(),
        `sources: ["conversation:sc_0192ab-cd", "conversation:../x", "conversation:"]`,
      ]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual(
      ["conversation:../x", "conversation:"].map(
        (s) =>
          `Unknown source "${s}". Use mail:, repo:, url:, issue:, release:, file: followed by the reference.`,
      ),
    );
  });

  test("a thread source is a SHA-256", () => {
    const bad = [
      "thread:q1@customer.example.test",
      `thread:${"A".repeat(64)}`,
      `thread:${"a".repeat(63)}`,
      "thread:",
    ];
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([
        ...minimalLines(),
        `sources: ${JSON.stringify([`thread:${"a".repeat(64)}`, ...bad])}`,
      ]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual(
      bad.map(
        (s) =>
          `Unknown source "${s}". Use mail:, repo:, url:, issue:, release:, file: followed by the reference.`,
      ),
    );
  });

  test("answeredAt must be a full timestamp and mail items need one", () => {
    const path = "sources/mail/2026-10/abc@x.md";
    const mail = (answeredAt: string | null) =>
      parseArticle(
        path,
        withFrontMatter([
          ...minimalLines({ origin: "mail" }),
          ...(answeredAt === null ? [] : [`answeredAt: ${answeredAt}`]),
        ]),
      ).problems.map((p) => p.message);
    expect(mail(null)).toEqual([
      "Mail items need `answeredAt`. Use YYYY-MM-DDTHH:MM:SSZ.",
    ]);
    expect(mail("2026-10-19T08:12:00Z")).toEqual([]);
    expect(mail('"2026-10-19T08:12:00.123+02:00"')).toEqual([]);
    for (const bad of [
      "2026-10-19T08:12:00",
      "2026-02-30T08:12:00Z",
      "2026-10-19T25:12:00Z",
      "2026-10-19Tnope",
    ])
      expect(mail(bad)).toEqual([
        `\`answeredAt: ${bad}\` is not a timestamp. Use YYYY-MM-DDTHH:MM:SSZ.`,
      ]);
  });

  test("validAsOfCommit names both sha lengths", () => {
    const parsed = parseArticle(
      "articles/x.md",
      withFrontMatter([...minimalLines(), "validAsOfCommit: abc1234"]),
    );
    expect(parsed.problems.map((p) => p.message)).toEqual([
      "`validAsOfCommit: abc1234` is not a full commit sha (40 or 64 lowercase hex characters).",
    ]);
  });
});
